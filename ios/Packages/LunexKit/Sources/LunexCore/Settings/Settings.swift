import Foundation
import Observation
import SwiftData

/// One change on the settings screens. Settings live in the local store and go to the server
/// through the queue as `settings.update`; profile fields (language, base currency, time zone)
/// as `profile.update`.
public enum SettingsChange: Equatable, Sendable {
    case hideAmounts(Bool)
    case biometricLock(Bool)
    /// Lock again after this long in the background
    case lockAfterSeconds(Int)
    /// 1 = Monday … 7 = Sunday
    case weekStartsOn(Int)
    /// Payday: the budget month starts on it (1…31)
    case monthStartsOnDay(Int)
    case haptics(Bool)
    case dailyReminder(Bool)
    /// `HH:MM`
    case dailyReminderTime(String)
    case budgetAlerts(Bool)
    case goalAlerts(Bool)
    case recurringAlerts(Bool)
    case smartSave(Bool)
    case weeklyReport(Bool)
    case quietHoursStart(String)
    case quietHoursEnd(String)
}

@MainActor
@Observable
public final class SettingsStore {
    @ObservationIgnored private let context: ModelContext
    @ObservationIgnored private let sync: SyncEngine

    public init(container: ModelContainer, sync: SyncEngine) {
        self.context = container.mainContext
        self.sync = sync
    }

    /// The account's settings; created with the defaults before the first download.
    public func current() -> SettingsRecord {
        if let record = try? context.fetch(FetchDescriptor<SettingsRecord>()).first {
            return record
        }
        let record = SettingsRecord()
        context.insert(record)
        return record
    }

    public func update(_ change: SettingsChange) throws {
        let record = current()
        var patch = SettingsPatch()
        switch change {
        case let .hideAmounts(value):
            record.hideAmounts = value
            patch.hideAmounts = value
        case let .biometricLock(value):
            record.biometricLockEnabled = value
            patch.biometricLockEnabled = value
        case let .lockAfterSeconds(value):
            let seconds = min(max(value, 0), 3600)
            record.lockAfterSeconds = seconds
            patch.lockAfterSeconds = seconds
        case let .weekStartsOn(value):
            let day = min(max(value, 1), 7)
            record.weekStartsOn = day
            patch.weekStartsOn = day
        case let .monthStartsOnDay(value):
            let day = min(max(value, 1), 31)
            record.monthStartsOnDay = day
            patch.monthStartsOnDay = day
        case let .haptics(value):
            record.hapticsEnabled = value
            patch.hapticsEnabled = value
        case let .dailyReminder(value):
            record.dailyReminderEnabled = value
            patch.dailyReminderEnabled = value
        case let .dailyReminderTime(value):
            guard Self.isClockTime(value) else { return }
            record.dailyReminderTime = value
            patch.dailyReminderTime = value
        case let .budgetAlerts(value):
            record.budgetAlertsEnabled = value
            patch.budgetAlertsEnabled = value
        case let .goalAlerts(value):
            record.goalAlertsEnabled = value
            patch.goalAlertsEnabled = value
        case let .recurringAlerts(value):
            record.recurringAlertsEnabled = value
            patch.recurringAlertsEnabled = value
        case let .smartSave(value):
            record.smartSaveEnabled = value
            patch.smartSaveEnabled = value
        case let .weeklyReport(value):
            record.weeklyReportEnabled = value
            patch.weeklyReportEnabled = value
        case let .quietHoursStart(value):
            guard Self.isClockTime(value) else { return }
            record.quietHoursStart = value
            patch.quietHoursStart = value
        case let .quietHoursEnd(value):
            guard Self.isClockTime(value) else { return }
            record.quietHoursEnd = value
            patch.quietHoursEnd = value
        }
        record.updatedAt = .now
        try sync.store(.make("settings.update", data: patch))
        try finish()
    }

