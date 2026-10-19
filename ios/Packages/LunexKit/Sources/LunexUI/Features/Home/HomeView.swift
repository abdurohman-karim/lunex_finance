import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

#if canImport(WidgetKit)
import WidgetKit
#endif

/// The whole day on one screen: what can be spent today, «Первые шаги» for a new account,
/// Smart Save, balance and the month against the plan, the primary goal and the last five
/// operations. Everything reads the local store, so it shows at once and offline.
struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SyncEngine.self) private var sync
    @Environment(BudgetPlans.self) private var plans
    @Environment(SmartSaveStore.self) private var smartSave
    @Environment(Localizer.self) private var localizer
    @Environment(\.scenePhase) private var scenePhase
    private var budget = BudgetQuery()

    @State private var editor: TransactionEditor?
    @State private var goalEditor: GoalEditorTarget?
    @State private var openGoal: UUID?
    @State private var now = Date.now

    var body: some View {
        let month = budget.month(now: now)
        ScrollView {
            VStack(spacing: LunexTheme.Spacing.space4) {
                header
                SafeToSpendRing(month: month, startsOnPayday: budget.startsOnPayday) {
                    editor = .new(.income)
                }
                .padding(.top, LunexTheme.Spacing.space2)
                FirstStepsCard(addOperation: { editor = .new(.expense) }, addGoal: { goalEditor = .new })
                SmartSaveCard(month: month) { goalEditor = .new }
                BalanceCard(month: month, startsOnPayday: budget.startsOnPayday)
                PrimaryGoalBlock { openGoal = $0 }
                RecentOperations { editor = .edit($0) }
            }
            .padding(.horizontal, LunexTheme.Spacing.space4)
            // Room for the «+» button above the tab bar.
            .padding(.bottom, 88)
        }
        .background(LunexColor.paper)
        .overlay(alignment: .bottomTrailing) {
            AddButton { editor = .new($0) }
                .padding(.trailing, LunexTheme.Spacing.space4)
                .padding(.bottom, LunexTheme.Spacing.space3)
        }
        .refreshable {
            await sync.sync()
            await session.refreshAccess()
            await plans.refresh()
            await smartSave.refresh()
        }
        // Every sync may change the month (an operation here or on another iPhone).
        .task(id: sync.lastSyncedAt) { await smartSave.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in now = .now }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { now = .now }
        }
        .navigationDestination(item: $openGoal) { id in
            GoalDetailView(goalId: id)
        }
        .transactionEditor($editor)
        .sheet(item: $goalEditor) { target in
            GoalEditor(target: target)
        }
    }

    private var header: some View {
        HStack {
            SectionLabel(now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(localizer.locale)))
            Spacer()
            if session.lastError?.isOffline == true {
                Image(systemName: "wifi.slash")
                    .foregroundStyle(LunexColor.inkMuted)
                    .accessibilityLabel(localizer("home.offline"))
            }
        }
        .padding(.top, LunexTheme.Spacing.space2)
    }
}

// MARK: - «+»

/// The big round «+»: a tap opens quick add for an expense; a long press offers the kind.
private struct AddButton: View {
    let open: (TransactionKind) -> Void
    @Environment(Localizer.self) private var localizer

    var body: some View {
        Button { open(.expense) } label: {
            Image(systemName: "plus")
                .font(.system(size: 26, weight: .medium))
                .foregroundStyle(LunexColor.onInk)
                .frame(width: 60, height: 60)
                .background(LunexColor.ink, in: Circle())
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        }
        .buttonStyle(.plain)
        .contextMenu {
            ForEach(TransactionKind.allCases, id: \.self) { kind in
                Button(localizer("add.kind.\(kind.rawValue)"), systemImage: icon(kind)) { open(kind) }
            }
        }
        .accessibilityLabel(localizer("history.add"))
        .accessibilityHint(localizer("home.add.hint"))
    }

    private func icon(_ kind: TransactionKind) -> String {
        switch kind {
        case .expense: "minus.circle"
        case .income: "plus.circle"
        case .transfer: "arrow.left.arrow.right"
        }
    }
}

// MARK: - First steps

/// «Первые шаги»: first operation, a goal, the budget (and a widget once widgets exist).
/// Leaves the screen when everything is done or the user hides it.
private struct FirstStepsCard: View {
    let addOperation: () -> Void
    let addGoal: () -> Void

    @Environment(FirstStepsStore.self) private var store
    @Environment(SessionStore.self) private var session
    @Environment(BudgetPlans.self) private var plans
    @Environment(Localizer.self) private var localizer
    @Environment(TabRouter.self) private var router

