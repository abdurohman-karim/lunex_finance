import Foundation
@testable import LunexCore
import SwiftData
import Testing

@MainActor
private struct CatalogHarness {
    let container: ModelContainer
    let catalog: Catalog
    let cash = UUID()
    let food = UUID()
    let salary = UUID()

    init() throws {
        container = try LunexStore.makeContainer(inMemory: true)
        let auth = AuthSession(store: InMemorySecureStore(), refresher: { _ in throw APIError.offline(URLError(.notConnectedToInternet)) })
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }, session: auth)
        catalog = Catalog(container: container, sync: SyncEngine(api: api, container: container) { _ in })
        let context = container.mainContext
        context.insert(AccountRecord(
            id: cash, name: "Наличные", type: "cash", currency: "UZS",
            initialBalance: 0, currentBalance: 300_000, isDefault: true
        ))
        context.insert(CategoryRecord(id: food, type: "expense", key: "food", name: "Food", icon: "fork.knife", color: "#557A95", isSystem: true))
        context.insert(CategoryRecord(id: salary, type: "income", key: "salary", name: "Salary", icon: "banknote", color: "#557A95", isSystem: true))
        let settings = SettingsRecord(key: "main")
        settings.defaultAccountId = cash
        context.insert(settings)
        try context.save()
    }

    var context: ModelContext { container.mainContext }

    func account(_ id: UUID) throws -> AccountRecord {
        try #require(try context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id })).first)
    }

    func category(_ id: UUID) throws -> CategoryRecord {
        try #require(try context.fetch(FetchDescriptor<CategoryRecord>(predicate: #Predicate { $0.id == id })).first)
    }

    func queued() throws -> [(type: String, body: [String: Any])] {
        try context.fetch(FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence)])).map {
            ($0.type, try JSONSerialization.jsonObject(with: $0.payload) as! [String: Any])
        }
    }

    func spend(from account: UUID, category: UUID? = nil) throws {
        context.insert(TransactionRecord(
            id: UUID(), type: "expense", accountId: account, amount: 10_000, currency: "UZS",
            amountBase: 10_000, categoryId: category, occurredAt: .now, source: "quick_add"
        ))
        try context.save()
    }
}

@Suite("Accounts")
@MainActor
struct AccountCatalogTests {
    @Test("a new account starts at its opening balance and waits in the queue; the first one is default")
    func create() throws {
        let harness = try CatalogHarness()
        let id = try harness.catalog.createAccount(AccountDraft(
            name: "  Visa ", kind: .card, currency: "USD", initialBalance: Decimal(string: "120.555")!
        ))
        let record = try harness.account(id)
        #expect(record.name == "Visa" && record.currency == "USD" && record.icon == "creditcard")
        #expect(record.initialBalance == Decimal(string: "120.56")! && record.currentBalance == record.initialBalance)
        #expect(record.sortOrder == 1 && !record.isDefault)

        let queued = try harness.queued()
        #expect(queued.map(\.type) == ["account.create"])
        let data = try #require(queued[0].body["data"] as? [String: Any])
        #expect(data["initialBalance"] as? String == "120.56")
        #expect(data["type"] as? String == "card" && data["includeInTotal"] as? Bool == true)

        #expect(throws: CatalogError.invalidName) { try harness.catalog.createAccount(AccountDraft(name: "   ")) }
    }

    @Test("the opening balance moves the current one; the currency is fixed once money moved")
    func update() throws {
        let harness = try CatalogHarness()
        var draft = harness.catalog.draft(for: try harness.account(harness.cash))
        draft.initialBalance = 50_000
        try harness.catalog.updateAccount(harness.cash, with: draft)
        #expect(try harness.account(harness.cash).currentBalance == 350_000)

        draft.currency = "USD"
        try harness.spend(from: harness.cash)
        #expect(throws: CatalogError.currencyLocked) { try harness.catalog.updateAccount(harness.cash, with: draft) }
        #expect(try harness.queued().map(\.type) == ["account.update"])
    }

    @Test("archiving the default account passes the default on; unarchiving takes it back when none")
    func archive() throws {
        let harness = try CatalogHarness()
        let card = try harness.catalog.createAccount(AccountDraft(name: "Visa"))
        try harness.catalog.setArchived(account: harness.cash, true)
        #expect(try harness.account(card).isDefault)
        #expect(try !harness.account(harness.cash).isDefault)
        #expect(try harness.context.fetch(FetchDescriptor<SettingsRecord>()).first?.defaultAccountId == card)

        try harness.catalog.setArchived(account: card, true)
        try harness.catalog.setArchived(account: harness.cash, false)
        #expect(try harness.account(harness.cash).isDefault)

        let updates = try harness.queued().filter { $0.type == "account.update" }.compactMap { $0.body["data"] as? [String: Bool] }
        #expect(updates == [["isArchived": true], ["isArchived": true], ["isArchived": false]])
    }

