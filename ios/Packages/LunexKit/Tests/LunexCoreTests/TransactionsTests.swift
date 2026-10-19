import Foundation
@testable import LunexCore
import SwiftData
import Testing

private func typed(_ keys: [AmountInput.Key], digits: Int = 0) -> AmountInput {
    var input = AmountInput(fractionDigits: digits)
    for key in keys { input.press(key) }
    return input
}

private func number(_ text: String) -> [AmountInput.Key] {
    text.map { character -> AmountInput.Key in
        switch character {
        case "+": .plus
        case "-": .minus
        case "*": .times
        case ",": .decimal
        default: .digit(Int(String(character))!)
        }
    }
}

@Suite("Amount keypad")
struct AmountInputTests {
    @Test("typing builds the number with spaced thousands")
    func typing() {
        let input = typed(number("45") + [.thousands])
        #expect(input.value == 45_000)
        #expect(input.display() == "45 000")
        // A leading zero is replaced; «000» needs a number before it.
        #expect(typed([.digit(0), .digit(7)]).value == 7)
        #expect(typed([.thousands]).isEmpty)
    }

    @Test("adds, subtracts and multiplies, × first")
    func arithmetic() {
        let sum = typed(number("45") + [.thousands] + number("+12") + [.thousands])
        #expect(sum.value == 57_000)
        #expect(sum.display() == "45 000 + 12 000")
        #expect(sum.hasOperator)
        #expect(typed(number("2+3*4")).value == 14)
        #expect(typed(number("100-30")).value == 70)
        // A trailing operator does not count; a second one replaces the first.
        #expect(typed(number("50+")).value == 50)
        #expect(typed(number("50+-")).text == "50−")
        #expect(typed(number("+5")).text == "5")
    }

    @Test("minor units follow the currency")
    func decimals() {
        let usd = typed(number("12,505"), digits: 2)
        #expect(usd.value == Decimal(string: "12.50"))
        #expect(usd.display(decimalSeparator: ",") == "12,50")
        #expect(typed(number("10*0,33"), digits: 2).value == Decimal(string: "3.3"))
        // No comma for sums.
        #expect(typed(number("12,5")).value == 125)
    }

    @Test("backspace removes the last key; an edit starts from the saved amount")
    func editing() {
        var input = typed(number("450"))
        input.press(.backspace)
        #expect(input.value == 45)
        let existing = AmountInput(amount: Decimal(string: "12.5")!, fractionDigits: 2)
        #expect(existing.display() == "12,5")
    }
}

@MainActor
private struct LedgerHarness {
    let container: ModelContainer
    let sync: SyncEngine
    let ledger: Ledger
    let cash = UUID()
    let card = UUID()
    let food = UUID()

    init() throws {
        container = try LunexStore.makeContainer(inMemory: true)
        let auth = AuthSession(store: InMemorySecureStore(), refresher: { _ in throw APIError.offline(URLError(.notConnectedToInternet)) })
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }, session: auth)
        sync = SyncEngine(api: api, container: container) { _ in }
        ledger = Ledger(container: container, sync: sync) { "UZS" }
        let context = container.mainContext
        context.insert(AccountRecord(id: cash, name: "Наличные", type: "cash", currency: "UZS", currentBalance: 500_000))
        context.insert(AccountRecord(id: card, name: "Visa", type: "card", currency: "USD", currentBalance: 100))
        context.insert(CategoryRecord(id: food, type: "expense", name: "Еда", icon: "fork.knife", color: "#557A95"))
        try context.save()
    }

    func balance(_ id: UUID) throws -> Decimal {
        try container.mainContext.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id })).first!.currentBalance
    }

    func queued() throws -> [(type: String, body: [String: Any])] {
        try container.mainContext.fetch(FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence)])).map {
            ($0.type, try JSONSerialization.jsonObject(with: $0.payload) as! [String: Any])
        }
    }

    func expense(_ amount: String, account: UUID? = nil) -> TransactionDraft {
        TransactionDraft(
            kind: .expense, amount: typed(number(amount)), accountId: account ?? cash,
            categoryId: food, occurredAt: Date(timeIntervalSince1970: 1_792_400_000), note: "  Обед "
        )
    }
}

