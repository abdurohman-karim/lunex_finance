import Foundation
@testable import LunexCore
import Testing

// The formula and the budget month themselves: FormulaCasesTests, on the cases shared with the server.

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

@Suite("First steps")
@MainActor
struct FirstStepsTests {
    @Test("the checklist counts what is done and offers the widget only once widgets exist")
    func progress() {
        let fresh = FirstStepsProgress(hasOperation: false, hasGoal: true, budgetSeen: false, hasWidget: false, widgetsAvailable: false)
        #expect(fresh.items == [.operation, .goal, .budget])
        #expect(fresh.doneCount == 1 && !fresh.isComplete && fresh.next == .operation)

        let done = FirstStepsProgress(hasOperation: true, hasGoal: true, budgetSeen: true, hasWidget: false, widgetsAvailable: false)
        #expect(done.isComplete && done.next == nil)

        let withWidgets = FirstStepsProgress(hasOperation: true, hasGoal: true, budgetSeen: true, hasWidget: false, widgetsAvailable: true)
        #expect(!withWidgets.isComplete && withWidgets.next == .widget)
    }

    @Test("seen budget and hidden checklist are remembered per account")
    func store() {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        let me = UUID()
        let other = UUID()
        let first = FirstStepsStore(defaults: defaults)
        first.markBudgetSeen(me)
        first.dismiss(me)
        let again = FirstStepsStore(defaults: defaults)
        #expect(again.hasSeenBudget(me) && again.isDismissed(me))
        #expect(!again.hasSeenBudget(other) && !again.isDismissed(other))
    }
}
