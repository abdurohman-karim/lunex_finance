import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// A goal: progress ring, the contribution plan against the deadline, milestones, actions
/// (deposit, withdraw, primary, pause, complete, archive, bring back, edit, delete) and every
/// contribution with its source; a swipe undoes one.
struct GoalDetailView: View {
    let goalId: UUID

    @Environment(GoalBook.self) private var book
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss

    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil }) private var goals: [GoalRecord]
    @Query private var contributions: [ContributionRecord]
    @Query private var accounts: [AccountRecord]

    @State private var editor: GoalEditorTarget?
    @State private var contribution: ContributionTarget?
    @State private var reached: ReachedGoal?
    @State private var confirmsDelete = false

    init(goalId: UUID) {
        self.goalId = goalId
        _contributions = Query(
            filter: #Predicate<ContributionRecord> { $0.goalId == goalId && $0.deletedAt == nil },
            sort: \ContributionRecord.createdAt, order: .reverse
        )
    }

    var body: some View {
        if let goal = goals.first(where: { $0.id == goalId }) {
            content(goal)
        } else {
            ContentUnavailableView(localizer("goals.gone"), systemImage: "target")
                .background(LunexColor.paper)
        }
    }

    private func content(_ goal: GoalRecord) -> some View {
        let status = GoalStatus(rawValue: goal.status) ?? .active
        let schedule = book.schedule(for: goal)
        return List {
            Section {
                header(goal, status: status)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if status.isLive {
                Section {
                    plan(goal, schedule: schedule)
                        .listRowBackground(LunexColor.surface)
                } header: {
                    SectionLabel(localizer("goals.plan"))
                }
            }
            Section {
                milestones(goal)
                    .listRowBackground(LunexColor.surface)
            } header: {
                SectionLabel(localizer("goals.milestones"))
            }
            Section {
                if contributions.isEmpty {
                    Text(localizer("goals.noContributions"))
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                        .listRowBackground(LunexColor.surface)
                }
                ForEach(contributions) { item in
                    ContributionRow(contribution: item, account: accounts.first { $0.id == item.accountId })
                        .listRowBackground(LunexColor.surface)
                        .swipeActions(edge: .trailing) {
                            Button(localizer("goals.undoContribution"), systemImage: "arrow.uturn.backward") {
                                undo(item)
                            }
                            .tint(LunexColor.negative)
                        }
                }
            } header: {
                SectionLabel(localizer("goals.history"))
            }
        }
        .groupedLists()
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(goal.title)
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .primaryAction) { menu(goal, status: status) }
        }
        .sheet(item: $editor) { target in
            GoalEditor(target: target)
        }
        .sheet(item: $contribution) { target in
            ContributionSheet(target: target) { outcome in
                if outcome.completed {
                    reached = ReachedGoal(id: goal.id)
                } else if let milestone = outcome.newMilestones.last {
                    toasts.show(localizer.format("goals.milestoneToast", milestone))
                }
            }
        }
        .fullScreen(item: $reached) { goal in
            GoalReachedView(goalId: goal.id) { editor = .new }
        }
        .confirmationDialog(localizer("goals.delete.confirm"), isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button(localizer("goals.delete"), role: .destructive) {
                run {
                    try book.delete(goal.id)
                    dismiss()
                }
            }
        }
    }

    // MARK: Sections

    private func header(_ goal: GoalRecord, status: GoalStatus) -> some View {
        Card {
            VStack(spacing: LunexTheme.Spacing.space4) {
                ProgressRing(
                    progress: Double(goal.progress) / 100,
                    tint: Color(hex: goal.color) ?? LunexColor.dataSteel,
                    lineWidth: 8
                ) {
                    VStack(spacing: LunexTheme.Spacing.space1) {
                        Text(goal.emoji).font(.system(size: 34))
                        Text("\(goal.progress)%")
                            .lunexText(.amountM)
                            .foregroundStyle(LunexColor.ink)
                    }
                }
                .frame(width: 168, height: 168)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(goal.title)
                .accessibilityValue("\(goal.progress)%")

                VStack(spacing: LunexTheme.Spacing.space1) {
                    Text(localizer.amount(goal.savedAmount, currency: goal.currency, showCurrency: true))
                        .lunexText(.amountL)
                        .foregroundStyle(LunexColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                    Text(localizer.format("goals.ofTarget", localizer.amount(goal.targetAmount, currency: goal.currency, showCurrency: true))
                        + " · " + localizer.goalDeadline(goal, book: book))
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                        .multilineTextAlignment(.center)
                }
                HStack(spacing: LunexTheme.Spacing.space2) {
                    if goal.isPrimary { StatusBadge(localizer("goals.primary"), isProminent: true) }
                    if status != .active { StatusBadge(localizer("goals.status.\(status.rawValue)")) }
                    if let linked = accounts.first(where: { $0.id == goal.linkedAccountId }) {
                        StatusBadge(localizer.format("goals.inAccount", linked.name))
                    }
                }
                HStack(spacing: LunexTheme.Spacing.space2) {
                    Button(localizer("goals.deposit")) { contribution = ContributionTarget(goalId: goal.id, kind: .deposit) }
                        .buttonStyle(.lunex(.primary, size: .compact))
                        .disabled(status == .completed || status == .archived)
                    Button(localizer("goals.withdraw")) { contribution = ContributionTarget(goalId: goal.id, kind: .withdrawal) }
                        .buttonStyle(.lunex(.secondary, size: .compact))
                        .disabled(goal.savedAmount <= 0)
                }
                .buttonStyle(.borderless)
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func plan(_ goal: GoalRecord, schedule: GoalSchedule?) -> some View {
        if let schedule {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                HStack {
                    ScheduleBadge(status: schedule.status)
                    Spacer()
                    Text(localizer.format("goals.daysLeft", schedule.daysLeft))
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.inkMuted)
                }
                PlanRow(title: localizer("goals.perDay"), value: localizer.amount(schedule.perDay, currency: goal.currency, showCurrency: true))
                PlanRow(title: localizer("goals.perWeek"), value: localizer.amount(schedule.perWeek, currency: goal.currency, showCurrency: true))
                PlanRow(title: localizer("goals.perMonth"), value: localizer.amount(schedule.perMonth, currency: goal.currency, showCurrency: true))
                Text(localizer.format("goals.expected", localizer.amount(schedule.expectedSaved, currency: goal.currency, showCurrency: true)))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
            }
            .padding(.vertical, LunexTheme.Spacing.space1)
        } else {
            Text(localizer("goals.noPlan"))
                .lunexText(.callout)
                .foregroundStyle(LunexColor.inkMuted)
        }
    }

    private func milestones(_ goal: GoalRecord) -> some View {
        let tint = Color(hex: goal.color) ?? LunexColor.dataSteel
        return HStack(spacing: LunexTheme.Spacing.space2) {
            ForEach(GoalMath.milestones, id: \.self) { percent in
                let done = goal.milestones.contains(percent) || goal.progress >= percent
                Text("\(percent)%")
                    .lunexText(.callout, weight: .semibold)
                    .foregroundStyle(done ? Color.white : LunexColor.inkMuted)
                    .frame(maxWidth: .infinity, minHeight: 40)
                    .background(done ? tint : LunexColor.surfaceSunken, in: Capsule())
                    .accessibilityLabel("\(percent)%")
                    .accessibilityValue(localizer(done ? "goals.milestone.done" : "goals.milestone.ahead"))
            }
        }
        .padding(.vertical, LunexTheme.Spacing.space1)
        .animation(.spring(duration: 0.5, bounce: 0.4), value: goal.milestones)
    }

    private func menu(_ goal: GoalRecord, status: GoalStatus) -> some View {
        Menu {
            Button(localizer("goals.edit"), systemImage: "pencil") { editor = .edit(goal.id) }
            if status.isLive, !goal.isPrimary {
                Button(localizer("goals.makePrimary"), systemImage: "star") { run { try book.makePrimary(goal.id) } }
            }
            switch status {
            case .active:
                Button(localizer("goals.pause"), systemImage: "pause") { run { try book.setStatus(goal.id, .paused) } }
                Button(localizer("goals.complete"), systemImage: "checkmark.circle") { run { try book.setStatus(goal.id, .completed) } }
            case .paused:
                Button(localizer("goals.resume"), systemImage: "play") { run { try book.setStatus(goal.id, .active) } }
                Button(localizer("goals.complete"), systemImage: "checkmark.circle") { run { try book.setStatus(goal.id, .completed) } }
            case .completed, .archived:
                // A reached target completes the goal again: bringing it back needs a bigger target.
                if goal.savedAmount < goal.targetAmount {
                    Button(localizer("goals.revive"), systemImage: "arrow.uturn.backward") { run { try book.setStatus(goal.id, .active) } }
                }
            }
            if status != .archived {
                Button(localizer("goals.archiveAction"), systemImage: "archivebox") { run { try book.setStatus(goal.id, .archived) } }
            }
            if goal.savedAmount <= 0 {
                Button(localizer("goals.delete"), systemImage: "trash", role: .destructive) { confirmsDelete = true }
            }
        } label: {
            Label(localizer("accounts.more"), systemImage: "ellipsis")
        }
    }

    private func run(_ change: () throws -> Void) {
        do {
            try change()
        } catch {
            toasts.show(localizer.goalMessage(error))
        }
    }

    private func undo(_ item: ContributionRecord) {
        run {
            try book.removeContribution(item.id)
            toasts.show(localizer("goals.contributionUndone"))
        }
    }
}

private struct PlanRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack {
            Text(title)
                .lunexText(.callout)
                .foregroundStyle(LunexColor.inkMuted)
            Spacer()
            Text(value)
                .lunexText(.callout, weight: .semibold)
                .monospacedDigit()
                .foregroundStyle(LunexColor.ink)
        }
        .accessibilityElement(children: .combine)
    }
}

