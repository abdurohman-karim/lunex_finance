import LunexCore
import LunexLocalization
import SwiftUI
import UserNotifications

/// First run after sign-in: language, base currency, focus, income, first goal, notifications.
/// Every step can be skipped; the answers go to the server in one request at the end, which
/// also opens the «Наличные» account.
struct OnboardingView: View {
    enum Step: Int, CaseIterable {
        case language, currency, focus, income, goal, notifications
    }

    @Environment(OnboardingService.self) private var onboarding
    @Environment(Localizer.self) private var localizer

    @State private var step = Step.language
    @State private var draft = OnboardingDraft(language: AppLanguage.preferred().rawValue)
    @State private var finishing = false
    @State private var errorText: String?
    @FocusState private var amountFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
                    titles
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            footer
        }
        .padding(.horizontal, LunexTheme.Spacing.space6)
        .padding(.top, LunexTheme.Spacing.space2)
        .padding(.bottom, LunexTheme.Spacing.space4)
        .background(LunexColor.paper)
        .animation(.default, value: step)
        .onAppear { draft.language = localizer.language.rawValue }
        .task(id: localizer.language) {
            // Goal names come in the chosen language.
            await onboarding.loadTemplates(language: localizer.language.rawValue)
            if let selected = draft.goalTemplate {
                draft.goalTemplate = onboarding.templates.first { $0.key == selected.key } ?? selected
            }
        }
    }

    // MARK: - Frame

    private var header: some View {
        HStack(spacing: LunexTheme.Spacing.space4) {
            IconButton(localizer("common.back"), systemImage: "chevron.left") { go(-1) }
                .opacity(step == .language ? 0 : 1)
                .disabled(step == .language || finishing)
            HStack(spacing: LunexTheme.Spacing.space1) {
                ForEach(Step.allCases, id: \.self) { item in
                    Capsule()
                        .fill(item.rawValue <= step.rawValue ? LunexColor.ink : LunexColor.line)
                        .frame(height: 3)
                }
            }
            .accessibilityElement()
            .accessibilityLabel(stepLabel)
        }
    }

    private var stepLabel: String {
        localizer.format("onboarding.step", step.rawValue + 1, Step.allCases.count)
    }

    private var titles: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            SectionLabel(stepLabel)
            Text(localizer("onboarding.\(key).title"))
                .lunexText(.titleL)
                .foregroundStyle(LunexColor.ink)
                .accessibilityAddTraits(.isHeader)
            Text(localizer("onboarding.\(key).subtitle"))
                .lunexText(.body)
                .foregroundStyle(LunexColor.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var key: String {
        switch step {
        case .language: "language"
        case .currency: "currency"
        case .focus: "focus"
        case .income: "income"
        case .goal: "goal"
        case .notifications: "notifications"
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .language: languageStep
        case .currency: currencyStep
        case .focus: focusStep
        case .income: incomeStep
        case .goal: goalStep
        case .notifications: notificationsStep
        }
    }

    private var footer: some View {
        VStack(spacing: LunexTheme.Spacing.space1) {
            if let errorText {
                Text(errorText)
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.negative)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, LunexTheme.Spacing.space2)
            }
            Button(action: primaryAction) {
                ZStack {
                    Text(localizer(step == .notifications ? "onboarding.notifications.allow" : "onboarding.next"))
                        .opacity(finishing ? 0 : 1)
                    if finishing {
                        ProgressView().tint(LunexColor.onInk)
                    }
                }
            }
            .buttonStyle(.lunex(.primary))
            .disabled(finishing || !canContinue)
            Button(localizer(step == .notifications ? "onboarding.notifications.later" : "onboarding.skip"), action: skip)
                .buttonStyle(.lunex(.quiet))
                .disabled(finishing)
        }
    }

    /// «Далее» needs an answer; «Пропустить» moves on without one.
    private var canContinue: Bool {
        switch step {
        case .focus: draft.focus != nil
        case .income: !draft.monthlyIncome.isEmpty
        case .goal: draft.hasValidGoal
        default: true
        }
    }

    // MARK: - Steps

    private var languageStep: some View {
        VStack(spacing: LunexTheme.Spacing.space3) {
            ForEach(AppLanguage.allCases) { language in
                ChoiceRow(title: language.displayName, isSelected: localizer.language == language) {
                    localizer.language = language
                    draft.language = language.rawValue
                }
            }
        }
    }

    private var currencyStep: some View {
        VStack(spacing: LunexTheme.Spacing.space3) {
            ForEach(SupportedCurrency.codes, id: \.self) { code in
                ChoiceRow(
                    title: localizer.locale.localizedString(forCurrencyCode: code)?.capitalizedFirst ?? code,
                    trailing: code,
                    isSelected: draft.currency == code
                ) {
                    draft.currency = code
                }
            }
        }
    }

    private var focusStep: some View {
        VStack(spacing: LunexTheme.Spacing.space3) {
            ForEach(OnboardingFocus.allCases, id: \.self) { focus in
                ChoiceRow(
                    title: localizer("onboarding.focus.\(focus.rawValue)"),
                    detail: localizer("onboarding.focus.\(focus.rawValue).detail"),
                    leading: .symbol(Self.symbol(for: focus)),
                    isSelected: draft.focus == focus
                ) {
                    draft.focus = focus
                }
            }
        }
    }

    private static func symbol(for focus: OnboardingFocus) -> String {
        switch focus {
        case .save: "target"
        case .track: "list.bullet"
        case .budget: "chart.pie"
        }
    }

    private var incomeStep: some View {
        AmountField(digits: $draft.monthlyIncome, currency: draft.currency, focused: $amountFocused)
            .onAppear { amountFocused = true }
    }

    private var goalStep: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space6) {
            // The amount comes first once a goal is picked, so the keyboard never hides it.
            if let template = draft.goalTemplate {
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
                    SectionLabel("\(template.name) · \(localizer("onboarding.goal.amount"))")
                    AmountField(digits: $draft.goalAmount, currency: draft.currency, focused: $amountFocused)
                }
                .transition(.opacity)
            }
            LazyVGrid(
                columns: [GridItem(.flexible(), spacing: LunexTheme.Spacing.space3), GridItem(.flexible())],
                spacing: LunexTheme.Spacing.space3
            ) {
                ForEach(onboarding.templates) { template in
                    TemplateTile(template: template, isSelected: draft.goalTemplate?.key == template.key) {
                        draft.goalTemplate = template
                        amountFocused = true
                    }
                }
            }
        }
    }

    private var notificationsStep: some View {
        Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space4) {
                ForEach(["moon", "sun.max", "chart.pie"], id: \.self) { symbol in
                    HStack(alignment: .firstTextBaseline, spacing: LunexTheme.Spacing.space3) {
                        Image(systemName: symbol)
                            .foregroundStyle(LunexColor.ink)
                            .frame(width: 24)
                        Text(localizer("onboarding.notifications.example.\(symbol)"))
                            .lunexText(.callout)
                            .foregroundStyle(LunexColor.ink)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    // MARK: - Actions

    private func go(_ delta: Int) {
        guard let next = Step(rawValue: step.rawValue + delta) else { return }
        errorText = nil
        amountFocused = false
        step = next
    }

    private func primaryAction() {
        if step == .notifications {
            // Blocks a second tap while the system asks for permission.
            finishing = true
            Task {
                let granted = (try? await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .badge, .sound])) ?? false
                await onboarding.reportNotifications(enabled: granted)
                await finish()
            }
        } else {
            go(1)
        }
    }

    private func skip() {
        switch step {
        case .focus: draft.focus = nil
        case .income: draft.monthlyIncome = ""
        case .goal: draft.goalTemplate = nil
        case .notifications:
            Task { await finish() }
            return
        default: break
        }
        go(1)
    }

    private func finish() async {
        errorText = nil
        finishing = true
        defer { finishing = false }
        do {
            // On success the session holds the completed profile and the app opens.
            try await onboarding.complete(draft)
        } catch {
            errorText = localizer.message(for: error)
        }
    }
}

