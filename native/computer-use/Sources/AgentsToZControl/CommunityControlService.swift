import ComputerUseApproval
import ComputerUseControlCore
import Foundation
import CryptoKit
import Security

/// Candidate key and antirollback record belong exclusively to Control's signed Keychain access group.
private enum CommunityControlKeychain {
    static let tag = Data("com.intenet.agentstozbycs.control.community-candidate.v1".utf8)
    static let service = "com.intenet.agentstozbycs.control.community-binding.v1"
    static let account = "binding"
    static func label(profile: String, device: String, agent: String?) -> String { "agentstoz-community-candidate profile=\(profile) device=\(device) agent=\(agent ?? "none")" }
    static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecUseDataProtectionKeychain as String: true, kSecAttrService as String: service, kSecAttrAccount as String: account] }
    static func read() throws -> CommunityControlBinding? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        let code = SecItemCopyMatching(q as CFDictionary, &found)
        if code == errSecItemNotFound { return nil }
        guard code == errSecSuccess, let data = found as? Data, data.count <= 8192,
              let binding = try? JSONDecoder().decode(CommunityControlBinding.self, from: data), binding.valid,
              let bytes = try? CommunityControlLease.decodeURL(binding.publicKey),
              (try? P256.Signing.PublicKey(x963Representation: bytes)) != nil else { throw ControlError.refuse("community-store-unavailable") }
        return binding
    }
    static func write(_ binding: CommunityControlBinding) throws {
        guard binding.valid else { throw ControlError.refuse("community-store-unavailable") }
        let data = try JSONEncoder().encode(binding)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw ControlError.refuse("community-store-unavailable") }
        var item = query; item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw ControlError.refuse("community-store-unavailable") }
    }
    static func key(for binding: CommunityControlBinding) throws -> SecKey {
        // Never regenerate a missing key after the record exists, including after a partial prepare.
        guard let found = try ComputerUseApproval.standingKey(tag: tag),
              found.label == label(profile: binding.profileID, device: binding.deviceID, agent: binding.agentDeviceID),
              CommunityControlLease.encodeURL(try ComputerUseApproval.publicPoint(of: found.key)) == binding.publicKey else {
            throw ControlError.refuse("community-key-lost")
        }
        return found.key
    }
    static func prepare(profile: String, device: String, agentDevice: String) throws -> CommunityControlBinding {
        if let binding = try read() {
            guard binding.profileID == profile, binding.deviceID == device, binding.agentDeviceID == agentDevice else { throw ControlError.refuse("community-binding-refused") }
            _ = try key(for: binding); return binding
        }
        let expected = label(profile: profile, device: device, agent: agentDevice)
        let key: SecKey
        if let orphan = try ComputerUseApproval.standingKey(tag: tag) {
            // A crash between key creation and record save leaves only a candidate, never authority.
            guard orphan.label == expected else { throw ControlError.refuse("community-binding-refused") }
            key = orphan.key
        } else {
            // Same non-presence Secure Enclave attributes as a standing key, but a distinct tag and NO allowance.
            key = try ComputerUseApproval.makeStandingKey(tag: tag, label: expected)
        }
        let binding = CommunityControlBinding(profileID: profile, deviceID: device,
            publicKey: CommunityControlLease.encodeURL(try ComputerUseApproval.publicPoint(of: key)), agentDeviceID: agentDevice)
        try write(binding); return binding
    }
}

