import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// The history: every operation by day with the day's total, search, combinable filters,
/// swipe to edit or delete (with «Отменить»), tap to open the operation's card.
struct TransactionsView: View {
    @Environment(Ledger.self) private var ledger
    @Environment(ToastCenter.self) private var toasts
    @Environment(SyncEngine.self) private var sync
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    @Query(
        filter: #Predicate<TransactionRecord> { $0.deletedAt == nil },
        sort: \TransactionRecord.occurredAt, order: .reverse
    )
    private var records: [TransactionRecord]
    @Query(sort: \CategoryRecord.sortOrder) private var categories: [CategoryRecord]
    @Query(sort: \AccountRecord.sortOrder) private var accounts: [AccountRecord]

    @State private var filter = HistoryFilter()
    @State private var editor: TransactionEditor?

    var body: some View {
        let categoryById = Dictionary(categories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let accountById = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let days = History.days(records, filter: filter, categories: categoryById, language: localizer.language.rawValue)

        List {
            if !records.isEmpty {
                filterBar(categoryById: categoryById)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            ForEach(days) { day in
                Section {
                    ForEach(day.items) { record in
                        row(record, categoryById: categoryById, accountById: accountById)
                    }
                } header: {
                    DayHeader(day: day, currency: baseCurrency)
                }
            }
        }
        .groupedLists()
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .overlay {
            if records.isEmpty {
                ContentUnavailableView {
                    Label(localizer("empty.transactions.title"), systemImage: "list.bullet.rectangle")
                } description: {
                    Text(localizer("empty.transactions.body"))
                } actions: {
                    Button(localizer("history.add")) { editor = .new(.expense) }
                        .buttonStyle(.lunex(.primary, size: .compact))
                }
            } else if days.isEmpty {
                ContentUnavailableView {
                    Label(localizer("history.noResults.title"), systemImage: "magnifyingglass")
                } description: {
                    Text(localizer("history.noResults.body"))
                } actions: {
                    if filter.hasFilters {
                        Button(localizer("history.filter.reset")) { withAnimation { resetFilters() } }
                            .buttonStyle(.lunex(.secondary, size: .compact))
                    }
                }
            }
        }
        .historySearch(text: $filter.query, prompt: localizer("history.search"))
        .navigationTitle(localizer("tab.transactions"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("home.addOperation"), systemImage: "plus") { editor = .new(.expense) }
            }
        }
        .refreshable { await sync.sync() }
        .transactionEditor($editor)
    }

    private func row(
        _ record: TransactionRecord,
        categoryById: [UUID: CategoryRecord],
        accountById: [UUID: AccountRecord]
    ) -> some View {
        Button {
            editor = .edit(record.id)
        } label: {
            TransactionRow(
                record: record,
                category: record.categoryId.flatMap { categoryById[$0] },
                account: accountById[record.accountId],
                target: record.transferAccountId.flatMap { accountById[$0] },
                baseCurrency: baseCurrency
            )
        }
        .buttonStyle(.plain)
        .listRowBackground(LunexColor.surface)
        .listRowSeparatorTint(LunexColor.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in LunexTheme.Size.iconWell + LunexTheme.Spacing.space3 }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(localizer("history.delete"), systemImage: "trash", role: .destructive) {
                delete(record.id)
            }
            .tint(LunexColor.negative)
        }
        .swipeActions(edge: .leading) {
            Button(localizer("history.edit"), systemImage: "pencil") {
                editor = .edit(record.id)
            }
            .tint(LunexColor.inkMuted)
        }
    }

    private var baseCurrency: String {
        session.profile?.baseCurrency ?? "UZS"
    }

    // MARK: - Filters

