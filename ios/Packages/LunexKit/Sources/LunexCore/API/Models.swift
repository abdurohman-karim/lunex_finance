import Foundation

/// `GET /v1/me`
public struct Profile: Codable, Sendable, Equatable {
    public let id: UUID
    public let displayName: String?
    public let email: String?
    public let role: String
    public let language: String
    public let baseCurrency: String
    public let timezone: String
    public let onboardingCompleted: Bool
    public let onboardingFocus: String?
    public let monthlyIncomeEstimate: String?
    public let identities: [String]
    public let createdAt: Date
    public let updatedAt: Date
}

/// `GET /v1/me/access`: what the user may do on Free or Pro. Loaded on launch and on
/// return to foreground, so turning monetization on needs no app update.
public struct Access: Codable, Sendable, Equatable {
    public struct Trial: Codable, Sendable, Equatable {
        public let startedAt: Date
        public let endsAt: Date
        public let active: Bool
        public let daysLeft: Int
    }

    public struct Limits: Codable, Sendable, Equatable {
        /// nil = unlimited
        public let accounts: Int?
        public let activeGoals: Int?
        public let aiMessagesPerDay: Int
        public let analyticsMonths: Int?
    }

    public let monetizationEnabled: Bool
    public let plan: String
    public let source: String?
    public let expiresAt: Date?
    public let trial: Trial?
    public let features: [String]
    public let limits: Limits

    public var isPro: Bool { plan == "pro" }

    public func allows(_ feature: String) -> Bool {
        features.contains(feature)
    }
}

/// Response of every sign-in endpoint.
public struct SignInResponse: Codable, Sendable {
    public let user: Profile
    public let isNewUser: Bool
    public let accessToken: String
    public let accessTokenExpiresAt: Date
    public let refreshToken: String
    public let refreshTokenExpiresAt: Date

    public var tokens: TokenPair {
        TokenPair(
            accessToken: accessToken,
            accessTokenExpiresAt: accessTokenExpiresAt,
            refreshToken: refreshToken,
            refreshTokenExpiresAt: refreshTokenExpiresAt
        )
    }
}

/// Endpoints the skeleton needs; feature steps add theirs next to them.
public enum API {
    public static func me() -> Endpoint<Profile> {
        .get("me")
    }

    public static func access() -> Endpoint<Access> {
        .get("me/access")
    }

    public static func refresh(_ refreshToken: String) -> Endpoint<TokenPair> {
        .send("POST", "auth/refresh", ["refreshToken": refreshToken], authenticated: false)
    }

    public static func logout(_ refreshToken: String) -> Endpoint<NoContent> {
        .send("POST", "auth/logout", ["refreshToken": refreshToken], authenticated: false)
    }
}
