import LunexCore
import LunexLocalization
import SwiftData
import SwiftUI

/// Chooses between the welcome screen and the app by session state.
public struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(SyncEngine.self) private var sync
    @Environment(BudgetPlans.self) private var budgetPlans
    @Environment(SettingsStore.self) private var settings
    @Environment(AppLock.self) private var appLock
    @Environment(Localizer.self) private var localizer
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppTheme.storageKey) private var theme = AppTheme.system
    @Query private var records: [SettingsRecord]

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
        // The switcher shows the screen blurred; a locked app shows nothing but the lock.
        .blur(radius: scenePhase == .active ? 0 : 24)
        .overlay {
            if readyAccount != nil, appLock.isLocked {
                LockView().transition(.opacity)
            } else if scenePhase != .active {
                PrivacyCover()
            }
        }
        .environment(\.locale, localizer.locale)
        .preferredColorScheme(theme.colorScheme)
        .tint(LunexColor.ink)
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: appLock.didEnterBackground()
            case .active: appLock.didBecomeActive()
            default: break
            }
        }
        .onChange(of: records.first?.hideAmounts, initial: true) { _, hidden in
            localizer.hidesAmounts = hidden ?? false
        }
        .onChange(of: lockSettings, initial: true) { _, value in
            appLock.configure(enabled: value.enabled, lockAfterSeconds: value.seconds)
        }
        .animation(.default, value: session.state)
        .task { await session.restore() }
        .task(id: readyAccount) {
            // Signed in and set up (also right after onboarding): bring the local store up to date.
            if readyAccount != nil {
                await sync.sync()
                await budgetPlans.refresh()
                // «Сегодня» and «месяц» are counted in the device's time zone.
                let zone = TimeZone.current.identifier
                if let profile = session.profile, profile.timezone != zone {
                    try? settings.updateProfile(timezone: zone)
                }
            }
        }
    }

    private var lockSettings: LockSettings {
        LockSettings(enabled: records.first?.biometricLockEnabled ?? false, seconds: records.first?.lockAfterSeconds ?? 60)
    }

    private struct LockSettings: Equatable {
        let enabled: Bool
        let seconds: Int
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

/// The selected main tab, for screens that send the user to another one (the home screen's
/// «Все», the month line, «Первые шаги»).
@MainActor
@Observable
final class TabRouter {
    var tab: AppTab = .home
}

struct MainTabView: View {
    @Environment(Localizer.self) private var localizer
    @Environment(ToastCenter.self) private var toasts
    @State private var router = TabRouter()

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
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
        .environment(router)
    }
}

#Preview {
    RootView()
        .lunexEnvironment(AppEnvironment.preview())
}
