#if DEBUG
import Foundation

/// The API for UI tests (`-LunexUITesting`): answers the requests the app makes from memory,
/// so the tests need neither a network nor the backend. Responses are the app's own wire types,
/// encoded the way it decodes them. Debug builds only.
///
/// Pushed changes are accepted and kept on the device; the server only remembers what it
/// creates itself (the account, onboarding and its «Наличные», the first goal).
public actor UITestServer: HTTPTransport {
    public enum Start: String, Sendable {
        /// A new user on the welcome screen
        case signedOut
        /// An account past onboarding: «Наличные», the categories, an income estimate
        case signedIn
    }

    /// The only code `auth/email/verify` accepts.
    public static let emailCode = "123456"
    /// A signed-in start keeps this in the Keychain.
    public static let refreshToken = "ui-test-refresh-token"
    /// The onboarding estimate of a signed-in start: the budget runs on it.
    public static let incomeEstimate = "3100000"

    private struct Versioned<Value: Sendable>: Sendable {
        let version: Int
        let value: Value
    }

    private var profile: Profile?
    private var profileVersion = 0
    private var accounts: [Versioned<AccountDTO>] = []
    private var goals: [Versioned<GoalDTO>] = []
    private let categories: [CategoryDTO]
    /// The sync cursor: bumped by every change the server makes
    private var version = 1

    public init(start: Start) {
        let now = Date.now
        categories = Self.systemCategories(at: now)
        guard start == .signedIn else { return }
        let profile = Self.profile(
            email: "beta@lunex.test", language: "ru", onboarded: true, estimate: Self.incomeEstimate, at: now
        )
        self.profile = profile
        profileVersion = 1
        accounts = [Versioned(version: 1, value: Self.cash(id: UUID(), language: profile.language, at: now))]
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url else { throw URLError(.badURL) }
        let path = url.path.components(separatedBy: "/v1/").last ?? url.path
        let body = request.httpBody
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let reply = Reply(url: url)

        switch (request.httpMethod ?? "GET", path) {
        case ("GET", "auth/providers"):
            return try reply.json(AuthProviders(apple: false, google: false, telegram: false, email: true))
        case ("POST", "auth/email/start"):
            return try reply.json(EmailCodeSent(expiresIn: 600, resendIn: 60), status: 202)
        case ("POST", "auth/email/verify"):
            return try verify(body, reply)
        case ("POST", "auth/refresh"):
            return try reply.json(Self.tokens())
        case ("POST", "auth/logout"):
            return reply.empty()
        case ("GET", "me"):
            guard let profile else { return reply.error(401, "unauthorized") }
            return try reply.json(profile)
        case ("GET", "me/access"):
            return try reply.json(Self.access)
        case ("GET", "goals/templates"):
            let language = query.first { $0.name == "language" }?.value ?? "ru"
            return try reply.json(BuiltInGoalTemplate.all.map {
                GoalTemplate(key: $0.key, emoji: $0.emoji, color: $0.color, name: $0.name(language: language))
            })
        case ("POST", "me/onboarding"):
            return try onboard(body, reply)
        case ("PUT", "me/devices/current"):
            return reply.raw("{}")
        case ("GET", "sync/changes"):
            let cursor = query.first { $0.name == "cursor" }?.value.flatMap(Int.init) ?? 0
            return try reply.json(changes(after: cursor))
        case ("POST", "sync/push"):
            let operations = body["operations"] as? [[String: Any]] ?? []
            return try reply.json(PushResponse(results: operations.map {
                PushResponse.Result(opId: $0["opId"] as? String, status: "applied", code: nil, message: nil)
            }))
        case ("GET", "smart-save/today"):
            return reply.raw(#"{"status":"no_spare_money","suggestion":null,"explanation":null}"#)
        default:
            // The budget plan and the rest: the app works from what it has.
            return reply.error(404, "not_found")
        }
    }

    // MARK: Sign-in and onboarding

    private func verify(_ body: [String: Any], _ reply: Reply) throws -> (Data, HTTPURLResponse) {
        guard body["code"] as? String == Self.emailCode else {
            return reply.error(400, "invalid_code")
        }
        let isNew = profile == nil
        let profile = profile ?? Self.profile(
            email: body["email"] as? String, language: body["language"] as? String ?? "ru",
            onboarded: false, estimate: nil, at: .now
        )
        set(profile)
        let tokens = Self.tokens()
        return try reply.json(SignInResponse(
            user: profile, isNewUser: isNew, accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt, refreshToken: tokens.refreshToken,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt
        ))
    }

    private func onboard(_ body: [String: Any], _ reply: Reply) throws -> (Data, HTTPURLResponse) {
        guard let current = profile else { return reply.error(401, "unauthorized") }
        guard let cashId = (body["cashAccountId"] as? String).flatMap(UUID.init(uuidString:)) else {
            return reply.error(400, "validation_failed")
        }
        let now = Date.now
        let updated = Profile(
            id: current.id, displayName: current.displayName, email: current.email, role: current.role,
            language: body["language"] as? String ?? current.language,
            baseCurrency: body["baseCurrency"] as? String ?? current.baseCurrency,
            timezone: body["timezone"] as? String ?? current.timezone,
            onboardingCompleted: true, onboardingFocus: body["focus"] as? String,
            monthlyIncomeEstimate: body["monthlyIncomeEstimate"] as? String,
            identities: current.identities, createdAt: current.createdAt, updatedAt: now
        )
        set(updated)
        if !accounts.contains(where: { $0.value.id == cashId }) {
            accounts.append(Versioned(version: version, value: Self.cash(
                id: cashId, language: updated.language, currency: updated.baseCurrency, at: now
            )))
        }
        if let goal = body["firstGoal"] as? [String: Any],
           let id = (goal["id"] as? String).flatMap(UUID.init(uuidString:)),
           !goals.contains(where: { $0.value.id == id }) {
            let template = BuiltInGoalTemplate.all.first { $0.key == goal["templateKey"] as? String }
            goals.append(Versioned(version: version, value: GoalDTO(
                id: id, title: goal["title"] as? String ?? template?.name(language: updated.language) ?? "",
                emoji: template?.emoji ?? BuiltInGoalTemplate.defaultEmoji,
                color: template?.color ?? BuiltInGoalTemplate.defaultColor,
                templateKey: template?.key, targetAmount: goal["targetAmount"] as? String ?? "0", savedAmount: "0",
                progress: 0, currency: updated.baseCurrency, deadline: nil, status: "active", isPrimary: true,
                priority: 0, linkedAccountId: nil, milestones: [], schedule: nil, completedAt: nil,
                archivedAt: nil, createdAt: now, updatedAt: now, deletedAt: nil
            )))
        }
        struct Result: Encodable { let profile: Profile }
        return try reply.json(Result(profile: updated))
    }

    private func set(_ profile: Profile) {
        version += 1
        self.profile = profile
        profileVersion = version
    }

    // MARK: Sync

    private func changes(after cursor: Int) -> SyncPage {
        SyncPage(
            profile: profileVersion > cursor ? profile : nil,
            accounts: accounts.filter { $0.version > cursor }.map(\.value),
            categories: cursor == 0 ? categories : [],
            transactions: [],
            goals: goals.filter { $0.version > cursor }.map(\.value),
            goalContributions: [],
            settings: cursor == 0 && profile != nil ? Self.settings(defaultAccount: accounts.first?.value.id) : nil,
            nextCursor: String(version),
            hasMore: false,
            serverTime: .now
        )
    }

    // MARK: Data

    private static func profile(email: String?, language: String, onboarded: Bool, estimate: String?, at now: Date) -> Profile {
        Profile(
            id: UUID(), displayName: nil, email: email, role: "user", language: language, baseCurrency: "UZS",
            timezone: TimeZone.current.identifier, onboardingCompleted: onboarded,
            onboardingFocus: onboarded ? "save" : nil, monthlyIncomeEstimate: estimate, identities: ["email"],
            createdAt: now, updatedAt: now
        )
    }

    private static func tokens() -> TokenPair {
        TokenPair(
            accessToken: "ui-test-access-\(UUID().uuidString)", accessTokenExpiresAt: .now.addingTimeInterval(900),
            refreshToken: refreshToken, refreshTokenExpiresAt: .now.addingTimeInterval(60 * 86_400)
        )
    }

    /// Monetization off: everything open, as in the beta.
    private static let access = Access(
        monetizationEnabled: false, plan: "pro", source: "monetization_off", expiresAt: nil, trial: nil,
        features: [], limits: .init(accounts: nil, activeGoals: nil, aiMessagesPerDay: 50, analyticsMonths: nil)
    )

    private static func cash(id: UUID, language: String, currency: String = "UZS", at now: Date) -> AccountDTO {
        let names = ["uz": "Naqd pul", "ru": "Наличные", "en": "Cash"]
        return AccountDTO(
            id: id, name: names[language] ?? "Cash", type: "cash", currency: currency, initialBalance: "0",
            currentBalance: "0", icon: "banknote", color: "#5D5C61", includeInTotal: true, isArchived: false,
            isDefault: true, sortOrder: 0, updatedAt: now, deletedAt: nil
        )
    }

    private static func settings(defaultAccount: UUID?) -> SettingsDTO {
        SettingsDTO(
            biometricLockEnabled: false, lockAfterSeconds: 60, hideAmounts: false, weekStartsOn: 1,
            monthStartsOnDay: 1, defaultAccountId: defaultAccount, dailyReminderEnabled: true,
            dailyReminderTime: "21:00", budgetAlertsEnabled: true, goalAlertsEnabled: true,
            recurringAlertsEnabled: true, smartSaveEnabled: true, weeklyReportEnabled: true,
            quietHoursStart: "22:00", quietHoursEnd: "08:00", hapticsEnabled: true, updatedAt: .now
        )
    }

    /// Part of the server's reference list (`backend/src/database/reference-data.ts`).
    private static func systemCategories(at now: Date) -> [CategoryDTO] {
        let list: [(type: String, key: String, icon: String, color: String, uz: String, ru: String, en: String)] = [
            ("expense", "food", "fork.knife", "#C08B5C", "Oziq-ovqat", "Еда", "Food"),
            ("expense", "transport", "bus.fill", "#557A95", "Transport", "Транспорт", "Transport"),
            ("expense", "market", "cart.fill", "#6E8B74", "Supermarket", "Супермаркет", "Groceries"),
            ("expense", "cafe", "cup.and.saucer.fill", "#8C7B6B", "Kafe va restoranlar", "Кафе и рестораны", "Cafes & restaurants"),
            ("expense", "home", "house.fill", "#5D5C61", "Uy-joy", "Жильё", "Housing"),
            ("expense", "health", "cross.case.fill", "#5F8A8B", "Salomatlik", "Здоровье", "Health"),
            ("income", "salary", "briefcase.fill", "#6E8B74", "Ish haqi", "Зарплата", "Salary"),
            ("income", "freelance", "laptopcomputer", "#7395AE", "Frilans", "Фриланс", "Freelance"),
        ]
        return list.enumerated().map { index, item in
            CategoryDTO(
                id: UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index + 1))!,
                type: item.type, key: item.key, name: item.ru,
                translations: ["uz": item.uz, "ru": item.ru, "en": item.en], icon: item.icon, color: item.color,
                parentId: nil, sortOrder: index, isArchived: false, isSystem: true, updatedAt: now, deletedAt: nil
            )
        }
    }
}

/// Builds the responses for one request.
private struct Reply {
    let url: URL

    func json<Value: Encodable>(_ value: Value, status: Int = 200) throws -> (Data, HTTPURLResponse) {
        (try LunexJSON.encoder().encode(value), response(status))
    }

    func raw(_ text: String, status: Int = 200) -> (Data, HTTPURLResponse) {
        (Data(text.utf8), response(status))
    }

    func empty() -> (Data, HTTPURLResponse) {
        (Data(), response(204))
    }

    func error(_ status: Int, _ code: String) -> (Data, HTTPURLResponse) {
        raw(#"{"statusCode":\#(status),"code":"\#(code)","message":"\#(code)"}"#, status: status)
    }

    private func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    }
}
#endif
