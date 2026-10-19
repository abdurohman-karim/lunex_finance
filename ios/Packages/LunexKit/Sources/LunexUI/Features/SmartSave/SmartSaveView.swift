import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// The home screen's Smart Save card: today's safe amount for the primary goal with
/// «Отложить» and «Не сегодня», or why there is none today. Tapping opens the explanation.
struct SmartSaveCard: View {
    let month: BudgetMonth
    let createGoal: () -> Void

    @Environment(SmartSaveStore.self) private var smartSave
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Query private var settings: [SettingsRecord]
    @Query(filter: #Predicate<GoalRecord> { $0.deletedAt == nil }) private var goals: [GoalRecord]

    @State private var details: SmartSaveDetails?
    @State private var reached: ReachedGoal?
    @State private var isWorking = false

    var body: some View {
        if settings.first?.smartSaveEnabled ?? true, let today = smartSave.today {
            card(today)
                .sheet(item: $details) { item in
                    SmartSaveSheet(today: item.today, month: month) { outcome, goalId in
                        finish(outcome, goalId: goalId)
                    }
                }
                .fullScreen(item: $reached) { goal in
                    GoalReachedView(goalId: goal.id, chooseNext: createGoal)
                }
        }
    }

    @ViewBuilder
    private func card(_ today: SmartSaveToday) -> some View {
        Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                HStack {
                    SectionLabel("Smart Save")
                    Spacer()
                    if today.suggestion != nil || today.explanation != nil {
                        Button(localizer("smartSave.why")) { details = SmartSaveDetails(today: today) }
                            .lunexText(.caption, weight: .medium)
                            .foregroundStyle(LunexColor.inkMuted)
                            .buttonStyle(.borderless)
                    }
                }
                switch today.status {
                case .available:
                    if let suggestion = today.suggestion {
                        available(suggestion)
                    }
                case .alreadySaved:
                    line(
                        localizer.format(
                            "smartSave.savedToday",
                            amount(today.suggestion?.acceptedAmount ?? today.suggestion?.amount ?? 0, today.suggestion?.currency),
                            today.suggestion?.goal.title ?? ""
                        ),
                        icon: "checkmark.circle"
                    )
                case .declined:
                    line(localizer("smartSave.declinedToday"), icon: "moon")
                case .noGoal:
                    noGoal
                default:
                    line(reason(today), icon: "info.circle")
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if today.suggestion != nil || today.explanation != nil {
                details = SmartSaveDetails(today: today)
            }
        }
    }

    private func available(_ suggestion: SmartSaveSuggestion) -> some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
            (Text(localizer("smartSave.offer.before") + " ")
                + Text(amount(suggestion.amount, suggestion.currency)).bold()
                + Text(" " + localizer.format("smartSave.offer.after", suggestion.goal.title)))
                .lunexText(.body)
                .foregroundStyle(LunexColor.ink)
            if suggestion.isForeign {
                Text("≈ " + localizer.amount(suggestion.amountBase, currency: suggestion.explanation.baseCurrency, showCurrency: true))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
            }
            Text(localizer.format(
                "smartSave.limitAfter",
                localizer.amount(month.dailyLimit(afterSaving: suggestion.amountBase), currency: month.currency, showCurrency: true)
            ))
            .lunexText(.caption)
            .foregroundStyle(LunexColor.inkMuted)
            HStack(spacing: LunexTheme.Spacing.space2) {
                Button(localizer("smartSave.accept")) { accept(suggestion) }
                    .buttonStyle(.lunex(.primary, size: .compact))
                    .disabled(isWorking)
                Button(localizer("smartSave.change")) { details = SmartSaveDetails(today: smartSave.today ?? SmartSaveToday(status: .available, suggestion: suggestion)) }
                    .buttonStyle(.lunex(.secondary, size: .compact))
            }
            .lineLimit(1)
            Button(localizer("smartSave.decline")) { decline(suggestion) }
                .buttonStyle(.lunex(.quiet))
                .padding(.leading, -LunexTheme.Spacing.space3)
                .padding(.top, -LunexTheme.Spacing.space2)
                .disabled(isWorking)
        }
    }

    @ViewBuilder
    private var noGoal: some View {
        let reachedOnly = !goals.isEmpty && !goals.contains { GoalStatus(rawValue: $0.status)?.isLive == true }
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
            Text(localizer(reachedOnly ? "smartSave.goalReached" : "smartSave.noGoal"))
                .lunexText(.body)
                .foregroundStyle(LunexColor.ink)
            Button(localizer(reachedOnly ? "goals.nextGoal" : "goals.new"), action: createGoal)
                .buttonStyle(.lunex(.secondary, size: .compact))
                .buttonStyle(.borderless)
        }
    }

    private func line(_ text: String, icon: String) -> some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: icon)
        }
        .lunexText(.callout)
        .foregroundStyle(LunexColor.inkMuted)
    }

    private func reason(_ today: SmartSaveToday) -> String {
        switch today.status {
        case .noSpareMoney: localizer("smartSave.noSpareMoney")
        case .tooSmall:
            localizer.format("smartSave.tooSmall", amount(SmartSaveSteps.step(for: today.explanation?.goalCurrency ?? month.currency), today.explanation?.goalCurrency))
        case .insufficientBalance: localizer("smartSave.insufficientBalance")
        case .exchangeRateUnavailable: localizer("smartSave.noRate")
        default: ""
        }
    }

    private func amount(_ value: Decimal, _ currency: String?) -> String {
        localizer.amount(value, currency: currency ?? month.currency, showCurrency: true)
    }

    private func accept(_ suggestion: SmartSaveSuggestion) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                finish(try await smartSave.accept(suggestion), goalId: suggestion.goal.id)
            } catch {
                toasts.show(localizer.smartSaveMessage(error))
            }
        }
    }

    private func decline(_ suggestion: SmartSaveSuggestion) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await smartSave.decline(suggestion)
            } catch {
                toasts.show(localizer.smartSaveMessage(error))
            }
        }
    }

    private func finish(_ outcome: SmartSaveOutcome, goalId: UUID) {
        switch outcome {
        case let .saved(saved, milestones, completed):
            if completed {
                reached = ReachedGoal(id: goalId)
            } else {
                let title = smartSave.today?.suggestion?.goal.title ?? ""
                var text = localizer.format("smartSave.savedToast", localizer.amount(saved, currency: smartSave.today?.suggestion?.currency ?? month.currency, showCurrency: true), title)
                if let milestone = milestones.last { text += " · " + localizer.format("goals.milestoneToast", milestone) }
                toasts.show(text)
            }
        case let .amountChanged(fresh):
            toasts.show(localizer.format("smartSave.amountChanged", localizer.amount(fresh.amount, currency: fresh.currency, showCurrency: true)))
        case .suggestionChanged:
            toasts.show(localizer("smartSave.suggestionChanged"))
        case let .unavailable(today):
            toasts.show(today.status == .alreadySaved ? localizer("smartSave.alreadySaved") : reason(today))
        }
    }
}

