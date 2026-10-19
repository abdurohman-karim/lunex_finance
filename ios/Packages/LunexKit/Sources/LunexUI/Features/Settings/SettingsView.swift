import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Settings: the account, language and currency, default account, payday and the first day
/// of the week, theme and haptics, management screens, sync.
struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SettingsStore.self) private var settings
    @Environment(Catalog.self) private var catalog
    @Environment(ToastCenter.self) private var toasts
    @Environment(Localizer.self) private var localizer
    @AppStorage(AppTheme.storageKey) private var theme = AppTheme.system

    @Query private var records: [SettingsRecord]
    @Query(filter: #Predicate<AccountRecord> { $0.deletedAt == nil && !$0.isArchived }, sort: \AccountRecord.sortOrder)
    private var accounts: [AccountRecord]
    @State private var pendingCurrency: String?

    var body: some View {
        let record = records.first
        Form {
            accountSection
            Section(localizer("settings.general")) {
                languagePicker
                Picker(localizer("settings.baseCurrency"), selection: Binding(
                    get: { session.profile?.baseCurrency ?? SupportedCurrency.default },
                    set: { code in
                        if code != session.profile?.baseCurrency { pendingCurrency = code }
                    }
                )) {
                    ForEach(SupportedCurrency.codes, id: \.self) { Text($0).tag($0) }
                }
                if !accounts.isEmpty {
                    Picker(localizer("settings.defaultAccount"), selection: Binding(
                        get: { accounts.first(where: \.isDefault)?.id ?? accounts.first?.id },
                        set: { id in run { if let id { try catalog.makeDefault(account: id) } } }
                    )) {
                        ForEach(accounts) { Text($0.name).tag(Optional($0.id)) }
                    }
                }
                Picker(localizer("settings.payday"), selection: binding(record?.monthStartsOnDay ?? 1) { .monthStartsOnDay($0) }) {
                    ForEach(1...31, id: \.self) { day in
                        Text(day == 1 ? localizer("settings.payday.first") : "\(day)").tag(day)
                    }
                }
                Picker(localizer("settings.weekStart"), selection: binding(record?.weekStartsOn ?? 1) { .weekStartsOn($0) }) {
                    Text(localizer("settings.weekStart.monday")).tag(1)
                    Text(localizer("settings.weekStart.saturday")).tag(6)
                    Text(localizer("settings.weekStart.sunday")).tag(7)
                }
            }
            Section(localizer("settings.appearance")) {
                Picker(localizer("settings.theme"), selection: $theme) {
                    ForEach(AppTheme.allCases, id: \.self) { Text(localizer("settings.theme.\($0.rawValue)")).tag($0) }
                }
                Toggle(localizer("settings.haptics"), isOn: binding(record?.hapticsEnabled ?? true) { .haptics($0) })
                    .tint(LunexColor.ink)
            }
            Section(localizer("settings.manage")) {
                NavigationLink { AccountsView() } label: { Label(localizer("accounts.title"), systemImage: "wallet.pass") }
                NavigationLink { CategoriesView() } label: { Label(localizer("categories.title"), systemImage: "square.grid.2x2") }
                NavigationLink { NotificationSettingsView() } label: { Label(localizer("settings.notifications"), systemImage: "bell") }
                NavigationLink { SecuritySettingsView() } label: { Label(localizer("settings.security"), systemImage: "lock") }
            }
            Section(localizer("settings.sync")) {
                SyncStatusRow()
                SyncNowButton()
            }
            Section {
                LabeledContent(localizer("settings.version"), value: Bundle.main.appVersion)
            }
        }
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.settings"))
        .confirmationDialog(
            localizer("settings.baseCurrency.confirm"),
            isPresented: Binding(get: { pendingCurrency != nil }, set: { if !$0 { pendingCurrency = nil } }),
            titleVisibility: .visible
        ) {
            if let code = pendingCurrency {
                Button(localizer.format("settings.baseCurrency.switch", code)) {
                    run { try settings.updateProfile(baseCurrency: code) }
                    toasts.show(localizer("settings.baseCurrency.pending"))
                }
            }
        } message: {
            Text(localizer("settings.baseCurrency.message"))
        }
    }

    private var accountSection: some View {
        Section {
            NavigationLink {
                AccountSettingsView()
            } label: {
                HStack(spacing: LunexTheme.Spacing.space3) {
                    Image(systemName: "person.crop.circle")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(LunexColor.inkMuted)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.profile?.displayName ?? session.profile?.email ?? localizer("settings.account"))
                            .lunexText(.bodyStrong)
                            .foregroundStyle(LunexColor.ink)
                            .lineLimit(1)
                        Text(planLine)
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                }
                .padding(.vertical, LunexTheme.Spacing.space1)
            }
        }
    }

    private var planLine: String {
        guard let access = session.access else { return localizer("settings.account") }
        var line = localizer(access.isPro ? "settings.plan.pro" : "settings.plan.free")
        if access.monetizationEnabled, let trial = access.trial, trial.active {
            line += " · " + localizer.format("settings.plan.trialLeft", trial.daysLeft)
        }
        return line
    }

    private var languagePicker: some View {
        @Bindable var localizer = localizer
        return Picker(localizer("settings.language"), selection: Binding(
            get: { localizer.language },
            set: { language in
                localizer.language = language
                // Reports, AI and pushes on the server follow the app's language.
                run { try settings.updateProfile(language: language.rawValue) }
            }
        )) {
            ForEach(AppLanguage.allCases) { Text($0.displayName).tag($0) }
        }
    }

    private func binding<Value>(_ value: Value, _ change: @escaping (Value) -> SettingsChange) -> Binding<Value> {
        Binding(get: { value }, set: { new in run { try settings.update(change(new)) } })
    }

    private func run(_ action: () throws -> Void) {
        do {
            try action()
        } catch {
            toasts.show(localizer("add.saveFailed"))
        }
    }
}

