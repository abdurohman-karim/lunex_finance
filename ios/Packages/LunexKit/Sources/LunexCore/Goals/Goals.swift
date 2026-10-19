import Foundation
import Observation
import SwiftData

public enum GoalStatus: String, CaseIterable, Sendable {
    case active, paused, completed, archived

    /// Still being saved for: active or paused.
    public var isLive: Bool { self == .active || self == .paused }
}

/// Ready-made goals (the server's `GOAL_TEMPLATES`), kept in the app so a goal can be made offline.
public struct BuiltInGoalTemplate: Sendable, Identifiable, Equatable {
    public let key: String
    public let emoji: String
    public let color: String
    let names: [String: String]

    public var id: String { key }

    public func name(language: String) -> String {
        names[language] ?? names["en"] ?? key
    }

    public static let all: [BuiltInGoalTemplate] = [
        .init(key: "phone", emoji: "📱", color: "#557A95", names: ["uz": "Telefon", "ru": "Телефон", "en": "Phone"]),
        .init(key: "car", emoji: "🚗", color: "#B1A296", names: ["uz": "Avtomobil", "ru": "Машина", "en": "Car"]),
        .init(key: "home", emoji: "🏠", color: "#5D5C61", names: ["uz": "Uy", "ru": "Дом", "en": "Home"]),
        .init(key: "travel", emoji: "✈️", color: "#7395AE", names: ["uz": "Sayohat", "ru": "Путешествие", "en": "Travel"]),
        .init(key: "education", emoji: "🎓", color: "#938E94", names: ["uz": "Taʼlim", "ru": "Учёба", "en": "Education"]),
        .init(key: "emergency_fund", emoji: "🛟", color: "#557A95", names: ["uz": "Favqulodda jamgʻarma", "ru": "Подушка безопасности", "en": "Emergency fund"]),
        .init(key: "wedding", emoji: "💍", color: "#B1A296", names: ["uz": "Toʻy", "ru": "Свадьба", "en": "Wedding"]),
        .init(key: "gadget", emoji: "💻", color: "#7395AE", names: ["uz": "Gadjet", "ru": "Гаджет", "en": "Gadget"]),
    ]

    public static let defaultEmoji = "🎯"
    public static let defaultColor = "#557A95"
}

// MARK: - Formulas

public enum ScheduleStatus: String, Sendable {
    case onTrack = "on_track", behind, ahead
}

public struct GoalSchedule: Equatable, Sendable {
    /// Needed contribution to finish by the deadline, rounded up to the currency
    public let perDay: Decimal
    public let perWeek: Decimal
    public let perMonth: Decimal
    /// What a steady pace from the goal's start would have saved by today
    public let expectedSaved: Decimal
    public let status: ScheduleStatus
    /// Days until the deadline, today included; 0 once it has passed
    public let daysLeft: Int
}

/// The server's `goal-math.ts`.
public enum GoalMath {
    public static let milestones = [25, 50, 75, 100]
    /// Within ±5 % of the target from the steady pace counts as «В графике».
    static let tolerance: Decimal = 0.05

    /// ⌊saved ÷ target × 100⌋
    public static func progress(saved: Decimal, target: Decimal) -> Int {
        guard target > 0 else { return 0 }
        let percent = BudgetMath.rounded(saved / target * 100, 0, .down)
        return max(0, NSDecimalNumber(decimal: percent).intValue)
    }

    public static func reachedMilestones(_ percent: Int) -> [Int] {
        milestones.filter { percent >= $0 }
    }

