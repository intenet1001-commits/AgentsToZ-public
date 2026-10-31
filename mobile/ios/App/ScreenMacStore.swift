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
    var nearbyService: String? = nil
    var relay: ScreenRelayRoute? = nil
    var privateNetwork: ScreenPrivateNetworkRoute? = nil
    var authentication: ScreenDeviceAuthentication = .biometricsOnly

    var pinned: PinnedMac? {
        guard let key = try? P256.Signing.PublicKey(x963Representation: macPublicKey) else { return nil }
        return try? PinnedMac(publicKey: key, fingerprint: ScreenControlIdentity.fingerprint(of: key))
    }
}

extension SavedScreenMac {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        macName = try values.decode(String.self, forKey: .macName)
        macPublicKey = try values.decode(Data.self, forKey: .macPublicKey)
        hostName = try values.decode(String.self, forKey: .hostName)
        address = try values.decode(String.self, forKey: .address)
        port = try values.decode(UInt16.self, forKey: .port)
        deviceKey = try values.decode(Data.self, forKey: .deviceKey)
        deviceName = try values.decode(String.self, forKey: .deviceName)
        registeredAt = try values.decode(Date.self, forKey: .registeredAt)
        if let name = try? values.decode(String.self, forKey: .nearbyService), ScreenNearby.isValidServiceName(name) { nearbyService = name }
        // Optional Internet metadata must never destroy an otherwise valid nearby registration.
        if let candidate = try? values.decode(ScreenRelayRoute.self, forKey: .relay),
           let key = try? P256.Signing.PublicKey(x963Representation: macPublicKey),
           candidate.matches(fingerprint: ScreenControlIdentity.fingerprint(of: key)) { relay = candidate }
        privateNetwork = try? values.decode(ScreenPrivateNetworkRoute.self, forKey: .privateNetwork)
        authentication = try values.decodeIfPresent(ScreenDeviceAuthentication.self, forKey: .authentication) ?? .biometricsOnly
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

    private struct Rows: Decodable {
        var macs: [SavedScreenMac] = []
        var discarded = 0
        init(from decoder: Decoder) throws {
            var rows = try decoder.unkeyedContainer()
            while !rows.isAtEnd {
                let row = try rows.superDecoder()
                if let mac = try? SavedScreenMac(from: row) { macs.append(mac) } else { discarded += 1 }
            }
        }
    }

    static func load(onDiscarded: (Int) -> Void = { _ in }) -> [SavedScreenMac] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return [] }
        guard let rows = try? JSONDecoder().decode(Rows.self, from: data) else { onDiscarded(1); return [] }
        if rows.discarded > 0 { onDiscarded(rows.discarded) }
        return rows.macs
    }

    static func save(_ macs: [SavedScreenMac]) throws {
        let data = try JSONEncoder().encode(macs)
        guard !macs.isEmpty else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
            }
            return
        }
        let updated = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(updated)) }
        var request = query
        request[kSecValueData as String] = data
        request[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(request as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    /// Called synchronously on MainActor by every registration sheet, even when another view's list is stale.
    static func register(_ mac: SavedScreenMac) throws -> [SavedScreenMac] {
        try persistRegistrationMutation(read: { try loadForUpdate() }, write: { try save($0) }) { rows in
            var renewed = mac
            // A renewed key must not silently lose the explicit private-network route for this pinned Mac.
            if let previous = rows.first(where: { $0.id == mac.id && $0.deviceName == mac.deviceName }) {
                renewed.privateNetwork = mac.privateNetwork ?? previous.privateNetwork
            }
            rows.removeAll { $0.id == mac.id && $0.deviceName == mac.deviceName }
            rows.append(renewed)
        }
    }

    /// Mutations must not mistake a temporary Keychain error or a damaged row for an empty store and erase other
    /// registrations. The tolerant display reader above remains useful, but cannot authorize replacing the document.
    static func loadForUpdate() throws -> [SavedScreenMac] {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status == errSecSuccess ? errSecDecode : status))
        }
        let rows = try JSONDecoder().decode(Rows.self, from: data)
        guard rows.discarded == 0 else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(errSecDecode)) }
        return rows.macs
    }
}
