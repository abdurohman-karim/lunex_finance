import LunexCore
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
        _environment = State(initialValue: AppEnvironment.live(config: config))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .lunexEnvironment(environment)
        }
        .onChange(of: scenePhase) { _, phase in
            // Plan and limits may change on the server (e.g. monetization switched on).
            if phase == .active {
                Task { await environment.session.refreshAccess() }
            }
        }
    }
}
