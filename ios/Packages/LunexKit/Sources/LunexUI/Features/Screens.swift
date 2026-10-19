import LunexCore
import LunexLocalization
import SwiftUI

// Tab roots. Each feature step of the build plan replaces its placeholder with the real screen.

struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SyncEngine.self) private var sync
    @Environment(Localizer.self) private var localizer
    @State private var editor: TransactionEditor?

    var body: some View {
        ScrollView {
            VStack(spacing: LunexTheme.Spacing.space4) {
                HStack {
                    SectionLabel(Date.now.formatted(.dateTime.weekday(.wide).day().month(.wide).locale(localizer.locale)))
                    Spacer()
                    if session.lastError?.isOffline == true {
                        Label(localizer("home.offline"), systemImage: "wifi.slash")
                            .labelStyle(.iconOnly)
                            .foregroundStyle(LunexColor.inkMuted)
                            .accessibilityLabel(localizer("home.offline"))
                    }
                }
                // Filled by the budget («Можно потратить сегодня») in the home-screen step.
                ProgressRing(progress: 0) {
                    VStack(spacing: LunexTheme.Spacing.space1) {
                        SectionLabel(localizer("home.safeToSpend"))
                            .multilineTextAlignment(.center)
                        Text("—")
                            .lunexText(.amountHero)
                            .foregroundStyle(LunexColor.ink)
                    }
                }
                .frame(width: LunexTheme.Size.ringHero, height: LunexTheme.Size.ringHero)
                .padding(.top, LunexTheme.Spacing.space4)
            }
            .padding(.horizontal, LunexTheme.Spacing.space4)
        }
        .background(LunexColor.paper)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("home.addOperation"), systemImage: "plus") { editor = .new(.expense) }
            }
        }
        .refreshable {
            await sync.sync()
            await session.refreshAccess()
        }
        .transactionEditor($editor)
    }
}

struct GoalsView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.goals.title"),
            systemImage: "target",
            description: Text(localizer("empty.goals.body"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.goals"))
    }
}

struct BudgetView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.budget.title"),
            systemImage: "chart.pie",
            description: Text(localizer("empty.budget.body"))
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.budget"))
    }
}

struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SyncEngine.self) private var sync
    @Environment(Localizer.self) private var localizer

    var body: some View {
        @Bindable var localizer = localizer
        Form {
            if let profile = session.profile {
                Section(localizer("settings.account")) {
                    VStack(alignment: .leading, spacing: LunexTheme.Spacing.space1) {
                        Text(profile.displayName ?? profile.email ?? "—")
                            .lunexText(.bodyStrong)
                        if profile.displayName != nil, let email = profile.email {
                            Text(email)
                                .lunexText(.callout)
                                .foregroundStyle(LunexColor.inkMuted)
                        }
                    }
                }
            }
            Section(localizer("settings.manage")) {
                NavigationLink {
                    AccountsView()
                } label: {
                    Label(localizer("accounts.title"), systemImage: "wallet.pass")
                }
                NavigationLink {
                    CategoriesView()
                } label: {
                    Label(localizer("categories.title"), systemImage: "square.grid.2x2")
                }
            }
            Section(localizer("settings.language")) {
                Picker(localizer("settings.language"), selection: $localizer.language) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(language.displayName).tag(language)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            if let access = session.access {
                Section(localizer("settings.plan")) {
                    HStack {
                        Text(localizer(access.isPro ? "settings.plan.pro" : "settings.plan.free"))
                        Spacer()
                        if access.monetizationEnabled, let trial = access.trial, trial.active {
                            StatusBadge(localizer.format("settings.plan.trialLeft", trial.daysLeft), isProminent: true)
                        }
                    }
                }
            }
            Section(localizer("settings.sync")) {
                SyncStatusRow()
                Button(localizer("settings.sync.now")) {
                    Task { await sync.sync() }
                }
                .disabled(sync.status == .syncing)
            }
            Section {
                Button(localizer("settings.signOut"), role: .destructive) {
                    Task { await session.signOut() }
                }
            }
            Section {
                LabeledContent(localizer("settings.version"), value: Bundle.main.appVersion)
            }
        }
        .scrollContentBackground(.hidden)
        .background(LunexColor.paper)
        .navigationTitle(localizer("tab.settings"))
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
private struct SyncStatusRow: View {
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
