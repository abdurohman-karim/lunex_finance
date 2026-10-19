import LunexCore
import LunexLocalization
import SwiftUI

// Tab roots. Each feature step of the build plan replaces its placeholder with the real screen.

struct HomeView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ScrollView {
            VStack(spacing: LunexTheme.Spacing.m) {
                if session.lastError?.isOffline == true {
                    Label(localizer("home.offline"), systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Card {
                    // Filled by the budget («Можно потратить сегодня») in the home-screen step.
                    HeadlineAmount(title: localizer("home.safeToSpend"), value: "—")
                }
            }
            .padding(LunexTheme.Spacing.m)
        }
        .navigationTitle(localizer("tab.home"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(localizer("home.addOperation"), systemImage: "plus.circle.fill") {}
                    .disabled(true)
            }
        }
        .refreshable { await session.reloadProfile() }
    }
}

struct TransactionsView: View {
    @Environment(Localizer.self) private var localizer

    var body: some View {
        ContentUnavailableView(
            localizer("empty.transactions.title"),
            systemImage: "list.bullet.rectangle",
            description: Text(localizer("empty.transactions.body"))
        )
        .navigationTitle(localizer("tab.transactions"))
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
        .navigationTitle(localizer("tab.budget"))
    }
}

struct SettingsView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        @Bindable var localizer = localizer
        Form {
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
                    Text(localizer(access.isPro ? "settings.plan.pro" : "settings.plan.free"))
                }
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
