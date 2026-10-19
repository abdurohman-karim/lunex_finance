import Foundation
import Observation

/// Why the amount is what it is (the server's `SmartSaveExplanation`); money in the base
/// currency unless said otherwise.
public struct SmartSaveExplanation: Codable, Equatable, Sendable {
    public let baseCurrency: String
    public let monthIncome: Decimal
    public let monthExpenses: Decimal
    public let savedToGoals: Decimal
    public let upcomingRecurring: Decimal
    public let freeMoney: Decimal
    public let daysLeft: Int
    public let perDay: Decimal
    public let sharePercent: Int
    public let goalCurrency: String?
    /// Goal-currency units per base unit, when the currencies differ
    public let rate: Decimal?
    /// In the goal currency
    public let goalRemaining: Decimal?
    public let accountId: UUID?
    /// In the goal currency
    public let accountBalance: Decimal?
    /// goal_remaining or account_balance
    public let cappedBy: String?

    public init(
        baseCurrency: String, monthIncome: Decimal = 0, monthExpenses: Decimal = 0, savedToGoals: Decimal = 0,
        upcomingRecurring: Decimal = 0, freeMoney: Decimal = 0, daysLeft: Int = 1, perDay: Decimal = 0,
        sharePercent: Int = 50, goalCurrency: String? = nil, rate: Decimal? = nil, goalRemaining: Decimal? = nil,
        accountId: UUID? = nil, accountBalance: Decimal? = nil, cappedBy: String? = nil
    ) {
        self.baseCurrency = baseCurrency
        self.monthIncome = monthIncome
        self.monthExpenses = monthExpenses
        self.savedToGoals = savedToGoals
        self.upcomingRecurring = upcomingRecurring
        self.freeMoney = freeMoney
        self.daysLeft = daysLeft
        self.perDay = perDay
        self.sharePercent = sharePercent
        self.goalCurrency = goalCurrency
        self.rate = rate
        self.goalRemaining = goalRemaining
        self.accountId = accountId
        self.accountBalance = accountBalance
        self.cappedBy = cappedBy
    }

    enum CodingKeys: String, CodingKey {
        case baseCurrency, monthIncome, monthExpenses, savedToGoals, upcomingRecurring, freeMoney
        case daysLeft, perDay, sharePercent, goalCurrency, rate, goalRemaining, accountId, accountBalance, cappedBy
    }

    // Money travels as decimal strings.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let amount = { (key: CodingKeys) throws -> Decimal in money(try c.decode(String.self, forKey: key)) }
        let optional = { (key: CodingKeys) throws -> Decimal? in money(try c.decodeIfPresent(String.self, forKey: key)) }
        baseCurrency = try c.decode(String.self, forKey: .baseCurrency)
        monthIncome = try amount(.monthIncome)
        monthExpenses = try amount(.monthExpenses)
        savedToGoals = try amount(.savedToGoals)
        upcomingRecurring = try amount(.upcomingRecurring)
        freeMoney = try amount(.freeMoney)
        daysLeft = try c.decode(Int.self, forKey: .daysLeft)
        perDay = try amount(.perDay)
        sharePercent = try c.decode(Int.self, forKey: .sharePercent)
        goalCurrency = try c.decodeIfPresent(String.self, forKey: .goalCurrency)
        rate = try optional(.rate)
        goalRemaining = try optional(.goalRemaining)
        accountId = try c.decodeIfPresent(UUID.self, forKey: .accountId)
        accountBalance = try optional(.accountBalance)
        cappedBy = try c.decodeIfPresent(String.self, forKey: .cappedBy)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let text = { (value: Decimal) in NSDecimalNumber(decimal: value).stringValue }
        try c.encode(baseCurrency, forKey: .baseCurrency)
        try c.encode(text(monthIncome), forKey: .monthIncome)
        try c.encode(text(monthExpenses), forKey: .monthExpenses)
        try c.encode(text(savedToGoals), forKey: .savedToGoals)
        try c.encode(text(upcomingRecurring), forKey: .upcomingRecurring)
        try c.encode(text(freeMoney), forKey: .freeMoney)
        try c.encode(daysLeft, forKey: .daysLeft)
        try c.encode(text(perDay), forKey: .perDay)
        try c.encode(sharePercent, forKey: .sharePercent)
        try c.encodeIfPresent(goalCurrency, forKey: .goalCurrency)
        try c.encodeIfPresent(rate.map(text), forKey: .rate)
        try c.encodeIfPresent(goalRemaining.map(text), forKey: .goalRemaining)
        try c.encodeIfPresent(accountId, forKey: .accountId)
        try c.encodeIfPresent(accountBalance.map(text), forKey: .accountBalance)
        try c.encodeIfPresent(cappedBy, forKey: .cappedBy)
    }
}

/// Today's suggestion for one goal.
public struct SmartSaveSuggestion: Codable, Equatable, Sendable, Identifiable {
    public struct Goal: Codable, Equatable, Sendable {
        public let id: UUID
        public let title: String
        public let emoji: String
    }