    /// Type, account, category, period; the chips wrap to a second line when a long name is chosen.
    private func filterBar(categoryById: [UUID: CategoryRecord]) -> some View {
        FlowLayout {
            kindFilter
            accountFilter
            categoryFilter(categoryById: categoryById)
            periodFilter
            if filter.hasFilters {
                Button(localizer("history.filter.reset")) { withAnimation { resetFilters() } }
                    .lunexText(.caption, weight: .medium)
                    .foregroundStyle(LunexColor.inkMuted)
                    .padding(.horizontal, LunexTheme.Spacing.space2)
                    .frame(minHeight: 32)
            }
        }
        .padding(.vertical, LunexTheme.Spacing.space1)
    }

    private var kindFilter: some View {
        Menu {
            Picker(localizer("history.filter.type"), selection: $filter.kind) {
                Text(localizer("history.filter.all")).tag(TransactionKind?.none)
                ForEach(TransactionKind.allCases, id: \.self) { kind in
                    Text(localizer("add.kind.\(kind.rawValue)")).tag(Optional(kind))
                }
            }
        } label: {
            ChipLabel(
                filter.kind.map { localizer("add.kind.\($0.rawValue)") } ?? localizer("history.filter.type"),
                trailingImage: "chevron.down",
                isSelected: filter.kind != nil,
                size: .small
            )
        }
        .menuIndicator(.hidden)
    }

    private var accountFilter: some View {
        let live = accounts.filter { $0.deletedAt == nil }
        return Menu {
            Picker(localizer("history.filter.account"), selection: $filter.accountId) {
                Text(localizer("history.filter.all")).tag(UUID?.none)
                ForEach(live) { account in
                    Text(account.name).tag(Optional(account.id))
                }
            }
        } label: {
            ChipLabel(
                live.first { $0.id == filter.accountId }?.name ?? localizer("history.filter.account"),
                trailingImage: "chevron.down",
                isSelected: filter.accountId != nil,
                size: .small
            )
        }
        .menuIndicator(.hidden)
    }

    private func categoryFilter(categoryById: [UUID: CategoryRecord]) -> some View {
        let language = localizer.language.rawValue
        let live = categories.filter { $0.deletedAt == nil }
        return Menu {
            Picker(localizer("history.filter.category"), selection: $filter.categoryId) {
                Text(localizer("history.filter.all")).tag(UUID?.none)
                ForEach([TransactionKind.expense, .income], id: \.self) { kind in
                    Section(localizer("add.kind.\(kind.rawValue)")) {
                        ForEach(live.filter { $0.type == kind.rawValue }) { category in
                            Label(category.displayName(language: language), systemImage: category.outlineIcon)
                                .tag(Optional(category.id))
                        }
                    }
                }
            }
        } label: {
            ChipLabel(
                filter.categoryId.flatMap { categoryById[$0]?.displayName(language: language) }
                    ?? localizer("history.filter.category"),
                trailingImage: "chevron.down",
                isSelected: filter.categoryId != nil,
                size: .small
            )
        }
        .menuIndicator(.hidden)
    }

    private var periodFilter: some View {
        Menu {
            Picker(localizer("history.filter.period"), selection: $filter.period) {
                ForEach(HistoryFilter.Period.allCases, id: \.self) { period in
                    Text(localizer("history.period.\(period.rawValue)")).tag(period)
                }
            }
        } label: {
            ChipLabel(
                filter.period == .all ? localizer("history.filter.period") : localizer("history.period.\(filter.period.rawValue)"),
                trailingImage: "chevron.down",
                isSelected: filter.period != .all,
                size: .small
            )
        }
        .menuIndicator(.hidden)
    }

    private func resetFilters() {
        let query = filter.query
        filter = HistoryFilter()
        filter.query = query
    }

    // MARK: - Actions

    private func delete(_ id: UUID) {
        let ledger = ledger
        do {
            try ledger.delete(id)
            toasts.show(localizer("add.deleted"), actionTitle: localizer("common.undo")) {
                try? ledger.restore(id)
            }
        } catch {
            toasts.show(localizer("add.saveFailed"))
        }
    }
}

