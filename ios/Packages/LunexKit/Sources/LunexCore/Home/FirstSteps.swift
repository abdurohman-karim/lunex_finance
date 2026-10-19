import Foundation
import Observation

/// One item of «Первые шаги» on the home screen (it replaces the bot's adaptive menu).
public enum FirstStep: String, CaseIterable, Sendable {
    /// Record the first operation
    case operation
    /// Create a goal
    case goal
    /// Look at the budget (or set one up)
    case budget
    /// Add a home-screen widget
    case widget
}

/// What is done of «Первые шаги». The checklist leaves the home screen once everything is
/// done, or when the user hides it.
public struct FirstStepsProgress: Equatable, Sendable {
    public let items: [FirstStep]
    public let done: Set<FirstStep>

    public init(
        hasOperation: Bool, hasGoal: Bool, budgetSeen: Bool, hasWidget: Bool, widgetsAvailable: Bool
    ) {
        // Widgets arrive with their own build step; until then the item is not offered.
        items = FirstStep.allCases.filter { $0 != .widget || widgetsAvailable }
        var done = Set<FirstStep>()
        if hasOperation { done.insert(.operation) }
        if hasGoal { done.insert(.goal) }
        if budgetSeen { done.insert(.budget) }
        if hasWidget { done.insert(.widget) }
        self.done = done.intersection(items)
    }

    public var doneCount: Int { done.count }
    public var isComplete: Bool { done.count == items.count }

    /// The first step still to do: the one the card suggests.
    public var next: FirstStep? { items.first { !done.contains($0) } }
}

/// Remembers, per account, what the server does not know: that the budget screen was seen
/// and that the checklist was hidden.
@MainActor
@Observable
public final class FirstStepsStore {
    private var budgetSeen: Set<String>
    private var dismissed: Set<String>
    @ObservationIgnored private let defaults: UserDefaults
    private static let budgetKey = "lunex.firstSteps.budgetSeen"
    private static let dismissedKey = "lunex.firstSteps.dismissed"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        budgetSeen = Set(defaults.stringArray(forKey: Self.budgetKey) ?? [])
        dismissed = Set(defaults.stringArray(forKey: Self.dismissedKey) ?? [])
    }

    public func hasSeenBudget(_ user: UUID) -> Bool {
        budgetSeen.contains(user.uuidString)
    }

    public func markBudgetSeen(_ user: UUID) {
        guard budgetSeen.insert(user.uuidString).inserted else { return }
        defaults.set(Array(budgetSeen), forKey: Self.budgetKey)
    }

    public func isDismissed(_ user: UUID) -> Bool {
        dismissed.contains(user.uuidString)
    }

    public func dismiss(_ user: UUID) {
        guard dismissed.insert(user.uuidString).inserted else { return }
        defaults.set(Array(dismissed), forKey: Self.dismissedKey)
    }
}