    public let id: UUID
    public let forDate: String
    /// pending, accepted, declined, expired
    public let status: String
    public let goal: Goal
    /// In the goal's currency
    public let amount: Decimal
    public let currency: String
    public let amountBase: Decimal
    public let acceptedAmount: Decimal?
    public let expiresAt: Date
    public let explanation: SmartSaveExplanation

    public init(
        id: UUID, forDate: String, status: String = "pending", goal: Goal, amount: Decimal, currency: String,
        amountBase: Decimal, acceptedAmount: Decimal? = nil, expiresAt: Date, explanation: SmartSaveExplanation
    ) {
        self.id = id
        self.forDate = forDate
        self.status = status
        self.goal = goal
        self.amount = amount
        self.currency = currency
        self.amountBase = amountBase
        self.acceptedAmount = acceptedAmount
        self.expiresAt = expiresAt
        self.explanation = explanation
    }

    enum CodingKeys: String, CodingKey {
        case id, forDate, status, goal, amount, currency, amountBase, acceptedAmount, expiresAt, explanation
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        forDate = try c.decode(String.self, forKey: .forDate)
        status = try c.decode(String.self, forKey: .status)
        goal = try c.decode(Goal.self, forKey: .goal)
        amount = money(try c.decode(String.self, forKey: .amount))
        currency = try c.decode(String.self, forKey: .currency)
        amountBase = money(try c.decode(String.self, forKey: .amountBase))
        acceptedAmount = money(try c.decodeIfPresent(String.self, forKey: .acceptedAmount))
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        explanation = try c.decode(SmartSaveExplanation.self, forKey: .explanation)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let text = { (value: Decimal) in NSDecimalNumber(decimal: value).stringValue }
        try c.encode(id, forKey: .id)
        try c.encode(forDate, forKey: .forDate)
        try c.encode(status, forKey: .status)
        try c.encode(goal, forKey: .goal)
        try c.encode(text(amount), forKey: .amount)
        try c.encode(currency, forKey: .currency)
        try c.encode(text(amountBase), forKey: .amountBase)
        try c.encodeIfPresent(acceptedAmount.map(text), forKey: .acceptedAmount)
        try c.encode(expiresAt, forKey: .expiresAt)
        try c.encode(explanation, forKey: .explanation)
    }

    /// The goal currency differs from the base one: show both amounts.
    public var isForeign: Bool { currency != explanation.baseCurrency }
}

/// `GET /v1/smart-save/today`
public struct SmartSaveToday: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case available
        case alreadySaved = "already_saved"
        case declined
        case noGoal = "no_goal"
        case noSpareMoney = "no_spare_money"
        case tooSmall = "too_small"
        case insufficientBalance = "insufficient_balance"
        case exchangeRateUnavailable = "exchange_rate_unavailable"
    }

    public let status: Status
    public let suggestion: SmartSaveSuggestion?
    public let explanation: SmartSaveExplanation?

    public init(status: Status, suggestion: SmartSaveSuggestion? = nil, explanation: SmartSaveExplanation? = nil) {
        self.status = status
        self.suggestion = suggestion
        self.explanation = explanation
    }
}

/// Rounding step and minimum of Smart Save per currency (the server's `currencies` seed).
public enum SmartSaveSteps {
    public static func step(for currency: String) -> Decimal {
        switch currency {
        case "UZS": 1000
        case "KZT": 500
        case "RUB": 100
        default: 1
        }
    }

    /// Amounts the slider offers: from the minimum up to the suggestion, by the currency's step.
    public static func range(upTo amount: Decimal, currency: String) -> ClosedRange<Double> {
        let step = NSDecimalNumber(decimal: self.step(for: currency)).doubleValue
        let top = NSDecimalNumber(decimal: amount).doubleValue
        return min(step, top)...max(step, top)
    }
}

/// What «Отложить» led to.
public enum SmartSaveOutcome: Equatable, Sendable {
    /// Saved: milestones reached, and whether the goal is now reached
    case saved(amount: Decimal, newMilestones: [Int], completed: Bool)
    /// The safe amount dropped since the card was shown: nothing was taken; here is the new one
    case amountChanged(SmartSaveSuggestion)
    /// The goal changed (another one became primary): nothing was taken; here is the new suggestion
    case suggestionChanged(SmartSaveSuggestion)
    /// No longer possible today (no spare money, already saved, expired…): the fresh state
    case unavailable(SmartSaveToday)
}

// MARK: - Store

/// Today's Smart Save from the server. The last answer is kept for the day so the card shows
/// at once on launch and offline; accepting needs a connection, as the server recalculates.
@MainActor
@Observable
public final class SmartSaveStore {
    public private(set) var today: SmartSaveToday?
    public private(set) var isLoading = false
    public private(set) var lastError: APIError?

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let sync: SyncEngine?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let calendar: Calendar
    private static let key = "lunex.smartSave"

