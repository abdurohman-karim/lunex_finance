import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Accounts and the total balance: active ones in the user's order (drag to reorder), then the archive.
struct AccountsView: View {
    @Environment(Catalog.self) private var catalog
    @Environment(SessionStore.self) private var session
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer

    @Query(filter: #Predicate<AccountRecord> { $0.deletedAt == nil }, sort: \AccountRecord.sortOrder)
    private var accounts: [AccountRecord]
    @State private var editor: AccountEditorTarget?
    @State private var isReordering = false

    var body: some View {
        let active = accounts.filter { !$0.isArchived }
        let archived = accounts.filter(\.isArchived)
        List {
            Section {
                totalCard(active)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            Section {
                ForEach(active) { account in
                    NavigationLink {
                        AccountDetailView(accountId: account.id)
                    } label: {
                        AccountRow(account: account, baseCurrency: baseCurrency)
                    }
                    .listRowBackground(LunexColor.surface)
                }
                .onMove { from, to in move(active, from: from, to: to) }
            } header: {
                SectionLabel(localizer("accounts.active"))
            }
            if !archived.isEmpty {
                Section {
                    ForEach(archived) { account in
                        NavigationLink {
                            AccountDetailView(accountId: account.id)
                        } label: {
                            AccountRow(account: account, baseCurrency: baseCurrency)
                                .opacity(0.6)
                        }
                        .listRowBackground(LunexColor.surface)
                    }
                } header: {
                    SectionLabel(localizer("accounts.archive"))
                }
            }
        }
        .groupedLists()
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .reordering(isReordering)
        .navigationTitle(localizer("accounts.title"))
        .toolbar {
            if active.count > 1 {
                ToolbarItem(placement: .primaryAction) {
                    Button(localizer(isReordering ? "add.done" : "common.reorder")) {
                        withAnimation { isReordering.toggle() }
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("accounts.new"), systemImage: "plus") { editor = .new }
                    .disabled(isReordering)
            }
        }
        .sheet(item: $editor) { target in
            AccountEditor(target: target)
        }
    }

    private var baseCurrency: String {
        session.profile?.baseCurrency ?? SupportedCurrency.default
    }

    private func totalCard(_ active: [AccountRecord]) -> some View {
        let balance = try? catalog.balance(of: active, base: baseCurrency)
        let apart = (balance?.unconverted ?? [:]).sorted { $0.key < $1.key }.map { code, amount in
            localizer.amount(amount, currency: code, showCurrency: true)
        }
        return Card {
            AmountDisplay(
                label: localizer("accounts.total"),
                value: localizer.amount(balance?.total ?? 0, currency: baseCurrency),
                currency: localizer.currencyName(baseCurrency),
                caption: apart.isEmpty ? nil : localizer.format("accounts.total.apart", apart.joined(separator: ", ")),
                scale: .large,
                isNegative: (balance?.total ?? 0) < 0
            )
        }
    }

    private func move(_ active: [AccountRecord], from: IndexSet, to: Int) {
        var ids = active.map(\.id)
        ids.move(fromOffsets: from, toOffset: to)
        do {
            try catalog.reorderAccounts(ids)
        } catch {
            toasts.show(localizer.catalogMessage(error))
        }
    }
}

/// Symbol, name, kind and currency, balance.
struct AccountRow: View {
    let account: AccountRecord
    let baseCurrency: String
    @Environment(Localizer.self) private var localizer

    var body: some View {
        HStack(spacing: LunexTheme.Spacing.space3) {
            SymbolWell(symbol: account.icon ?? AccountKind(rawValue: account.type)?.defaultIcon ?? "wallet.pass", color: account.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(account.name)
                    .lunexText(.bodyStrong)
                    .foregroundStyle(LunexColor.ink)
                    .lineLimit(1)
                Text(subtitle)
                    .lunexText(.callout)
                    .foregroundStyle(LunexColor.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: LunexTheme.Spacing.space2)
            Text(localizer.amount(account.currentBalance, currency: account.currency, showCurrency: account.currency != baseCurrency))
                .lunexText(.amountM)
                .foregroundStyle(account.currentBalance < 0 ? LunexColor.negative : LunexColor.ink)
                .lineLimit(1)
        }
        .frame(minHeight: LunexTheme.Size.rowHeight)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        let kind = localizer("account.kind.\(account.type)")
        // «Наличные · UZS», not «Наличные · Наличные · UZS»
        var parts = kind == account.name ? [account.currency] : [kind, account.currency]
        if account.isDefault { parts.append(localizer("accounts.default")) }
        if !account.includeInTotal { parts.append(localizer("accounts.notInTotal")) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - One account

/// An account: balance, actions (edit, transfer, default, archive, delete) and its operations by day.
struct AccountDetailView: View {
    let accountId: UUID

    @Environment(Catalog.self) private var catalog
    @Environment(SessionStore.self) private var session
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss

    @Query(filter: #Predicate<AccountRecord> { $0.deletedAt == nil }, sort: \AccountRecord.sortOrder)
    private var accounts: [AccountRecord]
    @Query(filter: #Predicate<TransactionRecord> { $0.deletedAt == nil }, sort: \TransactionRecord.occurredAt, order: .reverse)
    private var records: [TransactionRecord]
    @Query private var categories: [CategoryRecord]

    @State private var editor: AccountEditorTarget?
    @State private var transaction: TransactionEditor?
    @State private var confirmsDelete = false

    var body: some View {
        if let account = accounts.first(where: { $0.id == accountId }) {
            content(account)
        } else {
            ContentUnavailableView(localizer("accounts.gone"), systemImage: "wallet.pass")
                .background(LunexColor.paper)
        }
    }

    private func content(_ account: AccountRecord) -> some View {
        let categoryById = Dictionary(categories.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let accountById = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var filter = HistoryFilter()
        filter.accountId = accountId
        let days = History.days(records, filter: filter, categories: categoryById, language: localizer.language.rawValue)

        return List {
            Section {
                header(account)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if days.isEmpty {
                Section {
                    Text(localizer("accounts.noOperations"))
                        .lunexText(.callout)
                        .foregroundStyle(LunexColor.inkMuted)
                        .listRowBackground(LunexColor.surface)
                }
            }
            ForEach(days) { day in
                Section {
                    ForEach(day.items) { record in
                        Button {
                            transaction = .edit(record.id)
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
                    }
                } header: {
                    DayHeader(day: day, currency: baseCurrency)
                }
            }
        }
        .groupedLists()
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(account.name)
        .inlineTitle()
        .sheet(item: $editor) { target in
            AccountEditor(target: target)
        }
        .transactionEditor($transaction)
        .confirmationDialog(localizer("accounts.delete.confirm"), isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button(localizer("accounts.delete"), role: .destructive) { delete(account) }
        }
    }

    private func header(_ account: AccountRecord) -> some View {
        Card {
            VStack(alignment: .leading, spacing: LunexTheme.Spacing.space4) {
                HStack(spacing: LunexTheme.Spacing.space3) {
                    SymbolWell(symbol: account.icon ?? "wallet.pass", color: account.color, size: 48)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(localizer("account.kind.\(account.type)") + " · " + account.currency)
                            .lunexText(.callout)
                            .foregroundStyle(LunexColor.inkMuted)
                        HStack(spacing: LunexTheme.Spacing.space2) {
                            if account.isDefault {
                                StatusBadge(localizer("accounts.default"))
                            }
                            if account.isArchived {
                                StatusBadge(localizer("accounts.archived"))
                            }
                            if !account.includeInTotal {
                                StatusBadge(localizer("accounts.notInTotal"))
                            }
                        }
                    }
                }
                AmountDisplay(
                    label: localizer("accounts.balance"),
                    value: localizer.amount(account.currentBalance, currency: account.currency),
                    currency: localizer.currencyName(account.currency),
                    caption: localizer.format(
                        "accounts.initialBalance.caption",
                        localizer.amount(account.initialBalance, currency: account.currency, showCurrency: true)
                    ),
                    scale: .large,
                    isNegative: account.currentBalance < 0
                )
                HStack(spacing: LunexTheme.Spacing.space2) {
                    Button(localizer("accounts.edit")) { editor = .edit(account.id) }
                        .buttonStyle(.lunex(.secondary, size: .compact))
                    if !account.isArchived, accounts.filter({ !$0.isArchived }).count > 1 {
                        Button(localizer("add.kind.transfer")) { transaction = .new(.transfer, accountId: account.id) }
                            .buttonStyle(.lunex(.secondary, size: .compact))
                    }
                    Spacer(minLength: 0)
                    moreMenu(account)
                }
            }
        }
    }

    private func moreMenu(_ account: AccountRecord) -> some View {
        Menu {
            if !account.isArchived, !account.isDefault {
                Button(localizer("accounts.makeDefault"), systemImage: "checkmark.circle") { run { try catalog.makeDefault(account: account.id) } }
            }
            if account.isArchived {
                Button(localizer("accounts.unarchive"), systemImage: "tray.and.arrow.up") {
                    run { try catalog.setArchived(account: account.id, false) }
                }
            } else {
                Button(localizer("accounts.archiveAction"), systemImage: "archivebox") { archive(account) }
            }
            if (try? catalog.canDelete(account: account.id)) == true {
                Button(localizer("accounts.delete"), systemImage: "trash", role: .destructive) { confirmsDelete = true }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(LunexColor.ink)
                .frame(width: 40, height: 40)
                .background(LunexColor.surfaceSunken, in: Circle())
        }
        .accessibilityLabel(localizer("accounts.more"))
    }

    private var baseCurrency: String {
        session.profile?.baseCurrency ?? SupportedCurrency.default
    }

    private func run(_ change: () throws -> Void) {
        do {
            try change()
        } catch {
            toasts.show(localizer.catalogMessage(error))
        }
    }

    private func archive(_ account: AccountRecord) {
        let catalog = catalog
        let id = account.id
        run {
            try catalog.setArchived(account: id, true)
            toasts.show(localizer("accounts.archivedToast"), actionTitle: localizer("common.undo")) {
                try? catalog.setArchived(account: id, false)
            }
        }
    }

    private func delete(_ account: AccountRecord) {
        run {
            try catalog.deleteAccount(account.id)
            dismiss()
        }
    }
}

// MARK: - Editor

enum AccountEditorTarget: Identifiable, Hashable {
    case new
    case edit(UUID)

    var id: String {
        switch self {
        case .new: "new"
        case let .edit(id): id.uuidString
        }
    }
}

/// Name, kind, currency, opening balance, symbol, color and whether it counts in the total.
struct AccountEditor: View {
    let target: AccountEditorTarget

    @Environment(Catalog.self) private var catalog
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context

    @State private var draft = AccountDraft()
    @State private var balanceText = ""
    @State private var isNegative = false
    @State private var currencyLocked = false
    @State private var isLoaded = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section(localizer("accounts.name")) {
                    TextField(localizer("account.kind.\(draft.kind.rawValue)"), text: $draft.name)
                        .autocorrectionDisabled()
                        .onChange(of: draft.name) { _, name in
                            if name.count > 64 { draft.name = String(name.prefix(64)) }
                        }
                }
                Section(localizer("accounts.kind")) {
                    FlowLayout {
                        ForEach(AccountKind.allCases, id: \.self) { kind in
                            Chip(localizer("account.kind.\(kind.rawValue)"), systemImage: kind.defaultIcon, isSelected: draft.kind == kind) {
                                select(kind)
                            }
                        }
                    }
                    .padding(.vertical, LunexTheme.Spacing.space1)
                }
                Section {
                    Picker(localizer("accounts.currency"), selection: $draft.currency) {
                        ForEach(SupportedCurrency.codes, id: \.self) { code in
                            Text(code).tag(code)
                        }
                    }
                    .disabled(currencyLocked)
                } footer: {
                    if currencyLocked {
                        Text(localizer("accounts.currency.locked"))
                    }
                }
                Section {
                    HStack(spacing: LunexTheme.Spacing.space3) {
                        Button(isNegative ? "−" : "+") { isNegative.toggle() }
                            .lunexText(.titleM)
                            .foregroundStyle(LunexColor.ink)
                            .frame(width: 36, height: 36)
                            .background(LunexColor.surfaceSunken, in: Circle())
                            .buttonStyle(.plain)
                            .accessibilityLabel(localizer(isNegative ? "accounts.balance.negative" : "accounts.balance.positive"))
                        TextField("0", text: $balanceText)
                            .lunexText(.amountM)
                            .decimalKeyboard()
                        Text(localizer.currencyName(draft.currency))
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                } header: {
                    Text(localizer("accounts.initialBalance"))
                } footer: {
                    Text(localizer("accounts.initialBalance.footer"))
                }
                Section(localizer("accounts.icon")) {
                    SymbolGrid(symbols: Symbols.accounts, selection: $draft.icon, color: draft.color, label: localizer("accounts.icon"))
                }
                Section(localizer("accounts.color")) {
                    ColorRow(selection: $draft.color, label: localizer("accounts.color"))
                }
                Section {
                    Toggle(localizer("accounts.includeInTotal"), isOn: $draft.includeInTotal)
                        .tint(LunexColor.ink)
                } footer: {
                    Text(localizer("accounts.includeInTotal.footer"))
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(LunexColor.negative)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(LunexColor.paper)
            .navigationTitle(localizer(target == .new ? "accounts.new" : "accounts.edit"))
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(localizer("common.cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(localizer("common.save"), action: save)
                        .disabled(!draft.isValid)
                }
            }
            .onAppear(perform: load)
        }
        .tint(LunexColor.ink)
    }

    private func load() {
        guard !isLoaded else { return }
        isLoaded = true
        switch target {
        case .new:
            draft.currency = session.profile?.baseCurrency ?? SupportedCurrency.default
        case let .edit(id):
            guard let record = try? context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id })).first else { return }
            draft = catalog.draft(for: record)
            isNegative = record.initialBalance < 0
            balanceText = record.initialBalance == 0 ? "" : AmountText.text(abs(record.initialBalance), separator: localizer.locale.decimalSeparator ?? ",")
            currencyLocked = (try? catalog.hasMovements(id)) ?? false
        }
    }

    private func select(_ kind: AccountKind) {
        // A symbol the user has not changed follows the kind.
        if draft.icon == draft.kind.defaultIcon { draft.icon = kind.defaultIcon }
        draft.kind = kind
    }

    private func save() {
        guard let amount = AmountText.parse(balanceText) else {
            errorMessage = localizer("accounts.initialBalance.invalid")
            return
        }
        draft.initialBalance = isNegative ? -amount : amount
        do {
            switch target {
            case .new: try catalog.createAccount(draft)
            case let .edit(id): try catalog.updateAccount(id, with: draft)
            }
            dismiss()
        } catch {
            errorMessage = localizer.catalogMessage(error)
        }
    }

}

// MARK: - Shared

extension Localizer {
    /// Why the catalog refused a change, in words.
    func catalogMessage(_ error: Error) -> String {
        guard let error = error as? CatalogError else { return self("add.saveFailed") }
        return switch error {
        case .invalidName: self("catalog.error.invalidName")
        case .nameTaken: self("catalog.error.nameTaken")
        case .notFound: self("catalog.error.notFound")
        case .inUse: self("catalog.error.inUse")
        case .hasChildren: self("catalog.error.hasChildren")
        case .currencyLocked: self("accounts.currency.locked")
        case .systemReadonly: self("catalog.error.systemReadonly")
        case .invalidParent: self("catalog.error.invalidParent")
        }
    }
}

extension View {
    /// Rounded sections on paper (iOS); `swift test` builds for macOS, where they do not exist.
    func groupedLists() -> some View {
        #if os(iOS)
        listStyle(.insetGrouped)
            .listSectionSpacing(LunexTheme.Spacing.space4)
        #else
        self
        #endif
    }

    /// Shows drag handles on rows with `onMove` while `on`.
    func reordering(_ on: Bool) -> some View {
        #if os(iOS)
        environment(\.editMode, .constant(on ? .active : .inactive))
        #else
        self
        #endif
    }

    /// Full screen on iOS (the reached-goal celebration); a sheet where that does not exist.
    func fullScreen<Item: Identifiable, Content: View>(item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content) -> some View {
        #if os(iOS)
        fullScreenCover(item: item, content: content)
        #else
        sheet(item: item, content: content)
        #endif
    }

    func inlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    func decimalKeyboard() -> some View {
        #if os(iOS)
        keyboardType(.decimalPad)
        #else
        self
        #endif
    }
}
