import CryptoKit
import Foundation
import ScreenControlCore
import Security

/// A Mac this device registered for screen control: the Mac key pinned from its QR, where to find it, and this
/// device's Secure Enclave key for it (usable only here, only after Face ID).
struct SavedScreenMac: Codable, Identifiable, Hashable {
    /// Hex of the Mac fingerprint.
    let id: String
    let macName: String
    let macPublicKey: Data
    let hostName: String
    var address: String
    let port: UInt16
    let deviceKey: Data
    let deviceName: String
    let registeredAt: Date

    var pinned: PinnedMac? {
        guard let key = try? P256.Signing.PublicKey(x963Representation: macPublicKey) else { return nil }
        return try? PinnedMac(publicKey: key, fingerprint: ScreenControlIdentity.fingerprint(of: key))
    }
}

/// The registered Macs, in this device's keychain only: never synced, readable while unlocked.
enum ScreenMacStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.intenet.agentstoz.mobile.screen-macs",
         kSecAttrAccount as String: "macs",
         kSecAttrSynchronizable as String: false]
    }

    static func load() -> [SavedScreenMac] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return [] }
        return (try? JSONDecoder().decode([SavedScreenMac].self, from: data)) ?? []
    }

    static func save(_ macs: [SavedScreenMac]) throws {
        let data = try JSONEncoder().encode(macs)
        SecItemDelete(query as CFDictionary)
        guard !macs.isEmpty else { return }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}
