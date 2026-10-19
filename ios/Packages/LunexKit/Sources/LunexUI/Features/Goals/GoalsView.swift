import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Goals: what is saved in all of them, the primary goal as a large card with «Пополнить / Снять»,
/// the other live goals by priority (reorder mode), then reached ones and the archive.
struct GoalsView: View {
    @Environment(GoalBook.self) private var book
    @Environment(ToastCenter.self) private var toasts
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    @Query(GoalsView.descriptor) private var goals: [GoalRecord]

    private static let descriptor = FetchDescriptor<GoalRecord>(
        predicate: #Predicate<GoalRecord> { $0.deletedAt == nil },
        sortBy: [SortDescriptor<GoalRecord>(\.priority), SortDescriptor<GoalRecord>(\.createdAt)]
    )
    @State private var editor: GoalEditorTarget?
    @State private var contribution: ContributionTarget?
    @State private var reached: ReachedGoal?
    @State private var openGoal: UUID?
    @State private var isReordering = false

    private var live: [GoalRecord] {
        goals.filter { GoalStatus(rawValue: $0.status)?.isLive == true }
    }

    var body: some View {
        content
            .scrollContentBackground(.hidden)
            .background(LunexColor.paper)
            .navigationTitle(localizer("tab.goals"))
            .navigationDestination(item: $openGoal) { id in
                GoalDetailView(goalId: id)
            }
            .toolbar { toolbar }
            .sheet(item: $editor) { target in
                GoalEditor(target: target)
            }
            .sheet(item: $contribution) { target in
                ContributionSheet(target: target) { outcome in
                    celebrate(outcome, goalId: target.goalId)
                }
            }
            .fullScreen(item: $reached) { goal in
                GoalReachedView(goalId: goal.id) { editor = .new }
            }
    }

    @ViewBuilder
    private var content: some View {
        if goals.isEmpty {
            ContentUnavailableView {
                Label(localizer("empty.goals.title"), systemImage: "target")
            } description: {
                Text(localizer("empty.goals.body"))
            } actions: {
                Button(localizer("goals.new")) { editor = .new }
                    .buttonStyle(.lunex(.primary, size: .compact))
            }
        } else {
            list
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if live.count > 1 {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer(isReordering ? "add.done" : "common.reorder")) {
                    withAnimation { isReordering.toggle() }
                }
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button(localizer("goals.new"), systemImage: "plus") { editor = .new }
                .disabled(isReordering)
        }
    }

