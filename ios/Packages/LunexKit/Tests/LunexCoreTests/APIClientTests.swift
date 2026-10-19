import Foundation
@testable import LunexCore
import Testing

@Suite("API client")
struct APIClientTests {
    @Test("sends the access token and decodes the response")
    func authorizedRequest() async throws {
        let transport = StubTransport { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-1")
            #expect(request.value(forHTTPHeaderField: "X-App-Version") == "1.0 (1)")
            #expect(request.url?.absoluteString == "http://localhost:3000/v1/me")
            return (200, profileJSON)
        }
        let session = AuthSession(store: signedInStore(), refresher: { _ in
            Issue.record("No refresh expected")
            throw APIError(status: 500, code: "x", message: "x")
        })
        await session.save(TokenPair(
            accessToken: "access-1",
            accessTokenExpiresAt: .now.addingTimeInterval(600),
            refreshToken: "refresh-1",
            refreshTokenExpiresAt: .now.addingTimeInterval(86_400)
        ))
        let api = APIClient(baseURL: baseURL, transport: transport, session: session, appVersion: "1.0 (1)")

        let profile = try await api.send(API.me())
        #expect(profile.baseCurrency == "UZS")
        #expect(profile.identities == ["email"])
    }

    @Test("maps error bodies to APIError with their details")
    func errorMapping() async {
        let transport = StubTransport { _ in
            (403, #"{"code":"free_limit_reached","message":"Limit","resource":"accounts","limit":2}"#)
        }
        let api = APIClient(baseURL: baseURL, transport: transport, session: nil)
        await #expect {
            try await api.send(Endpoint<NoContent>.get("accounts", authenticated: false))
        } throws: { error in
            guard let error = error as? APIError else { return false }
            return error.status == 403 && error.code == "free_limit_reached"
                && error.detail("limit", as: Int.self) == 2 && !error.isTransient
        }
    }

    @Test("turns network failures into a retryable offline error")
    func offline() async {
        let transport = StubTransport { _ in throw URLError(.notConnectedToInternet) }
        let api = APIClient(baseURL: baseURL, transport: transport, session: nil)
        await #expect {
            try await api.send(Endpoint<NoContent>.get("health", authenticated: false))
        } throws: { error in
            (error as? APIError)?.isOffline == true && (error as? APIError)?.isTransient == true
        }
    }

    @Test("refreshes once after a 401 and retries with the new token")
    func refreshOn401() async throws {
        let refreshes = Counter()
        let transport = StubTransport { request in
            let token = request.value(forHTTPHeaderField: "Authorization")
            return token == "Bearer access-2" ? (200, profileJSON) : (401, #"{"code":"invalid_access_token"}"#)
        }
        let store = signedInStore()
        let session = AuthSession(store: store, refresher: { refreshToken in
            #expect(refreshToken == "refresh-1")
            refreshes.increment()
            return try LunexJSON.decoder().decode(TokenPair.self, from: Data(tokensJSON(access: "access-2").utf8))
        })
        let api = APIClient(baseURL: baseURL, transport: transport, session: session)

        _ = try await api.send(API.me())
        #expect(refreshes.count == 1)
        // The rotated refresh token replaced the old one.
        #expect(store.string(for: SecureKey.refreshToken) == "refresh-2")
    }

    @Test("parallel requests share one refresh")
    func singleFlightRefresh() async throws {
        let refreshes = Counter()
        let transport = StubTransport { _ in (200, profileJSON) }
        let session = AuthSession(store: signedInStore(), refresher: { _ in
            refreshes.increment()
            try await Task.sleep(for: .milliseconds(50))
            return try LunexJSON.decoder().decode(TokenPair.self, from: Data(tokensJSON(access: "access-2").utf8))
        })
        let api = APIClient(baseURL: baseURL, transport: transport, session: session)

        try await withThrowingTaskGroup(of: Profile.self) { group in
            for _ in 0..<5 { group.addTask { try await api.send(API.me()) } }
            for try await _ in group {}
        }
        #expect(refreshes.count == 1)
        #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer access-2" })
    }

    @Test("ends the session when the refresh token is rejected")
    func revokedRefreshToken() async {
        let ended = Counter()
        let store = signedInStore()
        let session = AuthSession(
            store: store,
            refresher: { _ in throw APIError(status: 401, code: "refresh_token_reused", message: "Reused") },
            onSignedOut: { ended.increment() }
        )
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in (200, profileJSON) }, session: session)

        await #expect(throws: APIError.self) { try await api.send(API.me()) }
        #expect(ended.count == 1)
        #expect(await session.hasSession == false)
    }

    @Test("keeps the session when the refresh fails offline")
    func offlineRefresh() async {
        let store = signedInStore()
        let session = AuthSession(store: store, refresher: { _ in throw APIError.offline(URLError(.timedOut)) })
        let api = APIClient(baseURL: baseURL, transport: StubTransport { _ in (200, profileJSON) }, session: session)

        await #expect(throws: APIError.self) { try await api.send(API.me()) }
        #expect(await session.hasSession == true)
    }
}
