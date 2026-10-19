import Foundation
@testable import LunexCore
import SwiftData
import Testing

/// The same cases as the server's `goal-math.spec.ts`.
@Suite("Goal formulas")
struct GoalMathTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return calendar
    }()

    private func day(_ text: String) -> Date {
        let parts = text.split(separator: "-").map { Int($0)! }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 10))!
    }

    private func schedule(saved: Decimal, deadline: String? = "2026-12-31", today: String = "2026-07-02") -> GoalSchedule? {
        GoalMath.schedule(
            target: 12_000_000, saved: saved, startedOn: day("2026-01-01"), deadline: deadline.map(day),
            today: day(today), fractionDigits: 0, calendar: calendar
        )
    }

    @Test("progress is floored; milestones are the ones reached")
    func progress() {
        #expect(GoalMath.progress(saved: 2_499_999, target: 10_000_000) == 24)
        #expect(GoalMath.progress(saved: 2_500_000, target: 10_000_000) == 25)
        #expect(GoalMath.progress(saved: 10_500_000, target: 10_000_000) == 105)
        #expect(GoalMath.progress(saved: 0, target: 0) == 0)
        #expect(GoalMath.reachedMilestones(24) == [])
        #expect(GoalMath.reachedMilestones(74) == [25, 50])
        #expect(GoalMath.reachedMilestones(105) == [25, 50, 75, 100])
    }

    @Test("no plan without a deadline or once reached; what is left is split and rounded up")
    func split() throws {
        #expect(schedule(saved: 0, deadline: nil) == nil)
        #expect(schedule(saved: 12_000_000) == nil)
        let plan = try #require(schedule(saved: 6_000_000))
        #expect(plan.daysLeft == 183)
        #expect(plan.perDay == 32_787 && plan.perWeek == 222_223 && plan.perMonth == 857_143)
    }

    @Test("compared with a steady pace, 5 % of the target either way is on track")
    func status() {
        #expect(schedule(saved: 6_000_000)?.status == .onTrack)
        #expect(schedule(saved: 5_500_000)?.status == .onTrack)
        #expect(schedule(saved: 5_300_000)?.status == .behind)
        #expect(schedule(saved: 7_000_000)?.status == .ahead)
        let late = schedule(saved: 11_000_000, today: "2027-01-15")
        #expect(late?.daysLeft == 0 && late?.status == .behind && late?.perDay == 1_000_000)
    }
}

@MainActor
private struct GoalHarness {
    let container: ModelContainer
    let book: GoalBook
    let card = UUID()
    let savings = UUID()

    init() throws {
        container = try LunexStore.makeContainer(inMemory: true)
        let auth = AuthSession(store: InMemorySecureStore(), refresher: { _ in throw APIError.offline(URLError(.notConnectedToInternet)) })
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in throw URLError(.notConnectedToInternet) }, session: auth)
        book = GoalBook(container: container, sync: SyncEngine(api: api, container: container) { _ in })
        container.mainContext.insert(AccountRecord(id: card, name: "Uzcard", type: "card", currency: "UZS", currentBalance: 5_000_000))
        container.mainContext.insert(AccountRecord(id: savings, name: "Копилка", type: "savings", currency: "UZS"))
        try container.mainContext.save()
    }

    func goal(_ id: UUID) throws -> GoalRecord {
        try #require(try container.mainContext.fetch(FetchDescriptor<GoalRecord>(predicate: #Predicate { $0.id == id })).first)
    }

    func balance(_ id: UUID) throws -> Decimal {
        try #require(try container.mainContext.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id })).first).currentBalance
    }

    func queued() throws -> [(type: String, body: [String: Any])] {
        try container.mainContext.fetch(FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence)])).map {
            ($0.type, try JSONSerialization.jsonObject(with: $0.payload) as! [String: Any])
        }
    }

    func car(target: Decimal = 1_000_000, linked: Bool = true) throws -> UUID {
        try book.create(GoalDraft(
            title: " Машина ", templateKey: "car", emoji: "🚗", color: "#B1A296", targetAmount: target,
            currency: "UZS", linkedAccountId: linked ? savings : nil
        ))
    }
}