@Suite("Ledger")
@MainActor
struct LedgerTests {
    @Test("a new expense is saved locally, takes the money and waits in the queue")
    func create() throws {
        let harness = try LedgerHarness()
        let id = try harness.ledger.create(harness.expense("45000"))

        let record = try #require(try harness.container.mainContext.fetch(FetchDescriptor<TransactionRecord>()).first)
        #expect(record.id == id && record.amount == 45_000 && record.amountBase == 45_000 && record.note == "Обед")
        #expect(try harness.balance(harness.cash) == 455_000)

        let queued = try harness.queued()
        #expect(queued.map(\.type) == ["transaction.create"])
        let data = try #require(queued[0].body["data"] as? [String: Any])
        #expect(data["amount"] as? String == "45000")
        #expect(data["type"] as? String == "expense")
        #expect(data["occurredAt"] as? String == "2026-10-19T08:53:20.000Z")
        #expect((data["id"] as? String)?.lowercased() == id.uuidString.lowercased())
    }

    @Test("an edit moves balances by the difference and sends every edited field")
    func update() throws {
        let harness = try LedgerHarness()
        let id = try harness.ledger.create(harness.expense("45000"))
        var draft = harness.expense("50000")
        draft.kind = .transfer
        draft.transferAccountId = harness.card
        try harness.ledger.update(id, with: draft)

        // Expense undone (+45 000), transfer applied (−50 000 here, +50 000 on the card).
        #expect(try harness.balance(harness.cash) == 450_000)
        #expect(try harness.balance(harness.card) == 50_100)
        let update = try #require(try harness.queued().last)
        #expect(update.type == "transaction.update")
        let data = try #require(update.body["data"] as? [String: Any])
        #expect(data["type"] as? String == "transfer")
        // A transfer has no category: it goes as null, not left out.
        #expect(data.keys.contains("categoryId") && data["categoryId"] is NSNull)
    }

    @Test("delete returns the money; restore takes it again")
    func deleteAndRestore() throws {
        let harness = try LedgerHarness()
        let id = try harness.ledger.create(harness.expense("45000"))
        try harness.ledger.delete(id)
        #expect(try harness.balance(harness.cash) == 500_000)
        try harness.ledger.restore(id)
        #expect(try harness.balance(harness.cash) == 455_000)
        #expect(try harness.queued().map(\.type) == ["transaction.create", "transaction.delete", "transaction.restore"])
    }

    @Test("another currency uses the last known rate until the server answers")
    func foreignCurrency() throws {
        let harness = try LedgerHarness()
        harness.container.mainContext.insert(TransactionRecord(
            id: UUID(), type: "expense", accountId: harness.card, amount: 1, currency: "USD",
            amountBase: 12_650, baseCurrency: "UZS", fxRate: 12_650, occurredAt: .now
        ))
        let id = try harness.ledger.create(harness.expense("10", account: harness.card))
        let record = try #require(try harness.container.mainContext.fetch(
            FetchDescriptor<TransactionRecord>(predicate: #Predicate { $0.id == id })
        ).first)
        #expect(record.amountBase == 126_500 && record.currency == "USD")
    }

    @Test("a draft says what is missing")
    func problems() {
        var draft = TransactionDraft(amount: AmountInput(fractionDigits: 0))
        #expect(draft.problem == .noAmount)
        draft.amount = typed(number("5"))
        #expect(draft.problem == .noAccount)
        let account = UUID()
        draft.accountId = account
        #expect(draft.problem == nil)
        draft.kind = .transfer
        #expect(draft.problem == .noTargetAccount)
        draft.transferAccountId = account
        #expect(draft.problem == .sameAccount)
        draft.amount = typed(number("5-5"))
        #expect(draft.problem == .noAmount)
    }
}