private struct SmartSaveDetails: Identifiable {
    let id = UUID()
    let today: SmartSaveToday
}

// MARK: - Explanation and confirmation

/// Why the amount is what it is, the slider to lower it, and «Отложить» with a fresh
/// recalculation: a lower safe amount takes nothing and shows the new one here.
struct SmartSaveSheet: View {
    let month: BudgetMonth
    let onFinish: (SmartSaveOutcome, UUID) -> Void

    @Environment(SmartSaveStore.self) private var smartSave
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Query private var accounts: [AccountRecord]

    @State private var today: SmartSaveToday
    @State private var chosen: Double
    @State private var notice: String?
    @State private var isWorking = false
    @State private var saves = 0

    init(today: SmartSaveToday, month: BudgetMonth, onFinish: @escaping (SmartSaveOutcome, UUID) -> Void) {
        self.month = month
        self.onFinish = onFinish
        _today = State(initialValue: today)
        _chosen = State(initialValue: NSDecimalNumber(decimal: today.suggestion?.amount ?? 0).doubleValue)
    }

    private var suggestion: SmartSaveSuggestion? {
        today.status == .available ? today.suggestion : nil
    }

    private var explanation: SmartSaveExplanation? {
        today.suggestion?.explanation ?? today.explanation
    }

    var body: some View {
        NavigationStack {
            List {
                if let suggestion {
                    Section {
                        offer(suggestion)
                            .listRowBackground(LunexColor.surface)
                    }
                }
                if let explanation {
                    Section {
                        why(explanation)
                            .listRowBackground(LunexColor.surface)
                    } header: {
                        SectionLabel(localizer("smartSave.whyTitle"))
                    } footer: {
                        Text(localizer("smartSave.rules"))
                    }
                }
            }
            .groupedLists()
            .scrollContentBackground(.hidden)
            .background(LunexColor.paper)
            .navigationTitle("Smart Save")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer("add.close")) { dismiss() }
                }
            }
            .sensoryFeedback(.success, trigger: saves)
        }
        .tint(LunexColor.ink)
    }

    // MARK: Offer

    private func offer(_ suggestion: SmartSaveSuggestion) -> some View {
        let picked = pickedAmount(suggestion)
        let base = suggestion.isForeign
            ? (suggestion.explanation.rate.map { picked / $0 } ?? suggestion.amountBase)
            : picked
        return VStack(alignment: .leading, spacing: LunexTheme.Spacing.space4) {
            HStack(spacing: LunexTheme.Spacing.space2) {
                Text(suggestion.goal.emoji).font(.system(size: 22))
                Text(localizer.format("smartSave.toGoal", suggestion.goal.title))
                    .lunexText(.bodyStrong)
                    .foregroundStyle(LunexColor.ink)
            }
            AmountDisplay(
                value: localizer.amount(picked, currency: suggestion.currency),
                currency: localizer.currencyName(suggestion.currency),
                caption: suggestion.isForeign
                    ? "≈ " + localizer.amount(base, currency: suggestion.explanation.baseCurrency, showCurrency: true)
                    : nil
            )
            if suggestion.amount > SmartSaveSteps.step(for: suggestion.currency) {
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
                    Text(localizer("smartSave.change"))
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.inkMuted)
                    Slider(
                        value: $chosen,
                        in: SmartSaveSteps.range(upTo: suggestion.amount, currency: suggestion.currency),
                        step: NSDecimalNumber(decimal: SmartSaveSteps.step(for: suggestion.currency)).doubleValue
                    )
                    .tint(LunexColor.dataSteel)
                    .accessibilityLabel(localizer("smartSave.change"))
                    .accessibilityValue(localizer.amount(picked, currency: suggestion.currency, showCurrency: true))
                }
            }
            Text(localizer.format(
                "smartSave.limitAfter",
                localizer.amount(month.dailyLimit(afterSaving: base), currency: month.currency, showCurrency: true)
            ))
            .lunexText(.callout)
            .foregroundStyle(LunexColor.inkMuted)
            if let account = accounts.first(where: { $0.id == suggestion.explanation.accountId }) {
                Text(localizer.format("smartSave.fromAccount", account.name))
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
            }
            if let notice {
                Text(notice)
                    .lunexText(.callout, weight: .medium)
                    .foregroundStyle(LunexColor.negative)
            }
            VStack(spacing: LunexTheme.Spacing.space2) {
                Button(localizer.format("smartSave.acceptAmount", localizer.amount(picked, currency: suggestion.currency, showCurrency: true))) {
                    accept(suggestion)
                }
                .buttonStyle(.lunex(.primary))
                .disabled(isWorking)
                Button(localizer("smartSave.decline")) { decline(suggestion) }
                    .buttonStyle(.lunex(.quiet))
                    .disabled(isWorking)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, LunexTheme.Spacing.space2)
    }

    /// The slider's amount, never above the suggestion.
    private func pickedAmount(_ suggestion: SmartSaveSuggestion) -> Decimal {
        let picked = Decimal(chosen).rounded(Money.fractionDigits(for: suggestion.currency))
        return min(max(picked, 0), suggestion.amount)
    }

    // MARK: Why

    private func why(_ e: SmartSaveExplanation) -> some View {
        let base = e.baseCurrency
        let money = { (value: Decimal) in localizer.amount(value, currency: base) }
        let minus = { (value: Decimal) in localizer.amount(-value, currency: base, signed: true) }
        return VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
            WhyRow(title: localizer("smartSave.why.income"), value: money(e.monthIncome))
            WhyRow(title: localizer("smartSave.why.expenses"), value: minus(e.monthExpenses))
            if e.upcomingRecurring != 0 {
                WhyRow(title: localizer("smartSave.why.recurring"), value: minus(e.upcomingRecurring))
            }
            if e.savedToGoals > 0 {
                WhyRow(title: localizer("smartSave.why.saved"), value: minus(e.savedToGoals))
            }
            Divider().overlay(LunexColor.line)
            WhyRow(title: localizer("smartSave.why.free"), value: money(e.freeMoney), isStrong: true)
            WhyRow(title: localizer.format("smartSave.why.perDay", e.daysLeft), value: money(e.perDay))
            WhyRow(title: localizer.format("smartSave.why.share", e.sharePercent), value: money(e.perDay * Decimal(e.sharePercent) / 100))
            if let rate = e.rate, rate > 0, let goalCurrency = e.goalCurrency {
                Text(localizer.format(
                    "smartSave.why.rate",
                    localizer.amount(1, currency: goalCurrency, showCurrency: true),
                    localizer.amount(1 / rate, currency: base, showCurrency: true)
                ))
                .lunexText(.caption)
                .foregroundStyle(LunexColor.inkMuted)
            }
            switch e.cappedBy {
            case "goal_remaining":
                capped(localizer.format("smartSave.why.cappedGoal", localizer.amount(e.goalRemaining ?? 0, currency: e.goalCurrency ?? base, showCurrency: true)))
            case "account_balance":
                capped(localizer.format("smartSave.why.cappedAccount", localizer.amount(e.accountBalance ?? 0, currency: e.goalCurrency ?? base, showCurrency: true)))
            default:
                EmptyView()
            }
            Text(localizer.format("smartSave.why.rounded", localizer.amount(SmartSaveSteps.step(for: e.goalCurrency ?? base), currency: e.goalCurrency ?? base, showCurrency: true)))
                .lunexText(.caption)
                .foregroundStyle(LunexColor.inkMuted)
        }
        .padding(.vertical, LunexTheme.Spacing.space1)
    }

    private func capped(_ text: String) -> some View {
        Label(text, systemImage: "arrow.down.to.line")
            .lunexText(.caption)
            .foregroundStyle(LunexColor.inkMuted)
    }

    // MARK: Actions

    private func accept(_ suggestion: SmartSaveSuggestion) {
        let picked = pickedAmount(suggestion)
        isWorking = true
        notice = nil
        Task {
            defer { isWorking = false }
            do {
                let outcome = try await smartSave.accept(suggestion, amount: picked < suggestion.amount ? picked : nil)
                switch outcome {
                case .saved:
                    saves += 1
                    dismiss()
                    onFinish(outcome, suggestion.goal.id)
                case let .amountChanged(fresh), let .suggestionChanged(fresh):
                    // Nothing was taken: show the new figures right here.
                    today = SmartSaveToday(status: .available, suggestion: fresh)
                    chosen = NSDecimalNumber(decimal: fresh.amount).doubleValue
                    notice = fresh.goal.id == suggestion.goal.id
                        ? localizer.format("smartSave.amountChanged", localizer.amount(fresh.amount, currency: fresh.currency, showCurrency: true))
                        : localizer("smartSave.suggestionChanged")
                case let .unavailable(fresh):
                    today = fresh
                    dismiss()
                    onFinish(outcome, suggestion.goal.id)
                }
            } catch {
                notice = localizer.smartSaveMessage(error)
            }
        }
    }

    private func decline(_ suggestion: SmartSaveSuggestion) {
        isWorking = true
        Task {
            defer { isWorking = false }
            do {
                try await smartSave.decline(suggestion)
                dismiss()
            } catch {
                notice = localizer.smartSaveMessage(error)
            }
        }
    }
}

private struct WhyRow: View {
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

extension Localizer {
    /// Why Smart Save could not do it, in words.
    func smartSaveMessage(_ error: Error) -> String {
        guard let error = error as? APIError else { return self("add.saveFailed") }
        if error.isOffline { return self("smartSave.offline") }
        return switch error.code {
        case "already_saved": self("smartSave.alreadySaved")
        case "suggestion_expired": self("smartSave.expired")
        default: self("add.saveFailed")
        }
    }
}

private extension Decimal {
    func rounded(_ digits: Int) -> Decimal {
        BudgetMath.rounded(self, digits, .down)
    }
}
