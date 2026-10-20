import LunexCore
import LunexLocalization
import LunexUI
import Sentry
import SwiftUI

@main
struct LunexApp: App {
    @State private var environment: AppEnvironment
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let config = AppConfig(bundle: .main)
        if let dsn = config.sentryDSN {
            SentrySDK.start { options in
                options.dsn = dsn
                options.releaseName = config.appVersion
                // A finance app: no IPs, user data or request bodies in error reports.
                options.sendDefaultPii = false
                options.tracesSampleRate = 0
                #if DEBUG
                options.environment = "development"
                #else
                options.environment = "production"
                #endif
            }
        }
        LunexAppearance.apply()
        _environment = State(initialValue: Self.uiTesting() ?? AppEnvironment.live(config: config))
    }

    /// `LUNEX_UI_TEST=signedOut|signedIn` from the UI tests: the app runs against an in-memory
    /// server and storage of its own (debug builds only).
    private static func uiTesting() -> AppEnvironment? {
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        guard let start = environment["LUNEX_UI_TEST"].flatMap(UITestServer.Start.init(rawValue:)) else { return nil }
        UIView.setAnimationsEnabled(false)
        let language = environment["LUNEX_UI_TEST_LANGUAGE"].flatMap(AppLanguage.init(rawValue:)) ?? .ru
        return AppEnvironment.uiTesting(start: start, language: language)
        #else
        return nil
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .lunexEnvironment(environment)
        }
        .onChange(of: scenePhase) { _, phase in
            // Plan and limits may change on the server (e.g. monetization switched on).
            if phase == .active {
                Task {
                    await environment.session.refreshAccess()
                    if environment.session.profile?.onboardingCompleted == true {
                        await environment.sync.sync()
                        await environment.budgetPlans.refresh()
                    }
                }
            }
        }
    }
}
