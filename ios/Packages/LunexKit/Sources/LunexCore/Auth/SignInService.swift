import Foundation
import Observation

/// Signs a guest in: asks the server which methods are on, sends email codes and exchanges
/// a provider's credential for a session. The provider sheets themselves are UI (LunexUI).
@MainActor
@Observable
public final class SignInService {
    /// nil until the server answered (or while offline): every method is offered then.
    public private(set) var providers: AuthProviders?

    /// Set when the app has a Google iOS client id.
    public let google: GoogleSignIn?
    public let telegramStartURL: URL

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let device: DeviceInfo

    public init(
        api: APIClient,
        session: SessionStore,
        device: DeviceInfo,
        telegramStartURL: URL,
        google: GoogleSignIn?
    ) {
        self.api = api
        self.session = session
        self.device = device
        self.telegramStartURL = telegramStartURL
        self.google = google
    }

    public func loadProviders() async {
        if let providers = try? await api.send(API.authProviders()) {
            self.providers = providers
        }
    }

    /// False when the server or the app has no configuration for it.
    public func isAvailable(_ provider: AuthProvider) -> Bool {
        if provider == .google, google == nil { return false }
        return providers?.isEnabled(provider) ?? true
    }

    public func requestEmailCode(_ email: String, language: String) async throws -> EmailCodeSent {
        try await api.send(API.emailStart(email: email, language: language))
    }

    /// On success the session is signed in and the UI moves on by itself.
    public func signIn(_ credential: SignInCredential, language: String) async throws {
        let response = try await api.send(API.signIn(credential, device: device, language: language))
        await session.signedIn(response)
    }
}
