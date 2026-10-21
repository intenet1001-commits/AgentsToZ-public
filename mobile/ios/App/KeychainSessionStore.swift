import Foundation
import Security
import AgentsToZCore

/// Keeps the resumable session token across launches.
///
/// This is the phone's half of the contract the Mac already keeps: the host holds a paired
/// session for 30 days so a locked phone can come back, and holding nothing here meant every
/// screen lock cost a walk to the Mac for a new QR — a consumed QR cannot be scanned twice.
///
/// The QR's own pairing token is still never stored; that one is single use. What is stored is
/// the session token the host issued to this device, scoped to the Mac's origin, with
/// `kSecAttrAccessibleAfterFirstUnlock` so a reboot does not silently drop it while still
/// requiring the device to have been unlocked once. `kSecAttrSynchronizable = false` keeps it off
/// iCloud: it authorizes one device on one private network, and nowhere else should hold it.
public struct KeychainSessionStore: RemoteSessionStore {
    private let service = "com.intenet.agentstoz.mobile.lan-session"

    public init() {}

    private func query(_ origin: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
            kSecAttrSynchronizable as String: false,
        ]
    }

    public func token(origin: String) -> String? {
        var request = query(origin)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, data.count <= 256,
              let value = String(data: data, encoding: .utf8) else { return nil }
        return value
    }

    public func save(token: String, origin: String) {
        // Replace rather than update-or-insert: one device holds at most one session per Mac, and
        // a stale entry would be resumed instead of the current one.
        SecItemDelete(query(origin) as CFDictionary)
        var request = query(origin)
        request[kSecValueData as String] = Data(token.utf8)
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(request as CFDictionary, nil)
    }

    public func clear(origin: String) {
        SecItemDelete(query(origin) as CFDictionary)
    }
}
