import Foundation
import SwiftData

// Local mirror of the server data. The app reads and writes these; the sync engine
// (build plan step «офлайн-очередь и синхронизация») keeps them in step with the API.
// Ids are the server ids, generated on the device for records created offline.

public enum LunexSchemaV1: VersionedSchema {
    public static let versionIdentifier = Schema.Version(1, 0, 0)

    public static var models: [any PersistentModel.Type] {
        [
            AccountRecord.self,
            CategoryRecord.self,
            TransactionRecord.self,
            GoalRecord.self,
            ContributionRecord.self,
            PendingOperation.self,
            SyncCursor.self,
        ]
    }

    @Model
    public final class AccountRecord {
        @Attribute(.unique) public var id: UUID
        public var name: String
        /// cash, card, bank, savings, other
        public var type: String
        public var currency: String
        public var initialBalance: Decimal
        public var currentBalance: Decimal
        public var icon: String?
        public var color: String?
        public var includeInTotal: Bool
        public var isArchived: Bool
        public var isDefault: Bool
        public var sortOrder: Int
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, name: String, type: String, currency: String,
            initialBalance: Decimal = 0, currentBalance: Decimal = 0,
            icon: String? = nil, color: String? = nil, includeInTotal: Bool = true,
            isArchived: Bool = false, isDefault: Bool = false, sortOrder: Int = 0,
            updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.name = name
            self.type = type
            self.currency = currency
            self.initialBalance = initialBalance
            self.currentBalance = currentBalance
            self.icon = icon
            self.color = color
            self.includeInTotal = includeInTotal
            self.isArchived = isArchived
            self.isDefault = isDefault
            self.sortOrder = sortOrder
            self.updatedAt = updatedAt
            self.deletedAt = deletedAt
        }
    }

    @Model
    public final class CategoryRecord {
        @Attribute(.unique) public var id: UUID
        /// expense, income
        public var type: String
        /// Key of a system category (`food`); nil for own ones
        public var key: String?
        public var name: String
        /// uz / ru / en names of system categories, for switching language offline
        public var translations: [String: String]?
        public var icon: String
        public var color: String
        public var parentId: UUID?
        public var sortOrder: Int
        public var isArchived: Bool
        public var isSystem: Bool
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, type: String, key: String? = nil, name: String,
            translations: [String: String]? = nil, icon: String, color: String,
            parentId: UUID? = nil, sortOrder: Int = 0, isArchived: Bool = false,
            isSystem: Bool = false, updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.type = type
            self.key = key
            self.name = name
            self.translations = translations
            self.icon = icon
            self.color = color
            self.parentId = parentId
            self.sortOrder = sortOrder
            self.isArchived = isArchived
            self.isSystem = isSystem
            self.updatedAt = updatedAt
            self.deletedAt = deletedAt
        }
    }

    @Model
    public final class TransactionRecord {
        @Attribute(.unique) public var id: UUID
        /// income, expense, transfer
        public var type: String
        public var accountId: UUID
        public var transferAccountId: UUID?
        public var amount: Decimal
        public var currency: String
        public var transferAmount: Decimal?
        public var amountBase: Decimal
        public var categoryId: UUID?
        public var note: String?
        public var merchant: String?
        public var occurredAt: Date
        public var source: String
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, type: String, accountId: UUID, transferAccountId: UUID? = nil,
            amount: Decimal, currency: String, transferAmount: Decimal? = nil,
            amountBase: Decimal, categoryId: UUID? = nil, note: String? = nil,
            merchant: String? = nil, occurredAt: Date, source: String = "quick_add",
            updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.type = type
            self.accountId = accountId
            self.transferAccountId = transferAccountId
            self.amount = amount
            self.currency = currency
            self.transferAmount = transferAmount
            self.amountBase = amountBase
            self.categoryId = categoryId
            self.note = note
            self.merchant = merchant
            self.occurredAt = occurredAt
            self.source = source
            self.updatedAt = updatedAt
            self.deletedAt = deletedAt
        }
    }

    @Model
    public final class GoalRecord {
        @Attribute(.unique) public var id: UUID
        public var title: String
        public var emoji: String
        public var color: String
        public var templateKey: String?
        public var targetAmount: Decimal
        public var savedAmount: Decimal
        public var currency: String
        public var deadline: String?
        /// active, paused, completed, archived
        public var status: String
        public var isPrimary: Bool
        public var priority: Int
        public var linkedAccountId: UUID?
        public var milestones: [Int]
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, title: String, emoji: String = "🎯", color: String, templateKey: String? = nil,
            targetAmount: Decimal, savedAmount: Decimal = 0, currency: String,
            deadline: String? = nil, status: String = "active", isPrimary: Bool = false,
            priority: Int = 0, linkedAccountId: UUID? = nil, milestones: [Int] = [],
            updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.title = title
            self.emoji = emoji
            self.color = color
            self.templateKey = templateKey
            self.targetAmount = targetAmount
            self.savedAmount = savedAmount
            self.currency = currency
            self.deadline = deadline
            self.status = status
            self.isPrimary = isPrimary
            self.priority = priority
            self.linkedAccountId = linkedAccountId
            self.milestones = milestones
            self.updatedAt = updatedAt
            self.deletedAt = deletedAt
        }
    }

    @Model
    public final class ContributionRecord {
        @Attribute(.unique) public var id: UUID
        public var goalId: UUID
        /// deposit, withdrawal
        public var type: String
        public var amount: Decimal
        public var currency: String
        public var accountId: UUID?
        /// manual, smart_save, auto_save, round_up
        public var method: String
        public var note: String?
        public var createdAt: Date
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, goalId: UUID, type: String, amount: Decimal, currency: String,
            accountId: UUID? = nil, method: String = "manual", note: String? = nil,
            createdAt: Date = .now, updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.goalId = goalId
            self.type = type
            self.amount = amount
            self.currency = currency
            self.accountId = accountId
            self.method = method
            self.note = note
            self.createdAt = createdAt
            self.updatedAt = updatedAt
            self.deletedAt = deletedAt
        }
    }

    /// A change made on this device that the server has not confirmed yet
    /// (one entry of `POST /v1/sync/push`).
    @Model
    public final class PendingOperation {
        @Attribute(.unique) public var opId: String
        /// e.g. `transaction.create`
        public var type: String
        /// The operation as the API expects it, JSON
        public var payload: Data
        public var createdAt: Date
        public var attempts: Int

        public init(opId: String = UUID().uuidString, type: String, payload: Data, createdAt: Date = .now) {
            self.opId = opId
            self.type = type
            self.payload = payload
            self.createdAt = createdAt
            self.attempts = 0
        }
    }

    /// The `nextCursor` of the last finished pull.
    @Model
    public final class SyncCursor {
        @Attribute(.unique) public var key: String
        public var cursor: String
        public var syncedAt: Date

        public init(key: String = "main", cursor: String, syncedAt: Date = .now) {
            self.key = key
            self.cursor = cursor
            self.syncedAt = syncedAt
        }
    }
}

public typealias AccountRecord = LunexSchemaV1.AccountRecord
public typealias CategoryRecord = LunexSchemaV1.CategoryRecord
public typealias TransactionRecord = LunexSchemaV1.TransactionRecord
public typealias GoalRecord = LunexSchemaV1.GoalRecord
public typealias ContributionRecord = LunexSchemaV1.ContributionRecord
public typealias PendingOperation = LunexSchemaV1.PendingOperation
public typealias SyncCursor = LunexSchemaV1.SyncCursor

/// Future schema versions add their migration stages here.
public enum LunexMigrationPlan: SchemaMigrationPlan {
    public static var schemas: [any VersionedSchema.Type] { [LunexSchemaV1.self] }
    public static var stages: [MigrationStage] { [] }
}

public enum LunexStore {
    /// The app's local database; in memory for tests and previews.
    public static func makeContainer(inMemory: Bool = false) throws -> ModelContainer {
        let schema = Schema(versionedSchema: LunexSchemaV1.self)
        let configuration = ModelConfiguration(
            "Lunex",
            schema: schema,
            isStoredInMemoryOnly: inMemory
        )
        return try ModelContainer(
            for: schema,
            migrationPlan: LunexMigrationPlan.self,
            configurations: configuration
        )
    }
}
