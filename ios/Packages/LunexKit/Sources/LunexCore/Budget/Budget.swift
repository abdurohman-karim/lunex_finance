import Foundation
import Observation

public enum BudgetState: String, Sendable, Codable {
    /// No income yet (nor an estimate): nothing to divide
    case noIncome = "no_income"
    case ok
    /// Today's spending is over the daily limit
    case overspent
}

/// Everything in the base currency, for the current budget month.
public struct BudgetInputs: Sendable {
    public var incomeActual: Decimal = 0
    /// The budget's planned income, or the estimate from onboarding; nil when unknown
    public var incomePlanned: Decimal?
    public var expensesBeforeToday: Decimal = 0
    public var expensesToday: Decimal = 0
    /// Net goal contributions this month (deposits − withdrawals)
    public var savedToGoals: Decimal = 0
    public var savingsTarget: Decimal = 0
    public var rollover: Decimal = 0
    /// Recurring expenses still to come from today to the end of the month
    public var upcomingRecurring: Decimal = 0
    public var totalLimit: Decimal?
    /// Days left in the month, today included (≥ 1)
    public var daysLeft = 1
    public var fractionDigits = 0

    public init() {}
}

public struct BudgetFigures: Equatable, Sendable {
    public let incomeBasis: Decimal
    public let reservedForSavings: Decimal
    /// Left for the rest of the month, today included
    public let available: Decimal
    public let dailyLimit: Decimal
    /// Negative when today's spending is over the daily limit
    public let safeToSpendToday: Decimal
    public let state: BudgetState
}

/// The spec's «Бизнес-правила», as the server's `budget-math.ts` computes them:
/// available = max(planned, actual income) + rollover − savings − expenses before today − upcoming recurring;
/// daily limit = available ÷ days left (the smaller one when a total limit is set), rounded down;
/// safe to spend today = daily limit − today's expenses.
public enum BudgetMath {
    public static func compute(_ inputs: BudgetInputs) -> BudgetFigures {
        let days = Decimal(max(1, inputs.daysLeft))
        let incomeBasis = max(inputs.incomeActual, inputs.incomePlanned ?? 0)
        // A savings target reserves its amount up front; saving more than planned reserves what was saved.
        let reserved = max(inputs.savingsTarget, inputs.savedToGoals)
        let available = incomeBasis + inputs.rollover - reserved - inputs.expensesBeforeToday - inputs.upcomingRecurring

        var daily = available / days
        if let limit = inputs.totalLimit {
            daily = min(daily, (limit - inputs.expensesBeforeToday - inputs.upcomingRecurring) / days)
        }
        // Rounded down: the app never suggests spending money the user does not have.
        let dailyLimit = rounded(max(0, daily), inputs.fractionDigits, .down)
        let safe = dailyLimit - inputs.expensesToday

        let hasMoney = incomeBasis + inputs.rollover > 0 || inputs.totalLimit != nil
        return BudgetFigures(
            incomeBasis: incomeBasis,
            reservedForSavings: reserved,
            available: available,
            dailyLimit: dailyLimit,
            safeToSpendToday: safe,
            state: !hasMoney ? .noIncome : safe < 0 ? .overspent : .ok
        )
    }

    static func rounded(_ value: Decimal, _ digits: Int, _ mode: NSDecimalNumber.RoundingMode) -> Decimal {
        var value = value
        var result = Decimal()
        NSDecimalRound(&result, &value, digits, mode)
        return result
    }
}

/// The budget month: it starts on payday (`month_starts_on_day`); in shorter months payday moves
/// to the last day.
public struct BudgetPeriod: Equatable, Sendable {
    /// Start of the first day
    public let start: Date
    /// Start of the last day (inclusive)
    public let end: Date

    public static func containing(_ date: Date, startDay: Int, calendar: Calendar) -> BudgetPeriod {
        let today = calendar.startOfDay(for: date)
        let parts = calendar.dateComponents([.year, .month], from: today)
        let thisMonth = payday(year: parts.year!, month: parts.month!, day: startDay, calendar: calendar)
        let start = today >= thisMonth
            ? thisMonth
            : payday(year: parts.year!, month: parts.month! - 1, day: startDay, calendar: calendar)
        let startParts = calendar.dateComponents([.year, .month], from: start)
        let next = payday(year: startParts.year!, month: startParts.month! + 1, day: startDay, calendar: calendar)
        return BudgetPeriod(start: start, end: calendar.date(byAdding: .day, value: -1, to: next)!)
    }

    /// `day` of that month, or its last day when the month is shorter.
    private static func payday(year: Int, month: Int, day: Int, calendar: Calendar) -> Date {
        let first = calendar.date(from: DateComponents(year: year, month: month, day: 1))!
        let length = calendar.range(of: .day, in: .month, for: first)!.count
        return calendar.date(byAdding: .day, value: min(max(day, 1), length) - 1, to: first)!
    }

    public func days(calendar: Calendar) -> Int {
        (calendar.dateComponents([.day], from: start, to: end).day ?? 0) + 1
    }

