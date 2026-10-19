import Foundation
import LunexCore
import LunexLocalization
import OSLog
import SwiftData

/// Wires the app's long-lived services once: Keychain, API, session, strings, local database.
@MainActor
public final class AppEnvironment {
    public let config: AppConfig
    public let session: SessionStore
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
        localizer: Localizer,
        container: ModelContainer,
        deviceId: UUID,
        api: APIClient
    ) {
        self.config = config
        self.session = session
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

        return AppEnvironment(
            config: config,
            session: session,
            localizer: Localizer(),
            container: makeContainer(),
            deviceId: DeviceIdentity.id(in: store),
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
        return AppEnvironment(
            config: config,
            session: SessionStore(api: api, auth: auth, cache: UserDefaultsProfileCache(defaults: UserDefaults(suiteName: "preview")!)),
            localizer: Localizer(defaults: UserDefaults(suiteName: "preview")!),
            container: try! LunexStore.makeContainer(inMemory: true),
            deviceId: DeviceIdentity.id(in: store),
            api: api
        )
    }

    private static func makeContainer() -> ModelContainer {
        do {
            return try LunexStore.makeContainer()
        } catch {
            // A broken store must not keep the app from starting; the server has the data.
            logger.fault("Local store failed to open: \(error.localizedDescription); using memory")
            return try! LunexStore.makeContainer(inMemory: true)
        }
    }
}

/// Lets AuthSession tell the session store it ended, without a reference cycle at init time.
@MainActor
private final class SessionBox {
    weak var session: SessionStore?
}