/// «Пополнение · вручную», date and account, «+600 000».
private struct ContributionRow: View {
    let contribution: ContributionRecord
    let account: AccountRecord?
    @Environment(Localizer.self) private var localizer

    var body: some View {
        let deposit = contribution.type == ContributionKind.deposit.rawValue
        HStack(spacing: LunexTheme.Spacing.space3) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(LunexColor.ink)
                .frame(width: 36, height: 36)
                .background(LunexColor.surfaceSunken, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(localizer(deposit ? "goals.contribution.deposit" : "goals.contribution.withdrawal")
                    + " · " + localizer("goals.method.\(contribution.method)"))
                    .lunexText(.body)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(1)
                Text(subtitle)
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: LunexTheme.Spacing.space2)
            Text(localizer.amount(deposit ? contribution.amount : -contribution.amount, currency: contribution.currency, signed: true))
                .lunexText(.amountM)
                .foregroundStyle(LunexColor.ink)
        }
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        switch contribution.method {
        case "smart_save": "sparkles"
        case "auto_save": "repeat"
        case "round_up": "arrow.up.circle"
        default: contribution.type == ContributionKind.deposit.rawValue ? "arrow.down.to.line" : "arrow.up.to.line"
        }
    }

    private var subtitle: String {
        var parts = [contribution.createdAt.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(localizer.locale))]
        if let account { parts.append(account.name) }
        if let note = contribution.note, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }
}
