import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Chooses between the welcome screen and the app by session state.
public struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    public init() {}

    public var body: some View {
        Group {
            switch session.state {
            case .loading:
                LoadingView()
            case .signedOut:
                WelcomeView()
            case .signedIn:
                MainTabView()
            }
        }
        .environment(\.locale, localizer.locale)
        .animation(.default, value: session.state)
        .task { await session.restore() }
    }
}

struct LoadingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        VStack(spacing: LunexTheme.Spacing.m) {
            ProgressView()
            Text(localizer("common.loading")).foregroundStyle(.secondary)
            if session.lastError != nil {
                Button(localizer("common.retry")) {
                    Task { await session.restore() }
                }
                .buttonStyle(.bordered)
            }
        }
    }
}

enum AppTab: Hashable {
    case home, transactions, goals, budget, settings
}

struct MainTabView: View {
    @Environment(Localizer.self) private var localizer
    @State private var tab: AppTab = .home

    var body: some View {
        TabView(selection: $tab) {
            Tab(localizer("tab.home"), systemImage: "house.fill", value: AppTab.home) {
                NavigationStack { HomeView() }
            }
            Tab(localizer("tab.transactions"), systemImage: "list.bullet.rectangle", value: AppTab.transactions) {
                NavigationStack { TransactionsView() }
            }
            Tab(localizer("tab.goals"), systemImage: "target", value: AppTab.goals) {
                NavigationStack { GoalsView() }
            }
            Tab(localizer("tab.budget"), systemImage: "chart.pie.fill", value: AppTab.budget) {
                NavigationStack { BudgetView() }
            }
            Tab(localizer("tab.settings"), systemImage: "gearshape.fill", value: AppTab.settings) {
                NavigationStack { SettingsView() }
            }
        }
    }
}

#Preview {
    let environment = AppEnvironment.preview()
    RootView()
        .environment(environment.session)
        .environment(environment.localizer)
        .modelContainer(environment.container)
}
