import LunexCore
import LunexLocalization
import SwiftUI

/// Chooses between the welcome screen and the app by session state.
public struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SyncEngine.self) private var sync
    @Environment(BudgetPlans.self) private var budgetPlans
    @Environment(Localizer.self) private var localizer

    public init() {}

    public var body: some View {
        Group {
            switch session.state {
            case .loading:
                LoadingView()
            case .signedOut:
                NavigationStack { WelcomeView() }
            case let .signedIn(profile):
                if profile.onboardingCompleted {
                    MainTabView()
                } else {
                    OnboardingView()
                }
            }
        }
        .environment(\.locale, localizer.locale)
        .tint(LunexColor.ink)
        .animation(.default, value: session.state)
        .task { await session.restore() }
        .task(id: readyAccount) {
            // Signed in and set up (also right after onboarding): bring the local store up to date.
            if readyAccount != nil {
                await sync.sync()
                await budgetPlans.refresh()
            }
        }
    }

    private var readyAccount: UUID? {
        guard let profile = session.profile, profile.onboardingCompleted else { return nil }
        return profile.id
    }
}

struct LoadingView: View {
    @Environment(SessionStore.self) private var session
    @Environment(Localizer.self) private var localizer

    var body: some View {
        VStack(spacing: LunexTheme.Spacing.space4) {
            ProgressView()
            Text(localizer("common.loading"))
                .lunexText(.callout)
                .foregroundStyle(LunexColor.inkMuted)
            if session.lastError != nil {
                Button(localizer("common.retry")) {
                    Task { await session.restore() }
                }
                .buttonStyle(.lunex(.secondary, size: .compact))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LunexColor.paper)
    }
}

enum AppTab: Hashable {
    case home, transactions, goals, budget, settings
}

struct MainTabView: View {
    @Environment(Localizer.self) private var localizer
    @Environment(ToastCenter.self) private var toasts
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
        .toastHost(toasts)
    }
}

#Preview {
    RootView()
        .lunexEnvironment(AppEnvironment.preview())
}
