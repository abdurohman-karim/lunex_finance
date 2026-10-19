import Foundation
@testable import LunexCore
import SwiftData
import Testing

@Suite("Money")
struct MoneyTests {
    @Test("parses API decimals exactly")
    func parsing() throws {
        #expect(Money("150000", "UZS")?.amount == 150_000)
        #expect(Money("12.50", "USD")?.apiValue == "12.5")
        #expect(Money("-300", "UZS")?.amount == -300)
        #expect(Money("1,5", "UZS") == nil)
        #expect(Money("12abc", "UZS") == nil)
        // 0.1 + 0.2 stays exact in Decimal.
        let sum = try #require(Decimal.exact("0.1")) + #require(Decimal.exact("0.2"))
        #expect(sum == Decimal.exact("0.3"))
    }

    @Test("formats with the currency's minor units")
    func formatting() throws {
        let uzs = try #require(Money("150000", "UZS")).formatted(locale: Locale(identifier: "en_US"))
        #expect(uzs.contains("150,000"))
        #expect(!uzs.contains("."))
        let usd = try #require(Money("12.5", "USD")).formatted(locale: Locale(identifier: "en_US"))
        #expect(usd == "$12.50")
        #expect(try #require(Money("1", "USD")).formatted(locale: .current, hidden: true) == "••••")
    }
}

@Suite("JSON")
struct JSONTests {
    @Test("reads the API's ISO 8601 dates with and without milliseconds")
    func dates() throws {
        let withMs = try #require(LunexJSON.parseDate("2026-10-19T08:32:36.186Z"))
        let withoutMs = try #require(LunexJSON.parseDate("2026-10-19T08:32:36Z"))
        #expect(abs(withMs.timeIntervalSince(withoutMs) - 0.186) < 0.0005)
        #expect(LunexJSON.parseDate("19.10.2026") == nil)
    }

    @Test("writes UTC with exact milliseconds, as the API requires")
    func formatting() throws {
        // .186 is not exact in a Double; a truncating formatter would write .185.
        let date = try #require(LunexJSON.parseDate("2026-10-19T08:32:36.186Z"))
        #expect(LunexJSON.formatDate(date) == "2026-10-19T08:32:36.186Z")
        #expect(LunexJSON.formatDate(Date(timeIntervalSince1970: 0)) == "1970-01-01T00:00:00.000Z")
        #expect(LunexJSON.formatDate(Date(timeIntervalSince1970: 59.9996)) == "1970-01-01T00:01:00.000Z")
    }
}

@Suite("Local store")
@MainActor
struct StorageTests {
    @Test("stores and finds records by id")
    func records() throws {
        let container = try LunexStore.makeContainer(inMemory: true)
        let context = container.mainContext
        let id = UUID()
        context.insert(AccountRecord(id: id, name: "Наличные", type: "cash", currency: "UZS", currentBalance: 150_000))
        context.insert(PendingOperation(type: "account.create", payload: Data("{}".utf8)))
        try context.save()

        let accounts = try context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id }))
        #expect(accounts.first?.currentBalance == 150_000)
        #expect(try context.fetchCount(FetchDescriptor<PendingOperation>()) == 1)
    }
}

@Suite("Session")
@MainActor
struct SessionStoreTests {
    final class MemoryCache: ProfileCache, @unchecked Sendable {
        var profile: Profile?
        func load() -> Profile? { profile }
        func save(_ profile: Profile?) { self.profile = profile }
    }

    private func store(transport: StubTransport, secure: InMemorySecureStore, cache: MemoryCache) -> SessionStore {
        let auth = AuthSession(store: secure, refresher: { _ in throw APIError.offline(URLError(.notConnectedToInternet)) })
        let api = APIClient(baseURL: baseURL, transport: transport, session: auth)
        return SessionStore(api: api, auth: auth, cache: cache)
    }

    @Test("without a stored session the user is signed out")
    func signedOut() async {
        let session = store(transport: StubTransport { _ in (200, profileJSON) }, secure: InMemorySecureStore(), cache: MemoryCache())
        await session.restore()
        #expect(session.state == .signedOut)
    }

    @Test("offline with a stored session it opens with the cached profile")
    func offlineRestore() async throws {
        let cache = MemoryCache()
        cache.profile = try LunexJSON.decoder().decode(Profile.self, from: Data(profileJSON.utf8))
        let session = store(
            transport: StubTransport { _ in throw URLError(.notConnectedToInternet) },
            secure: signedInStore(),
            cache: cache
        )
        await session.restore()
        #expect(session.profile?.email == "smoke@lunex.test")
        #expect(session.lastError?.isOffline == true)
    }
}
