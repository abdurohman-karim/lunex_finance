import Foundation
@testable import LunexCore
import Testing

/// The same cases as the server's `budget-math.spec.ts`: both sides must give the same figures.
@Suite("Budget formula")
struct BudgetMathTests {
    private func figures(_ change: (inout BudgetInputs) -> Void) -> BudgetFigures {
        var inputs = BudgetInputs()
        inputs.daysLeft = 13
        change(&inputs)
        return BudgetMath.compute(inputs)
    }

    @Test("spreads what is left over the remaining days and subtracts today")
    func spread() {
        let result = figures {
            $0.incomeActual = 6_000_000
            $0.expensesBeforeToday = 1_200_000
            $0.upcomingRecurring = 1_500_000
            $0.expensesToday = 50_000
        }
        #expect(result.available == 3_300_000)
        #expect(result.dailyLimit == 253_846)
        #expect(result.safeToSpendToday == 203_846)
        #expect(result.state == .ok)
    }

    @Test("uses the larger of planned and actual income")
    func income() {
        #expect(figures { $0.incomePlanned = 4_000_000; $0.incomeActual = 1_000_000 }.available == 4_000_000)
        #expect(figures { $0.incomePlanned = 4_000_000; $0.incomeActual = 5_000_000 }.available == 5_000_000)
    }

    @Test("reserves the savings target, or more if more was saved; adds the rollover")
    func savingsAndRollover() {
        #expect(figures { $0.incomeActual = 1_000_000; $0.savingsTarget = 200_000 }.available == 800_000)
        #expect(figures { $0.incomeActual = 1_000_000; $0.savingsTarget = 200_000; $0.savedToGoals = 300_000 }.available == 700_000)
        #expect(figures { $0.incomeActual = 1_000_000; $0.rollover = 130_000 }.available == 1_130_000)
    }

    @Test("takes the stricter of income and the total limit")
    func totalLimit() {
        let result = figures {
            $0.incomeActual = 10_000_000
            $0.totalLimit = 2_600_000
            $0.expensesBeforeToday = 1_300_000
        }
        #expect(result.dailyLimit == 100_000)
    }

    @Test("never suggests a negative daily limit, and reports overspending today")
    func overspent() {
        let result = figures {
            $0.incomeActual = 100_000
            $0.expensesBeforeToday = 500_000
            $0.expensesToday = 20_000
        }
        #expect(result.available == -400_000 && result.dailyLimit == 0)
        #expect(result.safeToSpendToday == -20_000 && result.state == .overspent)
    }

    @Test("rounds down to the currency precision; the last day counts as a full day")
    func rounding() {
        #expect(figures { $0.incomeActual = 100; $0.daysLeft = 3; $0.fractionDigits = 2 }.dailyLimit == Decimal(string: "33.33")!)
        #expect(figures { $0.incomeActual = 90_000; $0.daysLeft = 1 }.dailyLimit == 90_000)
    }

    @Test("asks for income when there is none yet")
    func noIncome() {
        #expect(figures { _ in }.state == .noIncome)
        #expect(figures { $0.totalLimit = 1_000_000 }.state == .ok)
    }
}

