import Foundation
@testable import LunexCore
import Testing

/// Examples in `shared/formula-cases/` at the repository root. The server's tests read the same
/// files (`budget-math.spec.ts`, `budget-period.spec.ts`, `goal-math.spec.ts`): the device and
/// the server must give the same figures.
@Suite("Shared formula cases")
struct FormulaCasesTests {
    @Test("budget", arguments: FormulaCases.budget.cases)
    func budget(_ example: BudgetCase) {
        let figures = BudgetMath.compute(example.inputs.merged(over: FormulaCases.budget.defaults))
        let expected = example.expected
        if let sum = expected.incomeBasis { #expect(figures.incomeBasis == sum.value, "incomeBasis") }
        if let sum = expected.reservedForSavings { #expect(figures.reservedForSavings == sum.value, "reservedForSavings") }
        if let sum = expected.available { #expect(figures.available == sum.value, "available") }
        if let sum = expected.dailyLimit { #expect(figures.dailyLimit == sum.value, "dailyLimit") }
        if let sum = expected.safeToSpendToday { #expect(figures.safeToSpendToday == sum.value, "safeToSpendToday") }
        if let state = expected.state { #expect(figures.state.rawValue == state) }
    }

    /// Early and late in the day: the time of day must not move the month.
    @Test("budget month", arguments: FormulaCases.periods.cases, [0, 23])
    func period(_ example: PeriodCase, hour: Int) {
        let calendar = FormulaCases.calendar
        let today = FormulaCases.day(example.today, hour: hour)
        let period = BudgetPeriod.containing(today, startDay: example.payday, calendar: calendar)
        #expect(FormulaCases.key(period.start) == example.start)
        #expect(FormulaCases.key(period.end) == example.end)
        #expect(period.days(calendar: calendar) == example.days)
        #expect(period.daysLeft(from: today, calendar: calendar) == example.daysLeft)
    }

    @Test("goal progress and milestones", arguments: FormulaCases.goals.progress)
    func progress(_ example: ProgressCase) {
        let percent = GoalMath.progress(saved: example.saved.value, target: example.target.value)
        #expect(percent == example.percent)
        #expect(GoalMath.reachedMilestones(percent) == example.milestones)
    }

    @Test("goal schedule", arguments: FormulaCases.goals.schedule)
    func schedule(_ example: ScheduleCase) throws {
        let defaults = FormulaCases.goals.scheduleDefaults
        let inputs = example.inputs
        let deadline: String? = inputs.deadline ?? defaults.deadline ?? nil
        let schedule = GoalMath.schedule(
            target: (inputs.target ?? defaults.target)?.value ?? 0,
            saved: (inputs.saved ?? defaults.saved)?.value ?? 0,
            startedOn: FormulaCases.day(inputs.startedOn ?? defaults.startedOn ?? ""),
            // The app keeps a deadline as the start of that day.
            deadline: deadline.map { FormulaCases.day($0, hour: 0) },
            today: FormulaCases.day(inputs.today ?? defaults.today ?? ""),
            fractionDigits: inputs.decimals ?? defaults.decimals ?? 0,
            calendar: FormulaCases.calendar
        )
        guard let expected = example.expected else {
            #expect(schedule == nil)
            return
        }
        let plan = try #require(schedule)
        if let days = expected.daysLeft { #expect(plan.daysLeft == days) }
        if let status = expected.status { #expect(plan.status.rawValue == status) }
        if let sum = expected.perDay { #expect(plan.perDay == sum.value, "perDay") }
        if let sum = expected.perWeek { #expect(plan.perWeek == sum.value, "perWeek") }
        if let sum = expected.perMonth { #expect(plan.perMonth == sum.value, "perMonth") }
        if let sum = expected.expectedSaved { #expect(plan.expectedSaved == sum.value, "expectedSaved") }
    }
}

// MARK: - Files

enum FormulaCases {
    /// `<repository>/shared/formula-cases`, found from this file's place in the repository.
    static let directory = URL(filePath: #filePath)
        .deletingLastPathComponent() // LunexCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // LunexKit
        .deletingLastPathComponent() // Packages
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent()
        .appending(path: "shared/formula-cases")

    static let budget: BudgetCases = load("budget")
    static let periods: PeriodCases = load("budget-period")
    static let goals: GoalCases = load("goals")

    /// Days in the files are days in the user's time zone.
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tashkent")!
        return calendar
    }()

    /// `2026-10-19` as a moment of that day.
    static func day(_ text: String, hour: Int = 10) -> Date {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        precondition(parts.count == 3, "Not a day: \(text)")
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: hour))!
    }

    static func key(_ date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }

    private static func load<T: Decodable>(_ name: String) -> T {
        let file = directory.appending(path: "\(name).json")
        do {
            return try JSONDecoder().decode(T.self, from: Data(contentsOf: file))
        } catch {
            fatalError("\(file.path): \(error)")
        }
    }
}

/// A sum, written as a string in the files so no float rounding gets in the way.
struct CaseSum: Decodable, Sendable {
    let value: Decimal

    init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a sum: \(text)"))
        }
        self.value = value
    }
}

// MARK: Budget

struct BudgetCases: Decodable, Sendable {
    let defaults: BudgetCaseInputs
    let cases: [BudgetCase]
}

struct BudgetCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let inputs: BudgetCaseInputs
    let expected: Expected
    var testDescription: String { name }

    struct Expected: Decodable, Sendable {
        let incomeBasis: CaseSum?
        let reservedForSavings: CaseSum?
        let available: CaseSum?
        let dailyLimit: CaseSum?
        let safeToSpendToday: CaseSum?
        let state: String?
    }
}

/// What a case changes; the rest comes from the file's defaults.
struct BudgetCaseInputs: Decodable, Sendable {
    let incomeActual: CaseSum?
    let incomePlanned: CaseSum?
    let expensesBeforeToday: CaseSum?
    let expensesToday: CaseSum?
    let savedToGoals: CaseSum?
    let savingsTarget: CaseSum?
    let rollover: CaseSum?
    let upcomingRecurring: CaseSum?
    let totalLimit: CaseSum?
    let daysLeft: Int?
    let decimals: Int?

    func merged(over defaults: BudgetCaseInputs) -> BudgetInputs {
        var inputs = BudgetInputs()
        inputs.incomeActual = (incomeActual ?? defaults.incomeActual)?.value ?? 0
        inputs.incomePlanned = (incomePlanned ?? defaults.incomePlanned)?.value
        inputs.expensesBeforeToday = (expensesBeforeToday ?? defaults.expensesBeforeToday)?.value ?? 0
        inputs.expensesToday = (expensesToday ?? defaults.expensesToday)?.value ?? 0
        inputs.savedToGoals = (savedToGoals ?? defaults.savedToGoals)?.value ?? 0
        inputs.savingsTarget = (savingsTarget ?? defaults.savingsTarget)?.value ?? 0
        inputs.rollover = (rollover ?? defaults.rollover)?.value ?? 0
        inputs.upcomingRecurring = (upcomingRecurring ?? defaults.upcomingRecurring)?.value ?? 0
        inputs.totalLimit = (totalLimit ?? defaults.totalLimit)?.value
        inputs.daysLeft = daysLeft ?? defaults.daysLeft ?? 1
        inputs.fractionDigits = decimals ?? defaults.decimals ?? 0
        return inputs
    }
}

// MARK: Budget month

struct PeriodCases: Decodable, Sendable {
    let cases: [PeriodCase]
}

struct PeriodCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let today: String
    let payday: Int
    let start: String
    let end: String
    let days: Int
    let daysLeft: Int
    var testDescription: String { name }
}

// MARK: Goals

struct GoalCases: Decodable, Sendable {
    let progress: [ProgressCase]
    let scheduleDefaults: ScheduleInputs
    let schedule: [ScheduleCase]
}

struct ProgressCase: Decodable, Sendable, CustomTestStringConvertible {
    let saved: CaseSum
    let target: CaseSum
    let percent: Int
    let milestones: [Int]
    var testDescription: String { "\(saved.value) of \(target.value)" }
}

struct ScheduleCase: Decodable, Sendable, CustomTestStringConvertible {
    let name: String
    let inputs: ScheduleInputs
    /// nil: no plan
    let expected: Expected?
    var testDescription: String { name }

    struct Expected: Decodable, Sendable {
        let daysLeft: Int?
        let status: String?
        let perDay: CaseSum?
        let perWeek: CaseSum?
        let perMonth: CaseSum?
        let expectedSaved: CaseSum?
    }
}

struct ScheduleInputs: Decodable, Sendable {
    let target: CaseSum?
    let saved: CaseSum?
    let startedOn: String?
    /// nil: not in the case; .some(nil): no deadline
    let deadline: String??
    let today: String?
    let decimals: Int?

    private enum CodingKeys: String, CodingKey {
        case target, saved, startedOn, deadline, today, decimals
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        target = try container.decodeIfPresent(CaseSum.self, forKey: .target)
        saved = try container.decodeIfPresent(CaseSum.self, forKey: .saved)
        startedOn = try container.decodeIfPresent(String.self, forKey: .startedOn)
        deadline = container.contains(.deadline) ? .some(try container.decodeIfPresent(String.self, forKey: .deadline)) : nil
        today = try container.decodeIfPresent(String.self, forKey: .today)
        decimals = try container.decodeIfPresent(Int.self, forKey: .decimals)
    }
}
