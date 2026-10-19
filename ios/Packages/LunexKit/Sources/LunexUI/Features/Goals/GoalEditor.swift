import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

enum GoalEditorTarget: Identifiable, Hashable {
    case new
    case edit(UUID)

    var id: String {
        switch self {
        case .new: "new"
        case let .edit(id): id.uuidString
        }
    }
}

/// A new goal starts from a template (or «Своя цель»), then name, emoji, amount and currency,
/// deadline (+30 / +90 / +180 / +365 days, a date or none), savings account and color.
struct GoalEditor: View {
    let target: GoalEditorTarget

    @Environment(GoalBook.self) private var book
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context

    @Query(sort: \AccountRecord.sortOrder) private var allAccounts: [AccountRecord]

    @State private var draft = GoalDraft()
    @State private var targetText = ""
    @State private var choseTemplate = false
    @State private var isLoaded = false
    @State private var picksDate = false
    @State private var errorMessage: String?

    private static let emoji = [
        "🎯", "🚗", "🏠", "✈️", "📱", "💻", "🎓", "🛟", "💍", "🏖️", "🎁", "🐶",
        "🏍️", "⌚️", "🎸", "📷", "👶", "🏋️", "🚲", "🛋️", "💎", "🌍", "🎮", "🏦",
    ]
    private static let spans = [30, 90, 180, 365]

