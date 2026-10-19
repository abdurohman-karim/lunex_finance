import Foundation

/// The installation, sent with every sign-in: the server keeps one session per device.
public struct DeviceInfo: Codable, Sendable, Equatable {
    public let id: UUID
    public let model: String?
    public let osVersion: String?
    public let appVersion: String?

    public init(id: UUID, model: String?, osVersion: String?, appVersion: String?) {
        self.id = id
        self.model = model
        self.osVersion = osVersion
        self.appVersion = appVersion
    }

    /// This device: hardware model ("iPhone17,3"), OS version and the app's version.
    public static func current(id: UUID, appVersion: String) -> DeviceInfo {
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return DeviceInfo(
            id: id,
            model: hardwareModel(),
            osVersion: "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
            appVersion: appVersion
        )
    }

    private static func hardwareModel() -> String? {
        // The simulator reports the Mac's CPU; the simulated model is in the environment.
        if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] {
            return simulated
        }
        var system = utsname()
        uname(&system)
        let machine = withUnsafeBytes(of: &system.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? nil : String(machine.prefix(64))
    }
}

public enum AuthProvider: String, Codable, Sendable, CaseIterable {
    case apple, google, telegram, email
}

/// `GET /v1/auth/providers`: the sign-in methods the server has configured.
public struct AuthProviders: Codable, Sendable, Equatable {
    public let apple: Bool
    public let google: Bool
    public let telegram: Bool
    public let email: Bool

    public func isEnabled(_ provider: AuthProvider) -> Bool {
        switch provider {
        case .apple: apple
        case .google: google
        case .telegram: telegram
        case .email: email
        }
    }
}

/// What a sign-in method proves; the server checks it and opens a session.
public enum SignInCredential: Sendable, Equatable {
    /// `nonce` is the raw value; Apple got its SHA-256.
    case apple(identityToken: String, nonce: String, displayName: String?)
    case google(idToken: String)
    case telegram(TelegramAuthData)
    case email(address: String, code: String)

    public var provider: AuthProvider {
        switch self {
        case .apple: .apple
        case .google: .google
        case .telegram: .telegram
        case .email: .email
        }
    }
}

/// Telegram Login data, passed to the server unchanged: its `hash` signs every field.
public struct TelegramAuthData: Codable, Sendable, Equatable {
    public let id: Int64
    public let firstName: String?
    public let lastName: String?
    public let username: String?
    public let photoURL: String?
    public let authDate: Int64
    public let hash: String

    enum CodingKeys: String, CodingKey {
        case id
        case firstName = "first_name"
        case lastName = "last_name"
        case username
        case photoURL = "photo_url"
        case authDate = "auth_date"
        case hash
    }
}

/// `POST /v1/auth/email/start`: the code is on its way.
public struct EmailCodeSent: Codable, Sendable, Equatable {
    /// Seconds the code stays valid
    public let expiresIn: Int
    /// Seconds before a new code may be requested
    public let resendIn: Int
}

public enum EmailAddress {
    /// A light check before asking the server: something@domain.tld, no spaces.
    public static func isValid(_ text: String) -> Bool {
        text.wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s.]{2,}/) != nil && text.count <= 255
    }
}

extension API {
    public static func authProviders() -> Endpoint<AuthProviders> {
        .get("auth/providers", authenticated: false)
    }

    public static func emailStart(email: String, language: String) -> Endpoint<EmailCodeSent> {
        struct Body: Encodable {
            let email: String
            let language: String
        }
        return .send("POST", "auth/email/start", Body(email: email, language: language), authenticated: false)
    }

    /// `language` becomes a new account's language; existing accounts keep theirs.
    public static func signIn(
        _ credential: SignInCredential,
        device: DeviceInfo,
        language: String
    ) -> Endpoint<SignInResponse> {
        var body = SignInBody(device: device, language: language)
        let path: String
        switch credential {
        case let .apple(identityToken, nonce, displayName):
            path = "auth/apple"
            body.identityToken = identityToken
            body.nonce = nonce
            body.displayName = displayName
        case let .google(idToken):
            path = "auth/google"
            body.idToken = idToken
        case let .telegram(authData):
            path = "auth/telegram"
            body.authData = authData
        case let .email(address, code):
            path = "auth/email/verify"
            body.email = address
            body.code = code
        }
        return .send("POST", path, body, authenticated: false)
    }
}

/// Fields of every sign-in endpoint; a nil field is left out of the JSON.
private struct SignInBody: Encodable {
    var identityToken: String?
    var nonce: String?
    var displayName: String?
    var idToken: String?
    var authData: TelegramAuthData?
    var email: String?
    var code: String?
    let device: DeviceInfo
    let language: String

    init(device: DeviceInfo, language: String) {
        self.device = device
        self.language = language
    }
}