    /// (target − saved) ÷ periods left, and «В графике / Отстаёт / Опережает» against a straight
    /// line from the start. Nil without a deadline or once the target is reached.
    public static func schedule(
        target: Decimal, saved: Decimal, startedOn: Date, deadline: Date?, today: Date,
        fractionDigits: Int, calendar: Calendar
    ) -> GoalSchedule? {
        guard let deadline, saved < target else { return nil }
        let remaining = target - saved
        let days = { (from: Date, to: Date) in
            calendar.dateComponents([.day], from: calendar.startOfDay(for: from), to: calendar.startOfDay(for: to)).day ?? 0
        }
        let daysLeft = max(0, days(today, deadline) + 1)
        let per = { (length: Int) -> Decimal in
            let periods = max(1, Int((Double(daysLeft) / Double(length)).rounded(.up)))
            return BudgetMath.rounded(remaining / Decimal(periods), fractionDigits, .up)
        }
        let total = max(1, days(startedOn, deadline))
        let elapsed = min(total, max(0, days(startedOn, today)))
        let expected = target * Decimal(elapsed) / Decimal(total)
        let slack = target * tolerance
        let status: ScheduleStatus = saved < expected - slack ? .behind : saved > expected + slack ? .ahead : .onTrack
        return GoalSchedule(
            perDay: per(1),
            perWeek: per(7),
            perMonth: per(30),
            expectedSaved: BudgetMath.rounded(expected, fractionDigits, .plain),
            status: daysLeft == 0 ? .behind : status,
            daysLeft: daysLeft
        )
    }
}

// MARK: - Drafts

/// The goal editor's answers.
public struct GoalDraft: Equatable, Sendable {
    public var title: String
    public var templateKey: String?
    public var emoji: String
    public var color: String
    public var targetAmount: Decimal
    public var currency: String
    /// Start of the deadline day; nil = no deadline
    public var deadline: Date?
    /// The savings account the money sits in; same currency as the goal
    public var linkedAccountId: UUID?

    public init(
        title: String = "", templateKey: String? = nil, emoji: String = BuiltInGoalTemplate.defaultEmoji,
        color: String = BuiltInGoalTemplate.defaultColor, targetAmount: Decimal = 0,
        currency: String = SupportedCurrency.default, deadline: Date? = nil, linkedAccountId: UUID? = nil
    ) {
        self.title = title
        self.templateKey = templateKey
        self.emoji = emoji
        self.color = color
        self.targetAmount = targetAmount
        self.currency = currency
        self.deadline = deadline
        self.linkedAccountId = linkedAccountId
    }

    public var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isValid: Bool { !trimmedTitle.isEmpty && trimmedTitle.count <= 120 && targetAmount > 0 }
}

public enum ContributionKind: String, Sendable, CaseIterable {
    case deposit, withdrawal
}

public enum GoalError: Error, Equatable {
    case invalidTitle
    case invalidAmount
    case deadlineInPast
    case notFound
    /// The target is reached: deposits wait until the goal is back in work
    case goalCompleted
    case goalArchived
    /// More than the goal holds
    case insufficientFunds
    /// Money is inside: withdraw it or archive the goal
    case hasMoney
    /// Only an active or paused goal can be the primary one
    case notLive
    /// The savings account must be in the goal's currency
    case invalidLinkedAccount
    /// No known rate between the goal's and the account's currencies
    case rateUnavailable
}

/// What a contribution changed: new milestones to celebrate, and whether the target was reached.
public struct ContributionOutcome: Equatable, Sendable {
    public let id: UUID
    public let newMilestones: [Int]
    public let completed: Bool
}

// MARK: - Goals on the device

/// Changes goals and their contributions on the device and queues them for the server, with the
/// server's rules (one primary goal, completing on reaching the target, milestones once each,
/// money moving between the account and the savings account).
@MainActor
@Observable
public final class GoalBook {
    @ObservationIgnored private let context: ModelContext
    @ObservationIgnored private let sync: SyncEngine
    @ObservationIgnored private let calendar: Calendar

    public init(container: ModelContainer, sync: SyncEngine, calendar: Calendar = .current) {
        self.context = container.mainContext
        self.sync = sync
        self.calendar = calendar
    }

    // MARK: Goals

