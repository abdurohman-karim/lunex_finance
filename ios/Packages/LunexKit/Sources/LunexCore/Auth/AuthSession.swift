import Foundation

public struct TokenPair: Codable, Sendable, Equatable {
    public let accessToken: String
    public let accessTokenExpiresAt: Date
    public let refreshToken: String
    public let refreshTokenExpiresAt: Date

    public init(accessToken: String, accessTokenExpiresAt: Date, refreshToken: String, refreshTokenExpiresAt: Date) {
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.refreshToken = refreshToken
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
    }
}

/// Holds the session: the access token in memory, the refresh token in the Keychain.
/// Concurrent requests that need a new access token share one refresh.
public actor AuthSession {
    public typealias Refresher = @Sendable (_ refreshToken: String) async throws -> TokenPair

    /// Refresh a little before expiry so a request does not leave with a dying token.
    private static let expiryMargin: TimeInterval = 30

    private let store: SecureStore
    private let refresher: Refresher
    private let onSignedOut: @Sendable () -> Void
    private var accessToken: String?
    private var accessTokenExpiresAt: Date?
    private var refreshTask: Task<TokenPair, Error>?

    public init(
        store: SecureStore,
        refresher: @escaping Refresher,
        onSignedOut: @escaping @Sendable () -> Void = {}
    ) {
        self.store = store
        self.refresher = refresher
        self.onSignedOut = onSignedOut
    }

    /// A stored refresh token means the user is signed in, even offline.
    public var hasSession: Bool {
        store.string(for: SecureKey.refreshToken) != nil
    }

    public func save(_ tokens: TokenPair) {
        accessToken = tokens.accessToken
        accessTokenExpiresAt = tokens.accessTokenExpiresAt
        store.set(tokens.refreshToken, for: SecureKey.refreshToken)
        store.set(LunexJSON.formatDate(tokens.refreshTokenExpiresAt), for: SecureKey.refreshTokenExpiresAt)
    }

    /// The current refresh token, e.g. to sign out on the server.
    public var refreshToken: String? {
        store.string(for: SecureKey.refreshToken)
    }

    public func clear() {
        refreshTask?.cancel()
        refreshTask = nil
        accessToken = nil
        accessTokenExpiresAt = nil
        store.set(nil, for: SecureKey.refreshToken)
        store.set(nil, for: SecureKey.refreshTokenExpiresAt)
    }

    public func validAccessToken(now: Date = Date()) async throws -> String {
        if let accessToken, let expiresAt = accessTokenExpiresAt,
           expiresAt.timeIntervalSince(now) > Self.expiryMargin {
            return accessToken
        }
        return try await refresh()
    }

    /// After a 401: the server rejected the token we thought was valid.
    public func forceRefresh() async throws -> String {
        accessToken = nil
        accessTokenExpiresAt = nil
        return try await refresh()
    }

    private func refresh() async throws -> String {
        // Someone is already refreshing: wait for the same result.
        if let refreshTask {
            return try await refreshTask.value.accessToken
        }
        guard let refreshToken = store.string(for: SecureKey.refreshToken) else {
            throw APIError(status: 401, code: "signed_out", message: "Not signed in")
        }
        let task = Task { [refresher] in
            try await refresher(refreshToken)
        }
        refreshTask = task
        do {
            let tokens = try await task.value
            refreshTask = nil
            save(tokens)
            return tokens.accessToken
        } catch let error as APIError where !error.isTransient {
            // The refresh token is revoked, reused or expired: the session is over.
            refreshTask = nil
            clear()
            onSignedOut()
            throw error
        } catch {
            refreshTask = nil
            throw error
        }
    }
}
