import Foundation

// Wire format of `/v1/sync`: what a pull returns and what the queue pushes.
// Money comes as decimal strings and becomes `Decimal` when it reaches a record.

/// One change for the server's queue (`POST /v1/sync/push`), already encoded.
public struct SyncOperation: Sendable, Equatable {
    public let opId: String
    /// e.g. `transaction.create`
    public let type: String
    /// The local record it changes; a pull leaves that record alone until the change is sent.
    public let recordId: UUID?
    let payload: Data

    /// An operation without a body: `transaction.delete`, `goal.contribution.delete`…
    public static func make(_ type: String, id: UUID? = nil, goalId: UUID? = nil) throws -> SyncOperation {
        try encode(Envelope<Empty>(opId: UUID().uuidString, type: type, id: id, goalId: goalId, data: nil), recordId: id)
    }

    /// `data` is shaped like the matching REST body; `recordId` names the record a create makes.
    public static func make<Body: Encodable & Sendable>(
        _ type: String, id: UUID? = nil, goalId: UUID? = nil, recordId: UUID? = nil, data: Body
    ) throws -> SyncOperation {
        try encode(
            Envelope(opId: UUID().uuidString, type: type, id: id, goalId: goalId, data: data),
            recordId: recordId ?? id
        )
    }

    private static func encode<Body: Encodable>(_ envelope: Envelope<Body>, recordId: UUID?) throws -> SyncOperation {
        SyncOperation(
            opId: envelope.opId,
            type: envelope.type,
            recordId: recordId,
            payload: try LunexJSON.encoder().encode(envelope)
        )
    }

    private struct Envelope<Body: Encodable>: Encodable {
        let opId: String
        let type: String
        let id: UUID?
        let goalId: UUID?
        let data: Body?
    }

    private struct Empty: Encodable {}
}

/// `GET /v1/sync/changes`: one page of changes since the cursor.
struct SyncPage: Decodable, Sendable {
    let profile: Profile?
    let accounts: [AccountDTO]
    let categories: [CategoryDTO]
    let transactions: [TransactionDTO]
    let goals: [GoalDTO]
    let goalContributions: [ContributionDTO]
    let settings: SettingsDTO?
    let nextCursor: String
    let hasMore: Bool
    let serverTime: Date
}

struct PushResponse: Decodable, Sendable {
    struct Result: Decodable, Sendable {
        let opId: String?
        /// applied, rejected
        let status: String
        let code: String?
        let message: String?
    }

    let results: [Result]
}

struct AccountDTO: Decodable, Sendable {
    let id: UUID
    let name: String
    let type: String
    let currency: String
    let initialBalance: String
    let currentBalance: String
    let icon: String?
    let color: String?
    let includeInTotal: Bool
    let isArchived: Bool
    let isDefault: Bool
    let sortOrder: Int
    let updatedAt: Date
    let deletedAt: Date?
}

struct CategoryDTO: Decodable, Sendable {
    let id: UUID
    let type: String
    let key: String?
    let name: String
    let translations: [String: String]?
    let icon: String
    let color: String
    let parentId: UUID?
    let sortOrder: Int
    let isArchived: Bool
    let isSystem: Bool
    let updatedAt: Date
    let deletedAt: Date?
}

struct TransactionDTO: Decodable, Sendable {
    let id: UUID
    let type: String
    let accountId: UUID
    let transferAccountId: UUID?
    let amount: String
    let currency: String
    let transferAmount: String?
    let transferCurrency: String?
    let amountBase: String
    let baseCurrency: String
    let fxRate: String
    let categoryId: UUID?
    let note: String?
    let merchant: String?
    let occurredAt: Date
    let source: String
    let createdAt: Date
    let updatedAt: Date
    let deletedAt: Date?
}

struct GoalDTO: Decodable, Sendable {
    struct Schedule: Decodable, Sendable {
        let perDay: String
        let perWeek: String
        let perMonth: String
        let expectedSaved: String
        let status: String
        let daysLeft: Int
    }

    let id: UUID
    let title: String
    let emoji: String
    let color: String
    let templateKey: String?
    let targetAmount: String
    let savedAmount: String
    let progress: Int
    let currency: String
    let deadline: String?
    let status: String
    let isPrimary: Bool
    let priority: Int
    let linkedAccountId: UUID?
    let milestones: [Int]
    let schedule: Schedule?
    let completedAt: Date?
    let archivedAt: Date?
    let createdAt: Date
    let updatedAt: Date
    let deletedAt: Date?
}

struct ContributionDTO: Decodable, Sendable {
    let id: UUID
    let goalId: UUID
    let type: String
    let amount: String
    let currency: String
    let accountId: UUID?
    let accountAmount: String?
    let accountCurrency: String?
    let method: String
    let note: String?
    let createdAt: Date
    let updatedAt: Date
    let deletedAt: Date?
}

struct SettingsDTO: Decodable, Sendable {
    let biometricLockEnabled: Bool
    let lockAfterSeconds: Int
    let hideAmounts: Bool
    let weekStartsOn: Int
    let monthStartsOnDay: Int
    let defaultAccountId: UUID?
    let dailyReminderEnabled: Bool
    let dailyReminderTime: String
    let budgetAlertsEnabled: Bool
    let goalAlertsEnabled: Bool
    let recurringAlertsEnabled: Bool
    let smartSaveEnabled: Bool
    let weeklyReportEnabled: Bool
    let quietHoursStart: String
    let quietHoursEnd: String
    let hapticsEnabled: Bool
    let updatedAt: Date
}

extension API {
    static func syncChanges(cursor: String?, limit: Int) -> Endpoint<SyncPage> {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        return .get("sync/changes", query: query)
    }

    /// `operations` are the queued payloads, already JSON.
    static func syncPush(operations: [Data]) -> Endpoint<PushResponse> {
        var body = Data(#"{"operations":["#.utf8)
        for (index, operation) in operations.enumerated() {
            if index > 0 { body.append(Data(",".utf8)) }
            body.append(operation)
        }
        body.append(Data("]}".utf8))
        return Endpoint(method: "POST", path: "sync/push", body: body)
    }
}

/// Money from the wire; a malformed amount reads as zero rather than dropping the record.
func money(_ text: String) -> Decimal {
    Decimal.exact(text) ?? 0
}

func money(_ text: String?) -> Decimal? {
    text.flatMap(Decimal.exact)
}