    private struct Cached: Codable {
        let day: String
        let today: SmartSaveToday
    }

    public init(api: APIClient, sync: SyncEngine?, defaults: UserDefaults = .standard, calendar: Calendar = .current) {
        self.api = api
        self.sync = sync
        self.defaults = defaults
        self.calendar = calendar
        if let data = defaults.data(forKey: Self.key),
           let cached = try? LunexJSON.decoder().decode(Cached.self, from: data),
           cached.day == Self.dayKey(.now, calendar: calendar) {
            today = cached.today
        }
    }

    /// Fetches today's card; keeps the cached one when offline.
    public func refresh() async {
        isLoading = true
        defer { isLoading = false }
        do {
            keep(try await api.send(API.smartSaveToday()))
            lastError = nil
        } catch let error as APIError {
            if Task.isCancelled { return }
            lastError = error
        } catch {
            lastError = APIError(status: 0, code: "smart_save_failed", message: String(describing: error))
        }
    }

    /// «Отложить», optionally a lower amount. The server recalculates; a lower safe amount
    /// takes nothing and comes back as `amountChanged`.
    public func accept(_ suggestion: SmartSaveSuggestion, amount: Decimal? = nil) async throws -> SmartSaveOutcome {
        let body = AcceptBody(amount: amount.map { NSDecimalNumber(decimal: $0).stringValue })
        do {
            let result = try await api.send(API.smartSaveAccept(suggestion.id, body))
            keep(SmartSaveToday(status: .alreadySaved, suggestion: result.suggestion))
            // The contribution and the account balances come with the next download.
            if let sync { Task { await sync.sync() } }
            return .saved(
                amount: result.suggestion.acceptedAmount ?? amount ?? suggestion.amount,
                newMilestones: result.newMilestones,
                completed: result.completed
            )
        } catch let error as APIError where error.status == 409 {
            switch error.code {
            case "amount_changed":
                guard let fresh = error.detail("suggestion", as: SmartSaveSuggestion.self) else { throw error }
                keep(SmartSaveToday(status: .available, suggestion: fresh))
                return .amountChanged(fresh)
            case "suggestion_changed":
                guard let fresh = error.detail("suggestion", as: SmartSaveSuggestion.self) else { throw error }
                keep(SmartSaveToday(status: .available, suggestion: fresh))
                return .suggestionChanged(fresh)
            default:
                await refresh()
                if let today { return .unavailable(today) }
                throw error
            }
        }
    }

    /// «Не сегодня»
    public func decline(_ suggestion: SmartSaveSuggestion) async throws {
        let declined = try await api.send(API.smartSaveDecline(suggestion.id))
        keep(SmartSaveToday(status: .declined, suggestion: declined))
    }

    /// Signed out: another account must not see this one's card.
    public func reset() {
        today = nil
        lastError = nil
        defaults.removeObject(forKey: Self.key)
    }

    private func keep(_ value: SmartSaveToday) {
        today = value
        let cached = Cached(day: Self.dayKey(.now, calendar: calendar), today: value)
        defaults.set(try? LunexJSON.encoder().encode(cached), forKey: Self.key)
    }

    static func dayKey(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    struct AcceptBody: Encodable, Sendable {
        let amount: String?
    }
}

/// `POST /v1/smart-save/:id/accept`, the parts the app uses.
struct SmartSaveAcceptResult: Decodable, Sendable {
    let newMilestones: [Int]
    let completed: Bool
    let suggestion: SmartSaveSuggestion
}

extension API {
    static func smartSaveToday() -> Endpoint<SmartSaveToday> {
        .get("smart-save/today")
    }

    static func smartSaveAccept(_ id: UUID, _ body: SmartSaveStore.AcceptBody) -> Endpoint<SmartSaveAcceptResult> {
        .send("POST", "smart-save/\(id.uuidString.lowercased())/accept", body)
    }

    static func smartSaveDecline(_ id: UUID) -> Endpoint<SmartSaveSuggestion> {
        .send("POST", "smart-save/\(id.uuidString.lowercased())/decline", [String: String]())
    }
}

extension BudgetMonth {
    /// The daily limit once `amountBase` more is set aside for goals: saving reserves money
    /// for the rest of the month (the «Дневной лимит после этого» line of the card).
    public func dailyLimit(afterSaving amountBase: Decimal) -> Decimal {
        let reserved = figures.reservedForSavings
        let newReserved = max(reserved, savedToGoals + amountBase)
        let available = figures.available - (newReserved - reserved)
        let days = Decimal(max(1, daysLeft))
        var daily = available / days
        if let totalLimit {
            let beforeToday = expensesTotal - expensesToday
            daily = min(daily, (totalLimit - beforeToday - upcomingRecurring) / days)
        }
        return BudgetMath.rounded(max(0, daily), Money.fractionDigits(for: currency), .down)
    }
}