@Suite("Goals")
@MainActor
struct GoalBookTests {
    @Test("the first goal becomes primary; the next ones go below it")
    func create() throws {
        let harness = try GoalHarness()
        let car = try harness.car()
        let phone = try harness.book.create(GoalDraft(title: "Телефон", targetAmount: 500_000))
        #expect(try harness.goal(car).isPrimary && harness.goal(car).title == "Машина")
        #expect(try !harness.goal(phone).isPrimary && harness.goal(phone).priority == 1)

        let data = try #require(try harness.queued().first?.body["data"] as? [String: Any])
        #expect(data["targetAmount"] as? String == "1000000" && data["templateKey"] as? String == "car")
        #expect((data["linkedAccountId"] as? String)?.lowercased() == harness.savings.uuidString.lowercased())

        #expect(throws: GoalError.invalidAmount) { try harness.book.create(GoalDraft(title: "Ноль", targetAmount: 0)) }
        let yesterday = Calendar.current.date(byAdding: .day, value: -1, to: .now)!
        #expect(throws: GoalError.deadlineInPast) {
            try harness.book.create(GoalDraft(title: "Вчера", targetAmount: 1, deadline: yesterday))
        }
    }

    @Test("a deposit moves money to the savings account, marks milestones once and completes the goal")
    func deposit() throws {
        let harness = try GoalHarness()
        let car = try harness.car()
        let phone = try harness.book.create(GoalDraft(title: "Телефон", targetAmount: 500_000))

        let first = try harness.book.contribute(to: car, kind: .deposit, amount: 600_000, accountId: harness.card)
        #expect(first.newMilestones == [25, 50] && !first.completed)
        #expect(try harness.balance(harness.card) == 4_400_000 && harness.balance(harness.savings) == 600_000)
        #expect(try harness.goal(car).progress == 60)

        let second = try harness.book.contribute(to: car, kind: .deposit, amount: 400_000, accountId: harness.card)
        #expect(second.newMilestones == [75, 100] && second.completed)
        #expect(try harness.goal(car).status == "completed" && !harness.goal(car).isPrimary)
        // The primary goal passes to the next live one.
        #expect(try harness.goal(phone).isPrimary)

        #expect(throws: GoalError.goalCompleted) {
            try harness.book.contribute(to: car, kind: .deposit, amount: 1, accountId: nil)
        }
        let body = try #require(try harness.queued().last?.body)
        #expect(body["type"] as? String == "goal.contribute")
        #expect((body["goalId"] as? String)?.lowercased() == car.uuidString.lowercased())
        let data = try #require(body["data"] as? [String: Any])
        #expect(data["amount"] as? String == "400000" && data["accountAmount"] == nil)
    }

    @Test("withdrawals cannot exceed the savings; undoing the deposit that reached the target reopens the goal")
    func withdrawAndUndo() throws {
        let harness = try GoalHarness()
        let car = try harness.car()
        let first = try harness.book.contribute(to: car, kind: .deposit, amount: 600_000, accountId: harness.card)
        let second = try harness.book.contribute(to: car, kind: .deposit, amount: 400_000, accountId: harness.card)
        #expect(throws: GoalError.insufficientFunds) {
            try harness.book.contribute(to: car, kind: .withdrawal, amount: 1_000_001, accountId: harness.card)
        }
        // A reached goal still gives its money back (buying what it was saved for).
        try harness.book.contribute(to: car, kind: .withdrawal, amount: 100_000, accountId: harness.card)
        #expect(try harness.goal(car).savedAmount == 900_000 && harness.goal(car).status == "completed")

        try harness.book.removeContribution(second.id)
        #expect(try harness.goal(car).savedAmount == 500_000)
        #expect(try harness.goal(car).status == "active" && harness.goal(car).isPrimary)
        #expect(try harness.balance(harness.card) == 4_500_000 && harness.balance(harness.savings) == 500_000)
        #expect(try harness.queued().last?.type == "goal.contribution.delete")
        // Its money has partly left the goal already.
        #expect(throws: GoalError.insufficientFunds) { try harness.book.removeContribution(first.id) }
    }

    @Test("lowering the target to the savings completes the goal; only an empty goal is deleted")
    func updateAndDelete() throws {
        let harness = try GoalHarness()
        let car = try harness.car(linked: false)
        try harness.book.contribute(to: car, kind: .deposit, amount: 300_000, accountId: nil)
        var draft = harness.book.draft(for: try harness.goal(car))
        draft.targetAmount = 300_000
        try harness.book.update(car, with: draft)
        #expect(try harness.goal(car).status == "completed" && harness.goal(car).progress == 100)
        #expect(throws: GoalError.hasMoney) { try harness.book.delete(car) }

        let empty = try harness.book.create(GoalDraft(title: "Пусто", targetAmount: 10))
        try harness.book.delete(empty)
        #expect(try harness.goal(empty).deletedAt != nil)
    }

    @Test("archiving the primary goal hands it to the next by priority; bringing it back does not take it")
    func statusAndPriority() throws {
        let harness = try GoalHarness()
        let car = try harness.car()
        let phone = try harness.book.create(GoalDraft(title: "Телефон", targetAmount: 500_000))
        let trip = try harness.book.create(GoalDraft(title: "Поездка", targetAmount: 900_000))
        try harness.book.reorder([trip, car, phone])
        try harness.book.setStatus(car, .archived)
        #expect(try harness.goal(trip).isPrimary && harness.goal(car).archivedAt != nil)

        try harness.book.setStatus(car, .active)
        #expect(try !harness.goal(car).isPrimary && harness.goal(car).archivedAt == nil)
        try harness.book.makePrimary(car)
        #expect(try harness.goal(car).isPrimary && !harness.goal(trip).isPrimary)
        try harness.book.setStatus(phone, .paused)
        #expect(throws: GoalError.notLive) {
            try harness.book.setStatus(phone, .archived)
            try harness.book.makePrimary(phone)
        }
        let statuses = try harness.queued().filter { $0.type == "goal.update" }.compactMap { ($0.body["data"] as? [String: Any])?["status"] as? String }
        #expect(statuses == ["archived", "active", "paused", "archived"])
    }
}
