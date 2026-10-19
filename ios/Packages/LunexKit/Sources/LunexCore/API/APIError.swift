import Foundation

/// A failed request. `code` is the server's stable error code (`invalid_code`,
/// `free_limit_reached`…) that the UI turns into a localised message.
public struct APIError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    /// The rest of the error body (e.g. `limit`, `retryAfter`, `actual`) as raw JSON.
    public let details: Data?

    public init(status: Int, code: String, message: String, details: Data? = nil) {
        self.status = status
        self.code = code
        self.message = message
        self.details = details
    }

    /// No connection, timeout, DNS: the request may be retried later.
    public static func offline(_ error: Error) -> APIError {
        APIError(status: 0, code: "offline", message: error.localizedDescription)
    }

    public var isOffline: Bool { status == 0 }
    /// Worth retrying as is (server trouble, rate limit, no connection).
    public var isTransient: Bool { isOffline || status == 429 || status >= 500 }

    /// Decodes an extra field of the error body, e.g. `limit` of `free_limit_reached`.
    public func detail<T: Decodable>(_ key: String, as type: T.Type = T.self) -> T? {
        guard
            let details,
            let object = try? JSONSerialization.jsonObject(with: details) as? [String: Any],
            let value = object[key],
            let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        else { return nil }
        return try? LunexJSON.decoder().decode(T.self, from: data)
    }

    static func from(status: Int, body: Data) -> APIError {
        struct Body: Decodable {
            let code: String?
            let message: String?
        }
        let parsed = try? JSONDecoder().decode(Body.self, from: body)
        return APIError(
            status: status,
            code: parsed?.code ?? "http_\(status)",
            message: parsed?.message ?? HTTPURLResponse.localizedString(forStatusCode: status),
            details: body.isEmpty ? nil : body
        )
    }
}
