import Foundation
import LunexCore
import LunexLocalization
import OSLog
import SwiftData
import SwiftUI

/// Wires the app's long-lived services once: Keychain, API, session, strings, local database.
@MainActor
public final class AppEnvironment {
    public let config: AppConfig
    public let session: SessionStore
    public let signIn: SignInService
    public let onboarding: OnboardingService
    public let sync: SyncEngine
    public let ledger: Ledger
    public let catalog: Catalog
    public let goals: GoalBook
    public let budgetPlans: BudgetPlans
    public let smartSave: SmartSaveStore
    public let toasts = ToastCenter()
    public let localizer: Localizer
    public let container: ModelContainer
    public let deviceId: UUID
    public let api: APIClient

    private static let logger = Logger(subsystem: "uz.lunex.finance", category: "environment")
    /// Simulator and debug builds talk to the local backend (`backend/`, port 3000).
    private static let developmentAPI = URL(string: "http://localhost:3000/v1")!

    private init(
        config: AppConfig,
        session: SessionStore,
        signIn: SignInService,
        onboarding: OnboardingService,
        sync: SyncEngine,
        localizer: Localizer,
        container: ModelContainer,
        deviceId: UUID,
        api: APIClient
    ) {
        self.config = config
        self.session = session
        self.signIn = signIn
        self.onboarding = onboarding
        self.sync = sync
        self.ledger = Ledger(container: container, sync: sync) { session.profile?.baseCurrency ?? "UZS" }
        self.catalog = Catalog(container: container, sync: sync)
        self.goals = GoalBook(container: container, sync: sync)
        let budgetPlans = BudgetPlans(api: api)
        self.budgetPlans = budgetPlans
        let smartSave = SmartSaveStore(api: api, sync: sync)
        self.smartSave = smartSave
        // Signing out leaves nothing of the account on the device.
        session.onSessionEnded = { sync.reset(); budgetPlans.reset(); smartSave.reset() }
        self.localizer = localizer
        self.container = container
        self.deviceId = deviceId
        self.api = api
    }

    public static func live(config: AppConfig) -> AppEnvironment {
        let store = KeychainStore()
        let baseURL = config.apiBaseURL ?? developmentAPI
        if config.apiBaseURL == nil {
            logger.error("LunexAPIBaseURL is not set; using \(developmentAPI.absoluteString)")
        }

        let transport = URLSessionTransport()
        // Sign-in and refresh go without a session; everything else through AuthSession.
        let publicAPI = APIClient(baseURL: baseURL, transport: transport, session: nil, appVersion: config.appVersion)
        let sessionBox = SessionBox()
        let auth = AuthSession(
            store: store,
            refresher: { refreshToken in try await publicAPI.send(API.refresh(refreshToken)) },
            onSignedOut: { Task { @MainActor in sessionBox.session?.sessionEnded() } }
        )
        let api = APIClient(baseURL: baseURL, transport: transport, session: auth, appVersion: config.appVersion)
        let session = SessionStore(api: api, auth: auth, cache: UserDefaultsProfileCache())
        sessionBox.session = session

        let deviceId = DeviceIdentity.id(in: store)
        let signIn = SignInService(
            api: publicAPI,
            session: session,
            device: DeviceInfo.current(id: deviceId, appVersion: config.appVersion),
            telegramStartURL: TelegramLogin.startURL(apiBaseURL: baseURL),
            google: config.googleClientID.map { GoogleSignIn(clientID: $0, transport: transport) }
        )

        let container = makeContainer()
        let sync = SyncEngine(api: api, container: container) { profile in session.update(profile) }
        sync.startMonitoringNetwork()

        return AppEnvironment(
            config: config,
            session: session,
            signIn: signIn,
            onboarding: OnboardingService(api: api, session: session),
            sync: sync,
            localizer: Localizer(),
            container: container,
            deviceId: deviceId,
            api: api
        )
    }

    /// In-memory everything, for SwiftUI previews.
    public static func preview() -> AppEnvironment {
        let store = InMemorySecureStore()
        let config = AppConfig(apiBaseURL: developmentAPI, sentryDSN: nil, appVersion: "preview")
        let auth = AuthSession(store: store, refresher: { _ in
            throw APIError(status: 401, code: "preview", message: "Preview")
        })
        let api = APIClient(baseURL: developmentAPI, transport: URLSessionTransport(), session: auth)
        let session = SessionStore(api: api, auth: auth, cache: UserDefaultsProfileCache(defaults: UserDefaults(suiteName: "preview")!))
        let deviceId = DeviceIdentity.id(in: store)
        let container = try! LunexStore.makeContainer(inMemory: true)
        return AppEnvironment(
            config: config,
            session: session,
            signIn: SignInService(
                api: api,
                session: session,
                device: DeviceInfo(id: deviceId, model: nil, osVersion: nil, appVersion: "preview"),
                telegramStartURL: TelegramLogin.startURL(apiBaseURL: developmentAPI),
                google: nil
            ),
            onboarding: OnboardingService(api: api, session: session),
            sync: SyncEngine(api: api, container: container) { _ in },
            localizer: Localizer(defaults: UserDefaults(suiteName: "preview")!),
            container: container,
            deviceId: deviceId,
            api: api
        )
    }

    private static func makeContainer() -> ModelContainer {
        do {
            return try LunexStore.makeContainer()
        } catch {
            // Even a fresh store failed (disk full?): run from memory; the server has the data.
            logger.fault("Local store failed to open: \(error.localizedDescription); using memory")
            return try! LunexStore.makeContainer(inMemory: true)
        }
    }
}

extension View {
    /// Puts the app's services where the screens read them.
    public func lunexEnvironment(_ app: AppEnvironment) -> some View {
        environment(app.session)
            .environment(app.signIn)
            .environment(app.onboarding)
            .environment(app.sync)
            .environment(app.ledger)
            .environment(app.catalog)
            .environment(app.goals)
            .environment(app.budgetPlans)
            .environment(app.smartSave)
            .environment(app.toasts)
            .environment(app.localizer)
            .modelContainer(app.container)
    }
}

/// Lets AuthSession tell the session store it ended, without a reference cycle at init time.
@MainActor
private final class SessionBox {
    weak var session: SessionStore?
}
