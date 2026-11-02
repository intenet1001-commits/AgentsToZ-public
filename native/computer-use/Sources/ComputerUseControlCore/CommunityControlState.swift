import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// Stored only in Control's private Keychain. A candidate is not consent; the last revision fences rollback/local off.
public struct CommunityControlBinding: Codable, Equatable, Sendable {
    public let profileID: String, deviceID: String, publicKey: String
    public let agentDeviceID: String?
    public private(set) var communityID: String?, enrollmentID: String?, capabilities: Set<CommunityControlCapability>?
    public private(set) var revision: Int64 = 0, keyEpoch: Int64 = 0, newestIssuedAt: Int64 = 0
    public private(set) var disabledThroughRevision: Int64 = 0
    public private(set) var policyDigest: String?
    public init(profileID: String, deviceID: String, publicKey: String, agentDeviceID: String? = nil) {
        self.profileID = profileID; self.deviceID = deviceID; self.publicKey = publicKey; self.agentDeviceID = agentDeviceID
    }
    public var valid: Bool {
        CommunityControlLease.validID(profileID) && CommunityControlLease.validID(deviceID)
        && (agentDeviceID.map(CommunityControlLease.validID) ?? true)
        && revision >= 0 && keyEpoch >= 0 && newestIssuedAt >= 0 && disabledThroughRevision >= 0
        && (revision == 0 ? keyEpoch == 0 && policyDigest == nil : keyEpoch > 0 && policyDigest?.count == 64)
    }
    fileprivate mutating func install(_ lease: CommunityControlLease) {
        revision = lease.revision; keyEpoch = lease.keyEpoch; newestIssuedAt = lease.issuedAt; policyDigest = lease.policyDigest
        communityID = lease.communityID; enrollmentID = lease.enrollmentID; capabilities = lease.capabilities
    }
    fileprivate mutating func disable() { disabledThroughRevision = max(disabledThroughRevision, revision) }
}

/// Main-actor service owns this state. No method creates a standing allowance or a CGEvent/window grant.
public final class CommunityControlState {
    public private(set) var binding: CommunityControlBinding
    private var active: CommunityControlLease?
    private var owner: ControlOwner?
    private var deadline: TimeInterval = 0
    private var lastTick: TimeInterval = 0
    private var disabled = false
    public init(binding: CommunityControlBinding) { self.binding = binding }
    public func install(_ lease: CommunityControlLease, localPublicKey: String, owner: ControlOwner,
                        now: Int64, tick: TimeInterval, save: (CommunityControlBinding) throws -> Void) throws {
        guard binding.valid, tick.isFinite, tick >= 0, lease.profileID == binding.profileID, lease.deviceID == binding.deviceID,
              lease.controlKey == binding.publicKey, localPublicKey == binding.publicKey,
              lease.agentDeviceID == binding.agentDeviceID,
              lease.revision >= binding.revision, lease.keyEpoch >= binding.keyEpoch,
              lease.issuedAt >= binding.newestIssuedAt, lease.expiresAt > now, lease.expiresAt <= now + 90_000,
              lease.revision > binding.disabledThroughRevision,
              lease.revision != binding.revision || lease.policyDigest == binding.policyDigest else {
            throw ControlError.refuse("community-binding-refused")
        }
        var next = binding; next.install(lease)
        try save(next) // Commit antirollback metadata before making the lease usable.
        binding = next; active = lease; self.owner = owner; disabled = false
        deadline = tick + Double(lease.expiresAt - now) / 1000; lastTick = tick
    }
    public func authorize(_ capability: CommunityControlCapability, owner: ControlOwner, now: Int64,
                          tick: TimeInterval, personHoldsControl: Bool) throws -> CommunityControlLease {
        guard !disabled, !personHoldsControl, self.owner == owner, let lease = active, lease.capabilities.contains(capability),
              now >= lease.issuedAt - 60_000, now < lease.expiresAt, tick.isFinite, tick >= lastTick, tick < deadline else {
            throw ControlError.refuse("community-not-authorized")
        }
        lastTick = tick
        return lease
    }
    /// Ends in RAM before durable storage. A failed save cannot leave an active lease in this process.
    public func disable(save: (CommunityControlBinding) throws -> Void) throws {
        disabled = true; active = nil; owner = nil
        var next = binding; next.disable(); try save(next); binding = next
    }
    public func end(owner: ControlOwner) { if self.owner == owner { active = nil; self.owner = nil } }
    /// Only status can refresh an expired component lease. It cannot register, change scopes or undo local off.
    public func mayRefresh(_ capability: CommunityControlCapability) -> Bool {
        !disabled && binding.revision > 0 && binding.revision > binding.disabledThroughRevision
            && binding.capabilities?.contains(capability) == true && binding.communityID != nil && binding.enrollmentID != nil
    }
    public var status: [String: Any] {
        ["candidatePrepared": true, "profileId": binding.profileID, "deviceId": binding.deviceID, "controlKey": binding.publicKey,
         "revision": binding.revision, "localOff": disabled || binding.revision > 0 && binding.disabledThroughRevision >= binding.revision]
            .merging(["agentDeviceId": binding.agentDeviceID as Any? ?? NSNull(), "communityId": binding.communityID as Any? ?? NSNull(),
                "enrollmentId": binding.enrollmentID as Any? ?? NSNull(), "capabilities": (binding.capabilities ?? []).map(\.rawValue).sorted()]) { _, value in value }
    }
}

