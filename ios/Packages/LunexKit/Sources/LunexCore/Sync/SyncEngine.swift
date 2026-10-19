import Foundation
import Network
import Observation
import SwiftData

/// Keeps the local SwiftData store in step with the server.
///
/// Screens change records locally and `enqueue` the matching operation; a sync first sends the
/// queue (`POST /v1/sync/push`), then downloads what changed since the stored cursor
/// (`GET /v1/sync/changes`, page by page). Records with a change still in the queue are left as
/// they are until it is sent, so a pull never undoes what the user just did. A refused create
/// removes its local record; any other refusal triggers a full download to return to the
/// server's state. Only one sync runs at a time; a request during it runs once more after it.
@MainActor
@Observable
public final class SyncEngine {
    public enum Status: Equatable, Sendable {
        case idle, syncing, offline, failed
    }

    /// A change the server refused for good (a validation or business rule); shown to the user.
    public struct Rejection: Equatable, Sendable, Identifiable {
        public let id: String
        public let type: String
        public let code: String
        public let message: String
    }

    public private(set) var status = Status.idle
    public private(set) var lastSyncedAt: Date?
    public private(set) var pendingCount = 0
    public private(set) var rejections: [Rejection] = []
    public private(set) var lastError: APIError?

    @ObservationIgnored private let api: APIClient
    /// Kept alive here: a context whose container is gone traps on first use.
    @ObservationIgnored private let container: ModelContainer
    @ObservationIgnored private let context: ModelContext
    @ObservationIgnored private let onProfile: @MainActor (Profile) -> Void
    @ObservationIgnored private var running: Task<Void, Never>?
    @ObservationIgnored private var runAgain = false
    @ObservationIgnored private var monitor: NWPathMonitor?

    static let pushBatch = 100
    static let pullLimit = 500
    /// A batch the server keeps refusing as a whole is dropped after this many tries.
    static let maxAttempts = 5
    private static let cursorKey = "main"

    public init(api: APIClient, container: ModelContainer, onProfile: @escaping @MainActor (Profile) -> Void) {
        self.api = api
        self.container = container
        self.context = container.mainContext
        self.onProfile = onProfile
        lastSyncedAt = storedCursor()?.syncedAt
        pendingCount = (try? context.fetchCount(FetchDescriptor<PendingOperation>())) ?? 0
    }

    // MARK: - Queue

    /// Queues a change the app has already applied to the local records, then syncs.
    public func enqueue(_ operation: SyncOperation) throws {
        try store(operation)
        Task { await sync() }
    }

