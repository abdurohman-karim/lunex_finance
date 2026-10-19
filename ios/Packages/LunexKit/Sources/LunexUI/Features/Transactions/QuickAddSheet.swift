import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// What the quick-add sheet opens for: a new operation of a kind, or an existing one to edit.
enum TransactionEditor: Identifiable, Hashable {
    /// `accountId` preselects the account (a transfer from an account's screen)
    case new(TransactionKind, accountId: UUID? = nil)
    case edit(UUID)

    var id: String {
        switch self {
        case let .new(kind, accountId): "new-\(kind.rawValue)-\(accountId?.uuidString ?? "")"
        case let .edit(id): id.uuidString
        }
    }
}

extension View {
    /// Presents the quick-add sheet while `editor` is set.
    func transactionEditor(_ editor: Binding<TransactionEditor?>) -> some View {
        sheet(item: editor) { editor in
            QuickAddSheet(editor: editor)
                .presentationDragIndicator(.visible)
                .presentationCornerRadius(LunexTheme.Radius.large)
                .presentationBackground(LunexColor.surface)
        }
    }
}

/// The quick-add sheet: type, amount on its own keypad (+ − ×), account, date, category, note.
/// Two or three taps for an everyday expense; the same sheet edits and deletes an operation.
struct QuickAddSheet: View {
    let editor: TransactionEditor

    @Environment(Ledger.self) private var ledger
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context

    @Query(sort: \AccountRecord.sortOrder) private var allAccounts: [AccountRecord]
    @Query(sort: \CategoryRecord.sortOrder) private var allCategories: [CategoryRecord]
    /// The last 90 days, to put frequent categories first
    @Query private var recent: [TransactionRecord]
    @Query private var settings: [SettingsRecord]

    @State private var draft: TransactionDraft
    @State private var record: TransactionRecord?
    @State private var isLoaded = false
    @State private var showsAllCategories = false
    @State private var picksDate = false
    @State private var errorMessage: String?
    @State private var keyTaps = 0
    @State private var saves = 0
    @State private var failures = 0
    @FocusState private var noteFocused: Bool

    /// Categories shown before «Ещё»
    private static let collapsedCategories = 7
    private static let noteLimit = 255