    @Query(filter: #Predicate<TransactionRecord> { $0.deletedAt == nil }) private var transactions: [TransactionRecord]
    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil }) private var goals: [GoalRecord]
    @State private var hasWidget = false

    /// Widgets come with their own build step (23); until then the item is not offered.
    static let widgetsAvailable = false

    var body: some View {
        if let user = session.profile?.id, !store.isDismissed(user) {
            let progress = FirstStepsProgress(
                hasOperation: !transactions.isEmpty,
                hasGoal: !goals.isEmpty,
                budgetSeen: store.hasSeenBudget(user) || plans.plan?.mode == "planned",
                hasWidget: hasWidget,
                widgetsAvailable: Self.widgetsAvailable
            )
            if !progress.isComplete {
                card(progress, user: user)
                    .task { hasWidget = await Self.widgetInstalled() }
            }
        }
    }

    private func card(_ progress: FirstStepsProgress, user: UUID) -> some View {
        Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel(localizer("firstSteps.title"))
                    Spacer()
                    Text(localizer.format("firstSteps.progress", progress.doneCount, progress.items.count))
                        .lunexText(.caption, weight: .medium)
                        .foregroundStyle(LunexColor.inkMuted)
                }
                ProgressBar(progress: Double(progress.doneCount) / Double(max(1, progress.items.count)))
                VStack(spacing: 0) {
                    ForEach(progress.items, id: \.self) { step in
                        row(step, done: progress.done.contains(step))
                    }
                }
                Button(localizer("firstSteps.hide")) {
                    withAnimation(.snappy) { store.dismiss(user) }
                }
                .buttonStyle(.lunex(.quiet))
                .padding(.leading, -LunexTheme.Spacing.space3)
            }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private func row(_ step: FirstStep, done: Bool) -> some View {
        Button { open(step) } label: {
            HStack(spacing: LunexTheme.Spacing.space3) {
                Image(systemName: done ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 22))
                    .foregroundStyle(done ? LunexColor.dataSteel : LunexColor.inkFaint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(localizer("firstSteps.\(step.rawValue)"))
                        .lunexText(.body, weight: .medium)
                        .foregroundStyle(done ? LunexColor.inkMuted : LunexColor.ink)
                        .strikethrough(done, color: LunexColor.inkFaint)
                    if !done {
                        Text(localizer("firstSteps.\(step.rawValue).detail"))
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                }
                Spacer(minLength: 0)
                if !done {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(LunexColor.inkFaint)
                }
            }
            .padding(.vertical, LunexTheme.Spacing.space2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(done)
        .accessibilityValue(localizer(done ? "goals.milestone.done" : "goals.milestone.ahead"))
    }

    private func open(_ step: FirstStep) {
        switch step {
        case .operation: addOperation()
        case .goal: addGoal()
        case .budget: router.tab = .budget
        case .widget: break
        }
    }

    private static func widgetInstalled() async -> Bool {
        #if canImport(WidgetKit) && os(iOS)
        guard widgetsAvailable else { return false }
        return await withCheckedContinuation { continuation in
            WidgetCenter.shared.getCurrentConfigurations { result in
                continuation.resume(returning: ((try? result.get()) ?? []).isEmpty == false)
            }
        }
        #else
        return false
        #endif
    }
}

// MARK: - Balance and the month

/// «Баланс · 2 счёта» in the base currency, and the month's spending against the plan.
private struct BalanceCard: View {
    let month: BudgetMonth
    let startsOnPayday: Bool

    @Environment(Catalog.self) private var catalog
    @Environment(Localizer.self) private var localizer
    @Environment(TabRouter.self) private var router
    @Query(filter: #Predicate<AccountRecord> { $0.deletedAt == nil && !$0.isArchived }) private var accounts: [AccountRecord]

    var body: some View {
        if !accounts.isEmpty {
            let counted = accounts.filter(\.includeInTotal)
            let balance = try? catalog.balance(of: counted, base: month.currency)
            Card {
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                    AmountDisplay(
                        label: localizer.format("home.balance", counted.count),
                        value: localizer.amount(balance?.total ?? 0, currency: month.currency),
                        currency: localizer.currencyName(month.currency),
                        scale: .large,
                        isNegative: (balance?.total ?? 0) < 0
                    )
                    Divider().overlay(LunexColor.line)
                    Button { router.tab = .budget } label: { monthLine }
                        .buttonStyle(.plain)
                }
            }
        }
    }

    private var monthLine: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            HStack(alignment: .firstTextBaseline) {
                SectionLabel(periodTitle)
                Spacer()
                Text(localizer.amount(month.expensesTotal, currency: month.currency))
                    .lunexText(.callout, weight: .medium)
                    .monospacedDigit()
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
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var periodTitle: String {
        if !startsOnPayday {
            return month.period.start.formatted(.dateTime.month(.wide).locale(localizer.locale))
        }
        let style = Date.FormatStyle.dateTime.day().month(.abbreviated).locale(localizer.locale)
        return month.period.start.formatted(style) + " – " + month.period.end.formatted(style)
    }
}

// MARK: - Primary goal

/// «Основная цель»: emoji, name, progress; a tap opens the goal.
private struct PrimaryGoalBlock: View {
    let open: (UUID) -> Void

    @Environment(GoalBook.self) private var book
    @Environment(Localizer.self) private var localizer
    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil && $0.isPrimary }) private var primary: [GoalRecord]

    var body: some View {
        if let goal = primary.first {
            Button { open(goal.id) } label: {
                Card {
                    VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                        SectionLabel(localizer("home.primaryGoal"))
                        HStack(spacing: LunexTheme.Spacing.space3) {
                            GoalEmoji(goal: goal, size: LunexTheme.Size.iconWell)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(goal.title)
                                    .lunexText(.bodyStrong)
                                    .foregroundStyle(LunexColor.ink)
                                    .lineLimit(1)
                                Text(localizer.format(
                                    "goals.savedOfTarget",
                                    localizer.amount(goal.savedAmount, currency: goal.currency),
                                    localizer.amount(goal.targetAmount, currency: goal.currency, showCurrency: true)
                                ))
                                .lunexText(.callout)
                                .foregroundStyle(LunexColor.inkMuted)
                                .lineLimit(1)
                            }
                            Spacer(minLength: LunexTheme.Spacing.space2)
                            Text("\(goal.progress)%")
                                .lunexText(.amountM)
                                .foregroundStyle(LunexColor.ink)
                        }
                        ProgressBar(progress: Double(goal.progress) / 100, tint: Color(hex: goal.color) ?? LunexColor.dataSteel)
                        if let schedule = book.schedule(for: goal) {
                            HStack {
                                ScheduleBadge(status: schedule.status)
                                Spacer()
                                Text(localizer.format("goals.needPerDay", localizer.amount(schedule.perDay, currency: goal.currency, showCurrency: true)))
                                    .lunexText(.caption)
                                    .foregroundStyle(LunexColor.inkMuted)
                            }
                        }
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Recent operations

/// The last five operations with «Все», which opens the history.
private struct RecentOperations: View {
    let edit: (UUID) -> Void

    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer
    @Environment(TabRouter.self) private var router
    @Query(Self.lastFive) private var records: [TransactionRecord]
    @Query private var categories: [CategoryRecord]
    @Query private var accounts: [AccountRecord]

    static var lastFive: FetchDescriptor<TransactionRecord> {
        var descriptor = FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.deletedAt == nil },
            sortBy: [SortDescriptor(\.occurredAt, order: .reverse)]
        )
        descriptor.fetchLimit = 5
        return descriptor
    }

    var body: some View {
        if !records.isEmpty {
            let categoryById = Dictionary(categories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let accountById = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
                HStack(alignment: .firstTextBaseline) {
                    SectionLabel(localizer("home.recent"))
                    Spacer()
                    Button(localizer("home.all")) { router.tab = .transactions }
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                        .buttonStyle(.plain)
                }
                .padding(.horizontal, LunexTheme.Spacing.space1)
                VStack(spacing: 0) {
                    ForEach(Array(records.enumerated()), id: \.element.id) { index, record in
                        if index > 0 {
                            Divider()
                                .overlay(LunexColor.line)
                                .padding(.leading, LunexTheme.Size.iconWell + LunexTheme.Spacing.space3)
                        }
                        Button { edit(record.id) } label: {
                            TransactionRow(
                                record: record,
                                category: record.categoryId.flatMap { categoryById[$0] },
                                account: accountById[record.accountId],
                                target: record.transferAccountId.flatMap { accountById[$0] },
                                baseCurrency: session.profile?.baseCurrency ?? SupportedCurrency.default,
                                showsDay: true
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, LunexTheme.Spacing.space4)
                .background(LunexColor.surface, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
            }
        }
    }
}
