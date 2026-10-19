import Foundation
import Observation
import SwiftData

public enum AccountKind: String, CaseIterable, Sendable {
    case cash, card, bank, savings, other

    /// The SF Symbol a new account of this kind starts with.
    public var defaultIcon: String {
        switch self {
        case .cash: "banknote"
        case .card: "creditcard"
        case .bank: "building.columns"
        case .savings: "lock"
        case .other: "wallet.pass"
        }
    }
}

public enum CategoryKind: String, CaseIterable, Sendable {
    case expense, income
}

/// The account editor's answers.
public struct AccountDraft: Equatable, Sendable {
    public var name: String
    public var kind: AccountKind
    public var currency: String
    /// Typed by hand; may be negative (a card in debt)
    public var initialBalance: Decimal
    public var icon: String
    public var color: String
    public var includeInTotal: Bool

    public init(
        name: String = "", kind: AccountKind = .card, currency: String = SupportedCurrency.default,
        initialBalance: Decimal = 0, icon: String? = nil, color: String = Palette.data[0], includeInTotal: Bool = true
    ) {
        self.name = name
        self.kind = kind
        self.currency = currency
        self.initialBalance = initialBalance
        self.icon = icon ?? kind.defaultIcon
        self.color = color
        self.includeInTotal = includeInTotal
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isValid: Bool { !trimmedName.isEmpty && trimmedName.count <= 64 }
}

/// The category editor's answers.
public struct CategoryDraft: Equatable, Sendable {
    public var kind: CategoryKind
    public var name: String
    public var icon: String
    public var color: String
    /// Makes it a subcategory; one level only
    public var parentId: UUID?

    public init(kind: CategoryKind = .expense, name: String = "", icon: String = "tag", color: String = Palette.data[0], parentId: UUID? = nil) {
        self.kind = kind
        self.name = name
        self.icon = icon
        self.color = color
        self.parentId = parentId
    }

    public var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isValid: Bool { !trimmedName.isEmpty && trimmedName.count <= 64 }
}

/// The colors accounts and categories can take: muted tones of the design system's data palette
/// (the server's system categories use the same ones). The overspend red is not among them.
public enum Palette {
    public static let data = [
        "#557A95", "#7395AE", "#8A9BA8", "#5F8A8B", "#6E8B74",
        "#B1A296", "#C08B5C", "#8C7B6B", "#938E94", "#5D5C61",
    ]
}

public enum CatalogError: Error, Equatable {
    case invalidName
    /// An own category with this name already exists at this level
    case nameTaken
    case notFound
    /// Operations or goals refer to it: archive instead
    case inUse
    /// A category with subcategories cannot be deleted or become a subcategory
    case hasChildren
    /// An account with operations keeps its currency
    case currencyLocked
    /// System categories can only be archived or moved
    case systemReadonly
    case invalidParent
}

/// Changes accounts and categories on the device and queues them for the server, applying the
/// server's rules first so a change is refused here rather than undone by the next sync.
@MainActor
@Observable
public final class Catalog {
    @ObservationIgnored private let context: ModelContext
    @ObservationIgnored private let sync: SyncEngine

    public init(container: ModelContainer, sync: SyncEngine) {
        self.context = container.mainContext
        self.sync = sync
    }

    // MARK: - Accounts

    @discardableResult
    public func createAccount(_ draft: AccountDraft) throws -> UUID {
        guard draft.isValid else { throw CatalogError.invalidName }
        let accounts = try liveAccounts()
        let id = UUID()
        let balance = Self.rounded(draft.initialBalance, currency: draft.currency)
        let record = AccountRecord(
            id: id, name: draft.trimmedName, type: draft.kind.rawValue, currency: draft.currency,
            initialBalance: balance, currentBalance: balance, icon: draft.icon, color: draft.color,
            includeInTotal: draft.includeInTotal, sortOrder: (accounts.map(\.sortOrder).max() ?? -1) + 1
        )
        context.insert(record)
        // The first account becomes the one quick add preselects, as on the server.
        if !accounts.contains(where: \.isDefault) {
            try setDefaultLocally(record)
        }
        try sync.store(.make("account.create", recordId: id, data: AccountCreateBody(record)))
        try finish()
        return id
    }