/// Separate management protocol, never accepted on the agent channel. It admits purpose-specific adapters only.
public struct CommunityControlRequest {
    public let operation: String
    public let body: [String: Any]
    public static func decode(_ data: Data) throws -> Self {
        let shapes: [String: Set<String>] = ["community-status": [], "community-prepare": ["profileId", "deviceId", "agentDeviceId"],
            "community-install": ["requestId", "envelope"], "community-refresh": ["requestId", "envelope"],
            "community-sign": ["purpose", "payload"], "community-authorize": ["capability"], "community-disable": [],
            "community-receive-status": ["legacyRestricted"], "community-receive-restrict": ["change"],
            "community-receive-review": ["requestId", "expectedRevision", "change"], "community-receive-review-status": ["reviewId"]]
        guard data.count <= ControlLimits.requestBytes, let value = try? JSONSerialization.jsonObject(with: data),
              let body = value as? [String: Any], CommunityControlLease.integer(body["v"]) == 3,
              body["channel"] as? String == "management", let op = body["op"] as? String, let fields = shapes[op],
              Set(body.keys) == fields.union(["v", "channel", "op"]) else { throw ControlError.invalid }
        for field in ["profileId", "deviceId", "agentDeviceId", "requestId", "reviewId"] where fields.contains(field) {
            guard let value = body[field] as? String, CommunityControlLease.validID(value) else { throw ControlError.invalid }
        }
        if op == "community-install" || op == "community-refresh" {
            guard let envelope = body["envelope"] as? [String: Any], Set(envelope.keys) == ["payload", "signature"],
                  let payload = envelope["payload"] as? String, payload.utf8.count <= 12_000,
                  let signature = envelope["signature"] as? String, signature.utf8.count == 86 else { throw ControlError.invalid }
        }
        if op == "community-sign" {
            guard let purpose = body["purpose"] as? String, ["agent", "teams"].contains(purpose),
                  let payload = body["payload"] as? [String: Any], let kind = payload["kind"] as? String,
                  ["access", "relay-bind", "handshake"].contains(kind) else { throw ControlError.invalid }
        }
        if op == "community-authorize" {
            guard let value = body["capability"] as? String, CommunityControlCapability(rawValue: value) != nil else { throw ControlError.invalid }
        }
        if op == "community-receive-status" {
            guard let b = body["legacyRestricted"] as? NSNumber, CFGetTypeID(b) == CFBooleanGetTypeID() else { throw ControlError.invalid }
        }
        if op == "community-receive-review" || op == "community-receive-restrict" {
            guard let change = body["change"] as? [String: Any] else { throw ControlError.invalid }
            _ = try CommunityReceiveChange.decode(change, restoring: op == "community-receive-review", now: 0)
            if op == "community-receive-review" { guard CommunityControlLease.integer(body["expectedRevision"]) != nil else { throw ControlError.invalid } }
        }
        return Self(operation: op, body: body)
    }
}
