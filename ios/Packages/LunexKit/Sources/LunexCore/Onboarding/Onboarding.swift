import Foundation
import Observation

/// `GET /v1/goals/templates`: phone, car, home… with emoji, colour and a name in the asked language.
public struct GoalTemplate: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    public let emoji: String
    public let color: String
    public let name: String

    public var id: String { key }

    public init(key: String, emoji: String, color: String, name: String) {
        self.key = key
        self.emoji = emoji
        self.color = color
        self.name = name
    }
}

public enum OnboardingFocus: String, Codable, Sendable, CaseIterable {
    case save, track, budget
}

/// A goal created during onboarding; ids are made on the device so a retry cannot duplicate it.
public struct NewGoal: Encodable, Sendable, Equatable {
    public let id: UUID
    public let title: String
    public let templateKey: String?
    public let emoji: String?
    public let color: String?
    /// Decimal string in the goal's currency
    public let targetAmount: String
    public let currency: String?
}

/// `POST /v1/me/onboarding`. Every field but the cash account id may be left out (a skipped step).
public struct OnboardingRequest: Encodable, Sendable, Equatable {
    public var language: String?
    public var baseCurrency: String?
    public var timezone: String?
    public var focus: OnboardingFocus?
    public var monthlyIncomeEstimate: String?
    public var cashAccountId: UUID
    public var firstGoal: NewGoal?
}

/// What the server returns; the app needs the completed profile.
public struct OnboardingResult: Decodable, Sendable {
    public let profile: Profile
}

/// Any JSON body the app does not read.
public struct IgnoredResponse: Decodable, Sendable {}

/// Currencies a user can pick as the base one (the server's reference list).
public enum SupportedCurrency {
    public static let codes = ["UZS", "USD", "EUR", "RUB", "KZT"]
    public static let `default` = "UZS"
}

/// Answers collected on the onboarding screens, turned into one request at the end.
public struct OnboardingDraft: Sendable, Equatable {
    public var language: String
    public var currency: String = SupportedCurrency.default
    public var focus: OnboardingFocus?
    /// Digits only, as typed; empty when skipped.
    public var monthlyIncome = ""
    public var goalTemplate: GoalTemplate?
    /// Digits only, as typed.
    public var goalAmount = ""

    public init(language: String) {
        self.language = language
    }

    /// A skipped or zero amount is left out; the server would refuse zero.
    static func amount(_ digits: String) -> String? {
        let digits = digits.filter(\.isASCII).filter(\.isNumber)
        guard let value = Decimal(string: digits), value > 0 else { return nil }
        return NSDecimalNumber(decimal: value).stringValue
    }

    public var hasValidGoal: Bool {
        goalTemplate != nil && Self.amount(goalAmount) != nil
    }

    public func request(cashAccountId: UUID, goalId: UUID, timezone: String) -> OnboardingRequest {
        var goal: NewGoal?
        if let template = goalTemplate, let target = Self.amount(goalAmount) {
            goal = NewGoal(
                id: goalId,
                title: template.name,
                templateKey: template.key,
                emoji: template.emoji,
                color: template.color,
                targetAmount: target,
                currency: currency
            )
        }
        return OnboardingRequest(
            language: language,
            baseCurrency: currency,
            timezone: timezone,
            focus: focus,
            monthlyIncomeEstimate: Self.amount(monthlyIncome),
            cashAccountId: cashAccountId,
            firstGoal: goal
        )
    }
}

extension API {
    public static func goalTemplates(language: String) -> Endpoint<[GoalTemplate]> {
        .get("goals/templates", query: [URLQueryItem(name: "language", value: language)])
    }

    public static func completeOnboarding(_ request: OnboardingRequest) -> Endpoint<OnboardingResult> {
        .send("POST", "me/onboarding", request)
    }

    /// Whether this device may receive push notifications; the APNs token comes with remote push.
    public static func updateDevice(pushEnabled: Bool) -> Endpoint<IgnoredResponse> {
        .send("PUT", "me/devices/current", ["pushEnabled": pushEnabled])
    }
}

/// Runs onboarding against the server. Ids for the cash account and the first goal are made
/// once, so retrying after a network failure creates nothing twice.
@MainActor
@Observable
public final class OnboardingService {
    public private(set) var templates: [GoalTemplate] = []

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let session: SessionStore
    @ObservationIgnored private let cashAccountId = UUID()
    @ObservationIgnored private let goalId = UUID()

    public init(api: APIClient, session: SessionStore) {
        self.api = api
        self.session = session
    }

    public func loadTemplates(language: String) async {
        if let templates = try? await api.send(API.goalTemplates(language: language)) {
            self.templates = templates
        }
    }

    /// Best effort: the choice is kept on the device either way.
    public func reportNotifications(enabled: Bool) async {
        _ = try? await api.send(API.updateDevice(pushEnabled: enabled))
    }

    /// Sends the answers; on success the session holds the completed profile and the app moves on.
    public func complete(_ draft: OnboardingDraft, timezone: String = TimeZone.current.identifier) async throws {
        let result = try await api.send(API.completeOnboarding(
            draft.request(cashAccountId: cashAccountId, goalId: goalId, timezone: timezone)
        ))
        session.update(result.profile)
    }
}
