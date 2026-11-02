import Foundation
import CoreFoundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif
private func receiveHex(_ text: String, count: Int) -> Bool { text.utf8.count == count && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }

/// The trusted Main constructs this caller from the authenticated peer. A display name is never a policy identity.
public struct CommunityReceivePeer: Equatable, Sendable {
    public let deviceID: String, instance: String
    public static func parse(sessionID: String) -> Self? {
        let fields = sessionID.split(separator: "_", omittingEmptySubsequences: false).map(String.init)
        guard fields.count == 4, fields[0] == "rcu", CommunityControlLease.validID(fields[1]),
              receiveHex(fields[2], count: 32), CommunityControlLease.validID(fields[3]) else { return nil }
        return Self(deviceID: fields[1].lowercased(), instance: fields[2])
    }
}
public struct CommunityReceiveBlock: Codable, Equatable, Sendable {
    public let deviceID: String, instance: String
    public let until: Int64
    public var valid: Bool { CommunityControlLease.validID(deviceID) && deviceID == deviceID.lowercased() && receiveHex(instance, count: 32) && until > 0 && until <= 9_007_199_254_650_991 }
}
public struct CommunityReceiveChange: Equatable, Sendable {
    public let enable: Bool
    public let unblockDevices: [String]
    public let block: CommunityReceiveBlock?
    public let blockDevice: String?
    public let disable: Bool
    public static func decode(_ raw: [String: Any], restoring: Bool, now: Int64) throws -> Self {
        guard now >= 0, now <= 9_007_199_168_000_000 else { throw ControlError.invalid }
        if let value = raw["allowRemote"] { guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw ControlError.invalid } }
        let keys = Set(raw.keys)
        if restoring {
            guard keys.isSubset(of: ["allowRemote", "unblockDevices"]), !keys.isEmpty,
                  raw["allowRemote"] == nil || (raw["allowRemote"] as? Bool) == true else { throw ControlError.invalid }
            let devices = (raw["unblockDevices"] as? [String] ?? []).map { $0.lowercased() }
            guard raw["unblockDevices"] == nil || raw["unblockDevices"] is [String], devices.count <= 64,
                  Set(devices).count == devices.count, devices.allSatisfy(CommunityControlLease.validID),
                  (raw["allowRemote"] as? Bool) == true || !devices.isEmpty else { throw ControlError.invalid }
            return Self(enable: raw["allowRemote"] as? Bool == true, unblockDevices: devices.sorted(), block: nil, blockDevice: nil, disable: false)
        }
        guard keys.isSubset(of: ["allowRemote", "block"]), !keys.isEmpty,
              raw["allowRemote"] == nil || (raw["allowRemote"] as? Bool) == false else { throw ControlError.invalid }
        var block: CommunityReceiveBlock?, device: String?
        if let value = raw["block"] {
            guard let b = value as? [String: Any], Set(b.keys).isSubset(of: ["deviceId", "connection", "minutes"]),
                  let id = b["deviceId"] as? String, CommunityControlLease.validID(id) else { throw ControlError.invalid }
            if let instance = b["connection"] as? String {
                let minutes: Int64
                if let rawMinutes = b["minutes"] { guard let n = CommunityControlLease.integer(rawMinutes), n >= 1, n <= 1440 else { throw ControlError.invalid }; minutes = n } else { minutes = 30 }
                let proposed = CommunityReceiveBlock(deviceID: id.lowercased(), instance: instance, until: now + minutes * 60_000)
                guard proposed.valid else { throw ControlError.invalid }; block = proposed
            } else { guard b["connection"] == nil, b["minutes"] == nil else { throw ControlError.invalid }; device = id.lowercased() }
        }
        guard raw["allowRemote"] != nil || block != nil || device != nil else { throw ControlError.invalid }
        return Self(enable: false, unblockDevices: [], block: block, blockDevice: device, disable: raw["allowRemote"] as? Bool == false)
    }
}
/// A separate Control-only Keychain record survives older binding writers. It contains no key or bearer credential.
public struct CommunityReceivePolicy: Codable, Equatable, Sendable {
    public let version: Int
    public private(set) var revision: Int64
    public private(set) var bindingKey: String?
    public private(set) var allowRemote: Bool
    public private(set) var blockedDevices: [String]
    public private(set) var blockedConnections: [CommunityReceiveBlock]
    public init(bindingKey: String?, allowRemote: Bool, revision: Int64 = 1) {
        version = 1; self.revision = revision; self.bindingKey = bindingKey; self.allowRemote = allowRemote
        blockedDevices = []; blockedConnections = []
    }
    public var valid: Bool {
        version == 1 && revision >= 1 && revision < 9_007_199_254_650_000
        && (bindingKey.map { receiveHex($0, count: 64) } ?? true)
        && blockedDevices.count <= 64 && Set(blockedDevices).count == blockedDevices.count && blockedDevices.allSatisfy { CommunityControlLease.validID($0) && $0 == $0.lowercased() }
        && blockedConnections.count <= 256 && blockedConnections.allSatisfy(\.valid)
        && Set(blockedConnections.map { $0.deviceID + ":" + $0.instance }).count == blockedConnections.count
    }
    public func allows(_ peer: CommunityReceivePeer, bindingKey: String, now: Int64) -> Bool {
        valid && self.bindingKey == bindingKey && allowRemote && !blockedDevices.contains(peer.deviceID)
        && !blockedConnections.contains { $0.deviceID == peer.deviceID && $0.instance == peer.instance && $0.until > now }
    }
    public func changing(_ change: CommunityReceiveChange, bindingKey: String?, now: Int64, restoring: Bool) throws -> Self {
        guard valid else { throw ControlError.invalid }
        var next = self; next.revision += 1
        // A different enrollment/epoch can inherit restrictions, never a positive allowance.
        if next.bindingKey != bindingKey { next.bindingKey = bindingKey; next.allowRemote = false }
        next.blockedConnections.removeAll { $0.until <= now }
        if restoring {
            guard let bindingKey, bindingKey.count == 64 else { throw ControlError.invalid }
            if change.enable { next.allowRemote = true }
            next.blockedDevices.removeAll { change.unblockDevices.contains($0) }
            next.blockedConnections.removeAll { change.unblockDevices.contains($0.deviceID) }
        } else {
            guard !change.enable && change.unblockDevices.isEmpty else { throw ControlError.invalid }
            if change.disable { next.allowRemote = false }
            if let id = change.blockDevice, !next.blockedDevices.contains(id) { next.blockedDevices.append(id); next.blockedDevices.sort() }
            if let b = change.block { next.blockedConnections.removeAll { $0.deviceID == b.deviceID && $0.instance == b.instance }; next.blockedConnections.append(b) }
        }
        guard next.valid else { throw ControlError.refuse("receive-policy-capacity") }; return next
    }
    public var json: [String: Any] { ["revision": revision, "allowRemote": allowRemote, "blockedDevices": blockedDevices,
        "blockedConnections": blockedConnections.map { ["deviceId": $0.deviceID, "instance": $0.instance, "until": $0.until] as [String: Any] }] }
}
public enum CommunityReceiveStorage {
    public static let marker = Data("agentstoz.receive-policy-ready/v1".utf8)
    public static func decode(policy: Data?, marker: Data?) throws -> CommunityReceivePolicy? {
        if policy == nil && marker == nil { return nil }
        guard marker == self.marker, let policy, policy.count <= 65_536,
              let value = try? JSONDecoder().decode(CommunityReceivePolicy.self, from: policy), value.valid else { throw ControlError.refuse("receive-store-unavailable") }
        return value
    }
}
/// Positive restoration is never committed by a caller boolean. The App invokes approve only after OS authentication.
public final class CommunityReceiveState {
    public private(set) var policy: CommunityReceivePolicy?
    public private(set) var failed = false
    public init(policy: CommunityReceivePolicy?) throws { guard policy?.valid != false else { throw ControlError.invalid }; self.policy = policy }
    public func bootstrap(bindingKey: String, legacyRestricted: Bool, save: (CommunityReceivePolicy) throws -> Void) throws {
        guard !failed else { throw ControlError.refuse("receive-store-unavailable") }
        guard policy == nil else { return }
        let next = CommunityReceivePolicy(bindingKey: bindingKey, allowRemote: !legacyRestricted)
        do { try save(next); policy = next } catch { failed = true; throw error }
    }
    public func restrict(_ change: CommunityReceiveChange, bindingKey: String?, now: Int64, save: (CommunityReceivePolicy) throws -> Void) throws {
        guard !failed else { throw ControlError.refuse("receive-store-unavailable") }
        let base = policy ?? CommunityReceivePolicy(bindingKey: bindingKey, allowRemote: false, revision: 1)
        let next = try base.changing(change, bindingKey: bindingKey, now: now, restoring: false)
        policy = next // Stop in RAM before the durable commit. Caller also ends remote grants before this method.
        do { try save(next) } catch { failed = true; throw error }
    }
    public func approve(_ change: CommunityReceiveChange, expectedRevision: Int64, bindingKey: String, now: Int64,
                        save: (CommunityReceivePolicy) throws -> Void) throws {
        guard !failed, (policy?.revision ?? 0) == expectedRevision else { throw ControlError.refuse("receive-policy-changed") }
        let base = policy ?? CommunityReceivePolicy(bindingKey: bindingKey, allowRemote: false, revision: 1)
        let next = try base.changing(change, bindingKey: bindingKey, now: now, restoring: true)
        try save(next); policy = next
    }
}