@Suite("Budget month")
struct BudgetMonthTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return calendar
    }()

    private func date(_ text: String) -> Date {
        let parts = text.split(separator: "-").map { Int($0)! }
        let hour = parts.count > 3 ? parts[3] : 12
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: hour))!
    }

    private func key(_ period: BudgetPeriod) -> String {
        period.startKey(calendar: calendar) + "…" + BudgetPeriod(start: period.end, end: period.end).startKey(calendar: calendar)
    }

    @Test("the month starts on payday; a payday past the month's end moves to its last day")
    func periods() {
        #expect(key(.containing(date("2026-10-19"), startDay: 1, calendar: calendar)) == "2026-10-01…2026-10-31")
        #expect(key(.containing(date("2026-10-19"), startDay: 25, calendar: calendar)) == "2026-09-25…2026-10-24")
        #expect(key(.containing(date("2026-10-25"), startDay: 25, calendar: calendar)) == "2026-10-25…2026-11-24")
        #expect(key(.containing(date("2027-02-28"), startDay: 31, calendar: calendar)) == "2027-02-28…2027-03-30")
        #expect(key(.containing(date("2027-01-10"), startDay: 31, calendar: calendar)) == "2026-12-31…2027-01-30")

        let october = BudgetPeriod.containing(date("2026-10-19"), startDay: 1, calendar: calendar)
        #expect(october.days(calendar: calendar) == 31)
        #expect(october.daysLeft(from: date("2026-10-19"), calendar: calendar) == 13)
    }

    private func operation(_ type: String, _ amount: Decimal, _ when: String, category: UUID? = nil, deleted: Bool = false) -> TransactionRecord {
        TransactionRecord(
            id: UUID(), type: type, accountId: UUID(), amount: amount, currency: "UZS",
            amountBase: amount, baseCurrency: "UZS", categoryId: category, occurredAt: date(when),
            deletedAt: deleted ? .now : nil
        )
    }

    @Test("adds up the month's operations around today and spreads the rest")
    func month() {
        let cafe = UUID()
        let market = UUID()
        let transactions = [
            operation("income", 6_000_000, "2026-10-05"),
            operation("expense", 700_000, "2026-10-10", category: market),
            operation("expense", 500_000, "2026-10-18", category: cafe),
            operation("expense", 50_000, "2026-10-19-09", category: cafe),
            operation("expense", 999_000, "2026-10-19-10", deleted: true),
            operation("expense", 300_000, "2026-09-30"),
            operation("transfer", 200_000, "2026-10-12"),
            // A dollar purchase gives the rate for a goal in dollars.
            TransactionRecord(
                id: UUID(), type: "expense", accountId: UUID(), amount: 1, currency: "USD", amountBase: 12_700,
                baseCurrency: "UZS", fxRate: 12_700, occurredAt: date("2026-09-20")
            ),
        ]
        let contribution = ContributionRecord(
            id: UUID(), goalId: UUID(), type: "deposit", amount: 10, currency: "USD", method: "manual", createdAt: date("2026-10-11")
        )
        let plan = BudgetPlan(periodStart: "2026-10-01", currency: "UZS", upcomingRecurring: 1_500_000)

        let month = BudgetCalculator.month(
            transactions: transactions, contributions: [contribution], baseCurrency: "UZS",
            monthStartsOnDay: 1, incomeEstimate: 4_000_000, plan: plan, now: date("2026-10-19-15"), calendar: calendar
        )
        #expect(month.daysTotal == 31 && month.daysLeft == 13)
        #expect(month.incomeActual == 6_000_000 && month.expensesTotal == 1_250_000 && month.expensesToday == 50_000)
        #expect(month.savedToGoals == 127_000)
        // 6 000 000 − 127 000 saved − 1 200 000 before today − 1 500 000 upcoming = 3 173 000 over 13 days
        #expect(month.figures.available == 3_173_000)
        #expect(month.figures.dailyLimit == 244_076)
        #expect(month.figures.safeToSpendToday == 194_076)
        #expect(month.byCategory.map(\.categoryId) == [market, cafe])
        #expect(month.byCategory.map(\.amount) == [700_000, 550_000])
        // 1 250 000 over 19 days → 2 039 474 for 31 days, plus 1 500 000 of recurring payments
        #expect(month.forecast == 3_539_474)
        #expect(!month.incomplete)
    }

    @Test("a plan for another month is ignored and the onboarding estimate is used")
    func stalePlan() {
        let stale = BudgetPlan(periodStart: "2026-09-01", currency: "UZS", incomePlanned: 9_000_000, upcomingRecurring: 1_000_000)
        let month = BudgetCalculator.month(
            transactions: [], contributions: [], baseCurrency: "UZS", monthStartsOnDay: 1,
            incomeEstimate: 3_100_000, plan: stale, now: date("2026-10-01"), calendar: calendar
        )
        #expect(month.figures.incomeBasis == 3_100_000)
        #expect(month.upcomingRecurring == 0)
        #expect(month.figures.dailyLimit == 100_000)
        #expect(month.todayLeftShare == 1)
    }
}