    init(editor: TransactionEditor) {
        self.editor = editor
        let kind: TransactionKind = if case let .new(kind, _) = editor { kind } else { .expense }
        _draft = State(initialValue: TransactionDraft(kind: kind, amount: AmountInput(fractionDigits: 0)))
        let since = Date.now.addingTimeInterval(-90 * 24 * 3600)
        _recent = Query(filter: #Predicate<TransactionRecord> { $0.occurredAt >= since && $0.deletedAt == nil })
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.top, LunexTheme.Spacing.space6)
                .padding(.bottom, 20)
            ScrollView {
                VStack(spacing: 20) {
                    amountSection
                    if draft.kind == .transfer {
                        targetSection
                    } else {
                        categorySection
                    }
                    noteField
                    if let record {
                        details(record)
                    }
                }
                .padding(.bottom, LunexTheme.Spacing.space4)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.hidden)
            if !noteFocused {
                Keypad(
                    fractionDigits: draft.amount.fractionDigits,
                    canSave: draft.problem == nil,
                    press: press,
                    done: save
                )
                .padding(.top, LunexTheme.Spacing.space2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, LunexTheme.Spacing.space4)
        .padding(.bottom, LunexTheme.Spacing.space2)
        .background(LunexColor.surface)
        .animation(.snappy, value: noteFocused)
        .onAppear(perform: load)
        .sheet(isPresented: $picksDate) { dateSheet }
        .sensoryFeedback(trigger: keyTaps) { _, _ in hapticsEnabled ? .impact(weight: .light, intensity: 0.6) : nil }
        .sensoryFeedback(trigger: saves) { _, _ in hapticsEnabled ? .success : nil }
        .sensoryFeedback(trigger: failures) { _, _ in hapticsEnabled ? .error : nil }
    }

    // MARK: - Sections

    private var header: some View {
        HStack(spacing: LunexTheme.Spacing.space3) {
            KindPicker(selection: draft.kind, title: { localizer("add.kind.\($0.rawValue)") }, select: select)
            IconButton(localizer("add.close"), systemImage: "xmark") { dismiss() }
        }
    }

    private var amountSection: some View {
        VStack(spacing: LunexTheme.Spacing.space3) {
            VStack(spacing: LunexTheme.Spacing.space1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(draft.amount.isEmpty ? "0" : amountText)
                        .lunexText(.amountHero)
                        .foregroundStyle(draft.amount.isEmpty ? LunexColor.inkFaint : LunexColor.ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)
                    Text(localizer.currencyName(currency))
                        .lunexText(.body)
                        .foregroundStyle(LunexColor.inkMuted)
                }
                if draft.amount.hasOperator, let value = draft.amount.value {
                    Text("= " + localizer.amount(value, currency: currency))
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.negative)
                }
            }
            .accessibilityElement(children: .combine)
            HStack(spacing: LunexTheme.Spacing.space2) {
                accountMenu
                dateMenu
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var accountMenu: some View {
        Menu {
            Picker(localizer("add.account"), selection: accountSelection) {
                ForEach(accounts) { account in
                    Text(account.name).tag(Optional(account.id))
                }
            }
        } label: {
            ChipLabel(account?.name ?? "—", trailingImage: "chevron.down", isSelected: false, size: .small)
        }
        .menuIndicator(.hidden)
        .accessibilityLabel(localizer("add.account"))
        .accessibilityValue(account?.name ?? "")
    }

    private var dateMenu: some View {
        Menu {
            Button(localizer("add.date.today")) { setDay(.now) }
            Button(localizer("add.date.yesterday")) {
                setDay(Calendar.current.date(byAdding: .day, value: -1, to: .now) ?? .now)
            }
            Button(localizer("add.date.other"), systemImage: "calendar") { picksDate = true }
        } label: {
            ChipLabel(dateTitle, trailingImage: "chevron.down", isSelected: false, size: .small)
        }
        .menuIndicator(.hidden)
        .accessibilityLabel(localizer("add.date.title"))
        .accessibilityValue(dateTitle)
    }

    private var dateSheet: some View {
        DatePicker(
            localizer("add.date.title"),
            selection: Binding(get: { draft.occurredAt }, set: { day in
                setDay(day)
                picksDate = false
            }),
            in: ...Date.now,
            displayedComponents: .date
        )
        .datePickerStyle(.graphical)
        .labelsHidden()
        .padding(LunexTheme.Spacing.space4)
        .presentationDetents([.medium])
        .presentationBackground(LunexColor.surface)
    }

    private var categorySection: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            SectionLabel(localizer("add.category"))
            let ranked = rankedCategories
            FlowLayout {
                ForEach(visibleCategories(ranked)) { category in
                    Chip(category.displayName(language: localizer.language.rawValue), isSelected: draft.categoryId == category.id) {
                        draft.categoryId = draft.categoryId == category.id ? nil : category.id
                    }
                }
                if ranked.count > Self.collapsedCategories {
                    Chip(
                        localizer(showsAllCategories ? "add.category.less" : "add.category.more"),
                        isSelected: false
                    ) {
                        withAnimation(.snappy) { showsAllCategories.toggle() }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var targetSection: some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            SectionLabel(localizer("add.to"))
            let targets = accounts.filter { $0.id != draft.accountId }
            if targets.isEmpty {
                Text(localizer("add.noSecondAccount"))
                    .lunexText(.callout)
                    .foregroundStyle(LunexColor.inkMuted)
            } else {
                FlowLayout {
                    ForEach(targets) { target in
                        Chip(target.name, isSelected: draft.transferAccountId == target.id) {
                            draft.transferAccountId = target.id
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var noteField: some View {
        TextField(localizer("add.note"), text: $draft.note)
            .focused($noteFocused)
            .submitLabel(.done)
            .onSubmit { noteFocused = false }
            .onChange(of: draft.note) { _, note in
                if note.count > Self.noteLimit { draft.note = String(note.prefix(Self.noteLimit)) }
            }
            .lunexInput()
    }

    /// The operation's card when editing: where it came from, and «Удалить».
    private func details(_ record: TransactionRecord) -> some View {
        VStack(alignment: .leading, spacing: LunexTheme.Spacing.space2) {
            Label {
                Text(sourceLine(record))
            } icon: {
                Image(systemName: Self.sourceIcon(record.source))
            }
            .lunexText(.caption)
            .foregroundStyle(LunexColor.inkMuted)
            if let merchant = record.merchant, !merchant.isEmpty {
                Label(merchant, systemImage: "storefront")
                    .lunexText(.caption)
                    .foregroundStyle(LunexColor.inkMuted)
            }
            Button(role: .destructive, action: deleteRecord) {
                Text(localizer("add.delete"))
                    .lunexText(.callout, weight: .medium)
                    .foregroundStyle(LunexColor.negative)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Data

    private var accounts: [AccountRecord] {
        allAccounts.filter { ($0.deletedAt == nil && !$0.isArchived) || $0.id == record?.accountId || $0.id == record?.transferAccountId }
    }

    private var account: AccountRecord? {
        accounts.first { $0.id == draft.accountId }
    }

    private var currency: String {
        account?.currency ?? record?.currency ?? "UZS"
    }

    private var hapticsEnabled: Bool {
        settings.first?.hapticsEnabled ?? true
    }

    private var defaultAccount: AccountRecord? {
        let preferred = settings.first?.defaultAccountId
        return accounts.first { $0.id == preferred } ?? accounts.first(where: \.isDefault) ?? accounts.first
    }

    private var rankedCategories: [CategoryRecord] {
        CategoryRanking.ordered(allCategories, kind: draft.kind, transactions: recent)
    }

    /// The first few, plus the chosen one when it is further down.
    private func visibleCategories(_ ranked: [CategoryRecord]) -> [CategoryRecord] {
        guard !showsAllCategories, ranked.count > Self.collapsedCategories else { return ranked }
        var shown = Array(ranked.prefix(Self.collapsedCategories))
        if let id = draft.categoryId, !shown.contains(where: { $0.id == id }), let chosen = ranked.first(where: { $0.id == id }) {
            shown[shown.count - 1] = chosen
        }
        return shown
    }

    private var amountText: String {
        draft.amount.display(
            decimalSeparator: localizer.locale.decimalSeparator ?? ",",
            groupingSeparator: localizer.locale.groupingSeparator ?? " "
        )
    }

    private var dateTitle: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(draft.occurredAt) { return localizer("add.date.today") }
        if calendar.isDateInYesterday(draft.occurredAt) { return localizer("add.date.yesterday") }
        let sameYear = calendar.isDate(draft.occurredAt, equalTo: .now, toGranularity: .year)
        let format: Date.FormatStyle = sameYear ? .dateTime.day().month(.abbreviated) : .dateTime.day().month(.abbreviated).year()
        return draft.occurredAt.formatted(format.locale(localizer.locale))
    }

    private func sourceLine(_ record: TransactionRecord) -> String {
        let created = record.createdAt.formatted(
            .dateTime.day().month(.abbreviated).hour().minute().locale(localizer.locale)
        )
        return localizer("transaction.source.\(record.source)") + " · " + created
    }

    private static func sourceIcon(_ source: String) -> String {
        switch source {
        case "voice": "mic"
        case "text_ai": "text.bubble"
        case "receipt_scan": "doc.text.viewfinder"
        case "recurring": "repeat"
        case "siri": "waveform"
        case "widget": "square.grid.2x2"
        default: "hand.tap"
        }
    }

    private var accountSelection: Binding<UUID?> {
        Binding(get: { draft.accountId }, set: { id in
            if let chosen = accounts.first(where: { $0.id == id }) { select(chosen) }
        })
    }

    // MARK: - Actions

    private func load() {
        guard !isLoaded else { return }
        isLoaded = true
        switch editor {
        case let .new(_, accountId):
            if let account = accounts.first(where: { $0.id == accountId }) ?? defaultAccount { select(account) }
            if draft.kind == .transfer {
                draft.transferAccountId = accounts.first { $0.id != draft.accountId }?.id
            }
        case let .edit(id):
            let found = try? context.fetch(FetchDescriptor<TransactionRecord>(predicate: #Predicate { $0.id == id })).first
            record = found
            if let found { draft = ledger.draft(for: found) }
        }
    }

    private func select(_ kind: TransactionKind) {
        guard draft.kind != kind else { return }
        draft.kind = kind
        showsAllCategories = false
        if kind == .transfer {
            draft.categoryId = nil
            if draft.transferAccountId == nil || draft.transferAccountId == draft.accountId {
                draft.transferAccountId = accounts.first { $0.id != draft.accountId }?.id
            }
        } else {
            draft.transferAccountId = nil
            if let id = draft.categoryId, allCategories.first(where: { $0.id == id })?.type != kind.rawValue {
                draft.categoryId = nil
            }
        }
    }

    private func select(_ chosen: AccountRecord) {
        draft.accountId = chosen.id
        let digits = Money.fractionDigits(for: chosen.currency)
        if digits != draft.amount.fractionDigits {
            draft.amount = draft.amount.value.map { AmountInput(amount: $0, fractionDigits: digits) }
                ?? AmountInput(fractionDigits: digits)
        }
        if draft.transferAccountId == chosen.id {
            draft.transferAccountId = accounts.first { $0.id != chosen.id }?.id
        }
    }

    /// Moves the operation to another day and keeps its time; never into the future.
    private func setDay(_ day: Date) {
        let calendar = Calendar.current
        let time = calendar.dateComponents([.hour, .minute, .second], from: draft.occurredAt)
        let moved = calendar.date(
            bySettingHour: time.hour ?? 12, minute: time.minute ?? 0, second: time.second ?? 0, of: day
        ) ?? day
        draft.occurredAt = min(moved, .now)
    }

    private func press(_ key: AmountInput.Key) {
        errorMessage = nil
        draft.amount.press(key)
        keyTaps += 1
    }

    private func save() {
        guard draft.problem == nil else {
            failures += 1
            return
        }
        let ledger = ledger
        do {
            switch editor {
            case .new:
                let id = try ledger.create(draft)
                toasts.show(localizer("add.saved.\(draft.kind.rawValue)"), actionTitle: localizer("common.undo")) {
                    try? ledger.delete(id)
                }
            case let .edit(id):
                let previous = record.map(ledger.draft(for:))
                try ledger.update(id, with: draft)
                toasts.show(localizer("add.updated"), actionTitle: previous == nil ? nil : localizer("common.undo")) {
                    if let previous { try? ledger.update(id, with: previous) }
                }
            }
            saves += 1
            dismiss()
        } catch {
            failures += 1
            errorMessage = localizer("add.saveFailed")
        }
    }

    private func deleteRecord() {
        guard case let .edit(id) = editor else { return }
        let ledger = ledger
        do {
            try ledger.delete(id)
            toasts.show(localizer("add.deleted"), actionTitle: localizer("common.undo")) {
                try? ledger.restore(id)
            }
            dismiss()
        } catch {
            failures += 1
            errorMessage = localizer("add.saveFailed")
        }
    }
}

// MARK: - Pieces

/// «Расход / Доход / Перевод» as a capsule with a sliding white thumb.
private struct KindPicker: View {
    let selection: TransactionKind
    let title: (TransactionKind) -> String
    let select: (TransactionKind) -> Void
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            ForEach(TransactionKind.allCases, id: \.self) { kind in
                let isSelected = kind == selection
                Button {
                    withAnimation(.snappy) { select(kind) }
                } label: {
                    Text(title(kind))
                        .lunexText(.callout, weight: isSelected ? .semibold : .medium)
                        .foregroundStyle(isSelected ? LunexColor.ink : LunexColor.inkMuted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, minHeight: 34)
                        .background {
                            if isSelected {
                                Capsule()
                                    .fill(LunexColor.surface)
                                    .shadow(color: .black.opacity(0.06), radius: 2, y: 1)
                                    .matchedGeometryEffect(id: "thumb", in: thumb)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isSelected ? .isSelected : [])
            }
        }
        .padding(3)
        .background(LunexColor.surfaceSunken, in: Capsule())
    }
}

/// 1 2 3 + / 4 5 6 − / 7 8 9 × / 000 0 ⌫ Готово. Currencies with minor units get «,» instead of «000».
struct Keypad: View {
    let fractionDigits: Int
    let canSave: Bool
    let press: (AmountInput.Key) -> Void
    let done: () -> Void
    @Environment(Localizer.self) private var localizer

    var body: some View {
        Grid(horizontalSpacing: LunexTheme.Spacing.space2, verticalSpacing: LunexTheme.Spacing.space2) {
            GridRow {
                digit(1); digit(2); digit(3)
                key(.plus, "+", label: "add.key.plus", style: .operator)
            }
            GridRow {
                digit(4); digit(5); digit(6)
                key(.minus, "−", label: "add.key.minus", style: .operator)
            }
            GridRow {
                digit(7); digit(8); digit(9)
                key(.times, "×", label: "add.key.times", style: .operator)
            }
            GridRow {
                if fractionDigits > 0 {
                    key(.decimal, localizer.locale.decimalSeparator ?? ",", label: "add.key.decimal", style: .digit)
                } else {
                    key(.thousands, "000", label: "add.key.thousands", style: .digit, size: 20)
                }
                digit(0)
                Button { press(.backspace) } label: {
                    Image(systemName: "delete.left")
                        .font(.system(size: 22, weight: .regular))
                }
                .buttonStyle(KeyStyle(style: .operator))
                .buttonRepeatBehavior(.enabled)
                .accessibilityLabel(localizer("add.key.backspace"))
                Button(localizer("add.done"), action: done)
                    .buttonStyle(KeyStyle(style: .done))
                    .disabled(!canSave)
            }
        }
    }

    private func digit(_ value: Int) -> some View {
        key(.digit(value), "\(value)", label: nil, style: .digit)
    }

    private func key(_ key: AmountInput.Key, _ title: String, label: String?, style: KeyStyle.Style, size: CGFloat = 24) -> some View {
        Button { press(key) } label: {
            Text(title).font(.system(size: size, weight: .regular).monospacedDigit())
        }
        .buttonStyle(KeyStyle(style: style))
        .accessibilityLabel(label.map { localizer($0) } ?? title)
    }
}

struct KeyStyle: ButtonStyle {
    enum Style {
        case digit, `operator`, done
    }

    let style: Style
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .lunexText(.body, weight: style == .done ? .semibold : nil)
            .foregroundStyle(foreground)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity, minHeight: LunexTheme.Size.controlHeight)
            .background(background, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.medium, style: .continuous))
            .opacity(configuration.isPressed ? 0.55 : isEnabled ? 1 : 0.35)
    }

    private var foreground: Color {
        switch style {
        case .digit: LunexColor.ink
        case .operator: LunexColor.inkMuted
        case .done: LunexColor.onInk
        }
    }

    private var background: Color {
        switch style {
        case .digit: LunexColor.surfaceSunken
        case .operator: .clear
        case .done: LunexColor.ink
        }
    }
}
