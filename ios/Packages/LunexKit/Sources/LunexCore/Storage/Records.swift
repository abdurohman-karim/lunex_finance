import Foundation
import SwiftData

// Local mirror of the server data. Screens read these and write through `SyncEngine`, which
// queues the change and keeps the records in step with the API. Ids are the server ids,
// generated on the device for records created offline. Deleted records stay with `deletedAt`
// (an operation can be restored); screens filter them out.
//
// V1 has not shipped yet, so it is still edited in place; a store from an older build that
// no longer opens is removed and refilled from the server (`LunexStore.makeContainer`).
// After the first release every change goes through a new version and `LunexMigrationPlan`.

public enum LunexSchemaV1: VersionedSchema {
    public static let versionIdentifier = Schema.Version(1, 0, 0)

    public static var models: [any PersistentModel.Type] {
        [
            AccountRecord.self,
            CategoryRecord.self,
            TransactionRecord.self,
            GoalRecord.self,
            ContributionRecord.self,
            SettingsRecord.self,
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
        public var transferCurrency: String?
        /// In the user's base currency at the rate of the operation date
        public var amountBase: Decimal
        public var baseCurrency: String
        public var fxRate: Decimal
        public var categoryId: UUID?
        public var note: String?
        public var merchant: String?
        public var occurredAt: Date
        public var source: String
        public var createdAt: Date
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, type: String, accountId: UUID, transferAccountId: UUID? = nil,
            amount: Decimal, currency: String, transferAmount: Decimal? = nil,
            transferCurrency: String? = nil, amountBase: Decimal, baseCurrency: String? = nil,
            fxRate: Decimal = 1, categoryId: UUID? = nil, note: String? = nil,
            merchant: String? = nil, occurredAt: Date, source: String = "quick_add",
            createdAt: Date = .now, updatedAt: Date = .now, deletedAt: Date? = nil
        ) {
            self.id = id
            self.type = type
            self.accountId = accountId
            self.transferAccountId = transferAccountId
            self.amount = amount
            self.currency = currency
            self.transferAmount = transferAmount
            self.transferCurrency = transferCurrency
            self.amountBase = amountBase
            self.baseCurrency = baseCurrency ?? currency
            self.fxRate = fxRate
            self.categoryId = categoryId
            self.note = note
            self.merchant = merchant
            self.occurredAt = occurredAt
            self.source = source
            self.createdAt = createdAt
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
        /// ⌊saved ÷ target × 100⌋, may exceed 100
        public var progress: Int
        /// The server's plan to the deadline; nil without a deadline
        public var schedulePerDay: Decimal?
        public var schedulePerWeek: Decimal?
        public var schedulePerMonth: Decimal?
        public var scheduleExpectedSaved: Decimal?
        /// on_track, behind, ahead
        public var scheduleStatus: String?
        public var scheduleDaysLeft: Int?
        public var completedAt: Date?
        public var archivedAt: Date?
        public var createdAt: Date
        public var updatedAt: Date
        public var deletedAt: Date?

        public init(
            id: UUID, title: String, emoji: String = "🎯", color: String, templateKey: String? = nil,
            targetAmount: Decimal, savedAmount: Decimal = 0, currency: String,
            deadline: String? = nil, status: String = "active", isPrimary: Bool = false,
            priority: Int = 0, linkedAccountId: UUID? = nil, milestones: [Int] = [],
            progress: Int = 0, createdAt: Date = .now, updatedAt: Date = .now, deletedAt: Date? = nil
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
            self.progress = progress
            self.createdAt = createdAt
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
        /// What the account paid or got, in its currency
        public var accountAmount: Decimal?
        public var accountCurrency: String?
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

    /// The user's settings (one row), as the server last sent them.
    @Model
    public final class SettingsRecord {
        @Attribute(.unique) public var key: String
        public var biometricLockEnabled: Bool
        public var lockAfterSeconds: Int
        public var hideAmounts: Bool
        /// 1 = Monday … 7 = Sunday
        public var weekStartsOn: Int
        /// Payday: the budget month starts on it
        public var monthStartsOnDay: Int
        public var defaultAccountId: UUID?
        public var dailyReminderEnabled: Bool
        /// `HH:MM`
        public var dailyReminderTime: String
        public var budgetAlertsEnabled: Bool
        public var goalAlertsEnabled: Bool
        public var recurringAlertsEnabled: Bool
        public var smartSaveEnabled: Bool
        public var weeklyReportEnabled: Bool
        public var quietHoursStart: String
        public var quietHoursEnd: String
        public var hapticsEnabled: Bool
        public var updatedAt: Date

        public init(key: String = "main", updatedAt: Date = .now) {
            self.key = key
            self.biometricLockEnabled = false
            self.lockAfterSeconds = 60
            self.hideAmounts = false
            self.weekStartsOn = 1
            self.monthStartsOnDay = 1
            self.defaultAccountId = nil
            self.dailyReminderEnabled = true
            self.dailyReminderTime = "21:00"
            self.budgetAlertsEnabled = true
            self.goalAlertsEnabled = true
            self.recurringAlertsEnabled = true
            self.smartSaveEnabled = true
            self.weeklyReportEnabled = true
            self.quietHoursStart = "22:00"
            self.quietHoursEnd = "08:00"
            self.hapticsEnabled = true
            self.updatedAt = updatedAt
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
        /// The record it changes, so a pull does not overwrite a change still on its way
        public var recordId: UUID?
        /// Queue order; `createdAt` can repeat within one tap
        public var sequence: Int
        public var createdAt: Date
        public var attempts: Int

        public init(
            opId: String = UUID().uuidString, type: String, payload: Data, recordId: UUID? = nil,
            sequence: Int = 0, createdAt: Date = .now
        ) {
            self.opId = opId
            self.type = type
            self.payload = payload
            self.recordId = recordId
            self.sequence = sequence
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
public typealias SettingsRecord = LunexSchemaV1.SettingsRecord
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
        let configuration = ModelConfiguration("Lunex", schema: schema, isStoredInMemoryOnly: inMemory)
        do {
            return try open(schema, configuration)
        } catch where !inMemory {
            // A store this build cannot read (an older pre-release schema): the server has the
            // data, so start empty and let the next sync refill it.
            for suffix in ["", "-shm", "-wal"] {
                try? FileManager.default.removeItem(at: URL(filePath: configuration.url.path() + suffix))
            }
            return try open(schema, configuration)
        }
    }

    private static func open(_ schema: Schema, _ configuration: ModelConfiguration) throws -> ModelContainer {
        try ModelContainer(for: schema, migrationPlan: LunexMigrationPlan.self, configurations: configuration)
    }
}
