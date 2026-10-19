import Foundation
import Security
import Synchronization

/// Small secrets that must survive app restarts: the refresh token and the device id.
public protocol SecureStore: Sendable {
    func string(for key: String) -> String?
    func set(_ value: String?, for key: String)
}

public enum SecureKey {
    public static let refreshToken = "refresh_token"
    public static let refreshTokenExpiresAt = "refresh_token_expires_at"
    public static let deviceId = "device_id"
}

/// iOS Keychain, readable after the first unlock and never synced to other devices.
public struct KeychainStore: SecureStore {
    private let service: String

    public init(service: String = "uz.lunex.finance") {
        self.service = service
    }

    public func string(for key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ value: String?, for key: String) {
        let query = baseQuery(key)
        SecItemDelete(query as CFDictionary)
        guard let value else { return }
        var attributes = query
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

/// For tests and SwiftUI previews.
public final class InMemorySecureStore: SecureStore {
    private let values = Mutex<[String: String]>([:])

    public init(_ initial: [String: String] = [:]) {
        values.withLock { $0 = initial }
    }

    public func string(for key: String) -> String? {
        values.withLock { $0[key] }
    }

    public func set(_ value: String?, for key: String) {
        values.withLock { $0[key] = value }
    }
}

/// The installation's id: created once, kept in the Keychain, sent with every sign-in.
public enum DeviceIdentity {
    public static func id(in store: SecureStore) -> UUID {
        if let stored = store.string(for: SecureKey.deviceId), let id = UUID(uuidString: stored) {
            return id
        }
        let id = UUID()
        store.set(id.uuidString.lowercased(), for: SecureKey.deviceId)
        return id
    }
}