private extension View {
    /// The search field stays under the title instead of hiding until the list is pulled down.
    func historySearch(text: Binding<String>, prompt: String) -> some View {
        #if os(iOS)
        searchable(text: text, placement: .navigationBarDrawer(displayMode: .always), prompt: prompt)
        #else
        searchable(text: text, prompt: prompt)
        #endif
    }
}

/// «Сегодня» … «−57 000»: the day and what it added up to.
struct DayHeader: View {
    let day: HistoryDay
    let currency: String
    @Environment(Localizer.self) private var localizer

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            SectionLabel(title)
            Spacer()
            if day.total != 0 {
                Text(localizer.amount(day.total, currency: currency, signed: true))
                    .lunexText(.caption, weight: .medium)
                    .monospacedDigit()
                    .foregroundStyle(LunexColor.inkMuted)
            }
        }
        .textCase(nil)
        .padding(.horizontal, LunexTheme.Spacing.space1)
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        let calendar = Calendar.current
        if calendar.isDateInToday(day.date) { return localizer("add.date.today") }
        if calendar.isDateInYesterday(day.date) { return localizer("add.date.yesterday") }
        let sameYear = calendar.isDate(day.date, equalTo: .now, toGranularity: .year)
        let format: Date.FormatStyle = sameYear
            ? .dateTime.weekday(.wide).day().month(.wide)
            : .dateTime.day().month(.wide).year()
        return day.date.formatted(format.locale(localizer.locale))
    }
}

/// Category icon, name, time and account (or note), and the amount with its sign.
struct TransactionRow: View {
    let record: TransactionRecord
    let category: CategoryRecord?
    let account: AccountRecord?
    let target: AccountRecord?
    let baseCurrency: String
    @Environment(Localizer.self) private var localizer

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space3) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(LunexColor.ink)
                .frame(width: LunexTheme.Size.iconWell, height: LunexTheme.Size.iconWell)
                .background(LunexColor.surfaceSunken, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .lunexText(.bodyStrong)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(1)
                Text(subtitle)
                    .lunexText(.callout)
                    .foregroundStyle(LunexColor.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: LunexTheme.Spacing.space2)
            VStack(alignment: .trailing, spacing: 2) {
                Text(amount)
                    .lunexText(.amountM)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(1)
                if record.currency != baseCurrency, record.type != "transfer" {
                    Text("≈ " + localizer.amount(record.amountBase, currency: baseCurrency, showCurrency: true))
                        .lunexText(.caption)
                        .foregroundStyle(LunexColor.inkMuted)
                        .lineLimit(1)
                }
            }
        }
        .frame(minHeight: LunexTheme.Size.rowHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        if record.type == "transfer" { return "arrow.left.arrow.right" }
        return category?.outlineIcon ?? "circle.dashed"
    }

    private var title: String {
        if record.type == "transfer" { return localizer("add.kind.transfer") }
        return category?.displayName(language: localizer.language.rawValue) ?? localizer("transaction.uncategorized")
    }

    private var subtitle: String {
        var parts = [record.occurredAt.formatted(.dateTime.hour().minute().locale(localizer.locale))]
        if record.type == "transfer" {
            parts.append("\(account?.name ?? "—") → \(target?.name ?? "—")")
        } else if let account {
            parts.append(account.name)
        }
        if let note = record.note, !note.isEmpty { parts.append(note) }
        return parts.joined(separator: " · ")
    }

    private var amount: String {
        let showCurrency = record.currency != baseCurrency
        switch record.type {
        case "expense": return localizer.amount(-record.amount, currency: record.currency, signed: true, showCurrency: showCurrency)
        case "income": return localizer.amount(record.amount, currency: record.currency, signed: true, showCurrency: showCurrency)
        default: return localizer.amount(record.amount, currency: record.currency, showCurrency: showCurrency)
        }
    }
}