    private var list: some View {
        let live = live
        let completed = goals.filter { $0.status == GoalStatus.completed.rawValue }
        let archived = goals.filter { $0.status == GoalStatus.archived.rawValue }
        return List {
            Section {
                summary(live + completed)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if isReordering {
                reorderSection(live)
            } else {
                primarySection(live)
            }
            if !completed.isEmpty {
                rows(completed, title: "goals.reached")
            }
            if !archived.isEmpty {
                rows(archived, title: "goals.archive", dimmed: true)
            }
        }
        .groupedLists()
        .reordering(isReordering)
    }

    private func reorderSection(_ live: [GoalRecord]) -> some View {
        Section {
            ForEach(live) { goal in
                GoalRow(goal: goal).listRowBackground(LunexColor.surface)
            }
            .onMove { from, to in move(live, from: from, to: to) }
        } header: {
            SectionLabel(localizer("goals.priority"))
        }
    }

    @ViewBuilder
    private func primarySection(_ live: [GoalRecord]) -> some View {
        let primary = live.first(where: \.isPrimary)
        if let primary {
            Section {
                PrimaryGoalCard(goal: primary) { kind in
                    contribution = ContributionTarget(goalId: primary.id, kind: kind)
                }
                .contentShape(Rectangle())
                .onTapGesture { openGoal = primary.id }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
        }
        let others = live.filter { $0.id != primary?.id }
        if !others.isEmpty {
            rows(others, title: "goals.others")
        }
    }

    private func rows(_ goals: [GoalRecord], title: String, dimmed: Bool = false) -> some View {
        Section {
            ForEach(goals) { goal in
                Button { openGoal = goal.id } label: {
                    GoalRow(goal: goal).opacity(dimmed ? 0.6 : 1)
                }
                .buttonStyle(.plain)
                .listRowBackground(LunexColor.surface)
            }
        } header: {
            SectionLabel(localizer(title))
        }
    }

    private func summary(_ goals: [GoalRecord]) -> some View {
        let base = session.profile?.baseCurrency ?? SupportedCurrency.default
        let total = goals.filter { $0.currency == base }.reduce(Decimal(0)) { $0 + $1.savedAmount }
        let apart = Dictionary(grouping: goals.filter { $0.currency != base && $0.savedAmount != 0 }, by: \.currency)
            .sorted { $0.key < $1.key }
            .map { code, list in localizer.amount(list.reduce(0) { $0 + $1.savedAmount }, currency: code, showCurrency: true) }
        return AmountDisplay(
            label: localizer("goals.savedIn"),
            value: localizer.amount(total, currency: base),
            currency: localizer.currencyName(base),
            caption: apart.isEmpty ? nil : "+ " + apart.joined(separator: ", "),
            scale: .large
        )
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, LunexTheme.Spacing.space1)
        .padding(.vertical, LunexTheme.Spacing.space2)
    }

    private func move(_ live: [GoalRecord], from: IndexSet, to: Int) {
        var ids = live.map(\.id)
        ids.move(fromOffsets: from, toOffset: to)
        do {
            try book.reorder(ids)
        } catch {
            toasts.show(localizer.goalMessage(error))
        }
    }

    private func celebrate(_ outcome: ContributionOutcome, goalId: UUID) {
        if outcome.completed {
            reached = ReachedGoal(id: goalId)
        } else if let milestone = outcome.newMilestones.last {
            toasts.show(localizer.format("goals.milestoneToast", milestone))
        }
    }
}

struct ReachedGoal: Identifiable, Hashable {
    let id: UUID
}

// MARK: - Cards and rows

/// The primary goal: progress, the schedule's verdict and the two everyday actions.
struct PrimaryGoalCard: View {
    let goal: GoalRecord
    let contribute: (ContributionKind) -> Void
    @Environment(GoalBook.self) private var book
    @Environment(Localizer.self) private var localizer