    public func updateAccount(_ id: UUID, with draft: AccountDraft) throws {
        guard draft.isValid else { throw CatalogError.invalidName }
        let record = try account(id)
        if draft.currency != record.currency, try hasMovements(id) {
            throw CatalogError.currencyLocked
        }
        let balance = Self.rounded(draft.initialBalance, currency: draft.currency)
        // Changing the opening balance shifts the current balance by the same amount.
        record.currentBalance += balance - record.initialBalance
        record.initialBalance = balance
        record.name = draft.trimmedName
        record.type = draft.kind.rawValue
        record.currency = draft.currency
        record.icon = draft.icon
        record.color = draft.color
        record.includeInTotal = draft.includeInTotal
        record.updatedAt = .now
        try sync.store(.make("account.update", id: id, data: AccountUpdateBody(record)))
        try finish()
    }

    /// Archived accounts keep their history and leave quick add; the default one passes to the next.
    public func setArchived(account id: UUID, _ archived: Bool) throws {
        let record = try account(id)
        guard record.isArchived != archived else { return }
        record.isArchived = archived
        record.updatedAt = .now
        if archived, record.isDefault {
            record.isDefault = false
            try reassignDefault(leaving: id)
        } else if !archived, try !liveAccounts().contains(where: \.isDefault) {
            try setDefaultLocally(record)
        }
        try sync.store(.make("account.update", id: id, data: ["isArchived": archived]))
        try finish()
    }

    /// The account quick add preselects.
    public func makeDefault(account id: UUID) throws {
        let record = try account(id)
        guard !record.isArchived else { throw CatalogError.notFound }
        guard !record.isDefault else { return }
        try setDefaultLocally(record)
        try sync.store(.make("account.update", id: id, data: ["isDefault": true]))
        try finish()
    }

    /// Only an account nothing refers to; the rest are archived.
    public func deleteAccount(_ id: UUID) throws {
        let record = try account(id)
        guard try canDelete(account: id) else { throw CatalogError.inUse }
        record.deletedAt = .now
        if record.isDefault {
            record.isDefault = false
            try reassignDefault(leaving: id)
        }
        try sync.store(.make("account.delete", id: id))
        try finish()
    }

    public func canDelete(account id: UUID) throws -> Bool {
        if try hasMovements(id) { return false }
        let linked: UUID? = id
        let goals = try context.fetchCount(FetchDescriptor<GoalRecord>(
            predicate: #Predicate { $0.linkedAccountId == linked && $0.deletedAt == nil }
        ))
        return goals == 0
    }