    /// Language, base currency or time zone of the profile. A new base currency re-values
    /// every operation on the server; the figures come back with the next download.
    public func updateProfile(language: String? = nil, baseCurrency: String? = nil, timezone: String? = nil) throws {
        let patch = ProfilePatch(language: language, baseCurrency: baseCurrency, timezone: timezone)
        guard patch.language != nil || patch.baseCurrency != nil || patch.timezone != nil else { return }
        try sync.store(.make("profile.update", data: patch))
        try finish()
    }

    private func finish() throws {
        try context.save()
        Task { await sync.sync() }
    }

    /// `HH:MM`, 24-hour clock
    static func isClockTime(_ text: String) -> Bool {
        text.wholeMatch(of: /([01]\d|2[0-3]):[0-5]\d/) != nil
    }

    /// `PATCH /v1/me/settings`: only the changed field is sent (nil fields are left out).
    struct SettingsPatch: Encodable, Sendable {
        var biometricLockEnabled: Bool?
        var lockAfterSeconds: Int?
        var hideAmounts: Bool?
        var weekStartsOn: Int?
        var monthStartsOnDay: Int?
        var dailyReminderEnabled: Bool?
        var dailyReminderTime: String?
        var budgetAlertsEnabled: Bool?
        var goalAlertsEnabled: Bool?
        var recurringAlertsEnabled: Bool?
        var smartSaveEnabled: Bool?
        var weeklyReportEnabled: Bool?
        var quietHoursStart: String?
        var quietHoursEnd: String?
        var hapticsEnabled: Bool?
    }

    /// `PATCH /v1/me`
    struct ProfilePatch: Encodable, Sendable {
        let language: String?
        let baseCurrency: String?
        let timezone: String?
    }
}

// MARK: - Account

/// Sign-in methods of the account, signing out everywhere and deleting the account.
/// These need a connection: they change sessions, not data.
@MainActor
@Observable
public final class AccountService {
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private let session: SessionStore

    public init(api: APIClient, session: SessionStore) {
        self.api = api
        self.session = session
    }

    /// Adds a sign-in method; the server refuses one that belongs to another account
    /// (`identity_in_use`) or a second one of the same kind (`provider_already_linked`).
    public func link(_ credential: SignInCredential) async throws {
        session.update(try await api.send(API.linkIdentity(credential)))
    }

    /// The last method cannot be removed (`last_identity`).
    public func unlink(_ provider: AuthProvider) async throws {
        session.update(try await api.send(API.unlinkIdentity(provider)))
    }

    /// «Выйти на всех устройствах»: every session ends, this one too.
    public func signOutEverywhere() async throws {
        _ = try await api.send(API.revokeSessions())
        await session.signOut()
    }

    /// «Удалить аккаунт»: data is erased in 30 days; signing in before that restores it.
    public func deleteAccount() async throws {
        _ = try await api.send(API.deleteAccount())
        await session.signOut()
    }
}

/// `POST /v1/me/identities`: the provider and its sign-in credential.
private struct LinkBody: Encodable {
    let provider: String
    var identityToken: String?
    var nonce: String?
    var displayName: String?
    var idToken: String?
    var authData: TelegramAuthData?
    var email: String?
    var code: String?

    init(_ credential: SignInCredential) {
        provider = credential.provider.rawValue
        switch credential {
        case let .apple(identityToken, nonce, displayName):
            self.identityToken = identityToken
            self.nonce = nonce
            self.displayName = displayName
        case let .google(idToken):
            self.idToken = idToken
        case let .telegram(authData):
            self.authData = authData
        case let .email(address, code):
            email = address
            self.code = code
        }
    }
}

extension API {
    static func linkIdentity(_ credential: SignInCredential) -> Endpoint<Profile> {
        .send("POST", "me/identities", LinkBody(credential))
    }

    static func unlinkIdentity(_ provider: AuthProvider) -> Endpoint<Profile> {
        Endpoint(method: "DELETE", path: "me/identities/\(provider.rawValue)")
    }

    static func revokeSessions() -> Endpoint<NoContent> {
        Endpoint(method: "DELETE", path: "me/sessions")
    }

    static func deleteAccount() -> Endpoint<NoContent> {
        Endpoint(method: "DELETE", path: "me")
    }
}