    @discardableResult
    public func create(_ draft: GoalDraft) throws -> UUID {
        try validate(draft)
        let goals = try liveGoals()
        let all = try context.fetch(FetchDescriptor<GoalRecord>())
        let id = UUID()
        let record = GoalRecord(
            id: id, title: draft.trimmedTitle, emoji: draft.emoji, color: draft.color,
            targetAmount: Self.rounded(draft.targetAmount, draft.currency), currency: draft.currency
        )
        record.templateKey = draft.templateKey
        record.deadline = draft.deadline.map(dayKey)
        record.linkedAccountId = draft.linkedAccountId
        record.priority = (all.map(\.priority).max() ?? -1) + 1
        // The first goal becomes the primary one.
        record.isPrimary = !goals.contains(where: \.isPrimary)
        context.insert(record)
        try sync.store(.make("goal.create", recordId: id, data: GoalCreateBody(record)))
        try finish()
        return id
    }

    public func update(_ id: UUID, with draft: GoalDraft) throws {
        let record = try goal(id)
        try validate(draft, currency: record.currency, keepingDeadline: record.deadline)
        record.title = draft.trimmedTitle
        record.emoji = draft.emoji
        record.color = draft.color
        record.targetAmount = Self.rounded(draft.targetAmount, record.currency)
        record.deadline = draft.deadline.map(dayKey)
        record.linkedAccountId = draft.linkedAccountId
        // Reaching the target (also by lowering it) completes a goal that is being saved for.
        settleStatus(record, next: GoalStatus(rawValue: record.status) ?? .active)
        record.progress = GoalMath.progress(saved: record.savedAmount, target: record.targetAmount)
        record.updatedAt = .now
        try settlePrimary()
        try sync.store(.make("goal.update", id: id, data: GoalUpdateBody(record)))
        try finish()
    }

    /// Pause, resume, complete, archive or bring back.
    public func setStatus(_ id: UUID, _ next: GoalStatus) throws {
        let record = try goal(id)
        guard record.status != next.rawValue else { return }
        settleStatus(record, next: next)
        record.updatedAt = .now
        try settlePrimary()
        try sync.store(.make("goal.update", id: id, data: ["status": next.rawValue]))
        try finish()
    }

    public func makePrimary(_ id: UUID) throws {
        let record = try goal(id)
        guard GoalStatus(rawValue: record.status)?.isLive == true else { throw GoalError.notLive }
        guard !record.isPrimary else { return }
        for other in try liveGoals() where other.isPrimary {
            other.isPrimary = false
        }
        record.isPrimary = true
        try sync.store(.make("goal.update", id: id, data: ["isPrimary": true]))
        try finish()
    }