    var body: some View {
        NavigationStack {
            Group {
                if target == .new && !choseTemplate {
                    templates
                } else {
                    form
                }
            }
            .scrollContentBackground(.hidden)
            .background(LunexColor.paper)
            .navigationTitle(localizer(target == .new ? "goals.new" : "goals.edit"))
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer("common.cancel")) { dismiss() }
                }
                if target != .new || choseTemplate {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(localizer("common.save"), action: save)
                            .disabled(draft.trimmedTitle.isEmpty || (AmountText.parse(targetText) ?? 0) <= 0)
                    }
                }
            }
            .sheet(isPresented: $picksDate) { dateSheet }
            .onAppear(perform: load)
        }
        .tint(LunexColor.ink)
    }

    // MARK: Templates

    private var templates: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                SectionLabel(localizer("goals.template"))
                LazyVGrid(columns: [GridItem(.flexible(), spacing: LunexTheme.Spacing.space3), GridItem(.flexible())], spacing: LunexTheme.Spacing.space3) {
                    ForEach(BuiltInGoalTemplate.all) { template in
                        tile(emoji: template.emoji, title: template.name(language: localizer.language.rawValue), color: template.color) {
                            pick(template)
                        }
                    }
                    tile(emoji: BuiltInGoalTemplate.defaultEmoji, title: localizer("goals.custom"), color: BuiltInGoalTemplate.defaultColor) {
                        pick(nil)
                    }
                }
            }
            .padding(LunexTheme.Spacing.space4)
        }
    }

    private func tile(emoji: String, title: String, color: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space3) {
                Text(emoji)
                    .font(.system(size: 28))
                    .frame(width: 52, height: 52)
                    .background((Color(hex: color) ?? LunexColor.dataSteel).opacity(0.16), in: Circle())
                Text(title)
                    .lunexText(.bodyStrong)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(LunexTheme.Spacing.space4)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
            .background(LunexColor.surface, in: RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: LunexTheme.Radius.large, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    private func pick(_ template: BuiltInGoalTemplate?) {
        draft.templateKey = template?.key
        draft.emoji = template?.emoji ?? BuiltInGoalTemplate.defaultEmoji
        draft.color = template?.color ?? BuiltInGoalTemplate.defaultColor
        draft.title = template?.name(language: localizer.language.rawValue) ?? ""
        withAnimation(.snappy) { choseTemplate = true }
    }

    // MARK: Form

    private var form: some View {
        Form {
            Section(localizer("goals.name")) {
                HStack(spacing: LunexTheme.Spacing.space3) {
                    Menu {
                        ForEach(Self.emoji, id: \.self) { emoji in
                            Button(emoji) { draft.emoji = emoji }
                        }
                    } label: {
                        Text(draft.emoji)
                            .font(.system(size: 26))
                            .frame(width: 48, height: 48)
                            .background((Color(hex: draft.color) ?? LunexColor.dataSteel).opacity(0.16), in: Circle())
                    }
                    .accessibilityLabel(localizer("goals.emoji"))
                    TextField(localizer("goals.name.placeholder"), text: $draft.title)
                        .autocorrectionDisabled()
                        .onChange(of: draft.title) { _, title in
                            if title.count > 120 { draft.title = String(title.prefix(120)) }
                        }
                }
            }
            Section {
                HStack(spacing: LunexTheme.Spacing.space3) {
                    TextField("0", text: $targetText)
                        .lunexText(.amountM)
                        .decimalKeyboard()
                    Picker(localizer("accounts.currency"), selection: $draft.currency) {
                        ForEach(SupportedCurrency.codes, id: \.self) { code in
                            Text(code).tag(code)
                        }
                    }
                    .labelsHidden()
                    .fixedSize()
                    .disabled(target != .new)
                }
            } header: {
                Text(localizer("goals.target"))
            } footer: {
                if target != .new {
                    Text(localizer("goals.currencyFixed"))
                }
            }
            Section {
                FlowLayout {
                    ForEach(Self.spans, id: \.self) { days in
                        Chip(localizer.format("goals.plusDays", days), isSelected: deadline(in: days) == draft.deadline && draft.deadline != nil) {
                            draft.deadline = deadline(in: days)
                        }
                    }
                    Chip(localizer("goals.pickDate"), systemImage: "calendar", isSelected: false) { picksDate = true }
                    Chip(localizer("goals.noDeadline"), isSelected: draft.deadline == nil) { draft.deadline = nil }
                }
                .padding(.vertical, LunexTheme.Spacing.space1)
            } header: {
                Text(localizer("goals.deadline"))
            } footer: {
                if let deadline = draft.deadline {
                    Text(localizer.format("goals.by", deadline.formatted(.dateTime.day().month(.wide).year().locale(localizer.locale))))
                }
            }
            Section {
                Picker(localizer("goals.linked"), selection: $draft.linkedAccountId) {
                    Text(localizer("goals.linked.none")).tag(UUID?.none)
                    ForEach(savingsCandidates) { account in
                        Text(account.name).tag(Optional(account.id))
                    }
                }
            } footer: {
                Text(localizer("goals.linked.footer"))
            }
            Section(localizer("accounts.color")) {
                ColorRow(selection: $draft.color, label: localizer("accounts.color"))
            }
            if let errorMessage {
                Section {
                    Text(errorMessage).foregroundStyle(LunexColor.negative)
                }
            }
        }
    }

    private var dateSheet: some View {
        DatePicker(
            localizer("goals.deadline"),
            selection: Binding(get: { draft.deadline ?? deadline(in: 90) }, set: { day in
                draft.deadline = Calendar.current.startOfDay(for: day)
                picksDate = false
            }),
            in: Calendar.current.startOfDay(for: .now)...,
            displayedComponents: .date
        )
        .datePickerStyle(.graphical)
        .labelsHidden()
        .padding(LunexTheme.Spacing.space4)
        .presentationDetents([.medium])
        .presentationBackground(LunexColor.surface)
    }

    /// Accounts the money can sit in: active, in the goal's currency.
    private var savingsCandidates: [AccountRecord] {
        allAccounts.filter { $0.deletedAt == nil && !$0.isArchived && $0.currency == draft.currency }
    }

    private func deadline(in days: Int) -> Date {
        Calendar.current.startOfDay(for: Calendar.current.date(byAdding: .day, value: days, to: .now) ?? .now)
    }

    private func load() {
        guard !isLoaded else { return }
        isLoaded = true
        switch target {
        case .new:
            draft.currency = session.profile?.baseCurrency ?? SupportedCurrency.default
        case let .edit(id):
            guard let record = try? context.fetch(FetchDescriptor<GoalRecord>(predicate: #Predicate { $0.id == id })).first else { return }
            draft = book.draft(for: record)
            targetText = AmountText.text(record.targetAmount, separator: localizer.locale.decimalSeparator ?? ",")
        }
    }

    private func save() {
        guard let amount = AmountText.parse(targetText), amount > 0 else {
            errorMessage = localizer("goals.error.invalidAmount")
            return
        }
        draft.targetAmount = amount
        if let linked = draft.linkedAccountId, !savingsCandidates.contains(where: { $0.id == linked }) {
            draft.linkedAccountId = nil
        }
        do {
            switch target {
            case .new: try book.create(draft)
            case let .edit(id): try book.update(id, with: draft)
            }
            dismiss()
        } catch {
            errorMessage = localizer.goalMessage(error)
        }
    }
}