    var body: some View {
        let schedule = book.schedule(for: goal)
        Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                HStack(spacing: LunexTheme.Spacing.space3) {
                    GoalEmoji(goal: goal, size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(goal.title)
                            .lunexText(.bodyStrong)
                            .foregroundStyle(LunexColor.ink)
                            .lineLimit(1)
                        Text(localizer("goals.primary") + " · " + localizer.goalDeadline(goal, book: book))
                            .lunexText(.callout)
                            .foregroundStyle(LunexColor.inkMuted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if let schedule {
                        ScheduleBadge(status: schedule.status)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: LunexTheme.Spacing.space2) {
                    Text(localizer.amount(goal.savedAmount, currency: goal.currency))
                        .lunexText(.amountL)
                        .foregroundStyle(LunexColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(localizer.format("goals.ofTarget", localizer.amount(goal.targetAmount, currency: goal.currency, showCurrency: true)))
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                        .lineLimit(1)
                }
                ProgressBar(progress: Double(goal.progress) / 100, tint: Color(hex: goal.color) ?? LunexColor.dataSteel)
                Text(caption(schedule))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
                HStack(spacing: LunexTheme.Spacing.space2) {
                    Button(localizer("goals.deposit")) { contribute(.deposit) }
                        .buttonStyle(.lunex(.primary, size: .compact))
                        .disabled(goal.status == GoalStatus.completed.rawValue)
                    Button(localizer("goals.withdraw")) { contribute(.withdrawal) }
                        .buttonStyle(.lunex(.secondary, size: .compact))
                        .disabled(goal.savedAmount <= 0)
                }
                .buttonStyle(.borderless)
            }
        }
    }

    private func caption(_ schedule: GoalSchedule?) -> String {
        var parts = ["\(goal.progress)%"]
        if goal.status == GoalStatus.paused.rawValue {
            parts.append(localizer("goals.status.paused"))
        } else if let schedule {
            parts.append(localizer.format("goals.needPerDay", localizer.amount(schedule.perDay, currency: goal.currency, showCurrency: true)))
        }
        return parts.joined(separator: " · ")
    }
}

/// Emoji, title, percent, a bar in the goal's color and «8 400 000 из 15 000 000 сум · без срока».
struct GoalRow: View {
    let goal: GoalRecord
    @Environment(GoalBook.self) private var book
    @Environment(Localizer.self) private var localizer

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space3) {
            GoalEmoji(goal: goal, size: LunexTheme.Size.iconWell)
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
                HStack {
                    Text(goal.title)
                        .lunexText(.bodyStrong)
                        .foregroundStyle(LunexColor.ink)
                        .lineLimit(1)
                    Spacer(minLength: LunexTheme.Spacing.space2)
                    Text("\(goal.progress)%")
                        .lunexText(.callout, weight: .medium)
                        .monospacedDigit()
                        .foregroundStyle(LunexColor.ink)
                }
                ProgressBar(progress: Double(goal.progress) / 100, tint: Color(hex: goal.color) ?? LunexColor.dataSteel)
                Text(caption)
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, LunexTheme.Spacing.space2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var caption: String {
        let amounts = localizer.format(
            "goals.savedOfTarget",
            localizer.amount(goal.savedAmount, currency: goal.currency),
            localizer.amount(goal.targetAmount, currency: goal.currency, showCurrency: true)
        )
        let state: String
        switch GoalStatus(rawValue: goal.status) ?? .active {
        case .paused: state = localizer("goals.status.paused")
        case .completed: state = localizer("goals.status.completed")
        case .archived: state = localizer("goals.status.archived")
        case .active:
            if let schedule = book.schedule(for: goal), schedule.status != .onTrack {
                state = localizer("goals.schedule.\(schedule.status.rawValue)").lowercased(with: localizer.locale)
            } else {
                state = localizer.goalDeadline(goal, book: book)
            }
        }
        return amounts + " · " + state
    }
}

/// The goal's emoji on a soft wash of its color.
struct GoalEmoji: View {
    let goal: GoalRecord
    let size: CGFloat

    var body: some View {
        Text(goal.emoji)
            .font(.system(size: size * 0.5))
            .frame(width: size, height: size)
            .background((Color(hex: goal.color) ?? LunexColor.dataSteel).opacity(0.16), in: Circle())
            .accessibilityHidden(true)
    }
}

/// «В графике», «Отстаёт», «Опережает» with a dot: steel, red, sage.
struct ScheduleBadge: View {
    let status: ScheduleStatus
    @Environment(Localizer.self) private var localizer

    var body: some View {
        StatusBadge(localizer("goals.schedule.\(status.rawValue)"), dot: color)
    }

    private var color: Color {
        switch status {
        case .onTrack: LunexColor.dataSteel
        case .behind: LunexColor.negative
        case .ahead: Color(hex: "#6E8B74") ?? LunexColor.dataSteel
        }
    }
}

extension Localizer {
    /// «к 1 июня 2027» or «без срока».
    func goalDeadline(_ goal: GoalRecord, book: GoalBook) -> String {
        // Said inside a line («Основная · без срока»), so in lower case.
        guard let deadline = goal.deadline.flatMap(book.date(fromKey:)) else {
            return self("goals.noDeadline").lowercased(with: locale)
        }
        return format("goals.by", deadline.formatted(.dateTime.day().month(.wide).year().locale(locale)))
    }

    /// Why a goal change was refused, in words.
    func goalMessage(_ error: Error) -> String {
        guard let error = error as? GoalError else { return self("add.saveFailed") }
        return switch error {
        case .invalidTitle: self("goals.error.invalidTitle")
        case .invalidAmount: self("goals.error.invalidAmount")
        case .deadlineInPast: self("goals.error.deadlineInPast")
        case .notFound: self("catalog.error.notFound")
        case .goalCompleted: self("goals.error.goalCompleted")
        case .goalArchived: self("goals.error.goalArchived")
        case .insufficientFunds: self("goals.error.insufficientFunds")
        case .hasMoney: self("goals.error.hasMoney")
        case .notLive: self("goals.error.notLive")
        case .invalidLinkedAccount: self("goals.error.invalidLinkedAccount")
        case .rateUnavailable: self("goals.error.rateUnavailable")
        }
    }
}
