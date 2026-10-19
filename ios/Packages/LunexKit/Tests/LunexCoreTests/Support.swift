import Foundation
@testable import LunexCore
import Synchronization

/// Answers requests from a closure and records them.
final class StubTransport: HTTPTransport {
    typealias Handler = @Sendable (URLRequest) async throws -> (Int, String)

    private let handler: Handler
    private let log = Mutex<[URLRequest]>([])

    init(_ handler: @escaping Handler) {
        self.handler = handler
    }

    var requests: [URLRequest] { log.withLock { $0 } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        log.withLock { $0.append(request) }
        let (status, body) = try await handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }
}

final class Counter: Sendable {
    private let value = Mutex(0)
    func increment() { value.withLock { $0 += 1 } }
    var count: Int { value.withLock { $0 } }
}

let baseURL = URL(string: "http://localhost:3000/v1")!

let profileJSON = """
{
  "id": "25e020bc-6ee5-480b-80a1-5ace7092c9a2",
  "displayName": null,
  "email": "smoke@lunex.test",
  "role": "user",
  "language": "ru",
  "baseCurrency": "UZS",
  "timezone": "Asia/Tashkent",
  "onboardingCompleted": false,
  "onboardingFocus": null,
  "monthlyIncomeEstimate": null,
  "identities": ["email"],
  "createdAt": "2026-10-19T08:32:36.186Z",
  "updatedAt": "2026-10-19T08:32:36.186Z"
}
"""

func tokensJSON(access: String, refresh: String = "refresh-2") -> String {
    """
    {"accessToken":"\(access)","accessTokenExpiresAt":"2099-01-01T00:00:00.000Z",
     "refreshToken":"\(refresh)","refreshTokenExpiresAt":"2099-01-01T00:00:00.000Z"}
    """
}

/// A store with a refresh token, as after a sign-in.
func signedInStore() -> InMemorySecureStore {
    InMemorySecureStore([SecureKey.refreshToken: "refresh-1"])
}