/// Light, dark or as the system: kept on the device, not in the account.
enum AppTheme: String, CaseIterable {
    case system, light, dark
    static let storageKey = "lunex.theme"

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

private struct SyncNowButton: View {
    @Environment(SyncEngine.self) private var sync
    @Environment(Localizer.self) private var localizer

    var body: some View {
        Button(localizer("settings.sync.now")) {
            Task { await sync.sync() }
        }
        .disabled(sync.status == .syncing)
    }
}

extension Bundle {
    var appVersion: String {
        let version = object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "\(version) (\(build))"
    }
}

/// «Синхронизировано 2 минуты назад», «Нет сети», what is still waiting and what was refused.
struct SyncStatusRow: View {
    @Environment(SyncEngine.self) private var sync
    @Environment(Localizer.self) private var localizer

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { _ in
            HStack(alignment: .firstTextBaseline, spacing: LunexTheme.Spacing.space3) {
                Image(systemName: symbol)
                    .foregroundStyle(sync.status == .failed ? LunexColor.negative : LunexColor.ink)
                VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
                    Text(title)
                        .lunexText(.body)
                        .foregroundStyle(LunexColor.ink)
                    ForEach(details, id: \.self) { detail in
                        Text(detail)
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.inkMuted)
                    }
                    if !sync.rejections.isEmpty {
                        Text(localizer.format("settings.sync.rejected", sync.rejections.count))
                            .lunexText(.caption)
                            .foregroundStyle(LunexColor.negative)
                    }
                }
                Spacer(minLength: 0)
                if sync.status == .syncing {
                    ProgressView()
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var symbol: String {
        switch sync.status {
        case .syncing: "arrow.triangle.2.circlepath"
        case .offline: "wifi.slash"
        case .failed: "exclamationmark.triangle"
        case .idle: sync.pendingCount > 0 ? "icloud.and.arrow.up" : "checkmark.icloud"
        }
    }

    private var title: String {
        switch sync.status {
        case .syncing: return localizer("settings.sync.syncing")
        case .offline: return localizer("settings.sync.offline")
        case .failed: return localizer("settings.sync.failed")
        case .idle:
            guard let last = sync.lastSyncedAt else { return localizer("settings.sync.never") }
            return localizer.format(
                "settings.sync.synced",
                last.formatted(.relative(presentation: .named).locale(localizer.locale))
            )
        }
    }

    private var details: [String] {
        var lines: [String] = []
        if sync.pendingCount > 0 {
            lines.append(localizer.format("settings.sync.pending", sync.pendingCount))
        }
        if sync.status == .failed, let error = sync.lastError {
            lines.append(localizer.message(for: error))
        }
        return lines
    }
}
