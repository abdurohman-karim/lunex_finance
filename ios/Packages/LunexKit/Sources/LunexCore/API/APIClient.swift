import Foundation

/// Sends a request; URLSession in the app, a stub in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }
}

/// Body of 204 responses.
public struct NoContent: Decodable, Sendable {
    public init() {}
}

/// One API call: method, path under `/v1`, query, JSON body, and whether it needs a session.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public let method: String
    public let path: String
    public let query: [URLQueryItem]
    public let body: Data?
    public let authenticated: Bool

    public init(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        authenticated: Bool = true
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.authenticated = authenticated
    }

    public static func get(_ path: String, query: [URLQueryItem] = [], authenticated: Bool = true) -> Self {
        Self(method: "GET", path: path, query: query, authenticated: authenticated)
    }

    public static func send<Body: Encodable>(
        _ method: String,
        _ path: String,
        _ body: Body,
        authenticated: Bool = true
    ) -> Self {
        Self(
            method: method,
            path: path,
            body: try? LunexJSON.encoder().encode(body),
            authenticated: authenticated
        )
    }
}

/// JSON over HTTPS to the Lunex API. Adds the access token, refreshes it once on 401
/// and maps failures to `APIError`.
public final class APIClient: Sendable {
    private let baseURL: URL
    private let transport: HTTPTransport
    private let session: AuthSession?
    private let appVersion: String?

    public init(baseURL: URL, transport: HTTPTransport, session: AuthSession?, appVersion: String? = nil) {
        self.baseURL = baseURL
        self.transport = transport
        self.session = session
        self.appVersion = appVersion
    }

    public func send<Response>(_ endpoint: Endpoint<Response>) async throws -> Response {
        let token = endpoint.authenticated ? try await accessToken(fresh: false) : nil
        let (data, response) = try await perform(endpoint, token: token)

        if response.statusCode == 401, endpoint.authenticated {
            // The token was rejected (expired early, revoked): refresh once and retry.
            let retryToken = try await accessToken(fresh: true)
            let (retryData, retryResponse) = try await perform(endpoint, token: retryToken)
            return try decode(endpoint, data: retryData, response: retryResponse)
        }
        return try decode(endpoint, data: data, response: response)
    }

    private func accessToken(fresh: Bool) async throws -> String {
        guard let session else {
            throw APIError(status: 401, code: "signed_out", message: "Not signed in")
        }
        return fresh ? try await session.forceRefresh() : try await session.validAccessToken()
    }

    private func perform<Response>(
        _ endpoint: Endpoint<Response>,
        token: String?
    ) async throws -> (Data, HTTPURLResponse) {
        var components = URLComponents(
            url: baseURL.appending(path: endpoint.path),
            resolvingAgainstBaseURL: false
        )
        if !endpoint.query.isEmpty {
            components?.queryItems = endpoint.query
        }
        guard let url = components?.url else {
            throw APIError(status: 0, code: "bad_url", message: endpoint.path)
        }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = endpoint.method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = endpoint.body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let appVersion {
            request.setValue(appVersion, forHTTPHeaderField: "X-App-Version")
        }
        do {
            return try await transport.send(request)
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.offline(error)
        }
    }

    private func decode<Response>(
        _ endpoint: Endpoint<Response>,
        data: Data,
        response: HTTPURLResponse
    ) throws -> Response {
        guard (200..<300).contains(response.statusCode) else {
            throw APIError.from(status: response.statusCode, body: data)
        }
        if Response.self == NoContent.self || data.isEmpty, let empty = NoContent() as? Response {
            return empty
        }
        do {
            return try LunexJSON.decoder().decode(Response.self, from: data)
        } catch {
            throw APIError(
                status: response.statusCode,
                code: "decoding_failed",
                message: "\(endpoint.method) \(endpoint.path): \(error)"
            )
        }
    }
}