@Suite("History")
@MainActor
struct HistoryTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return calendar
    }()

    private func date(_ text: String) -> Date {
        ISO8601DateFormatter().date(from: text)!
    }

    @Test("groups by day with totals, filters combine, search finds notes, categories and amounts")
    func days() {
        let cash = UUID(), card = UUID(), food = UUID(), cafe = UUID(), salary = UUID()
        let categories: [UUID: CategoryRecord] = [
            food: CategoryRecord(id: food, type: "expense", name: "Еда", translations: ["en": "Food"], icon: "fork.knife", color: "#000000"),
            cafe: CategoryRecord(id: cafe, type: "expense", name: "Кафе", icon: "cup", color: "#000000", parentId: food),
            salary: CategoryRecord(id: salary, type: "income", name: "Зарплата", icon: "briefcase", color: "#000000"),
        ]
        let records = [
            TransactionRecord(id: UUID(), type: "expense", accountId: cash, amount: 45_000, currency: "UZS", amountBase: 45_000,
                              categoryId: cafe, note: "Обед", occurredAt: date("2026-10-19T08:00:00Z")),
            TransactionRecord(id: UUID(), type: "expense", accountId: cash, amount: 30_000, currency: "UZS", amountBase: 30_000,
                              categoryId: food, occurredAt: date("2026-10-19T05:00:00Z")),
            TransactionRecord(id: UUID(), type: "income", accountId: card, amount: 8_000_000, currency: "UZS", amountBase: 8_000_000,
                              categoryId: salary, occurredAt: date("2026-10-18T10:00:00Z")),
            TransactionRecord(id: UUID(), type: "transfer", accountId: card, transferAccountId: cash, amount: 100_000,
                              currency: "UZS", amountBase: 100_000, occurredAt: date("2026-09-30T10:00:00Z")),
            TransactionRecord(id: UUID(), type: "expense", accountId: cash, amount: 1, currency: "UZS", amountBase: 1,
                              occurredAt: date("2026-10-19T09:00:00Z"), deletedAt: .now),
        ]
        let now = date("2026-10-19T12:00:00Z")
        let days = { (filter: HistoryFilter) in
            History.days(records, filter: filter, categories: categories, language: "en", calendar: calendar, now: now)
        }

        let all = days(HistoryFilter())
        #expect(all.map(\.items.count) == [2, 1, 1])
        #expect(all.map(\.total) == [-75_000, 8_000_000, 0])

        var filter = HistoryFilter()
        filter.categoryId = food
        #expect(days(filter).flatMap(\.items).count == 2)
        filter = HistoryFilter()
        filter.accountId = cash
        filter.period = .lastMonth
        #expect(days(filter).flatMap(\.items).map(\.type) == ["transfer"])
        filter = HistoryFilter()
        filter.kind = .income
        #expect(days(filter).flatMap(\.items).count == 1)

        for query in ["обед", "food", "45 000"] {
            var search = HistoryFilter()
            search.query = query
            #expect(days(search).flatMap(\.items).count >= 1, "\(query)")
        }
        var nothing = HistoryFilter()
        nothing.query = "такси"
        #expect(days(nothing).isEmpty)
    }

    @Test("the quick-add grid puts often and recently used categories first")
    func ranking() {
        let a = CategoryRecord(id: UUID(), type: "expense", name: "A", icon: "a", color: "#000000", sortOrder: 0)
        let b = CategoryRecord(id: UUID(), type: "expense", name: "B", icon: "b", color: "#000000", sortOrder: 1)
        let c = CategoryRecord(id: UUID(), type: "expense", name: "C", icon: "c", color: "#000000", sortOrder: 2)
        let archived = CategoryRecord(id: UUID(), type: "expense", name: "D", icon: "d", color: "#000000", isArchived: true)
        let income = CategoryRecord(id: UUID(), type: "income", name: "E", icon: "e", color: "#000000")
        let now = Date()
        let use = { (category: CategoryRecord, daysAgo: Double) in
            TransactionRecord(id: UUID(), type: "expense", accountId: UUID(), amount: 1, currency: "UZS", amountBase: 1,
                              categoryId: category.id, occurredAt: now.addingTimeInterval(-daysAgo * 86_400))
        }
        let ordered = CategoryRanking.ordered(
            [a, b, c, archived, income], kind: .expense,
            transactions: [use(c, 1), use(c, 2), use(b, 0.5), use(a, 200)], now: now
        )
        #expect(ordered.map(\.name) == ["C", "B", "A"])
    }
}