    /// Drag-and-drop priority: the first one is the most important.
    public func reorder(_ ids: [UUID]) throws {
        guard !ids.isEmpty else { return }
        let byId = Dictionary(try context.fetch(FetchDescriptor<GoalRecord>()).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (index, id) in ids.enumerated() {
            byId[id]?.priority = index
        }
        try settlePrimary()
        try sync.store(.make("goal.reorder", data: ["ids": ids]))
        try finish()
    }

    /// Only an empty goal; one with money is archived instead.
    public func delete(_ id: UUID) throws {
        let record = try goal(id)
        guard record.savedAmount <= 0 else { throw GoalError.hasMoney }
        let now = Date.now
        record.deletedAt = now
        record.isPrimary = false
        for contribution in try contributions(of: id) {
            contribution.deletedAt = now
        }
        try settlePrimary()
        try sync.store(.make("goal.delete", id: id))
        try finish()
    }

    public func draft(for record: GoalRecord) -> GoalDraft {
        GoalDraft(
            title: record.title, templateKey: record.templateKey, emoji: record.emoji, color: record.color,
            targetAmount: record.targetAmount, currency: record.currency,
            deadline: record.deadline.flatMap(date(fromKey:)), linkedAccountId: record.linkedAccountId
        )
    }

    // MARK: Contributions

    /// A deposit or withdrawal in the goal's currency; `accountId` is where the money comes from
    /// or goes to (none: not tracked on an account).
    @discardableResult
    public func contribute(
        to goalId: UUID, kind: ContributionKind, amount: Decimal, accountId: UUID?, note: String = ""
    ) throws -> ContributionOutcome {
        let goal = try goal(goalId)
        let amount = Self.rounded(amount, goal.currency)
        guard amount > 0 else { throw GoalError.invalidAmount }
        let status = GoalStatus(rawValue: goal.status) ?? .active
        if kind == .deposit, status == .completed { throw GoalError.goalCompleted }
        if kind == .deposit, status == .archived { throw GoalError.goalArchived }
        if kind == .withdrawal, amount > goal.savedAmount { throw GoalError.insufficientFunds }

        var accountAmount: Decimal?
        var accountCurrency: String?
        if let accountId {
            guard let account = try fetchAccount(accountId) else { throw GoalError.notFound }
            accountCurrency = account.currency
            accountAmount = account.currency == goal.currency
                ? amount
                : try converted(amount, from: goal.currency, to: account.currency)
        }

        let id = UUID()
        let contribution = ContributionRecord(
            id: id, goalId: goalId, type: kind.rawValue, amount: amount, currency: goal.currency,
            accountId: accountId, method: "manual", note: note.trimmedOrNil
        )
        contribution.accountAmount = accountAmount
        contribution.accountCurrency = accountCurrency
        context.insert(contribution)
        try moveMoney(goal: goal, kind: kind, amount: amount, accountId: accountId, accountAmount: accountAmount, sign: 1)

        goal.savedAmount += kind == .deposit ? amount : -amount
        goal.progress = GoalMath.progress(saved: goal.savedAmount, target: goal.targetAmount)
        var fresh: [Int] = []
        if kind == .deposit {
            fresh = GoalMath.reachedMilestones(goal.progress).filter { !goal.milestones.contains($0) }
            goal.milestones = (goal.milestones + fresh).sorted()
        }
        let completed = kind == .deposit && status.isLive && goal.savedAmount >= goal.targetAmount
        if completed {
            goal.status = GoalStatus.completed.rawValue
            goal.completedAt = .now
            try settlePrimary()
        }
        goal.updatedAt = .now

        let body = ContributionBody(
            id: id, type: kind.rawValue, amount: Self.text(amount), accountId: accountId,
            accountAmount: accountCurrency == goal.currency ? nil : accountAmount.map(Self.text),
            note: contribution.note
        )
        try sync.store(.make("goal.contribute", goalId: goalId, recordId: id, data: body))
        try finish()
        return ContributionOutcome(id: id, newMilestones: fresh, completed: completed)
    }

    /// Undo of a contribution: the money goes back where it came from.
    public func removeContribution(_ id: UUID) throws {
        guard let contribution = try context.fetch(FetchDescriptor<ContributionRecord>(predicate: #Predicate { $0.id == id })).first,
              contribution.deletedAt == nil
        else { throw GoalError.notFound }
        let goal = try goal(contribution.goalId)
        let kind = ContributionKind(rawValue: contribution.type) ?? .deposit
        if kind == .deposit, contribution.amount > goal.savedAmount { throw GoalError.insufficientFunds }

        try moveMoney(
            goal: goal, kind: kind, amount: contribution.amount, accountId: contribution.accountId,
            accountAmount: contribution.accountAmount, sign: -1
        )
        contribution.deletedAt = .now
        contribution.updatedAt = .now
        goal.savedAmount += kind == .deposit ? -contribution.amount : contribution.amount
        goal.progress = GoalMath.progress(saved: goal.savedAmount, target: goal.targetAmount)
        // Undoing the deposit that reached the target puts the goal back to work.
        if kind == .deposit, goal.status == GoalStatus.completed.rawValue, goal.savedAmount < goal.targetAmount {
            goal.status = GoalStatus.active.rawValue
            goal.completedAt = nil
            try settlePrimary()
        }
        goal.updatedAt = .now
        try sync.store(.make("goal.contribution.delete", id: id, goalId: goal.id))
        try finish()
    }

    /// The contribution plan of a goal with a deadline, worked out now.
    public func schedule(for record: GoalRecord, now: Date = .now) -> GoalSchedule? {
        GoalMath.schedule(
            target: record.targetAmount, saved: record.savedAmount, startedOn: record.createdAt,
            deadline: record.deadline.flatMap(date(fromKey:)), today: now,
            fractionDigits: Money.fractionDigits(for: record.currency), calendar: calendar
        )
    }

    // MARK: - Details

    private func finish() throws {
        try context.save()
        Task { await sync.sync() }
    }

    private func validate(_ draft: GoalDraft, currency: String? = nil, keepingDeadline: String? = nil) throws {
        guard !draft.trimmedTitle.isEmpty, draft.trimmedTitle.count <= 120 else { throw GoalError.invalidTitle }
        guard draft.targetAmount > 0 else { throw GoalError.invalidAmount }
        if let deadline = draft.deadline, dayKey(deadline) != keepingDeadline,
           calendar.startOfDay(for: deadline) < calendar.startOfDay(for: .now) {
            throw GoalError.deadlineInPast
        }
        if let linked = draft.linkedAccountId {
            guard let account = try fetchAccount(linked), !account.isArchived,
                  account.currency == (currency ?? draft.currency)
            else { throw GoalError.invalidLinkedAccount }
        }
    }

    /// Reaching the target completes a live goal; leaving or entering the archive stamps the dates.
    private func settleStatus(_ record: GoalRecord, next: GoalStatus) {
        let reaches = next.isLive && record.savedAmount >= record.targetAmount
        let status: GoalStatus = reaches ? .completed : next
        let previous = GoalStatus(rawValue: record.status) ?? .active
        if status == .completed, previous != .completed { record.completedAt = .now }
        if status.isLive { record.completedAt = nil }
        if status == .archived, previous != .archived { record.archivedAt = .now }
        if status != .archived { record.archivedAt = nil }
        record.status = status.rawValue
    }

    /// Exactly one primary goal among the live ones: a primary goal that is no longer live
    /// hands over to the next live one by priority.
    private func settlePrimary() throws {
        let goals = try context.fetch(FetchDescriptor<GoalRecord>(sortBy: [SortDescriptor(\.priority), SortDescriptor(\.createdAt)]))
        let live = goals.filter { $0.deletedAt == nil && GoalStatus(rawValue: $0.status)?.isLive == true }
        for goal in goals where goal.isPrimary && !live.contains(where: { $0.id == goal.id }) {
            goal.isPrimary = false
        }
        if !live.contains(where: \.isPrimary) {
            live.first?.isPrimary = true
        }
    }

    private func moveMoney(
        goal: GoalRecord, kind: ContributionKind, amount: Decimal, accountId: UUID?, accountAmount: Decimal?, sign: Decimal
    ) throws {
        let linked = goal.linkedAccountId
        if let accountId, accountId == linked { return } // The money already sits in the savings account.
        let flow: Decimal = kind == .deposit ? 1 : -1
        if let accountId, let accountAmount, let account = try fetchAccount(accountId) {
            account.currentBalance -= accountAmount * flow * sign
        }
        if let linked, let account = try fetchAccount(linked) {
            account.currentBalance += amount * flow * sign
        }
    }

    /// Goal currency to account currency through the base currency, at the rates of the latest operations.
    private func converted(_ amount: Decimal, from: String, to: String) throws -> Decimal {
        guard let fromRate = try rateToBase(from), let toRate = try rateToBase(to), toRate > 0 else {
            throw GoalError.rateUnavailable
        }
        return Self.rounded(amount * fromRate / toRate, to)
    }

    private func rateToBase(_ currency: String) throws -> Decimal? {
        var descriptor = FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.currency == currency },
            sortBy: [SortDescriptor(\.occurredAt, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        if let record = try context.fetch(descriptor).first {
            return record.fxRate
        }
        // A currency that operations are counted in is the base itself.
        var base = FetchDescriptor<TransactionRecord>(predicate: #Predicate { $0.baseCurrency == currency })
        base.fetchLimit = 1
        return try context.fetch(base).isEmpty ? nil : 1
    }

    private func liveGoals() throws -> [GoalRecord] {
        try context.fetch(FetchDescriptor<GoalRecord>(predicate: #Predicate { $0.deletedAt == nil }))
            .filter { GoalStatus(rawValue: $0.status)?.isLive == true }
    }

    private func goal(_ id: UUID) throws -> GoalRecord {
        guard let record = try context.fetch(FetchDescriptor<GoalRecord>(
            predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
        )).first else { throw GoalError.notFound }
        return record
    }

    private func contributions(of goalId: UUID) throws -> [ContributionRecord] {
        try context.fetch(FetchDescriptor<ContributionRecord>(predicate: #Predicate { $0.goalId == goalId && $0.deletedAt == nil }))
    }

    private func fetchAccount(_ id: UUID) throws -> AccountRecord? {
        try context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id && $0.deletedAt == nil })).first
    }

    /// `2027-06-01`, as goals store their deadline.
    func dayKey(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    public func date(fromKey key: String) -> Date? {
        let parts = key.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    nonisolated static func rounded(_ value: Decimal, _ currency: String) -> Decimal {
        BudgetMath.rounded(value, Money.fractionDigits(for: currency), .plain)
    }

    nonisolated static func text(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue
    }

    // MARK: - Bodies

    /// `POST /v1/goals`
    private struct GoalCreateBody: Encodable, Sendable {
        let id: UUID
        let title: String
        let templateKey: String?
        let emoji: String
        let color: String
        let targetAmount: String
        let currency: String
        let deadline: String?
        let linkedAccountId: UUID?

        init(_ record: GoalRecord) {
            id = record.id
            title = record.title
            templateKey = record.templateKey
            emoji = record.emoji
            color = record.color
            targetAmount = GoalBook.text(record.targetAmount)
            currency = record.currency
            deadline = record.deadline
            linkedAccountId = record.linkedAccountId
        }
    }

    /// `PATCH /v1/goals/:id` with every field the editor shows; null clears the deadline or the account.
    private struct GoalUpdateBody: Encodable, Sendable {
        let title: String
        let emoji: String
        let color: String
        let targetAmount: String
        let deadline: String?
        let linkedAccountId: UUID?

        init(_ record: GoalRecord) {
            title = record.title
            emoji = record.emoji
            color = record.color
            targetAmount = GoalBook.text(record.targetAmount)
            deadline = record.deadline
            linkedAccountId = record.linkedAccountId
        }

        enum CodingKeys: String, CodingKey {
            case title, emoji, color, targetAmount, deadline, linkedAccountId
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(title, forKey: .title)
            try container.encode(emoji, forKey: .emoji)
            try container.encode(color, forKey: .color)
            try container.encode(targetAmount, forKey: .targetAmount)
            try container.encode(deadline, forKey: .deadline)
            try container.encode(linkedAccountId, forKey: .linkedAccountId)
        }
    }

    /// `POST /v1/goals/:id/contributions`
    private struct ContributionBody: Encodable, Sendable {
        let id: UUID
        let type: String
        let amount: String
        let accountId: UUID?
        let accountAmount: String?
        let note: String?
    }
}

private extension String {
    var trimmedOrNil: String? {
        let text = trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
