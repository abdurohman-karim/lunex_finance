import Foundation
@testable import LunexCore
import Testing

private let device = DeviceInfo(
    id: UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!,
    model: "iPhone17,3",
    osVersion: "18.0.0",
    appVersion: "0.1.0 (1)"
)

private func json(_ body: Data?) throws -> [String: Any] {
    let body = try #require(body)
    return try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
}

private func signInJSON() -> String {
    """
    {"user": \(profileJSON), "isNewUser": true,
     "accessToken": "access-1", "accessTokenExpiresAt": "2099-01-01T00:00:00.000Z",
     "refreshToken": "refresh-1", "refreshTokenExpiresAt": "2099-01-01T00:00:00.000Z"}
    """
}

@Suite("Sign-in requests")
struct SignInRequestTests {
    @Test("each credential goes to its endpoint with the device and language")
    func endpoints() throws {
        let email = API.signIn(.email(address: "a@lunex.uz", code: "123456"), device: device, language: "ru")
        #expect(email.path == "auth/email/verify")
        #expect(!email.authenticated)
        let body = try json(email.body)
        #expect(body["email"] as? String == "a@lunex.uz")
        #expect(body["code"] as? String == "123456")
        #expect(body["language"] as? String == "ru")
        #expect((body["device"] as? [String: Any])?["model"] as? String == "iPhone17,3")
        // Fields of other providers are left out, not sent as null.
        #expect(body["idToken"] == nil && body["nonce"] == nil)

        #expect(API.signIn(.google(idToken: "t"), device: device, language: "uz").path == "auth/google")
        let apple = API.signIn(.apple(identityToken: "t", nonce: "n", displayName: nil), device: device, language: "en")
        #expect(apple.path == "auth/apple")
    }

    @Test("Telegram data keeps Telegram's field names, so its hash still matches")
    func telegramBody() throws {
        let data = TelegramAuthData(
            id: 42, firstName: "Asadbek", lastName: nil, username: "asadbek",
            photoURL: nil, authDate: 1_792_400_000, hash: String(repeating: "a", count: 64)
        )
        let endpoint = API.signIn(.telegram(data), device: device, language: "uz")
        #expect(endpoint.path == "auth/telegram")
        let body = try json(endpoint.body)
        let authData = try #require(body["authData"] as? [String: Any])
        #expect(Set(authData.keys) == ["id", "first_name", "username", "auth_date", "hash"])
        #expect(authData["auth_date"] as? Int == 1_792_400_000)
    }

    @Test("checks email addresses before asking the server")
    func emails() {
        #expect(EmailAddress.isValid("asadbek@lunex.uz"))
        #expect(EmailAddress.isValid("a.b+c@mail.co.uk"))
        #expect(!EmailAddress.isValid("asadbek"))
        #expect(!EmailAddress.isValid("a@b"))
        #expect(!EmailAddress.isValid("a b@lunex.uz"))
        #expect(!EmailAddress.isValid("a@lunex.u"))
    }
}

