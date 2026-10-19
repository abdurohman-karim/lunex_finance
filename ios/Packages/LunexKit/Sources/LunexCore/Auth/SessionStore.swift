import Foundation
import Observation

/// Remembers the last profile so the app opens signed in without a network round trip.
public protocol ProfileCache: Sendable {
    func load() -> Profile?
    func save(_ profile: Profile?)
}

public struct UserDefaultsProfileCache: ProfileCache {
    private let key = "lunex.profile"
    nonisolated(unsafe) private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> Profile? {
        defaults.data(forKey: key).flatMap { try? LunexJSON.decoder().decode(Profile.self, from: $0) }
    }

    public func save(_ profile: Profile?) {
        if let profile, let data = try? LunexJSON.encoder().encode(profile) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

/// Who is signed in, for the UI. Talks to the API and keeps the last known profile and
/// access so the app starts instantly, also offline.
@MainActor
@Observable
public final class SessionStore {
    public enum State: Equatable {
        /// Checking the stored session on launch
        case loading
        case signedOut
        case signedIn(Profile)
    }

    public private(set) var state: State = .loading
    public private(set) var access: Access?
    /// Last network problem worth showing (e.g. an offline banner); nil when fine.
    public private(set) var lastError: APIError?

    private let api: APIClient
    private let auth: AuthSession
    private let cache: ProfileCache

    public init(api: APIClient, auth: AuthSession, cache: ProfileCache) {
        self.api = api
        self.auth = auth
        self.cache = cache
    }

    public var profile: Profile? {
        if case let .signedIn(profile) = state { return profile }
        return nil
    }

    /// On launch: a stored session with a cached profile opens at once; the network refreshes it.
    public func restore() async {
        guard await auth.hasSession else {
            cache.save(nil)
            state = .signedOut
            return
        }
        if let cached = cache.load() {
            state = .signedIn(cached)
        }
        await reloadProfile()
    }

    /// After a sign-in endpoint answered.
    public func signedIn(_ response: SignInResponse) async {
        await auth.save(response.tokens)
        apply(response.user)
        await refreshAccess()
    }

    /// A profile the server returned from another call (onboarding, a profile edit).
    public func update(_ profile: Profile) {
        apply(profile)
    }

    public func reloadProfile() async {
        do {
            apply(try await api.send(API.me()))
            lastError = nil
            await refreshAccess()
        } catch {
            lastError = error as? APIError ?? APIError.offline(error)
            if !(await auth.hasSession) { sessionEnded() }
        }
    }

    /// Plan, trial and limits; on launch and whenever the app comes to the foreground.
    public func refreshAccess() async {
        guard await auth.hasSession else { return }
        do {
            access = try await api.send(API.access())
        } catch {
            lastError = error as? APIError ?? APIError.offline(error)
        }
    }

    public func signOut() async {
        if let refreshToken = await auth.refreshToken {
            // Best effort: the server forgets the session; locally it ends either way.
            _ = try? await api.send(API.logout(refreshToken))
        }
        await auth.clear()
        sessionEnded()
    }

    /// The session is over: signed out here, or ended by the server (revoked, account deleted).
    public func sessionEnded() {
        cache.save(nil)
        state = .signedOut
        access = nil
    }

    private func apply(_ profile: Profile) {
        cache.save(profile)
        state = .signedIn(profile)
    }
}
