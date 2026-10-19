import Charts
import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Reads what the budget needs from the local store and works the month out on the device:
/// a saved operation changes the figures at once, with or without a connection.
@MainActor
struct BudgetQuery: DynamicProperty {
    @Query(filter: #Predicate<TransactionRecord> { $0.deletedAt == nil })
    private var transactions: [TransactionRecord]
    @Query(filter: #Predicate<ContributionRecord> { $0.deletedAt == nil })
    private var contributions: [ContributionRecord]
    @Query private var settings: [SettingsRecord]
    @Environment(BudgetPlans.self) private var plans
    @Environment(SessionStore.self) private var session

    var baseCurrency: String {
        session.profile?.baseCurrency ?? SupportedCurrency.default
    }

    /// Payday other than the 1st: the month runs «до зарплаты».
    var startsOnPayday: Bool {
        (settings.first?.monthStartsOnDay ?? 1) != 1
    }

    func month(now: Date) -> BudgetMonth {
        BudgetCalculator.month(
            transactions: transactions,
            contributions: contributions,
            baseCurrency: baseCurrency,
            monthStartsOnDay: settings.first?.monthStartsOnDay ?? 1,
            incomeEstimate: session.profile?.monthlyIncomeEstimate.flatMap(Decimal.exact),
            plan: plans.plan,
            now: now
        )
    }
}

// MARK: - Home ring

/// «Можно потратить сегодня» in the progress ring: what is left of today's limit; the ring and
/// the number turn red when today's spending is over it.
struct SafeToSpendRing: View {
    let month: BudgetMonth
    let startsOnPayday: Bool
    let addIncome: () -> Void
    @Environment(Localizer.self) private var localizer

    var body: some View {
        let overspent = month.figures.state == .overspent
        VStack(spacing: LunexTheme.Spacing.space4) {
            // Over the limit the whole ring turns red: nothing is left of today.
            ProgressRing(progress: overspent ? 1 : month.todayLeftShare, tint: overspent ? LunexColor.negative : LunexColor.dataSteel) {
                VStack(spacing: LunexTheme.Spacing.space1) {
                    SectionLabel(localizer("home.safeToSpend"))
                        .multilineTextAlignment(.center)
                    Text(hero)
                        .lunexText(.amountHero)
                        .foregroundStyle(overspent ? LunexColor.negative : LunexColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .contentTransition(.numericText())
                    Text(caption)
                        .lunexText(.callout)
                        .foregroundStyle(overspent ? LunexColor.negative : LunexColor.inkMuted)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                }
            }
            .frame(width: LunexTheme.Size.ringHero, height: LunexTheme.Size.ringHero)
            .animation(.snappy, value: month.figures.safeToSpendToday)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(localizer("home.safeToSpend"))
            .accessibilityValue(hero + " " + caption)

            if month.figures.state == .noIncome {
                Button(localizer("home.addIncome"), action: addIncome)
                    .buttonStyle(.lunex(.secondary, size: .compact))
            } else {
                Text(localizer.format(startsOnPayday ? "home.daysToPayday" : "home.daysLeft", month.daysLeft))
                    .lunexText(.callout)
                    .foregroundStyle(LunexColor.inkMuted)
            }
        }
    }

    private var hero: String {
        switch month.figures.state {
        case .noIncome: "—"
        case .ok: localizer.amount(month.figures.safeToSpendToday, currency: month.currency)
        case .overspent: localizer.amount(month.figures.safeToSpendToday, currency: month.currency)
        }
    }

    private var caption: String {
        let currency = localizer.currencyName(month.currency)
        switch month.figures.state {
        case .noIncome:
            return localizer("home.noIncome")
        case .ok:
            return localizer.format("home.ofDailyLimit", currency, localizer.amount(month.figures.dailyLimit, currency: month.currency))
        case .overspent:
            return localizer.format("home.overspent", currency)
        }
    }
}

// MARK: - Budget tab

/// The month in auto mode: daily limit and today's share, spent against the plan with a forecast,
/// spending by category, and how the limit is worked out.
struct BudgetView: View {
    @Environment(SyncEngine.self) private var sync
    @Environment(BudgetPlans.self) private var plans
    @Environment(Localizer.self) private var localizer
    @Environment(\.scenePhase) private var scenePhase

    private var budget = BudgetQuery()
    @Query private var categories: [CategoryRecord]
    @State private var now = Date.now
    @State private var editor: TransactionEditor?

    var body: some View {
        let month = budget.month(now: now)
        ScrollView {
            VStack(spacing: LunexTheme.Spacing.space4) {
                if month.figures.state == .noIncome {
                    noIncome
                } else {
                    limitCard(month)
                    if !month.byCategory.isEmpty {
                        categoriesCard(month)
                    }
                    calculationCard(month)
                }
            }
            .padding(.horizontal, LunexTheme.Spacing.space4)
            .padding(.bottom, LunexTheme.Spacing.space8)
        }
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.budget"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Text(periodTitle(month))
                    .lunexText(.callout, weight: .medium)
                    .foregroundStyle(LunexColor.ink)
                    .padding(.horizontal, LunexTheme.Spacing.space2)
            }
        }
        .refreshable {
            await sync.sync()
            await plans.refresh()
        }
        .task { await plans.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in now = .now }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { now = .now }
        }
        .transactionEditor($editor)
    }