    /// Days from `date` to the end, that day included.
    public func daysLeft(from date: Date, calendar: Calendar) -> Int {
        (calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: end).day ?? 0) + 1
    }

    /// The day after the last one: the upper bound of the month's operations.
    public func nextStart(calendar: Calendar) -> Date {
        calendar.date(byAdding: .day, value: 1, to: end)!
    }

    /// `2026-10-01`, as the server names a budget month.
    public func startKey(calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: start)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
}

/// What the device does not hold and the server does: the month's plan (planned income or the
/// onboarding estimate, savings target, rollover, total limit) and recurring payments still to
/// come. Fetched with `GET /v1/budget/current` and kept for offline use.
public struct BudgetPlan: Codable, Equatable, Sendable {
    public let periodStart: String
    public let currency: String
    /// auto or planned
    public let mode: String
    public let incomePlanned: Decimal?
    public let savingsTarget: Decimal
    public let rollover: Decimal
    public let upcomingRecurring: Decimal
    public let totalLimit: Decimal?
    /// The server's own figure, to compare against
    public let safeToSpendToday: Decimal
    public let fetchedAt: Date

    public init(
        periodStart: String, currency: String, mode: String = "auto", incomePlanned: Decimal? = nil,
        savingsTarget: Decimal = 0, rollover: Decimal = 0, upcomingRecurring: Decimal = 0,
        totalLimit: Decimal? = nil, safeToSpendToday: Decimal = 0, fetchedAt: Date = .now
    ) {
        self.periodStart = periodStart
        self.currency = currency
        self.mode = mode
        self.incomePlanned = incomePlanned
        self.savingsTarget = savingsTarget
        self.rollover = rollover
        self.upcomingRecurring = upcomingRecurring
        self.totalLimit = totalLimit
        self.safeToSpendToday = safeToSpendToday
        self.fetchedAt = fetchedAt
    }
}

/// One category's spending this month (nil id: no category).
public struct CategorySpend: Equatable, Sendable, Identifiable {
    public let categoryId: UUID?
    public let amount: Decimal
    public var id: String { categoryId?.uuidString ?? "none" }
}

/// The current budget month worked out on the device from its own operations, so the figures
/// change the moment an operation is saved, online or not.
public struct BudgetMonth: Equatable, Sendable {
    public let period: BudgetPeriod
    public let daysTotal: Int
    /// Today included
    public let daysLeft: Int
    public let currency: String
    public let mode: String
    public let incomeActual: Decimal
    public let incomePlanned: Decimal?
    public let expensesTotal: Decimal
    public let expensesToday: Decimal
    public let savedToGoals: Decimal
    public let upcomingRecurring: Decimal
    public let totalLimit: Decimal?
    public let figures: BudgetFigures
    /// Largest first
    public let byCategory: [CategorySpend]
    /// Spending by the end of the month at this month's pace, recurring payments included
    public let forecast: Decimal
    /// Some amounts had no rate to the base currency and were left out
    public let incomplete: Bool

    /// What the month's spending is measured against: the total limit, else the income basis.
    public var plannedSpending: Decimal? {
        if let totalLimit { return totalLimit }
        let basis = figures.incomeBasis - figures.reservedForSavings
        return basis > 0 ? basis : nil
    }

    /// Share of today's daily limit still free, 0…1.
    public var todayLeftShare: Double {
        guard figures.dailyLimit > 0 else { return 0 }
        let share = NSDecimalNumber(decimal: figures.safeToSpendToday / figures.dailyLimit).doubleValue
        return min(max(share, 0), 1)
    }
}