@Suite("Provider flows")
struct ProviderFlowTests {
    @Test("Apple nonce: random, URL-safe, and hashed as the server expects")
    func appleNonce() {
        let nonce = AppleSignIn.makeNonce()
        #expect(nonce.count == 43)
        #expect(nonce.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        #expect(nonce != AppleSignIn.makeNonce())
        #expect(AppleSignIn.sha256("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    @Test("Telegram result is read from the fragment, padded or not")
    func telegramCallback() throws {
        let payload = #"{"id":42,"first_name":"Tg","auth_date":1792400000,"hash":"abc"}"#
        let encoded = Data(payload.utf8).base64URLEncodedString()
        let url = try #require(URL(string: "lunex://auth/telegram#tgAuthResult=\(encoded)"))
        let data = try #require(TelegramLogin.authData(from: url))
        #expect(data.id == 42)
        #expect(data.firstName == "Tg")
        #expect(data.authDate == 1_792_400_000)

        let padded = Data(payload.utf8).base64EncodedString()
        #expect(TelegramLogin.authData(from: URL(string: "lunex://auth/telegram?tgAuthResult=\(padded)")!) == data)
        #expect(TelegramLogin.authData(from: URL(string: "lunex://auth/telegram#tgAuthResult=false")!) == nil)
        #expect(TelegramLogin.authData(from: URL(string: "lunex://auth/telegram")!) == nil)
        #expect(TelegramLogin.startURL(apiBaseURL: baseURL).absoluteString == "http://localhost:3000/v1/auth/telegram/start")
    }

    @Test("Google: PKCE request, redirect checks and code exchange")
    func google() async throws {
        let transport = StubTransport { _ in (200, #"{"access_token":"x","id_token":"google-id-token"}"#) }
        let google = GoogleSignIn(clientID: "123-abc.apps.googleusercontent.com", transport: transport)
        #expect(google.callbackScheme == "com.googleusercontent.apps.123-abc")

        let request = google.makeRequest()
        let items = try #require(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems)
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(query["redirect_uri"] == "com.googleusercontent.apps.123-abc:/oauth2redirect")
        #expect(query["code_challenge_method"] == "S256")
        #expect(query["code_challenge"]?.count == 43)
        #expect(query["state"] == request.state)

        let callback = { (query: String) in URL(string: "com.googleusercontent.apps.123-abc:/oauth2redirect?\(query)")! }
        #expect(throws: SignInFlowError.cancelled) {
            try google.code(from: callback("error=access_denied&state=\(request.state)"), for: request)
        }
        #expect(throws: SignInFlowError.invalidResponse("state mismatch")) {
            try google.code(from: callback("code=c&state=forged"), for: request)
        }
        let code = try google.code(from: callback("code=4%2F0Ab&state=\(request.state)"), for: request)
        #expect(code == "4/0Ab")

        #expect(try await google.idToken(code: code, for: request) == "google-id-token")
        let sent = try #require(transport.requests.first)
        #expect(sent.url == GoogleSignIn.tokenURL)
        let form = String(decoding: try #require(sent.httpBody), as: UTF8.self)
        #expect(form.contains("code=4%2F0Ab"))
        #expect(form.contains("code_verifier=\(request.codeVerifier)"))
        #expect(form.contains("grant_type=authorization_code"))
    }
}

@Suite("Sign-in service")
@MainActor
struct SignInServiceTests {
    private func service(_ transport: StubTransport, google: GoogleSignIn? = nil) -> (SignInService, SessionStore, InMemorySecureStore) {
        let secure = InMemorySecureStore()
        let auth = AuthSession(store: secure, refresher: { _ in throw APIError(status: 401, code: "x", message: "") })
        let api = APIClient(baseURL: baseURL, transport: transport, session: auth)
        let session = SessionStore(api: api, auth: auth, cache: UserDefaultsProfileCache(defaults: UserDefaults(suiteName: "lunex.tests.\(UUID())")!))
        let publicAPI = APIClient(baseURL: baseURL, transport: transport, session: nil)
        let signIn = SignInService(
            api: publicAPI,
            session: session,
            device: device,
            telegramStartURL: TelegramLogin.startURL(apiBaseURL: baseURL),
            google: google
        )
        return (signIn, session, secure)
    }

    @Test("an email code signs the user in and keeps the refresh token")
    func emailSignIn() async throws {
        let transport = StubTransport { request in
            switch request.url?.path() {
            case "/v1/auth/email/start": (202, #"{"expiresIn":600,"resendIn":60}"#)
            case "/v1/auth/email/verify": (200, signInJSON())
            default: (200, #"{"monetizationEnabled":false,"plan":"pro","source":"trial","expiresAt":null,"trial":null,"features":[],"limits":{"accounts":null,"activeGoals":null,"aiMessagesPerDay":50,"analyticsMonths":null}}"#)
            }
        }
        let (signIn, session, secure) = service(transport)

        let sent = try await signIn.requestEmailCode("smoke@lunex.test", language: "ru")
        #expect(sent.resendIn == 60)
        #expect(try json(transport.requests[0].httpBody)["language"] as? String == "ru")

        try await signIn.signIn(.email(address: "smoke@lunex.test", code: "123456"), language: "ru")
        #expect(session.profile?.email == "smoke@lunex.test")
        #expect(secure.string(for: SecureKey.refreshToken) == "refresh-1")
        #expect(session.access?.isPro == true)
        // Sign-in goes without a token; the access request after it carries the new one.
        #expect(transport.requests[1].value(forHTTPHeaderField: "Authorization") == nil)
        #expect(transport.requests[2].value(forHTTPHeaderField: "Authorization") == "Bearer access-1")
    }

    @Test("a wrong code leaves the user signed out with the server's error")
    func wrongCode() async {
        let transport = StubTransport { _ in (400, #"{"code":"invalid_code","message":"The code is wrong","attemptsLeft":3}"#) }
        let (signIn, session, _) = service(transport)
        await #expect {
            try await signIn.signIn(.email(address: "smoke@lunex.test", code: "000000"), language: "ru")
        } throws: { error in
            let error = error as? APIError
            return error?.code == "invalid_code" && error?.detail("attemptsLeft", as: Int.self) == 3
        }
        #expect(session.profile == nil)
    }

    @Test("offers only what the server and the app have configured")
    func availability() async {
        let transport = StubTransport { _ in (200, #"{"apple":true,"google":true,"telegram":false,"email":true}"#) }
        let (signIn, _, _) = service(transport)
        // Unknown before the server answers: everything is offered.
        #expect(signIn.isAvailable(.telegram))
        await signIn.loadProviders()
        #expect(signIn.isAvailable(.apple))
        #expect(!signIn.isAvailable(.telegram))
        // The server allows Google, but this build has no client id.
        #expect(!signIn.isAvailable(.google))
    }
}