@MainActor
final class CommunityControlService {
    static let shared = CommunityControlService()
    private var state: CommunityControlState?
    private var loadingFailed = false
    private init() {
        do { if let binding = try CommunityControlKeychain.read() { state = CommunityControlState(binding: binding) } }
        catch { loadingFailed = true }
    }
    func handle(_ request: CommunityControlRequest, owner: ControlOwner) -> Data {
        guard ProcessGeneration.alive(owner) else { return ControlResponse.failure(.refuse("owner-unavailable")) }
        do { return try run(request, owner: owner) }
        catch let e as ControlError { return ControlResponse.failure(e) }
        catch { return ControlResponse.failure(.refuse("community-authorization-refused")) }
    }
    private func run(_ request: CommunityControlRequest, owner: ControlOwner) throws -> Data {
        switch request.operation {
        case "community-status":
            let authority = CommunityControlAuthority.configured.flatMap { $0.origin == nil ? nil : $0 }
            return ControlResponse.success(["communityProtocolVersion": 3,
                "configured": authority != nil, "storeAvailable": !loadingFailed,
                "authority": authority.map { ["origin": $0.origin!.absoluteString, "profileId": $0.profileID,
                    "issuerPublicKey": CommunityControlLease.encodeURL($0.issuer.x963Representation)] } as Any? ?? NSNull(),
                "binding": state?.status as Any? ?? NSNull()])
        case "community-disable":
            try disable(); return ControlResponse.success(["disabled": true])
        case "community-receive-status":
            return ControlResponse.success(try CommunityReceiveService.shared.status(owner: owner, legacyRestricted: request.body["legacyRestricted"] as? Bool ?? true))
        case "community-receive-restrict":
            guard let change = request.body["change"] as? [String: Any] else { throw ControlError.invalid }
            return ControlResponse.success(try CommunityReceiveService.shared.restrict(change, owner: owner))
        case "community-receive-review":
            guard let id = request.body["requestId"] as? String, let revision = CommunityControlLease.integer(request.body["expectedRevision"]),
                  let change = request.body["change"] as? [String: Any] else { throw ControlError.invalid }
            return ControlResponse.success(try CommunityReceiveService.shared.review(requestID: id, expected: revision, raw: change, owner: owner))
        case "community-receive-review-status":
            guard let id = request.body["reviewId"] as? String else { throw ControlError.invalid }
            return ControlResponse.success(CommunityReceiveService.shared.reviewStatus(id, owner: owner))
        case "community-prepare":
            guard !loadingFailed, let authority = CommunityControlAuthority.configured,
                  let profile = request.body["profileId"] as? String, profile == authority.profileID,
                  let device = request.body["deviceId"] as? String, let agentDevice = request.body["agentDeviceId"] as? String else { throw ControlError.refuse("community-not-configured") }
            let binding = try CommunityControlKeychain.prepare(profile: profile, device: device, agentDevice: agentDevice)
            // Repeated preparation never replaces a current state, lease, off fence or candidate.
            if state == nil { state = CommunityControlState(binding: binding) }
            return ControlResponse.success(["controlKey": binding.publicKey, "profileId": profile, "deviceId": device, "agentDeviceId": agentDevice, "candidateOnly": true])
        case "community-install", "community-refresh":
            guard !loadingFailed, let authority = CommunityControlAuthority.configured, let state,
                  let requestID = request.body["requestId"] as? String,
                  let envelope = request.body["envelope"] as? [String: Any] else { throw ControlError.refuse("community-not-prepared") }
            guard request.operation != "community-refresh" || state.binding.revision > 0 else { throw ControlError.refuse("community-not-enrolled") }
            let lease = try CommunityControlLease.verify(envelope: envelope, requestID: requestID, authority: authority, now: nowMs())
            let key = try CommunityControlKeychain.key(for: state.binding)
            try state.install(lease, localPublicKey: CommunityControlLease.encodeURL(try ComputerUseApproval.publicPoint(of: key)),
                owner: owner, now: nowMs(), tick: ProcessInfo.processInfo.systemUptime, save: CommunityControlKeychain.write)
            return ControlResponse.success(["installed": true, "revision": lease.revision, "expiresAt": lease.expiresAt])
        case "community-authorize":
            guard !loadingFailed, let state, let name = request.body["capability"] as? String,
                  let capability = CommunityControlCapability(rawValue: name) else { throw ControlError.refuse("community-not-authorized") }
            _ = try CommunityControlKeychain.key(for: state.binding)
            let lease = try state.authorize(capability, owner: owner, now: nowMs(), tick: ProcessInfo.processInfo.systemUptime,
                personHoldsControl: (capability == .agentSettings || capability == .browser) && ScopedControlShared.service.state.grant?.person == true)
            return ControlResponse.success(["authorized": true, "capability": capability.rawValue, "communityId": lease.communityID,
                "profileId": lease.profileID, "deviceId": lease.deviceID, "revision": lease.revision,
                "expiresAt": lease.expiresAt, "desktopGrant": false])
        case "community-sign":
            guard !loadingFailed, let state, let authority = CommunityControlAuthority.configured,
                  let purpose = request.body["purpose"] as? String, let payload = request.body["payload"] as? [String: Any],
                  let kind = payload["kind"] as? String, let community = state.binding.communityID,
                  let enrollment = state.binding.enrollmentID else { throw ControlError.refuse("community-not-enrolled") }
            let capability = try CommunityComponentProof.capability(purpose)
            guard state.mayRefresh(capability) else { throw ControlError.refuse("community-not-authorized") }
            let key = try CommunityControlKeychain.key(for: state.binding)
            if kind == "access" {
                let bytes = try CommunityComponentProof.accessBytes(payload, communityID: community, enrollmentID: enrollment, purpose: purpose, now: nowMs())
                if (payload["request"] as? [String: Any])?["operation"] as? String != "component-status" {
                    _ = try state.authorize(capability, owner: owner, now: nowMs(), tick: ProcessInfo.processInfo.systemUptime, personHoldsControl: false)
                }
                let signature = try CommunityComponentProof.sign(Data("agentstoz.community-access.request/v2\0".utf8) + bytes, key: key)
                return ControlResponse.success(["publicKey": state.binding.publicKey, "payload": CommunityControlLease.encodeURL(bytes), "signature": CommunityControlLease.encodeURL(signature)])
            }
            let own = try state.authorize(capability, owner: owner, now: nowMs(), tick: ProcessInfo.processInfo.systemUptime, personHoldsControl: false)
            let bytes: Data
            if kind == "relay-bind" { bytes = try CommunityComponentProof.relayBytes(payload, authority: authority, own: own, purpose: purpose, now: nowMs()) }
            else if kind == "mobile-host-handshake" { bytes = try CommunityComponentProof.mobileHostHandshakeMessage(payload, authority: authority, own: own, purpose: purpose, now: nowMs()) }
            else if kind == "handshake" { bytes = try CommunityComponentProof.handshakeMessage(payload, authority: authority, own: own, purpose: purpose, now: nowMs()) }
            else { throw ControlError.invalid }
            return ControlResponse.success(["publicKey": state.binding.publicKey, "signature": CommunityControlLease.encodeURL(try CommunityComponentProof.sign(bytes, key: key))])
        default: throw ControlError.invalid
        }
    }
    /// A local stop/off cannot be undone by refreshing the same signed policy. A new owner-reviewed revision is needed.
    func disable() throws {
        guard !loadingFailed else { throw ControlError.refuse("community-store-unavailable") }
        guard let state else { return }
        do { try state.disable(save: CommunityControlKeychain.write) }
        catch {
            // If the record cannot commit, delete the private candidate as a second durable fail-closed fence.
            try? ComputerUseApproval.deleteStandingKey(tag: CommunityControlKeychain.tag)
            loadingFailed = true
            throw ControlError.refuse("community-disable-unconfirmed")
        }
    }
    func end(owner: ControlOwner) { CommunityReceiveService.shared.end(owner: owner); state?.end(owner: owner) }
    /// A common communication certificate never substitutes for the separately approved full desktop allowance.
    func receiveContext(owner: ControlOwner) throws -> CommunityReceiveContext {
        guard !loadingFailed, let state, ScopedControlShared.service.standingForReception() else { throw ControlError.refuse("receive-not-authorized") }
        _ = try CommunityControlKeychain.key(for: state.binding)
        let lease = try state.authorize(.agentCommunicate, owner: owner, now: nowMs(), tick: ProcessInfo.processInfo.systemUptime, personHoldsControl: false)
        let bytes = try JSONSerialization.data(withJSONObject: [lease.profileID, lease.communityID, lease.enrollmentID, lease.deviceID, lease.controlKey, lease.keyEpoch], options: [.withoutEscapingSlashes])
        let key = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return CommunityReceiveContext(bindingKey: key, communityID: lease.communityID, profileID: lease.profileID, deviceID: lease.deviceID, revision: lease.revision, expiresAt: lease.expiresAt)
    }
    /// A failed negative write cannot revive the old positive record after a restart.
    func receiveStorageFailed() {
        try? state?.disable(save: CommunityControlKeychain.write)
        try? ComputerUseApproval.deleteStandingKey(tag: CommunityControlKeychain.tag)
        loadingFailed = true
    }
}