    private var noIncome: some View {
        ContentUnavailableView {
            Label(localizer("empty.budget.title"), systemImage: "chart.pie")
        } description: {
            Text(localizer("empty.budget.body"))
        } actions: {
            Button(localizer("home.addIncome")) { editor = .new(.income) }
                .buttonStyle(.lunex(.primary, size: .compact))
        }
        .padding(.top, LunexTheme.Spacing.space12)
    }

    private func limitCard(_ month: BudgetMonth) -> some View {
        let currency = localizer.currencyName(month.currency)
        let overspent = month.figures.state == .overspent
        return Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space4) {
                AmountDisplay(
                    label: localizer("budget.dailyLimit"),
                    value: localizer.amount(month.figures.dailyLimit, currency: month.currency),
                    currency: currency,
                    caption: overspent
                        ? localizer.format("budget.todayOver", localizer.amount(-month.figures.safeToSpendToday, currency: month.currency, showCurrency: true))
                        : localizer.format("budget.todayLeft", localizer.amount(month.figures.safeToSpendToday, currency: month.currency, showCurrency: true)),
                    isNegative: overspent
                )
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(localizer("budget.spent"))
                            .lunexText(.callout)
                            .foregroundStyle(LunexColor.inkMuted)
                        Spacer()
                        Text(localizer.amount(month.expensesTotal, currency: month.currency))
                            .lunexText(.amountM)
                            .foregroundStyle(LunexColor.ink)
                        if let planned = month.plannedSpending {
                            Text(localizer.format("budget.ofPlan", localizer.amount(planned, currency: month.currency)))
                                .lunexText(.callout)
                                .foregroundStyle(LunexColor.inkMuted)
                        }
                    }
                    if let planned = month.plannedSpending {
                        ProgressBar(progress: NSDecimalNumber(decimal: month.expensesTotal / planned).doubleValue)
                    }
                }
                if let forecast = forecastLine(month) {
                    Text(forecast)
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                }
            }
        }
    }

    private func forecastLine(_ month: BudgetMonth) -> String? {
        guard month.expensesTotal > 0, let planned = month.plannedSpending else { return nil }
        let lastDay = month.period.end.formatted(.dateTime.day().month(.wide).locale(localizer.locale))
        let amount = localizer.amount(month.forecast, currency: month.currency, showCurrency: true)
        let verdict = month.forecast <= planned
            ? localizer("budget.forecast.fits")
            : localizer.format("budget.forecast.short", localizer.amount(month.forecast - planned, currency: month.currency, showCurrency: true))
        return localizer.format("budget.forecast", lastDay, amount) + " " + verdict
    }

    // MARK: Categories

    private struct Slice: Identifiable {
        let id: String
        let name: String
        let amount: Decimal
        let color: Color
    }

    /// The four largest categories, the rest as «Прочее».
    private func slices(_ month: BudgetMonth) -> [Slice] {
        let byId = Dictionary(categories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let language = localizer.language.rawValue
        var result = month.byCategory.prefix(4).map { spend -> Slice in
            let category = spend.categoryId.flatMap { byId[$0] }
            return Slice(
                id: spend.id,
                name: category?.displayName(language: language) ?? localizer("transaction.uncategorized"),
                amount: spend.amount,
                color: Color(hex: category?.color) ?? LunexColor.inkFaint
            )
        }
        let rest = month.byCategory.dropFirst(4).reduce(Decimal(0)) { $0 + $1.amount }
        if rest > 0 {
            result.append(Slice(id: "rest", name: localizer("budget.other"), amount: rest, color: LunexColor.dataGraphite))
        }
        return result
    }

    private func categoriesCard(_ month: BudgetMonth) -> some View {
        let slices = slices(month)
        return Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space4) {
                SectionLabel(localizer("budget.byCategory"))
                HStack(spacing: LunexTheme.Spacing.space4) {
                    Chart(slices) { slice in
                        SectorMark(
                            angle: .value(slice.name, NSDecimalNumber(decimal: slice.amount).doubleValue),
                            innerRadius: .ratio(0.72),
                            angularInset: 1.5
                        )
                        .foregroundStyle(slice.color)
                    }
                    .chartLegend(.hidden)
                    .frame(width: 132, height: 132)
                    .overlay {
                        VStack(spacing: 2) {
                            Text(localizer("budget.total"))
                                .lunexText(.caption)
                                .foregroundStyle(LunexColor.inkMuted)
                            Text(localizer.amount(month.expensesTotal, currency: month.currency))
                                .lunexText(.callout, weight: .semibold)
                                .foregroundStyle(LunexColor.ink)
                                .lineLimit(1)
                                .minimumScaleFactor(0.6)
                        }
                        .padding(.horizontal, 24)
                    }
                    .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
                        ForEach(slices) { slice in
                            HStack(spacing: LunexTheme.Spacing.space2) {
                                Circle().fill(slice.color).frame(width: 8, height: 8)
                                Text(slice.name)
                                    .lunexText(.caption)
                                    .foregroundStyle(LunexColor.ink)
                                    .lineLimit(1)
                                Spacer(minLength: LunexTheme.Spacing.space1)
                                Text(localizer.amount(slice.amount, currency: month.currency))
                                    .lunexText(.caption, weight: .medium)
                                    .monospacedDigit()
                                    .foregroundStyle(LunexColor.ink)
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                }
            }
        }
    }

    // MARK: How it is worked out

    private func calculationCard(_ month: BudgetMonth) -> some View {
        let currency = month.currency
        let figures = month.figures
        let income = month.incomePlanned.map { $0 > month.incomeActual } == true
            ? localizer("budget.calc.incomePlanned")
            : localizer("budget.calc.incomeActual")
        return Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                SectionLabel(localizer("budget.calc.title"))
                CalcRow(title: income, value: localizer.amount(figures.incomeBasis, currency: currency))
                if figures.reservedForSavings != 0 {
                    CalcRow(title: localizer("budget.calc.saved"), value: localizer.amount(-figures.reservedForSavings, currency: currency, signed: true))
                }
                CalcRow(
                    title: localizer("budget.calc.spentBefore"),
                    value: localizer.amount(-(month.expensesTotal - month.expensesToday), currency: currency, signed: true)
                )
                if month.upcomingRecurring != 0 {
                    CalcRow(title: localizer("budget.calc.recurring"), value: localizer.amount(-month.upcomingRecurring, currency: currency, signed: true))
                }
                Divider().overlay(LunexColor.line)
                CalcRow(title: localizer("budget.calc.available"), value: localizer.amount(figures.available, currency: currency), isStrong: true)
                CalcRow(title: localizer.format("budget.calc.days", month.daysLeft), value: localizer.amount(figures.dailyLimit, currency: currency), isStrong: true)
                Text(localizer(month.mode == "auto" ? "budget.mode.auto" : "budget.mode.planned"))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
                if month.incomplete {
                    Text(localizer("budget.incomplete"))
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.inkMuted)
                }
            }
        }
    }

    private func periodTitle(_ month: BudgetMonth) -> String {
        let calendar = Calendar.current
        if calendar.component(.day, from: month.period.start) == 1 {
            return month.period.start.formatted(.dateTime.month(.wide).locale(localizer.locale)).capitalized(with: localizer.locale)
        }
        let style = Date.FormatStyle.dateTime.day().month(.abbreviated).locale(localizer.locale)
        return month.period.start.formatted(style) + " – " + month.period.end.formatted(style)
    }
}

private struct CalcRow: View {
    let title: String
    let value: String
    var isStrong = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .lunexText(.callout, weight: isStrong ? .semibold : nil)
                .foregroundStyle(isStrong ? LunexColor.ink : LunexColor.inkMuted)
            Spacer(minLength: LunexTheme.Spacing.space2)
            Text(value)
                .lunexText(.callout, weight: isStrong ? .semibold : .medium)
                .monospacedDigit()
                .foregroundStyle(LunexColor.ink)
        }
        .accessibilityElement(children: .combine)
    }
}
