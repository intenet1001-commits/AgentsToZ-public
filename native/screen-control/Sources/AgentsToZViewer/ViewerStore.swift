#if os(macOS)
import Foundation
import ScreenControlCore
import Security

/// The Viewer's `targets` item (docs/design/mac-to-mac-2026-11-01/DESIGN.md 7.4): one generic password in the Viewer's
/// own data-protection keychain group, readable only while this Mac is unlocked, on this Mac only, never synchronised.
/// No file holds any of it. `ViewerTargetsLedger` decides what may be written; this only moves bytes.
struct KeychainTargets: ViewerTargetsBackend {
    static let accessGroup = "DA8QKAQ2C9.com.intenet.agentstozbycs.viewer"
    static let service = "com.intenet.agentstozbycs.viewer"
    static let account = "targets"
    private let itemAccount: String
    init(account: String = Self.account) { itemAccount = account }

    struct KeychainError: Error, CustomStringConvertible {
        let status: OSStatus
        var description: String { "keychain \(status): \(SecCopyErrorMessageString(status, nil) as String? ?? "")" }
    }

    private func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: itemAccount,
         kSecAttrAccessGroup as String: Self.accessGroup,
         kSecAttrSynchronizable as String: false,
         kSecUseDataProtectionKeychain as String: true]
    }

    func read() throws -> Data? {
        var query = query()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { throw KeychainError(status: errSecDecode) }
            return data
        case errSecItemNotFound:
            return nil
        default:
            // Locked, a missing entitlement, anything else: never "nothing stored".
            throw KeychainError(status: status)
        }
    }

    func write(_ data: Data) throws {
        let attributes: [String: Any] = [kSecValueData as String: data,
                                         kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query().merging(attributes) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
            return
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
}
#endif