// MARK: - Parts

/// One answer among several: a `surface` row, outlined in `ink` with a check when chosen.
private struct ChoiceRow: View {
    enum Leading {
        case symbol(String)
    }

    let title: String
    var detail: String?
    var leading: Leading?
    var trailing: String?
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: LunexTheme.Spacing.space4) {
                if case let .symbol(name) = leading {
                    Image(systemName: name)
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(LunexColor.ink)
                        .frame(width: LunexTheme.Size.iconWell, height: LunexTheme.Size.iconWell)
                        .background(LunexColor.surfaceSunken, in: Circle())
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .lunexText(.bodyStrong)
                        .foregroundStyle(LunexColor.ink)
                    if let detail {
                        Text(detail)
                            .lunexText(.callout)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                }
                Spacer(minLength: 0)
                if let trailing {
                    Text(trailing)
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                }
                ZStack {
                    Circle().strokeBorder(isSelected ? LunexColor.ink : LunexColor.line, lineWidth: 1.5)
                    if isSelected {
                        Circle().fill(LunexColor.ink)
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(LunexColor.onInk)
                    }
                }
                .frame(width: 24, height: 24)
            }
            .padding(LunexTheme.Spacing.space4)
            .frame(minHeight: LunexTheme.Size.controlHeight + 8)
            .background(LunexColor.surface, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous)
                    .strokeBorder(isSelected ? LunexColor.ink : LunexColor.line, lineWidth: 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A goal template: its emoji (the one place the UI shows emoji) and name.
private struct TemplateTile: View {
    let template: GoalTemplate
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: LunexTheme.Spacing.space3) {
                Text(template.emoji)
                    .font(.system(size: 18))
                    .frame(width: 36, height: 36)
                    .background(LunexColor.surfaceSunken, in: Circle())
                Text(template.name)
                    .lunexText(.callout, weight: .semibold)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, LunexTheme.Spacing.space3)
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            .background(LunexColor.surface, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous)
                    .strokeBorder(isSelected ? LunexColor.ink : LunexColor.line, lineWidth: isSelected ? 1.5 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

/// A whole-number amount with thousands spaced out («1 240 000») and the currency after it.
/// The real field sits underneath (SwiftUI does not reformat a field while it is being edited);
/// the formatted number is drawn on top.
private struct AmountField: View {
    @Binding var digits: String
    let currency: String
    var focused: FocusState<Bool>.Binding

    var body: some View {
        ZStack(alignment: .leading) {
            TextField("", text: filtered)
                .focused(focused)
                .amountKeyboard()
                .foregroundStyle(.clear)
                .tint(.clear)
                .accessibilityLabel(currency)
            HStack(alignment: .firstTextBaseline, spacing: LunexTheme.Spacing.space2) {
                HStack(spacing: 1) {
                    Text(digits.isEmpty ? "0" : Self.group(digits))
                        .lunexText(.amountL)
                        .foregroundStyle(digits.isEmpty ? LunexColor.inkFaint : LunexColor.ink)
                        .contentTransition(.numericText())
                    if focused.wrappedValue {
                        Capsule()
                            .fill(LunexColor.ink)
                            .frame(width: 2, height: 32)
                    }
                }
                Spacer(minLength: 0)
                Text(currency)
                    .lunexText(.body)
                    .foregroundStyle(LunexColor.inkMuted)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .padding(.horizontal, LunexTheme.Spacing.space4)
        .frame(minHeight: 72)
        .background(LunexColor.surfaceSunken, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
        .onTapGesture { focused.wrappedValue = true }
    }

    private var filtered: Binding<String> {
        Binding {
            digits
        } set: { text in
            let only = text.filter(\.isASCII).filter(\.isNumber)
            digits = String(only.drop { $0 == "0" }.prefix(13))
        }
    }

    static func group(_ digits: String) -> String {
        var result = ""
        for (index, character) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { result.append(" ") }
            result.append(character)
        }
        return result
    }
}

private extension View {
    func amountKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.numberPad)
        #else
        self
        #endif
    }
}

private extension String {
    /// «узбекский сум» → «Узбекский сум»: currency names come lowercase in some languages.
    var capitalizedFirst: String {
        prefix(1).uppercased() + dropFirst()
    }
}