public enum BudgetCalculator {
    public static func month(
        transactions: [TransactionRecord],
        contributions: [ContributionRecord],
        baseCurrency: String,
        monthStartsOnDay: Int,
        incomeEstimate: Decimal?,
        plan: BudgetPlan?,
        now: Date = .now,
        calendar: Calendar = .current
    ) -> BudgetMonth {
        let period = BudgetPeriod.containing(now, startDay: monthStartsOnDay, calendar: calendar)
        let monthEnd = period.nextStart(calendar: calendar)
        let today = calendar.startOfDay(for: now)
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!
        let daysTotal = period.days(calendar: calendar)
        let daysLeft = period.daysLeft(from: now, calendar: calendar)
        let digits = Money.fractionDigits(for: baseCurrency)
        // A plan is for one month in one currency; another month or currency falls back to the estimate.
        let plan = plan.flatMap { $0.periodStart == period.startKey(calendar: calendar) && $0.currency == baseCurrency ? $0 : nil }

        var incomplete = false
        var income: Decimal = 0
        var beforeToday: Decimal = 0
        var todaySpent: Decimal = 0
        var categories: [UUID?: Decimal] = [:]
        var rates: [String: (date: Date, rate: Decimal)] = [:]
        for record in transactions where record.deletedAt == nil {
            if record.baseCurrency == baseCurrency, record.currency != baseCurrency,
               rates[record.currency].map({ $0.date < record.occurredAt }) ?? true {
                rates[record.currency] = (record.occurredAt, record.fxRate)
            }
            guard record.occurredAt >= period.start, record.occurredAt < monthEnd else { continue }
            guard record.type == "income" || record.type == "expense" else { continue }
            guard record.baseCurrency == baseCurrency else {
                // Saved before the base currency changed; the next sync brings it recalculated.
                incomplete = true
                continue
            }
            if record.type == "income" {
                income += record.amountBase
            } else if record.occurredAt < today {
                beforeToday += record.amountBase
                categories[record.categoryId, default: 0] += record.amountBase
            } else if record.occurredAt < tomorrow {
                todaySpent += record.amountBase
                categories[record.categoryId, default: 0] += record.amountBase
            }
        }

        var saved: Decimal = 0
        for contribution in contributions where contribution.deletedAt == nil {
            guard contribution.createdAt >= period.start, contribution.createdAt < monthEnd else { continue }
            let value: Decimal
            if contribution.currency == baseCurrency {
                value = contribution.amount
            } else if contribution.accountCurrency == baseCurrency, let amount = contribution.accountAmount {
                value = amount
            } else if let rate = rates[contribution.currency]?.rate {
                value = contribution.amount * rate
            } else {
                incomplete = true
                continue
            }
            saved += contribution.type == "withdrawal" ? -value : value
        }

        var inputs = BudgetInputs()
        inputs.incomeActual = income
        inputs.incomePlanned = plan?.incomePlanned ?? incomeEstimate
        inputs.expensesBeforeToday = beforeToday
        inputs.expensesToday = todaySpent
        inputs.savedToGoals = saved
        inputs.savingsTarget = plan?.savingsTarget ?? 0
        inputs.rollover = plan?.rollover ?? 0
        inputs.upcomingRecurring = plan?.upcomingRecurring ?? 0
        inputs.totalLimit = plan?.totalLimit
        inputs.daysLeft = daysLeft
        inputs.fractionDigits = digits
        let figures = BudgetMath.compute(inputs)

        let spent = beforeToday + todaySpent
        let elapsed = Decimal(max(1, daysTotal - daysLeft + 1))
        let forecast = BudgetMath.rounded(spent / elapsed * Decimal(daysTotal) + inputs.upcomingRecurring, digits, .plain)

        return BudgetMonth(
            period: period,
            daysTotal: daysTotal,
            daysLeft: daysLeft,
            currency: baseCurrency,
            mode: plan?.mode ?? "auto",
            incomeActual: income,
            incomePlanned: inputs.incomePlanned,
            expensesTotal: spent,
            expensesToday: todaySpent,
            savedToGoals: saved,
            upcomingRecurring: inputs.upcomingRecurring,
            totalLimit: inputs.totalLimit,
            figures: figures,
            byCategory: categories.map { CategorySpend(categoryId: $0.key, amount: $0.value) }
                .filter { $0.amount != 0 }
                .sorted { $0.amount > $1.amount },
            forecast: forecast,
            incomplete: incomplete
        )
    }
}

// MARK: - Plan from the server

/// Keeps the month's plan from the server, for the device's own calculation; the last one
/// fetched stays for offline launches.
@MainActor
@Observable
public final class BudgetPlans {
    public private(set) var plan: BudgetPlan?
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let defaults: UserDefaults
    private static let key = "lunex.budgetPlan"

    public init(api: APIClient, defaults: UserDefaults = .standard) {
        self.api = api
        self.defaults = defaults
        plan = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(BudgetPlan.self, from: $0) }
    }

    /// Quietly keeps the cached plan when offline or refused.
    public func refresh() async {
        guard let summary = try? await api.send(API.budgetCurrent()) else { return }
        let fresh = summary.plan
        plan = fresh
        defaults.set(try? JSONEncoder().encode(fresh), forKey: Self.key)
    }

    /// Signed out: another account must not see this one's plan.
    public func reset() {
        plan = nil
        defaults.removeObject(forKey: Self.key)
    }
}

/// `GET /v1/budget/current`, the parts the device uses.
struct BudgetSummaryDTO: Decodable, Sendable {
    struct Period: Decodable, Sendable {
        let start: String
    }

    struct Income: Decodable, Sendable {
        let planned: String?
    }

    let period: Period
    let currency: String
    let mode: String
    let income: Income
    let savingsTarget: String
    let rollover: String
    let upcomingRecurring: String
    let totalLimit: String?
    let safeToSpendToday: String

    var plan: BudgetPlan {
        BudgetPlan(
            periodStart: period.start, currency: currency, mode: mode,
            incomePlanned: money(income.planned), savingsTarget: money(savingsTarget),
            rollover: money(rollover), upcomingRecurring: money(upcomingRecurring),
            totalLimit: money(totalLimit), safeToSpendToday: money(safeToSpendToday)
        )
    }
}

extension API {
    static func budgetCurrent() -> Endpoint<BudgetSummaryDTO> {
        .get("budget/current")
    }
}
