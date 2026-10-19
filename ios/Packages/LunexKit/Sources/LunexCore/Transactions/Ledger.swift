import Foundation
import Observation
import SwiftData

public enum TransactionKind: String, CaseIterable, Sendable, Codable {
    case expense, income, transfer
}

/// The quick-add sheet's answers: what, how much, from where, when.
public struct TransactionDraft: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        case noAmount, noAccount, noTargetAccount, sameAccount
    }

    public var kind: TransactionKind
    public var amount: AmountInput
    public var accountId: UUID?
    /// Transfers: the receiving account
    public var transferAccountId: UUID?
    /// Not for transfers
    public var categoryId: UUID?
    public var occurredAt: Date
    public var note: String

    public init(
        kind: TransactionKind = .expense, amount: AmountInput, accountId: UUID? = nil,
        transferAccountId: UUID? = nil, categoryId: UUID? = nil, occurredAt: Date = .now, note: String = ""
    ) {
        self.kind = kind
        self.amount = amount
        self.accountId = accountId
        self.transferAccountId = transferAccountId
        self.categoryId = categoryId
        self.occurredAt = occurredAt
        self.note = note
    }

    /// What still stops saving; nil when it can be saved.
    public var problem: Problem? {
        guard let value = amount.value, value > 0 else { return .noAmount }
        guard let accountId else { return .noAccount }
        if kind == .transfer {
            guard let transferAccountId else { return .noTargetAccount }
            if transferAccountId == accountId { return .sameAccount }
        }
        return nil
    }
}

/// Changes operations on the device and queues them for the server. Balances of the accounts
/// involved move at once, the way the server moves them; the next sync brings the exact figures
/// (amounts in the base currency, transfer rates).
@MainActor
@Observable
public final class Ledger {
    @ObservationIgnored private let context: ModelContext
    @ObservationIgnored private let sync: SyncEngine
    @ObservationIgnored private let baseCurrency: @MainActor () -> String

    public init(container: ModelContainer, sync: SyncEngine, baseCurrency: @escaping @MainActor () -> String) {
        self.context = container.mainContext
        self.sync = sync
        self.baseCurrency = baseCurrency
    }

    // MARK: - Changes

    /// Records a new operation; returns its id (for «Отменить»).
    @discardableResult
    public func create(_ draft: TransactionDraft, source: String = "quick_add") throws -> UUID {
        let state = try resolve(draft)
        let id = UUID()
        let record = TransactionRecord(
            id: id, type: draft.kind.rawValue, accountId: state.account.id,
            transferAccountId: state.target?.id, amount: state.amount, currency: state.account.currency,
            transferAmount: state.target.map { _ in state.amount }, transferCurrency: state.target?.currency,
            amountBase: state.amountBase, baseCurrency: state.base, fxRate: state.rate,
            categoryId: draft.kind == .transfer ? nil : draft.categoryId,
            note: draft.note.trimmed, occurredAt: draft.occurredAt, source: source
        )
        context.insert(record)
        try move(nil, record)

        try sync.store(.make("transaction.create", recordId: id, data: CreateBody(record: record)))
        try context.save()
        Task { await sync.sync() }
        return id
    }

    public func update(_ id: UUID, with draft: TransactionDraft) throws {
        let record = try find(id)
        let before = Movement(record)
        let state = try resolve(draft)
        record.type = draft.kind.rawValue
        record.accountId = state.account.id
        record.currency = state.account.currency
        record.transferAccountId = state.target?.id
        record.transferAmount = state.target.map { _ in state.amount }
        record.transferCurrency = state.target?.currency
        record.amount = state.amount
        record.amountBase = state.amountBase
        record.baseCurrency = state.base
        record.fxRate = state.rate
        record.categoryId = draft.kind == .transfer ? nil : draft.categoryId
        record.note = draft.note.trimmed
        record.occurredAt = draft.occurredAt
        record.updatedAt = .now
        try move(before, record)

        try sync.store(.make("transaction.update", id: id, data: UpdateBody(record: record)))
        try context.save()
        Task { await sync.sync() }
    }

    public func delete(_ id: UUID) throws {
        let record = try find(id)
        guard record.deletedAt == nil else { return }
        let before = Movement(record)
        record.deletedAt = .now
        try move(before, nil)
        try sync.store(.make("transaction.delete", id: id))
        try context.save()
        Task { await sync.sync() }
    }

    /// Brings back a deleted operation («Отменить» after a delete).
    public func restore(_ id: UUID) throws {
        let record = try find(id)
        guard record.deletedAt != nil else { return }
        record.deletedAt = nil
        try move(nil, record)
        try sync.store(.make("transaction.restore", id: id))
        try context.save()
        Task { await sync.sync() }
    }

    /// The sheet's answers for an existing operation.
    public func draft(for record: TransactionRecord) -> TransactionDraft {
        TransactionDraft(
            kind: TransactionKind(rawValue: record.type) ?? .expense,
            amount: AmountInput(amount: record.amount, fractionDigits: Money.fractionDigits(for: record.currency)),
            accountId: record.accountId,
            transferAccountId: record.transferAccountId,
            categoryId: record.categoryId,
            occurredAt: record.occurredAt,
            note: record.note ?? ""
        )
    }

    // MARK: - Details