    /// Operations or goal contributions move its money, so its currency is fixed.
    public func hasMovements(_ id: UUID) throws -> Bool {
        let optional: UUID? = id
        let transactions = try context.fetchCount(FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.deletedAt == nil && ($0.accountId == id || $0.transferAccountId == optional) }
        ))
        let contributions = try context.fetchCount(FetchDescriptor<ContributionRecord>(
            predicate: #Predicate { $0.deletedAt == nil && $0.accountId == optional }
        ))
        return transactions + contributions > 0
    }

    /// Drag-and-drop order of the active accounts.
    public func reorderAccounts(_ ids: [UUID]) throws {
        guard !ids.isEmpty else { return }
        let byId = Dictionary(try liveAccounts().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (index, id) in ids.enumerated() {
            byId[id]?.sortOrder = index
        }
        try sync.store(.make("account.reorder", data: ["ids": ids]))
        try finish()
    }

    public func draft(for record: AccountRecord) -> AccountDraft {
        let kind = AccountKind(rawValue: record.type) ?? .other
        return AccountDraft(
            name: record.name, kind: kind, currency: record.currency, initialBalance: record.initialBalance,
            icon: record.icon ?? kind.defaultIcon, color: record.color ?? Palette.data[0], includeInTotal: record.includeInTotal
        )
    }

    /// The total of the accounts counted in it, in the base currency. Other currencies use the
    /// rate of their latest operation; those never used yet are listed apart.
    public func balance(of accounts: [AccountRecord], base: String) throws -> AccountsBalance {
        var total: Decimal = 0
        var apart: [String: Decimal] = [:]
        for account in accounts where account.includeInTotal && !account.isArchived && account.deletedAt == nil {
            if account.currency == base {
                total += account.currentBalance
            } else if let rate = try lastRate(from: account.currency, to: base) {
                total += account.currentBalance * rate
            } else {
                apart[account.currency, default: 0] += account.currentBalance
            }
        }
        return AccountsBalance(total: Self.rounded(total, currency: base), currency: base, unconverted: apart)
    }

    // MARK: - Categories

    @discardableResult
    public func createCategory(_ draft: CategoryDraft) throws -> UUID {
        guard draft.isValid else { throw CatalogError.invalidName }
        if let parentId = draft.parentId {
            try validateParent(parentId, kind: draft.kind, child: nil)
        }
        try assertNameFree(draft.trimmedName, kind: draft.kind, parentId: draft.parentId, except: nil)
        let siblings = try liveCategories().filter { $0.type == draft.kind.rawValue && $0.parentId == draft.parentId }
        let id = UUID()
        let record = CategoryRecord(
            id: id, type: draft.kind.rawValue, name: draft.trimmedName, icon: draft.icon, color: draft.color,
            parentId: draft.parentId, sortOrder: (siblings.map(\.sortOrder).max() ?? -1) + 1
        )
        context.insert(record)
        try sync.store(.make("category.create", recordId: id, data: CategoryCreateBody(record)))
        try finish()
        return id
    }

    /// Name, icon, color and parent of an own category.
    public func updateCategory(_ id: UUID, with draft: CategoryDraft) throws {
        let record = try category(id)
        guard !record.isSystem else { throw CatalogError.systemReadonly }
        guard draft.isValid else { throw CatalogError.invalidName }
        let kind = CategoryKind(rawValue: record.type) ?? .expense
        if let parentId = draft.parentId, parentId != record.parentId {
            try validateParent(parentId, kind: kind, child: id)
        }
        try assertNameFree(draft.trimmedName, kind: kind, parentId: draft.parentId, except: id)
        record.name = draft.trimmedName
        record.icon = draft.icon
        record.color = draft.color
        record.parentId = draft.parentId
        record.updatedAt = .now
        try sync.store(.make("category.update", id: id, data: CategoryUpdateBody(record)))
        try finish()
    }

    /// Archived categories keep their operations and leave quick add; system ones too.
    public func setArchived(category id: UUID, _ archived: Bool) throws {
        let record = try category(id)
        guard record.isArchived != archived else { return }
        record.isArchived = archived
        record.updatedAt = .now
        try sync.store(.make("category.update", id: id, data: ["isArchived": archived]))
        try finish()
    }

    /// Only an own category without subcategories that no operation uses; the rest are archived.
    public func deleteCategory(_ id: UUID) throws {
        let record = try category(id)
        guard !record.isSystem else { throw CatalogError.systemReadonly }
        if try hasChildren(id) { throw CatalogError.hasChildren }
        if try isUsed(category: id) { throw CatalogError.inUse }
        record.deletedAt = .now
        try sync.store(.make("category.delete", id: id))
        try finish()
    }

    public func canDelete(category id: UUID) throws -> Bool {
        let record = try category(id)
        return try !record.isSystem && !hasChildren(id) && !isUsed(category: id)
    }

    /// Drag-and-drop order within one list (top-level categories, or one category's subcategories).
    public func reorderCategories(_ ids: [UUID]) throws {
        guard !ids.isEmpty else { return }
        let byId = Dictionary(try liveCategories().map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for (index, id) in ids.enumerated() {
            byId[id]?.sortOrder = index
        }
        try sync.store(.make("category.reorder", data: ["ids": ids]))
        try finish()
    }

    public func draft(for record: CategoryRecord) -> CategoryDraft {
        CategoryDraft(
            kind: CategoryKind(rawValue: record.type) ?? .expense, name: record.name,
            icon: record.icon, color: record.color, parentId: record.parentId
        )
    }

    // MARK: - Details

    private func finish() throws {
        try context.save()
        Task { await sync.sync() }
    }

    private func liveAccounts() throws -> [AccountRecord] {
        try context.fetch(FetchDescriptor<AccountRecord>(
            predicate: #Predicate { $0.deletedAt == nil },
            sortBy: [SortDescriptor(\.sortOrder)]
        ))
    }

    private func liveCategories() throws -> [CategoryRecord] {
        try context.fetch(FetchDescriptor<CategoryRecord>(predicate: #Predicate { $0.deletedAt == nil }))
    }

    private func account(_ id: UUID) throws -> AccountRecord {
        guard let record = try context.fetch(FetchDescriptor<AccountRecord>(
            predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
        )).first else { throw CatalogError.notFound }
        return record
    }

    private func category(_ id: UUID) throws -> CategoryRecord {
        guard let record = try context.fetch(FetchDescriptor<CategoryRecord>(
            predicate: #Predicate { $0.id == id && $0.deletedAt == nil }
        )).first else { throw CatalogError.notFound }
        return record
    }

    private var settings: SettingsRecord? {
        try? context.fetch(FetchDescriptor<SettingsRecord>()).first
    }

    private func setDefaultLocally(_ record: AccountRecord) throws {
        for other in try liveAccounts() where other.isDefault && other.id != record.id {
            other.isDefault = false
        }
        record.isDefault = true
        settings?.defaultAccountId = record.id
    }

    /// The next active account by order becomes the default one, as the server does.
    private func reassignDefault(leaving id: UUID) throws {
        let next = try liveAccounts().first { $0.id != id && !$0.isArchived }
        if let next {
            try setDefaultLocally(next)
        } else {
            settings?.defaultAccountId = nil
        }
    }

    private func lastRate(from currency: String, to base: String) throws -> Decimal? {
        var descriptor = FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.currency == currency && $0.baseCurrency == base },
            sortBy: [SortDescriptor(\.occurredAt, order: .reverse)]
        )
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first?.fxRate
    }

    private func hasChildren(_ id: UUID) throws -> Bool {
        let parent: UUID? = id
        return try context.fetchCount(FetchDescriptor<CategoryRecord>(
            predicate: #Predicate { $0.parentId == parent && $0.deletedAt == nil }
        )) > 0
    }

    private func isUsed(category id: UUID) throws -> Bool {
        let category: UUID? = id
        return try context.fetchCount(FetchDescriptor<TransactionRecord>(
            predicate: #Predicate { $0.categoryId == category && $0.deletedAt == nil }
        )) > 0
    }

    /// A parent is a top-level category of the same type; a category with subcategories stays on top.
    private func validateParent(_ parentId: UUID, kind: CategoryKind, child: UUID?) throws {
        guard parentId != child, let parent = try? category(parentId),
              parent.parentId == nil, parent.type == kind.rawValue
        else { throw CatalogError.invalidParent }
        if let child, try hasChildren(child) { throw CatalogError.hasChildren }
    }

    /// Own categories of a type are unique by name among siblings, ignoring case.
    private func assertNameFree(_ name: String, kind: CategoryKind, parentId: UUID?, except: UUID?) throws {
        let taken = try liveCategories().contains {
            !$0.isSystem && $0.id != except && $0.type == kind.rawValue && $0.parentId == parentId
                && $0.name.compare(name, options: [.caseInsensitive]) == .orderedSame
        }
        if taken { throw CatalogError.nameTaken }
    }

    static func rounded(_ value: Decimal, currency: String) -> Decimal {
        var value = value
        var result = Decimal()
        NSDecimalRound(&result, &value, Money.fractionDigits(for: currency), .plain)
        return result
    }

    // MARK: - Bodies

    /// `POST /v1/accounts`
    private struct AccountCreateBody: Encodable, Sendable {
        let id: UUID
        let name: String
        let type: String
        let currency: String
        let initialBalance: String
        let icon: String?
        let color: String?
        let includeInTotal: Bool

        init(_ record: AccountRecord) {
            id = record.id
            name = record.name
            type = record.type
            currency = record.currency
            initialBalance = NSDecimalNumber(decimal: record.initialBalance).stringValue
            icon = record.icon
            color = record.color
            includeInTotal = record.includeInTotal
        }
    }

    /// `PATCH /v1/accounts/:id` with every field the editor shows.
    private struct AccountUpdateBody: Encodable, Sendable {
        let name: String
        let type: String
        let currency: String
        let initialBalance: String
        let icon: String?
        let color: String?
        let includeInTotal: Bool

        init(_ record: AccountRecord) {
            name = record.name
            type = record.type
            currency = record.currency
            initialBalance = NSDecimalNumber(decimal: record.initialBalance).stringValue
            icon = record.icon
            color = record.color
            includeInTotal = record.includeInTotal
        }
    }

    /// `POST /v1/categories`
    private struct CategoryCreateBody: Encodable, Sendable {
        let id: UUID
        let type: String
        let name: String
        let icon: String
        let color: String
        let parentId: UUID?

        init(_ record: CategoryRecord) {
            id = record.id
            type = record.type
            name = record.name
            icon = record.icon
            color = record.color
            parentId = record.parentId
        }
    }

    /// `PATCH /v1/categories/:id`; a null parent moves a subcategory to the top level.
    private struct CategoryUpdateBody: Encodable, Sendable {
        let name: String
        let icon: String
        let color: String
        let parentId: UUID?

        init(_ record: CategoryRecord) {
            name = record.name
            icon = record.icon
            color = record.color
            parentId = record.parentId
        }

        enum CodingKeys: String, CodingKey {
            case name, icon, color, parentId
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(name, forKey: .name)
            try container.encode(icon, forKey: .icon)
            try container.encode(color, forKey: .color)
            try container.encode(parentId, forKey: .parentId)
        }
    }
}

/// What the accounts add up to in the base currency.
public struct AccountsBalance: Equatable, Sendable {
    public let total: Decimal
    public let currency: String
    /// Accounts in currencies with no known rate yet, summed per currency
    public let unconverted: [String: Decimal]
}