    @Test("an account with operations cannot be deleted; an empty one can")
    func delete() throws {
        let harness = try CatalogHarness()
        try harness.spend(from: harness.cash)
        #expect(throws: CatalogError.inUse) { try harness.catalog.deleteAccount(harness.cash) }

        let spare = try harness.catalog.createAccount(AccountDraft(name: "Spare"))
        try harness.catalog.deleteAccount(spare)
        #expect(try harness.account(spare).deletedAt != nil)
        #expect(try harness.queued().map(\.type) == ["account.create", "account.delete"])
    }

    @Test("new order is saved locally and sent as the list of ids")
    func reorder() throws {
        let harness = try CatalogHarness()
        let card = try harness.catalog.createAccount(AccountDraft(name: "Visa"))
        try harness.catalog.reorderAccounts([card, harness.cash])
        #expect(try harness.account(card).sortOrder == 0 && harness.account(harness.cash).sortOrder == 1)
        let body = try #require(try harness.queued().last?.body["data"] as? [String: [String]])
        #expect(body["ids"]?.map { $0.lowercased() } == [card, harness.cash].map { $0.uuidString.lowercased() })
    }

    @Test("the total counts included accounts in the base currency; unknown rates stay apart")
    func total() throws {
        let harness = try CatalogHarness()
        let usd = try harness.catalog.createAccount(AccountDraft(name: "Visa", currency: "USD", initialBalance: 100))
        _ = try harness.catalog.createAccount(AccountDraft(name: "Евро", currency: "EUR", initialBalance: 10))
        _ = try harness.catalog.createAccount(AccountDraft(name: "Сейф", currency: "UZS", initialBalance: 1_000_000, includeInTotal: false))
        harness.context.insert(TransactionRecord(
            id: UUID(), type: "expense", accountId: usd, amount: 1, currency: "USD",
            amountBase: 12_700, baseCurrency: "UZS", fxRate: 12_700, occurredAt: .now, source: "quick_add"
        ))
        let accounts = try harness.context.fetch(FetchDescriptor<AccountRecord>())
        let balance = try harness.catalog.balance(of: accounts, base: "UZS")
        // 300 000 in cash plus 100 $ at the last known rate
        #expect(balance.total == 1_570_000)
        #expect(balance.unconverted == ["EUR": 10])
    }
}

@Suite("Categories")
@MainActor
struct CategoryCatalogTests {
    @Test("own categories are unique by name among siblings; subcategories are one level deep")
    func create() throws {
        let harness = try CatalogHarness()
        let coffee = try harness.catalog.createCategory(CategoryDraft(name: "Кофе", icon: "cup.and.saucer", parentId: harness.food))
        #expect(try harness.category(coffee).parentId == harness.food)
        let data = try #require(try harness.queued().last?.body["data"] as? [String: Any])
        #expect((data["parentId"] as? String)?.lowercased() == harness.food.uuidString.lowercased())

        #expect(throws: CatalogError.nameTaken) {
            try harness.catalog.createCategory(CategoryDraft(name: "кофе", parentId: harness.food))
        }
        #expect(throws: CatalogError.invalidParent) {
            try harness.catalog.createCategory(CategoryDraft(name: "Латте", parentId: coffee))
        }
        #expect(throws: CatalogError.invalidParent) {
            try harness.catalog.createCategory(CategoryDraft(kind: .expense, name: "Премия", parentId: harness.salary))
        }
        // Same name at another level is fine.
        _ = try harness.catalog.createCategory(CategoryDraft(name: "Кофе"))
    }

    @Test("system categories are only archived; moving an own one to the top sends a null parent")
    func update() throws {
        let harness = try CatalogHarness()
        #expect(throws: CatalogError.systemReadonly) {
            try harness.catalog.updateCategory(harness.food, with: CategoryDraft(name: "Еда"))
        }
        try harness.catalog.setArchived(category: harness.food, true)
        #expect(try harness.category(harness.food).isArchived)

        let coffee = try harness.catalog.createCategory(CategoryDraft(name: "Кофе", parentId: harness.food))
        var draft = harness.catalog.draft(for: try harness.category(coffee))
        draft.parentId = nil
        draft.color = "#7395AE"
        try harness.catalog.updateCategory(coffee, with: draft)

        let queued = try harness.queued()
        #expect(queued.map(\.type) == ["category.update", "category.create", "category.update"])
        let data = try #require(queued[2].body["data"] as? [String: Any])
        #expect(data["parentId"] is NSNull && data["color"] as? String == "#7395AE")
    }

    @Test("a used or parent category cannot be deleted, only archived")
    func delete() throws {
        let harness = try CatalogHarness()
        let home = try harness.catalog.createCategory(CategoryDraft(name: "Дом"))
        let repair = try harness.catalog.createCategory(CategoryDraft(name: "Ремонт", parentId: home))
        #expect(throws: CatalogError.hasChildren) { try harness.catalog.deleteCategory(home) }
        try harness.spend(from: harness.cash, category: repair)
        #expect(throws: CatalogError.inUse) { try harness.catalog.deleteCategory(repair) }
        #expect(throws: CatalogError.systemReadonly) { try harness.catalog.deleteCategory(harness.food) }

        let gym = try harness.catalog.createCategory(CategoryDraft(name: "Спорт"))
        try harness.catalog.deleteCategory(gym)
        #expect(try harness.category(gym).deletedAt != nil)
    }
}
