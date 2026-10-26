#if os(macOS)
import CryptoKit
import Foundation
import os
import ScreenControlCore
import Security

/// A device the person approved at this Mac (DESIGN 「등록 목록」).
public struct RegisteredDevice: Codable, Sendable, Identifiable, Hashable, ExpiringRegistration {
    /// Hex of the device fingerprint: SHA-256 of its public key.
    public let id: String
    public let publicKey: Data
    public let name: String
    public let model: String
    public let attestationKeyID: Data
    public let registeredAt: Date
    public var lastConnectedAt: Date?

    public init(record: RegistrationRecord, attestationKeyID: Data, at date: Date = Date()) {
        id = record.deviceID.map { String(format: "%02x", $0) }.joined()
        publicKey = record.devicePublicKey.x963Representation
        name = record.deviceName
        model = record.deviceModel
        self.attestationKeyID = attestationKeyID
        registeredAt = date
    }

    /// When it expires unless used before then (SR-13: 90 days without use).
    public var expiresAt: Date { RegistrationLifetime.expiry(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt) }

    public func isExpired(at now: Date = Date()) -> Bool {
        RegistrationLifetime.isExpired(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt, at: now)
    }
}

public enum ScreenStoreError: Error, Sendable {
    case keychain(OSStatus), corrupt
}

/// The identity key and the registered devices, where only AgentsToZ Screen can reach them: data-protection keychain
/// items in the app's own access group, which its provisioning profile grants and no other app's signature can claim
/// (DESIGN 「보안 원칙」 2·3). Never a file: another process of the same user could put its own key in a file.
public struct ScreenStore: Sendable {
    static let accessGroup = "DA8QKAQ2C9.com.intenet.agentstozbycs.screen"
    static let service = "com.intenet.agentstozbycs.screen"

    public init() {}

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Self.service,
         kSecAttrAccount as String: account,
         kSecAttrAccessGroup as String: Self.accessGroup,
         kSecUseDataProtectionKeychain as String: true,
         kSecAttrSynchronizable as String: false]
    }

    func read(_ account: String) throws -> Data? {
        var request = query(account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw ScreenStoreError.keychain(status) }
        return data
    }

    func write(_ account: String, _ data: Data) throws {
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw ScreenStoreError.keychain(status) }
        var request = query(account)
        request[kSecValueData as String] = data
        // Readable after the first unlock, so a locked Mac can still answer a registered phone (DESIGN S0-2).
        request[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(request as CFDictionary, nil)
        guard added == errSecSuccess else { throw ScreenStoreError.keychain(added) }
    }

    /// The Mac identity key, made once in the Secure Enclave. Only its blob is stored; it works on this Mac only.
    public func identity() throws -> SecureEnclaveTranscriptSigner {
        if let blob = try read("identity") { return try SecureEnclaveTranscriptSigner(dataRepresentation: blob) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                           .privateKeyUsage, &error) else {
            throw error.map { $0.takeRetainedValue() as Error } ?? ScreenStoreError.corrupt
        }
        let blob = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access).dataRepresentation
        try write("identity", blob)
        return try SecureEnclaveTranscriptSigner(dataRepresentation: blob)
    }

    /// One row per device, also from a store that holds two for one key (re-registering appended a row before it
    /// replaced one), so the menu, each connection and the key exchange agree on its expiry. The next save stores it so.
    public func devices() throws -> [RegisteredDevice] {
        guard let data = try read("devices") else { return [] }
        guard let devices = try? JSONDecoder().decode([RegisteredDevice].self, from: data) else { throw ScreenStoreError.corrupt }
        return devices.oneRowPerDevice()
    }

    public func save(_ devices: [RegisteredDevice]) throws {
        try write("devices", try JSONEncoder().encode(devices))
    }

    /// The networks approved at this Mac (결정 4), one row per network and at most `NetworkApproval.limit`. A row that
    /// names no valid router is discarded without losing the other approvals. Only its count is reported.
    public func networks(onDiscarded: (Int) -> Void = { _ in }) throws -> [ApprovedNetwork] {
        guard let data = try read("networks") else { return [] }
        let loaded = try Self.decodeNetworks(data)
        if loaded.discardedCount > 0 { onDiscarded(loaded.discardedCount) }
        return loaded.networks
    }

    static func decodeNetworks(_ data: Data) throws -> (networks: [ApprovedNetwork], discardedCount: Int) {
        guard let rows = try? JSONDecoder().decode(NetworkRows.self, from: data) else { throw ScreenStoreError.corrupt }
        return (NetworkApproval.normalized(rows.networks), rows.discardedCount)
    }

    private struct NetworkRows: Decodable {
        var networks: [ApprovedNetwork] = []
        var discardedCount = 0
        init(from decoder: Decoder) throws {
            var rows = try decoder.unkeyedContainer()
            while !rows.isAtEnd {
                let row = try rows.superDecoder()
                do { networks.append(try ApprovedNetwork(from: row)) }
                catch { discardedCount += 1 }
            }
        }
    }

    public func saveNetworks(_ networks: [ApprovedNetwork]) throws {
        try write("networks", try JSONEncoder().encode(NetworkApproval.normalized(networks)))
    }
}

extension RegisteredDeviceKeys {
    /// The registry as the key exchange sees it: each device's key with the dates its expiry follows from. A row whose
    /// key does not parse is left out, so it can never connect.
    func set(_ devices: [RegisteredDevice]) {
        set(devices.compactMap { device in
            (try? P256.Signing.PublicKey(x963Representation: device.publicKey)).map {
                Entry(publicKey: $0, registeredAt: device.registeredAt, lastConnectedAt: device.lastConnectedAt)
            }
        })
    }
}
#endif
