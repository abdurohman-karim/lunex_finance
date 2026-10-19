import Foundation
@testable import LunexCore
import SwiftData
import Testing

private let accountA = UUID(uuidString: "00000000-0000-4000-8000-00000000000A")!
private let accountB = UUID(uuidString: "00000000-0000-4000-8000-00000000000B")!
private let txId = UUID(uuidString: "00000000-0000-4000-8000-0000000000C1")!

private func accountJSON(_ id: UUID, name: String, deleted: Bool = false) -> String {
    """
    {"id":"\(id.uuidString.lowercased())","name":"\(name)","type":"cash","currency":"UZS",
     "initialBalance":"0","currentBalance":"150000","icon":"banknote","color":"#5D5C61",
     "includeInTotal":true,"isArchived":false,"isDefault":true,"sortOrder":0,
     "createdAt":"2026-10-19T08:00:00.000Z","updatedAt":"2026-10-19T08:00:00.000Z",
     "deletedAt":\(deleted ? "\"2026-10-19T09:00:00.000Z\"" : "null")}
    """
}

private let transactionJSON = """
{"id":"\(txId.uuidString.lowercased())","type":"expense","accountId":"\(accountA.uuidString.lowercased())",
 "transferAccountId":null,"amount":"45000","currency":"UZS","transferAmount":null,"transferCurrency":null,
 "amountBase":"45000","baseCurrency":"UZS","fxRate":"1","categoryId":null,"note":"Кафе","merchant":null,
 "occurredAt":"2026-10-19T08:40:00.000Z","source":"quick_add","createdAt":"2026-10-19T08:40:00.000Z",
 "updatedAt":"2026-10-19T08:40:00.000Z","deletedAt":null}
"""

private func pageJSON(
    accounts: [String] = [], transactions: [String] = [], profile: String = "null",
    next: String, hasMore: Bool = false
) -> String {
    """
    {"profile":\(profile),"accounts":[\(accounts.joined(separator: ","))],"categories":[],
     "transactions":[\(transactions.joined(separator: ","))],"goals":[],"goalContributions":[],
     "settings":null,"nextCursor":"\(next)","hasMore":\(hasMore),"serverTime":"2026-10-19T10:00:00.000Z"}
    """
}

@MainActor
private final class ProfileLog {
    var profiles: [Profile] = []
}

@MainActor
private struct Harness {
    let engine: SyncEngine
    let context: ModelContext
    let transport: StubTransport
    let log = ProfileLog()

    init(_ handler: @escaping StubTransport.Handler) throws {
        let container = try LunexStore.makeContainer(inMemory: true)
        transport = StubTransport(handler)
        let auth = AuthSession(store: signedInStore(), refresher: { _ in
            TokenPair(accessToken: "a", accessTokenExpiresAt: .distantFuture, refreshToken: "r", refreshTokenExpiresAt: .distantFuture)
        })
        let api = APIClient(baseURL: baseURL, transport: transport, session: auth)
        let log = self.log
        engine = SyncEngine(api: api, container: container) { profile in log.profiles.append(profile) }
        context = container.mainContext
    }

    func accounts() throws -> [AccountRecord] {
        try context.fetch(FetchDescriptor<AccountRecord>(sortBy: [SortDescriptor(\.name)]))
    }

    func paths() -> [String] {
        transport.requests.compactMap { request in
            request.url.map { url in
                url.path() + (url.query().map { "?" + $0 } ?? "")
            }
        }
    }
}

private func pushedOpIds(_ request: URLRequest) throws -> [String] {
    let body = try #require(request.httpBody)
    let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
    let operations = try #require(json["operations"] as? [[String: Any]])
    return operations.compactMap { $0["opId"] as? String }
}

@Suite("Sync")
@MainActor
struct SyncEngineTests {
    @Test("a first sync downloads every page, applies it and remembers the cursor")
    func pull() async throws {
        let harness = try Harness { request in
            let query = request.url?.query() ?? ""
            if query.contains("cursor=c2") {
                return (200, pageJSON(next: "c2"))
            }
            if query.contains("cursor=c1") {
                return (200, pageJSON(accounts: [accountJSON(accountB, name: "Humo")], transactions: [transactionJSON], next: "c2"))
            }
            return (200, pageJSON(accounts: [accountJSON(accountA, name: "Наличные")], profile: profileJSON, next: "c1", hasMore: true))
        }
        await harness.engine.sync()

        #expect(harness.engine.status == .idle)
        #expect(try harness.accounts().map(\.name) == ["Humo", "Наличные"])
        let tx = try #require(try harness.context.fetch(FetchDescriptor<TransactionRecord>()).first)
        #expect(tx.amount == 45_000 && tx.note == "Кафе" && tx.accountId == accountA)
        #expect(harness.log.profiles.count == 1)
        #expect(harness.engine.lastSyncedAt != nil)

        // The next sync continues from the stored cursor.
        await harness.engine.sync()
        #expect(harness.paths().last == "/v1/sync/changes?limit=500&cursor=c2")
    }

