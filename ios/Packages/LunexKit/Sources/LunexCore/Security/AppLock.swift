import Foundation
import LocalAuthentication
import Observation

public enum BiometryKind: Sendable, Equatable {
    case faceID, touchID, opticID
    /// No biometrics: the device passcode
    case passcode
    /// Neither biometrics nor a passcode is set up: the lock cannot be turned on
    case unavailable
}

/// When the app locks: on launch, and after the set time in the background.
public enum LockPolicy {
    public static func shouldLock(enabled: Bool, lockAfterSeconds: Int, backgroundedAt: Date?, now: Date) -> Bool {
        guard enabled, let backgroundedAt else { return false }
        return now.timeIntervalSince(backgroundedAt) >= TimeInterval(max(0, lockAfterSeconds))
    }
}

/// Face ID / Touch ID / the device passcode in front of the app.
@MainActor
@Observable
public final class AppLock {
    public private(set) var isLocked: Bool
    public private(set) var isAuthenticating = false
    @ObservationIgnored private var enabled: Bool
    @ObservationIgnored private var lockAfterSeconds: Int
    @ObservationIgnored private var backgroundedAt: Date?

    /// Locked from the very first frame when the lock is on, so nothing shows before it.
    public init(enabled: Bool, lockAfterSeconds: Int = 60) {
        self.enabled = enabled
        self.lockAfterSeconds = lockAfterSeconds
        isLocked = enabled
    }

    /// The settings changed (here or on another iPhone).
    public func configure(enabled: Bool, lockAfterSeconds: Int) {
        self.enabled = enabled
        self.lockAfterSeconds = lockAfterSeconds
        if !enabled { isLocked = false }
    }

    public func didEnterBackground(now: Date = .now) {
        backgroundedAt = now
    }

    public func didBecomeActive(now: Date = .now) {
        if LockPolicy.shouldLock(enabled: enabled, lockAfterSeconds: lockAfterSeconds, backgroundedAt: backgroundedAt, now: now) {
            isLocked = true
        }
        backgroundedAt = nil
    }

    /// Signed out: nothing to protect.
    public func reset() {
        enabled = false
        isLocked = false
        backgroundedAt = nil
    }

    /// Asks for Face ID / Touch ID, falling back to the passcode. True when it succeeded.
    @discardableResult
    public func unlock(reason: String) async -> Bool {
        guard !isAuthenticating else { return false }
        isAuthenticating = true
        defer { isAuthenticating = false }
        let ok = await Self.authenticate(reason: reason)
        if ok { isLocked = false }
        return ok
    }

    /// What the device offers right now.
    public static var biometry: BiometryKind {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return .unavailable }
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        case .opticID: return .opticID
        default: return .passcode
        }
    }

    /// Confirms once before the lock is turned on, so nobody locks themselves out.
    public static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedFallbackTitle = nil
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
