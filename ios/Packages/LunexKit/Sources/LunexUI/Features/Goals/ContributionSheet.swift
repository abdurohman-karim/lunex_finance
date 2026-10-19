import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

struct ContributionTarget: Identifiable, Hashable {
    let goalId: UUID
    var kind: ContributionKind
    var id: String { goalId.uuidString + kind.rawValue }
}

/// Deposit into or withdraw from a goal: amount on the keypad, the account the money comes from
/// or goes to. Reports what the deposit reached (milestones, the target) to celebrate it.
struct ContributionSheet: View {
    let target: ContributionTarget
    let onDone: (ContributionOutcome) -> Void

    @Environment(GoalBook.self) private var book
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss

    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil }) private var goals: [GoalRecord]
    @Query(sort: \AccountRecord.sortOrder) private var allAccounts: [AccountRecord]
    @Query private var settings: [SettingsRecord]

    @State private var kind: ContributionKind
    @State private var amount = AmountInput(fractionDigits: 0)
    @State private var accountId: UUID?
    @State private var isLoaded = false
    @State private var errorMessage: String?
    @State private var keyTaps = 0
    @State private var saves = 0
    @State private var failures = 0

    init(target: ContributionTarget, onDone: @escaping (ContributionOutcome) -> Void) {
        self.target = target
        self.onDone = onDone
        _kind = State(initialValue: target.kind)
    }

    var body: some View {
        let goal = goals.first { $0.id == target.goalId }
        VStack(spacing: 0) {
            HStack(spacing: LunexTheme.Spacing.space3) {
                Picker(localizer("goals.contribution.kind"), selection: $kind) {
                    Text(localizer("goals.deposit")).tag(ContributionKind.deposit)
                    Text(localizer("goals.withdraw")).tag(ContributionKind.withdrawal)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                IconButton(localizer("add.close"), systemImage: "xmark") { dismiss() }
            }
            .padding(.top, LunexTheme.Spacing.space6)
            .padding(.bottom, 20)

            if let goal {
                VStack(spacing: LunexTheme.Spacing.space3) {
                    HStack(spacing: LunexTheme.Spacing.space2) {
                        GoalEmoji(goal: goal, size: 32)
                        Text(goal.title)
                            .lunexText(.bodyStrong)
                            .foregroundStyle(LunexColor.ink)
                            .lineLimit(1)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(amount.isEmpty ? "0" : amount.display(
                            decimalSeparator: localizer.locale.decimalSeparator ?? ",",
                            groupingSeparator: localizer.locale.groupingSeparator ?? " "
                        ))
                        .lunexText(.amountHero)
                        .foregroundStyle(amount.isEmpty ? LunexColor.inkFaint : LunexColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)
                        Text(localizer.currencyName(goal.currency))
                            .lunexText(.body)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                    Text(info(goal))
                        .lunexText(.callout)
                        .foregroundStyle(errorMessage == nil ? LunexColor.inkMuted : LunexColor.negative)
                        .multilineTextAlignment(.center)
                    accountMenu(goal)
                }
                .frame(maxWidth: .infinity)
            }
            Spacer(minLength: LunexTheme.Spacing.space4)
            Keypad(
                fractionDigits: amount.fractionDigits,
                canSave: (amount.value ?? 0) > 0 && goal != nil,
                press: { key in
                    errorMessage = nil
                    amount.press(key)
                    keyTaps += 1
                },
                done: { if let goal { save(goal) } }
            )
        }
        .padding(.horizontal, LunexTheme.Spacing.space4)
        .padding(.bottom, LunexTheme.Spacing.space2)
        .background(LunexColor.surface)
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(LunexTheme.Radius.large)
        .presentationBackground(LunexColor.surface)
        .onAppear { if let goal { load(goal) } }
        .sensoryFeedback(.selection, trigger: keyTaps)
        .sensoryFeedback(.success, trigger: saves)
        .sensoryFeedback(.error, trigger: failures)
    }

    private var accounts: [AccountRecord] {
        allAccounts.filter { $0.deletedAt == nil && !$0.isArchived }
    }

    private func accountMenu(_ goal: GoalRecord) -> some View {
        let chosen = accounts.first { $0.id == accountId }
        return Menu {
            Picker(localizer("add.account"), selection: $accountId) {
                ForEach(accounts) { account in
                    Text(account.id == goal.linkedAccountId ? localizer.format("goals.linkedMark", account.name) : account.name)
                        .tag(Optional(account.id))
                }
                Text(localizer("goals.noAccount")).tag(UUID?.none)
            }
        } label: {
            ChipLabel(
                localizer(kind == .deposit ? "goals.from" : "goals.to") + " " + (chosen?.name ?? localizer("goals.noAccount")),
                trailingImage: "chevron.down",
                isSelected: false,
                size: .small
            )
        }
        .menuIndicator(.hidden)
    }

    private func info(_ goal: GoalRecord) -> String {
        if let errorMessage { return errorMessage }
        if kind == .withdrawal {
            return localizer.format("goals.canWithdraw", localizer.amount(goal.savedAmount, currency: goal.currency, showCurrency: true))
        }
        let left = max(0, goal.targetAmount - goal.savedAmount)
        return localizer.format("goals.leftToSave", localizer.amount(left, currency: goal.currency, showCurrency: true))
    }

    private func load(_ goal: GoalRecord) {
        guard !isLoaded else { return }
        isLoaded = true
        amount = AmountInput(fractionDigits: Money.fractionDigits(for: goal.currency))
        // The default account, or the first one in the goal's currency.
        let preferred = settings.first?.defaultAccountId
        accountId = (accounts.first { $0.id == preferred && $0.currency == goal.currency }
            ?? accounts.first { $0.currency == goal.currency && $0.id != goal.linkedAccountId }
            ?? accounts.first { $0.id == preferred })?.id
    }

    private func save(_ goal: GoalRecord) {
        guard let value = amount.value, value > 0 else { return }
        do {
            let outcome = try book.contribute(to: goal.id, kind: kind, amount: value, accountId: accountId)
            saves += 1
            let deposit = kind == .deposit
            let book = book
            if !outcome.completed {
                toasts.show(localizer(deposit ? "goals.deposited" : "goals.withdrawn"), actionTitle: localizer("common.undo")) {
                    try? book.removeContribution(outcome.id)
                }
            }
            dismiss()
            onDone(outcome)
        } catch {
            failures += 1
            errorMessage = localizer.goalMessage(error)
        }
    }
}

// MARK: - Reached

/// «Цель достигнута!» with a burst of the goal's color, and the way to the next goal.
struct GoalReachedView: View {
    let goalId: UUID
    let chooseNext: () -> Void

    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil }) private var goals: [GoalRecord]
    @State private var burst = false

    var body: some View {
        let goal = goals.first { $0.id == goalId }
        let tint = Color(hex: goal?.color) ?? LunexColor.dataSteel
        VStack(spacing: LunexTheme.Spacing.space6) {
            Spacer()
            ZStack {
                ForEach(0..<16, id: \.self) { index in
                    Circle()
                        .fill(index.isMultiple(of: 2) ? tint : LunexColor.dataSand)
                        .frame(width: 10, height: 10)
                        .offset(y: burst ? -130 : 0)
                        .rotationEffect(.degrees(Double(index) / 16 * 360))
                        .opacity(burst ? 0 : 1)
                }
                Text(goal?.emoji ?? "🎯")
                    .font(.system(size: 88))
                    .frame(width: 168, height: 168)
                    .background(tint.opacity(0.16), in: Circle())
                    .scaleEffect(burst ? 1 : 0.6)
            }
            .accessibilityHidden(true)
            VStack(spacing: LunexTheme.Spacing.space2) {
                Text(localizer("goals.reachedTitle"))
                    .lunexText(.titleL)
                    .foregroundStyle(LunexColor.ink)
                if let goal {
                    Text(goal.title + " · " + localizer.amount(goal.savedAmount, currency: goal.currency, showCurrency: true))
                        .lunexText(.body)
                        .foregroundStyle(LunexColor.inkMuted)
                        .multilineTextAlignment(.center)
                }
                Text(localizer("goals.reachedBody"))
                    .lunexText(.callout)
                    .foregroundStyle(LunexColor.inkMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: LunexTheme.Spacing.space2) {
                Button(localizer("goals.nextGoal")) {
                    dismiss()
                    chooseNext()
                }
                .buttonStyle(.lunex(.primary))
                Button(localizer("add.done")) { dismiss() }
                    .buttonStyle(.lunex(.quiet))
            }
        }
        .padding(LunexTheme.Spacing.space6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .sensoryFeedback(.success, trigger: burst)
        .onAppear {
            withAnimation(reduceMotion ? nil : .spring(duration: 0.9, bounce: 0.35)) { burst = true }
        }
    }
}
