import CryptoKit
import Foundation

/// A sign-in that ended without a credential.
public enum SignInFlowError: Error, Equatable, Sendable {
    /// The user closed the sheet or declined.
    case cancelled
    /// The provider answered with something we cannot use.
    case invalidResponse(String)
}

/// Sign in with Apple: Apple signs the SHA-256 of a nonce into the token, the server
/// checks it against the raw nonce, so a captured token cannot be replayed.
public enum AppleSignIn {
    public static func makeNonce() -> String {
        Random.urlSafeString(bytes: 32)
    }

    /// Lowercase hex, as the server compares it.
    public static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Google Sign-In without the SDK: OAuth 2.0 with PKCE in ASWebAuthenticationSession,
/// then the ID token goes to the server. iOS clients have no secret.
public struct GoogleSignIn: Sendable {
    /// An authorization request in flight; its verifier and state stay on the device.
    public struct Request: Sendable {
        public let url: URL
        let state: String
        let codeVerifier: String
    }

    public let clientID: String
    private let transport: HTTPTransport

    static let authorizationURL = URL(string: "https://accounts.google.com/o/oauth2/v2/auth")!
    static let tokenURL = URL(string: "https://oauth2.googleapis.com/token")!

    /// `clientID` is the iOS OAuth client, e.g. `123-abc.apps.googleusercontent.com`.
    public init(clientID: String, transport: HTTPTransport) {
        self.clientID = clientID
        self.transport = transport
    }

    /// Google redirects iOS clients to their reversed client id: `com.googleusercontent.apps.123-abc`.
    public var callbackScheme: String {
        clientID.split(separator: ".").reversed().joined(separator: ".")
    }

    var redirectURI: String { "\(callbackScheme):/oauth2redirect" }

    public func makeRequest() -> Request {
        let verifier = Random.urlSafeString(bytes: 32)
        let state = Random.urlSafeString(bytes: 16)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
        var components = URLComponents(url: Self.authorizationURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        return Request(url: components.url!, state: state, codeVerifier: verifier)
    }

    /// The authorization code from Google's redirect back to the app.
    public func code(from callback: URL, for request: Request) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        if let error = value("error") {
            throw error == "access_denied" ? SignInFlowError.cancelled : SignInFlowError.invalidResponse(error)
        }
        guard value("state") == request.state else {
            throw SignInFlowError.invalidResponse("state mismatch")
        }
        guard let code = value("code"), !code.isEmpty else {
            throw SignInFlowError.invalidResponse("no code")
        }
        return code
    }

    /// Exchanges the code for the ID token that `POST /v1/auth/google` verifies.
    public func idToken(code: String, for request: Request) async throws -> String {
        var urlRequest = URLRequest(url: Self.tokenURL, timeoutInterval: 30)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = Data(formEncoded([
            "grant_type": "authorization_code",
            "code": code,
            "client_id": clientID,
            "redirect_uri": redirectURI,
            "code_verifier": request.codeVerifier,
        ]).utf8)

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.send(urlRequest)
        } catch {
            throw APIError.offline(error)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw SignInFlowError.invalidResponse("token endpoint returned \(response.statusCode)")
        }
        struct TokenResponse: Decodable {
            let id_token: String?
        }
        guard let token = try? JSONDecoder().decode(TokenResponse.self, from: data).id_token else {
            throw SignInFlowError.invalidResponse("no id_token")
        }
        return token
    }

    private func formEncoded(_ fields: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields
            .sorted { $0.key < $1.key }
            .map { key, value in
                "\(key)=\(value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)"
            }
            .joined(separator: "&")
    }
}

/// Telegram Login through the server's pages (`backend` → `/v1/auth/telegram/start`):
/// Telegram only returns to the bot's domain, and that page hands the result to the app.
public enum TelegramLogin {
    /// ASWebAuthenticationSession finishes on `lunex://auth/telegram#tgAuthResult=…`.
    public static let callbackScheme = "lunex"

    public static func startURL(apiBaseURL: URL) -> URL {
        apiBaseURL.appending(path: "auth/telegram/start")
    }

    /// Decodes `tgAuthResult` (base64 JSON, in the fragment or the query); nil when Telegram
    /// returned no login.
    public static func authData(from callback: URL) -> TelegramAuthData? {
        let components = URLComponents(url: callback, resolvingAgainstBaseURL: false)
        let fragmentItems = components?.fragment.flatMap { URLComponents(string: "?\($0)")?.queryItems } ?? []
        let items = fragmentItems + (components?.queryItems ?? [])
        guard let value = items.first(where: { $0.name == "tgAuthResult" })?.value,
              let data = Data(base64URLEncoded: value)
        else { return nil }
        return try? JSONDecoder().decode(TelegramAuthData.self, from: data)
    }
}

enum Random {
    /// Cryptographically random bytes as unpadded base64url (43 characters for 32 bytes).
    static func urlSafeString(bytes count: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64URLEncodedString()
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Accepts base64url and plain base64, with or without padding.
    init?(base64URLEncoded text: String) {
        var base64 = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
}