    @Test("queued changes go first, in order, and leave the queue once applied")
    func push() async throws {
        let harness = try Harness { request in
            if request.url?.path() == "/v1/sync/push" {
                let ids = try pushedOpIds(request)
                let results = ids.map { #"{"opId":"\#($0)","status":"applied","record":{}}"# }
                return (200, #"{"results":[\#(results.joined(separator: ","))]}"#)
            }
            return (200, pageJSON(next: "c1"))
        }
        let first = try SyncOperation.make("account.update", id: accountA, data: ["name": "Карта"])
        let second = try SyncOperation.make("transaction.delete", id: txId)
        try harness.engine.store(first)
        try harness.engine.store(second)
        #expect(harness.engine.pendingCount == 2)

        await harness.engine.sync()
        let push = try #require(harness.transport.requests.first)
        #expect(push.url?.path() == "/v1/sync/push")
        #expect(try pushedOpIds(push) == [first.opId, second.opId])
        #expect(harness.paths().last?.hasPrefix("/v1/sync/changes") == true)
        #expect(harness.engine.pendingCount == 0)
        #expect(try harness.context.fetchCount(FetchDescriptor<PendingOperation>()) == 0)
    }

    @Test("a refused create removes its record; another refusal downloads everything again")
    func rejected() async throws {
        let harness = try Harness { request in
            if request.url?.path() == "/v1/sync/push" {
                let ids = try pushedOpIds(request)
                let results = ids.map {
                    #"{"opId":"\#($0)","status":"rejected","code":"free_limit_reached","message":"Limit"}"#
                }
                return (200, #"{"results":[\#(results.joined(separator: ","))]}"#)
            }
            return (200, pageJSON(next: "c9"))
        }
        // An earlier sync left a cursor.
        await harness.engine.sync()
        harness.context.insert(TransactionRecord(
            id: txId, type: "expense", accountId: accountA, amount: 1, currency: "UZS", amountBase: 1, occurredAt: .now
        ))
        try harness.engine.store(SyncOperation.make("transaction.create", recordId: txId, data: ["id": txId.uuidString]))
        try harness.engine.store(SyncOperation.make("account.update", id: accountA, data: ["name": "X"]))

        await harness.engine.sync()
        #expect(try harness.context.fetchCount(FetchDescriptor<TransactionRecord>()) == 0)
        #expect(harness.engine.rejections.map(\.code) == ["free_limit_reached", "free_limit_reached"])
        #expect(harness.engine.pendingCount == 0)
        // The account update was refused: the pull after it starts without a cursor.
        #expect(harness.paths().last == "/v1/sync/changes?limit=500")
    }

    @Test("offline the queue stays and the status says so")
    func offline() async throws {
        let harness = try Harness { _ in throw URLError(.notConnectedToInternet) }
        try harness.engine.store(SyncOperation.make("transaction.delete", id: txId))
        await harness.engine.sync()
        #expect(harness.engine.status == .offline)
        #expect(harness.engine.pendingCount == 1)
    }

    @Test("server trouble keeps the queue for the next try")
    func serverError() async throws {
        let harness = try Harness { _ in (503, #"{"code":"unavailable","message":"Down"}"#) }
        try harness.engine.store(SyncOperation.make("transaction.delete", id: txId))
        await harness.engine.sync()
        #expect(harness.engine.status == .failed)
        #expect(harness.engine.pendingCount == 1)
    }

    @Test("a pull leaves a record alone while its change is still queued")
    func protectsPending() async throws {
        let harness = try Harness { request in
            if request.url?.path() == "/v1/sync/push" {
                // The server answers for none of them (e.g. an older server): the change stays queued.
                return (200, #"{"results":[]}"#)
            }
            return (200, pageJSON(accounts: [accountJSON(accountA, name: "С сервера")], next: "c1"))
        }
        harness.context.insert(AccountRecord(id: accountA, name: "На телефоне", type: "cash", currency: "UZS"))
        try harness.engine.store(SyncOperation.make("account.update", id: accountA, data: ["name": "На телефоне"]))

        await harness.engine.sync()
        #expect(try harness.accounts().map(\.name) == ["На телефоне"])
        #expect(harness.engine.pendingCount == 1)
    }

    @Test("deleted records arrive with deletedAt; signing out clears the device")
    func deletionAndReset() async throws {
        let harness = try Harness { _ in
            (200, pageJSON(accounts: [accountJSON(accountA, name: "Старый", deleted: true)], next: "c1"))
        }
        await harness.engine.sync()
        #expect(try harness.accounts().first?.deletedAt != nil)

        harness.engine.reset()
        #expect(try harness.accounts().isEmpty)
        #expect(try harness.context.fetchCount(FetchDescriptor<SyncCursor>()) == 0)
        #expect(harness.engine.lastSyncedAt == nil)
    }
}
