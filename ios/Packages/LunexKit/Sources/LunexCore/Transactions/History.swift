import Foundation

/// Search and filters of the operations history; they combine.
public struct HistoryFilter: Equatable, Sendable {
    public enum Period: String, CaseIterable, Sendable {
        case all, thisMonth, lastMonth, last30Days
    }

    public var kind: TransactionKind?
    /// Matches both sides of a transfer
    public var accountId: UUID?
    /// Includes its subcategories
    public var categoryId: UUID?
    public var period = Period.all
    /// Note, merchant, category name, or an amount («45000», «45 000»)
    public var query = ""

    public init() {}

    /// Anything narrowed down besides the search text.
    public var hasFilters: Bool {
        kind != nil || accountId != nil || categoryId != nil || period != .all
    }

    /// The period's dates; nil for all time.
    public func interval(now: Date, calendar: Calendar) -> DateInterval? {
        switch period {
        case .all:
            return nil
        case .thisMonth:
            return calendar.dateInterval(of: .month, for: now)
        case .lastMonth:
            guard let previous = calendar.date(byAdding: .month, value: -1, to: now) else { return nil }
            return calendar.dateInterval(of: .month, for: previous)
        case .last30Days:
            let start = calendar.startOfDay(for: calendar.date(byAdding: .day, value: -29, to: now) ?? now)
            return DateInterval(start: start, end: calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) ?? now)
        }
    }
}

/// One day of the history with its total in the base currency (income minus expenses).
public struct HistoryDay: Identifiable, Equatable {
    public let date: Date
    public let total: Decimal
    public let items: [TransactionRecord]

    public var id: Date { date }

    public static func == (lhs: HistoryDay, rhs: HistoryDay) -> Bool {
        lhs.date == rhs.date && lhs.total == rhs.total && lhs.items.map(\.id) == rhs.items.map(\.id)
    }
}

public enum History {
    /// Live operations matching the filter, newest first, grouped by day.
    public static func days(
        _ records: [TransactionRecord],
        filter: HistoryFilter,
        categories: [UUID: CategoryRecord],
        language: String,
        calendar: Calendar = .current,
        now: Date = .now
    ) -> [HistoryDay] {
        let interval = filter.interval(now: now, calendar: calendar)
        let categoryIds = filter.categoryId.map { id in
            Set([id] + categories.values.filter { $0.parentId == id }.map(\.id))
        }
        let search = Search(filter.query)
        let matching = records.filter { record in
            guard record.deletedAt == nil else { return false }
            if let kind = filter.kind, record.type != kind.rawValue { return false }
            if let account = filter.accountId, record.accountId != account, record.transferAccountId != account {
                return false
            }
            if let ids = categoryIds {
                guard let category = record.categoryId, ids.contains(category) else { return false }
            }
            if let interval, !interval.contains(record.occurredAt) || record.occurredAt == interval.end {
                return false
            }
            return search.matches(record, category: record.categoryId.flatMap { categories[$0] }, language: language)
        }
        .sorted { $0.occurredAt > $1.occurredAt }

        var days: [HistoryDay] = []
        var current: (date: Date, items: [TransactionRecord])?
        for record in matching {
            let day = calendar.startOfDay(for: record.occurredAt)
            if current?.date != day {
                if let current { days.append(Self.day(current.date, current.items)) }
                current = (day, [])
            }
            current?.items.append(record)
        }
        if let current { days.append(Self.day(current.date, current.items)) }
        return days
    }

    private static func day(_ date: Date, _ items: [TransactionRecord]) -> HistoryDay {
        let total = items.reduce(Decimal(0)) { sum, record in
            switch record.type {
            case "income": sum + record.amountBase
            case "expense": sum - record.amountBase
            default: sum
            }
        }
        return HistoryDay(date: date, total: total, items: items)
    }

    private struct Search {
        let words: String
        /// The query as an amount, when it is one («45 000» → 45000)
        let amount: Decimal?

        init(_ query: String) {
            words = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let digits = words.filter { !$0.isWhitespace }.replacingOccurrences(of: ",", with: ".")
            amount = digits.isEmpty ? nil : Decimal.exact(digits)
        }

        func matches(_ record: TransactionRecord, category: CategoryRecord?, language: String) -> Bool {
            guard !words.isEmpty else { return true }
            if let amount, record.amount == amount || record.amountBase == amount { return true }
            let fields = [record.note, record.merchant, category?.displayName(language: language)]
            return fields.contains { $0?.lowercased().contains(words) == true }
        }
    }
}

extension CategoryRecord {
    /// A system category's name in the app's language; own categories keep theirs.
    public func displayName(language: String) -> String {
        translations?[language] ?? name
    }

    /// The SF Symbol in its outline form: the design system draws monochrome outlines.
    public var outlineIcon: String {
        icon.replacingOccurrences(of: ".fill", with: "")
    }
}

public enum CategoryRanking {
    /// Categories for the quick-add grid: the most used in the last 90 days first, then the most
    /// recent, then the user's own order. Archived and deleted ones are left out.
    public static func ordered(
        _ categories: [CategoryRecord],
        kind: TransactionKind,
        transactions: [TransactionRecord],
        now: Date = .now
    ) -> [CategoryRecord] {
        let since = now.addingTimeInterval(-90 * 24 * 3600)
        var uses: [UUID: (count: Int, last: Date)] = [:]
        for record in transactions where record.deletedAt == nil && record.occurredAt >= since {
            guard let id = record.categoryId else { continue }
            let previous = uses[id] ?? (0, .distantPast)
            uses[id] = (previous.count + 1, max(previous.last, record.occurredAt))
        }
        return categories
            .filter { $0.type == kind.rawValue && !$0.isArchived && $0.deletedAt == nil }
            .sorted { lhs, rhs in
                let left = uses[lhs.id] ?? (0, .distantPast)
                let right = uses[rhs.id] ?? (0, .distantPast)
                if left.count != right.count { return left.count > right.count }
                if left.last != right.last { return left.last > right.last }
                return lhs.sortOrder < rhs.sortOrder
            }
    }
}