    private struct Resolved {
        let account: AccountRecord
        let target: AccountRecord?
        let amount: Decimal
        let base: String
        let rate: Decimal
        let amountBase: Decimal
    }

    public enum LedgerError: Error, Equatable {
        case invalid(TransactionDraft.Problem)
        case notFound
    }

    private func resolve(_ draft: TransactionDraft) throws -> Resolved {
        if let problem = draft.problem { throw LedgerError.invalid(problem) }
        guard let accountId = draft.accountId, let account = try fetchAccount(accountId),
              let amount = draft.amount.value
        else { throw LedgerError.invalid(.noAccount) }
        var target: AccountRecord?
        if draft.kind == .transfer {
            guard let id = draft.transferAccountId, let found = try fetchAccount(id) else {
                throw LedgerError.invalid(.noTargetAccount)
            }
            target = found
        }
        let base = baseCurrency()
        let rate = account.currency == base ? 1 : try lastRate(from: account.currency, to: base)
        var amountBase = amount * rate
        var rounded = Decimal()
        NSDecimalRound(&rounded, &amountBase, Money.fractionDigits(for: base), .plain)
        return Resolved(account: account, target: target, amount: amount, base: base, rate: rate, amountBase: rounded)
    }

    /// The rate of the latest operation in that currency; 1 until the server has sent one.
    private func lastRate(from currency: String, to base: String) throws -> Decimal {
        var descriptor = FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.currency == currency && $0.baseCurrency == base },
            sortBy: [SortDescriptor(\.occurredAt, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first?.fxRate ?? 1
    }

    private func find(_ id: UUID) throws -> TransactionRecord {
        guard let record = try context.fetch(FetchDescriptor<TransactionRecord>(predicate: #Predicate { $0.id == id })).first
        else { throw LedgerError.notFound }
        return record
    }

    private func fetchAccount(_ id: UUID) throws -> AccountRecord? {
        try context.fetch(FetchDescriptor<AccountRecord>(predicate: #Predicate { $0.id == id })).first
    }

    /// How an operation moves balances: income adds, expense takes, a transfer moves money
    /// from one account to the other (the server's `balanceEffects`).
    private struct Movement {
        let type: String
        let accountId: UUID
        let amount: Decimal
        let transferAccountId: UUID?
        let transferAmount: Decimal?

        init(_ record: TransactionRecord) {
            type = record.type
            accountId = record.accountId
            amount = record.amount
            transferAccountId = record.transferAccountId
            transferAmount = record.transferAmount
        }

        var effects: [UUID: Decimal] {
            var effects: [UUID: Decimal] = [:]
            switch type {
            case "income":
                effects[accountId, default: 0] += amount
            case "expense":
                effects[accountId, default: 0] -= amount
            case "transfer":
                effects[accountId, default: 0] -= amount
                if let transferAccountId {
                    effects[transferAccountId, default: 0] += transferAmount ?? amount
                }
            default:
                break
            }
            return effects
        }
    }

    private func move(_ before: Movement?, _ after: TransactionRecord?) throws {
        var net: [UUID: Decimal] = [:]
        for (id, delta) in before?.effects ?? [:] { net[id, default: 0] -= delta }
        for (id, delta) in after.map(Movement.init)?.effects ?? [:] { net[id, default: 0] += delta }
        for (id, delta) in net where delta != 0 {
            if let account = try fetchAccount(id) {
                account.currentBalance += delta
            }
        }
    }

    /// `POST /v1/transactions`
    private struct CreateBody: Encodable, Sendable {
        let id: UUID
        let type: String
        let accountId: UUID
        let amount: String
        let categoryId: UUID?
        let transferAccountId: UUID?
        let note: String?
        let occurredAt: Date
        let source: String

        init(record: TransactionRecord) {
            id = record.id
            type = record.type
            accountId = record.accountId
            amount = NSDecimalNumber(decimal: record.amount).stringValue
            categoryId = record.categoryId
            transferAccountId = record.transferAccountId
            note = record.note
            occurredAt = record.occurredAt
            source = record.source
        }
    }

    /// `PATCH /v1/transactions/:id` with every field the sheet edits, so a change of type or
    /// category also clears what no longer applies (null category, null receiving account).
    private struct UpdateBody: Encodable, Sendable {
        let type: String
        let accountId: UUID
        let amount: String
        let categoryId: UUID?
        let transferAccountId: UUID?
        let note: String
        let occurredAt: Date

        init(record: TransactionRecord) {
            type = record.type
            accountId = record.accountId
            amount = NSDecimalNumber(decimal: record.amount).stringValue
            categoryId = record.categoryId
            transferAccountId = record.transferAccountId
            note = record.note ?? ""
            occurredAt = record.occurredAt
        }

        enum CodingKeys: String, CodingKey {
            case type, accountId, amount, categoryId, transferAccountId, note, occurredAt
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(type, forKey: .type)
            try container.encode(accountId, forKey: .accountId)
            try container.encode(amount, forKey: .amount)
            try container.encode(categoryId, forKey: .categoryId)
            try container.encode(transferAccountId, forKey: .transferAccountId)
            try container.encode(note, forKey: .note)
            try container.encode(occurredAt, forKey: .occurredAt)
        }
    }
}

private extension String {
    /// Trimmed, nil when empty.
    var trimmed: String? {
        let text = trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}