    /// Queues without syncing; for several changes in a row, then one `sync()`.
    public func store(_ operation: SyncOperation) throws {
        var last = FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence, order: .reverse)])
        last.fetchLimit = 1
        let sequence = ((try context.fetch(last).first?.sequence) ?? 0) + 1
        context.insert(PendingOperation(
            opId: operation.opId,
            type: operation.type,
            payload: operation.payload,
            recordId: operation.recordId,
            sequence: sequence
        ))
        try context.save()
        pendingCount += 1
    }

    // MARK: - Sync

    /// Sends the queue, then downloads changes. Safe to call often.
    public func sync() async {
        if let running {
            runAgain = true
            await running.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            repeat {
                runAgain = false
                await runOnce()
            } while runAgain
        }
        running = task
        await task.value
        running = nil
    }

    private func runOnce() async {
        status = .syncing
        do {
            try await pushQueue()
            try await pullChanges()
            status = .idle
            lastError = nil
        } catch let error as APIError {
            lastError = error
            status = error.isOffline ? .offline : .failed
        } catch {
            lastError = APIError(status: 0, code: "sync_failed", message: String(describing: error))
            status = .failed
        }
        pendingCount = (try? context.fetchCount(FetchDescriptor<PendingOperation>())) ?? pendingCount
    }

    private func pushQueue() async throws {
        while true {
            var next = FetchDescriptor<PendingOperation>(sortBy: [SortDescriptor(\.sequence)])
            next.fetchLimit = Self.pushBatch
            let batch = try context.fetch(next)
            guard !batch.isEmpty else { return }

            let response: PushResponse
            do {
                response = try await api.send(API.syncPush(operations: batch.map(\.payload)))
            } catch let error as APIError where !error.isTransient && error.status != 401 {
                // The whole request is refused (not offline, not the server's trouble): count it,
                // and give up on the batch rather than block the queue forever.
                try giveUp(on: batch, after: error)
                throw error
            }

            let results = Dictionary(
                response.results.compactMap { result in result.opId.map { ($0, result) } },
                uniquingKeysWith: { first, _ in first }
            )
            var needsFullPull = false
            var settled = 0
            for operation in batch {
                guard let result = results[operation.opId] else { continue }
                settled += 1
                if result.status == "rejected" {
                    rejections.append(Rejection(
                        id: operation.opId,
                        type: operation.type,
                        code: result.code ?? "rejected",
                        message: result.message ?? ""
                    ))
                    if !removeLocalRecord(createdBy: operation) {
                        needsFullPull = true
                    }
                }
                context.delete(operation)
            }
            try context.save()
            if needsFullPull {
                resetCursor()
            }
            if settled == 0 {
                // The server answered for none of them; try again on the next sync.
                return
            }
        }
    }

    private func giveUp(on batch: [PendingOperation], after error: APIError) throws {
        for operation in batch {
            operation.attempts += 1
            if operation.attempts >= Self.maxAttempts {
                rejections.append(Rejection(
                    id: operation.opId, type: operation.type, code: error.code, message: error.message
                ))
                _ = removeLocalRecord(createdBy: operation)
                context.delete(operation)
            }
        }
        try context.save()
    }

    /// A refused create leaves a record the server never had: remove it. Returns false for
    /// other operations, whose records come back right with a full download.
    private func removeLocalRecord(createdBy operation: PendingOperation) -> Bool {
        guard let id = operation.recordId else { return false }
        switch operation.type {
        case "account.create":
            try? context.delete(model: AccountRecord.self, where: #Predicate { $0.id == id })
        case "category.create":
            try? context.delete(model: CategoryRecord.self, where: #Predicate { $0.id == id })
        case "transaction.create":
            try? context.delete(model: TransactionRecord.self, where: #Predicate { $0.id == id })
        case "goal.create":
            try? context.delete(model: GoalRecord.self, where: #Predicate { $0.id == id })
        case "goal.contribute":
            try? context.delete(model: ContributionRecord.self, where: #Predicate { $0.id == id })
        default:
            return false
        }
        return true
    }

    private func pullChanges() async throws {
        var cursor = storedCursor()?.cursor
        var page: SyncPage
        repeat {
            page = try await api.send(API.syncChanges(cursor: cursor, limit: Self.pullLimit))
            try apply(page)
            cursor = page.nextCursor
            // Each page is consistent on its own: keep progress, so a failure resumes here.
            saveCursor(page.nextCursor, syncedAt: page.hasMore ? nil : .now)
            try context.save()
        } while page.hasMore
        lastSyncedAt = storedCursor()?.syncedAt
    }

    // MARK: - Applying a page

    private func apply(_ page: SyncPage) throws {
        let pending = try Set(context.fetch(FetchDescriptor<PendingOperation>()).compactMap(\.recordId))
        if let profile = page.profile {
            onProfile(profile)
        }
        try upsert(page.accounts.filter { !pending.contains($0.id) })
        try upsert(page.categories.filter { !pending.contains($0.id) })
        try upsert(page.transactions.filter { !pending.contains($0.id) })
        try upsert(page.goals.filter { !pending.contains($0.id) })
        try upsert(page.goalContributions.filter { !pending.contains($0.id) })
        if let settings = page.settings {
            try upsert(settings)
        }
    }

    private func upsert(_ items: [AccountDTO]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        let existing = try context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { ids.contains($0.id) }))
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in items {
            let record = byId[item.id] ?? {
                let new = AccountRecord(id: item.id, name: item.name, type: item.type, currency: item.currency)
                context.insert(new)
                return new
            }()
            record.name = item.name
            record.type = item.type
            record.currency = item.currency
            record.initialBalance = money(item.initialBalance)
            record.currentBalance = money(item.currentBalance)
            record.icon = item.icon
            record.color = item.color
            record.includeInTotal = item.includeInTotal
            record.isArchived = item.isArchived
            record.isDefault = item.isDefault
            record.sortOrder = item.sortOrder
            record.updatedAt = item.updatedAt
            record.deletedAt = item.deletedAt
        }
    }

    private func upsert(_ items: [CategoryDTO]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        let existing = try context.fetch(FetchDescriptor<CategoryRecord>(predicate: #Predicate { ids.contains($0.id) }))
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in items {
            let record = byId[item.id] ?? {
                let new = CategoryRecord(id: item.id, type: item.type, name: item.name, icon: item.icon, color: item.color)
                context.insert(new)
                return new
            }()
            record.type = item.type
            record.key = item.key
            record.name = item.name
            record.translations = item.translations
            record.icon = item.icon
            record.color = item.color
            record.parentId = item.parentId
            record.sortOrder = item.sortOrder
            record.isArchived = item.isArchived
            record.isSystem = item.isSystem
            record.updatedAt = item.updatedAt
            record.deletedAt = item.deletedAt
        }
    }

    private func upsert(_ items: [TransactionDTO]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        let existing = try context.fetch(FetchDescriptor<TransactionRecord>(predicate: #Predicate { ids.contains($0.id) }))
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in items {
            let record = byId[item.id] ?? {
                let new = TransactionRecord(
                    id: item.id, type: item.type, accountId: item.accountId, amount: money(item.amount),
                    currency: item.currency, amountBase: money(item.amountBase), occurredAt: item.occurredAt
                )
                context.insert(new)
                return new
            }()
            record.type = item.type
            record.accountId = item.accountId
            record.transferAccountId = item.transferAccountId
            record.amount = money(item.amount)
            record.currency = item.currency
            record.transferAmount = money(item.transferAmount)
            record.transferCurrency = item.transferCurrency
            record.amountBase = money(item.amountBase)
            record.baseCurrency = item.baseCurrency
            record.fxRate = money(item.fxRate)
            record.categoryId = item.categoryId
            record.note = item.note
            record.merchant = item.merchant
            record.occurredAt = item.occurredAt
            record.source = item.source
            record.createdAt = item.createdAt
            record.updatedAt = item.updatedAt
            record.deletedAt = item.deletedAt
        }
    }

    private func upsert(_ items: [GoalDTO]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        let existing = try context.fetch(FetchDescriptor<GoalRecord>(predicate: #Predicate { ids.contains($0.id) }))
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in items {
            let record = byId[item.id] ?? {
                let new = GoalRecord(
                    id: item.id, title: item.title, color: item.color,
                    targetAmount: money(item.targetAmount), currency: item.currency
                )
                context.insert(new)
                return new
            }()
            record.title = item.title
            record.emoji = item.emoji
            record.color = item.color
            record.templateKey = item.templateKey
            record.targetAmount = money(item.targetAmount)
            record.savedAmount = money(item.savedAmount)
            record.progress = item.progress
            record.currency = item.currency
            record.deadline = item.deadline
            record.status = item.status
            record.isPrimary = item.isPrimary
            record.priority = item.priority
            record.linkedAccountId = item.linkedAccountId
            record.milestones = item.milestones
            record.schedulePerDay = money(item.schedule?.perDay)
            record.schedulePerWeek = money(item.schedule?.perWeek)
            record.schedulePerMonth = money(item.schedule?.perMonth)
            record.scheduleExpectedSaved = money(item.schedule?.expectedSaved)
            record.scheduleStatus = item.schedule?.status
            record.scheduleDaysLeft = item.schedule?.daysLeft
            record.completedAt = item.completedAt
            record.archivedAt = item.archivedAt
            record.createdAt = item.createdAt
            record.updatedAt = item.updatedAt
            record.deletedAt = item.deletedAt
        }
    }

    private func upsert(_ items: [ContributionDTO]) throws {
        guard !items.isEmpty else { return }
        let ids = items.map(\.id)
        let existing = try context.fetch(FetchDescriptor<ContributionRecord>(predicate: #Predicate { ids.contains($0.id) }))
        let byId = Dictionary(existing.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for item in items {
            let record = byId[item.id] ?? {
                let new = ContributionRecord(
                    id: item.id, goalId: item.goalId, type: item.type,
                    amount: money(item.amount), currency: item.currency
                )
                context.insert(new)
                return new
            }()
            record.goalId = item.goalId
            record.type = item.type
            record.amount = money(item.amount)
            record.currency = item.currency
            record.accountId = item.accountId
            record.accountAmount = money(item.accountAmount)
            record.accountCurrency = item.accountCurrency
            record.method = item.method
            record.note = item.note
            record.createdAt = item.createdAt
            record.updatedAt = item.updatedAt
            record.deletedAt = item.deletedAt
        }
    }

    private func upsert(_ item: SettingsDTO) throws {
        let key = Self.cursorKey
        let record = try context.fetch(FetchDescriptor<SettingsRecord>(predicate: #Predicate { $0.key == key })).first ?? {
            let new = SettingsRecord(key: key)
            context.insert(new)
            return new
        }()
        record.biometricLockEnabled = item.biometricLockEnabled
        record.lockAfterSeconds = item.lockAfterSeconds
        record.hideAmounts = item.hideAmounts
        record.weekStartsOn = item.weekStartsOn
        record.monthStartsOnDay = item.monthStartsOnDay
        record.defaultAccountId = item.defaultAccountId
        record.dailyReminderEnabled = item.dailyReminderEnabled
        record.dailyReminderTime = item.dailyReminderTime
        record.budgetAlertsEnabled = item.budgetAlertsEnabled
        record.goalAlertsEnabled = item.goalAlertsEnabled
        record.recurringAlertsEnabled = item.recurringAlertsEnabled
        record.smartSaveEnabled = item.smartSaveEnabled
        record.weeklyReportEnabled = item.weeklyReportEnabled
        record.quietHoursStart = item.quietHoursStart
        record.quietHoursEnd = item.quietHoursEnd
        record.hapticsEnabled = item.hapticsEnabled
        record.updatedAt = item.updatedAt
    }

    // MARK: - Cursor

    private func storedCursor() -> SyncCursor? {
        let key = Self.cursorKey
        return try? context.fetch(FetchDescriptor<SyncCursor>(predicate: #Predicate { $0.key == key })).first
    }

    /// `syncedAt` is set when the download reached the end; nil keeps the previous time.
    private func saveCursor(_ cursor: String, syncedAt: Date?) {
        if let stored = storedCursor() {
            stored.cursor = cursor
            if let syncedAt { stored.syncedAt = syncedAt }
        } else {
            context.insert(SyncCursor(key: Self.cursorKey, cursor: cursor, syncedAt: syncedAt ?? .distantPast))
        }
    }

    /// The next pull starts from scratch and brings every record back to the server's state.
    private func resetCursor() {
        let key = Self.cursorKey
        try? context.delete(model: SyncCursor.self, where: #Predicate { $0.key == key })
    }

    // MARK: - Network and sign-out

    /// Syncs again when the connection comes back and something is waiting.
    public func startMonitoringNetwork() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in
                guard let self, self.pendingCount > 0 || self.status == .offline else { return }
                await self.sync()
            }
        }
        monitor.start(queue: DispatchQueue(label: "uz.lunex.finance.network"))
        self.monitor = monitor
    }

    /// Signed out: nothing of this account may stay on the device.
    public func reset() {
        for model in LunexSchemaV1.models {
            try? context.delete(model: model)
        }
        try? context.save()
        status = .idle
        lastSyncedAt = nil
        pendingCount = 0
        rejections = []
        lastError = nil
    }
}

private extension ModelContext {
    func delete(model: any PersistentModel.Type) throws {
        try delete(model: model, where: nil, includeSubclasses: true)
    }
}
