import Foundation
import CryptoKit

extension CommunityComponentProof {
    public static let mobileHandshakeFields = ["version", "purpose", "profileId", "communityId", "channelId", "senderKind", "receiverKind",
        "senderDeviceId", "receiverDeviceId", "senderEnrollmentId", "receiverEnrollmentId", "senderPolicyDigest", "receiverPolicyDigest",
        "senderUseId", "senderUsePublicKey", "senderUsePolicyDigest", "senderConnectionId", "receiverConnectionId", "receiverBootId", "receiverInstance",
        "senderEphemeral", "receiverEphemeral", "senderNonce", "receiverNonce"]
    private static let mobileOrder = ["screen.view", "screen.control", "screen.receive.view", "screen.receive.control", "agent.communicate", "teams.run", "computer-use.agent-settings", "computer-use.browser"]
    private static func mobileExact(_ object: [String: Any], _ fields: [String]) throws { guard Set(object.keys) == Set(fields) else { throw ApprovalError.invalidPayload } }
    private static func mobilePoint(_ value: Any?) throws -> String {
        guard let value = value as? String else { throw ApprovalError.invalidPayload }
        _ = try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(value)); return value
    }
    private static func mobileHash(_ values: [Any], domain: String = "") throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])
        return SHA256.hash(data: Data(domain.utf8) + bytes).map { String(format: "%02x", $0) }.joined()
    }
    private static func mobileReply(_ envelope: [String: Any], kind: String, authority: CommunityControlAuthority, now: Int64) throws -> (body: [String: Any], at: Int64, id: String) {
        try mobileExact(envelope, ["payload", "signature"])
        guard let payload = envelope["payload"] as? String, let signature = envelope["signature"] as? String else { throw ApprovalError.invalidPayload }
        let bytes = try CommunityControlLease.decodeURL(payload), sig = try P256.Signing.ECDSASignature(rawRepresentation: CommunityControlLease.decodeURL(signature))
        guard bytes.count <= 48_000, authority.issuer.isValidSignature(sig, for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes),
              let fields = try JSONSerialization.jsonObject(with: bytes) as? [Any], fields.count == 5,
              CommunityControlLease.integer(fields[0]) == 2, fields[1] as? String == kind,
              let id = fields[2] as? String, CommunityControlLease.validID(id), let at = CommunityControlLease.integer(fields[3]), at >= 0, at >= now - 60_000, at <= now + 5_000,
              let body = fields[4] as? [String: Any], CommunityControlLease.integer(body["issuedAt"]) == at,
              let expires = CommunityControlLease.integer(body["expiresAt"]), expires > now, expires > at, expires <= at + 90_000 else { throw ApprovalError.invalidPayload }
        return (body, at, id)
    }
    /// Validates the issuer-certified mobile identity and live RAM episode before signing one structured host transcript.
    /// This creates no desktop, browser, Teams or settings execution grant.
    public static func mobileHostHandshakeMessage(_ payload: [String: Any], authority: CommunityControlAuthority, own: CommunityControlLease, purpose: String, now: Int64) throws -> Data {
        try mobileExact(payload, ["kind", "transcript", "ownAuthorization", "controllerAuthorization", "controllerUseSession"])
        let cap = try capability(purpose)
        guard purpose.hasPrefix("mobile-"), payload["kind"] as? String == "mobile-host-handshake",
              let t = payload["transcript"] as? [String: Any], let ownEnvelope = payload["ownAuthorization"] as? [String: Any],
              let mobileEnvelope = payload["controllerAuthorization"] as? [String: Any], let useEnvelope = payload["controllerUseSession"] as? [String: Any],
              let origin = authority.origin?.absoluteString else { throw ApprovalError.invalidPayload }
        try mobileExact(t, mobileHandshakeFields)
        let requestedOwn = try CommunityControlLease.verify(envelope: ownEnvelope, deviceID: own.deviceID, authority: authority, now: now)
        let mobile = try mobileReply(mobileEnvelope, kind: "authorization", authority: authority, now: now).body
        let useReply = try mobileReply(useEnvelope, kind: "session", authority: authority, now: now), use = useReply.body
        try mobileExact(mobile, ["version", "communityId", "profileId", "enrollmentId", "deviceId", "deviceKind", "name", "hostPublicKey", "publicKey", "biometricPublicKey", "controlKey", "agentDeviceId", "capabilities", "revision", "keyEpoch", "issuedAt", "expiresAt"])
        try mobileExact(use, ["version", "communityId", "enrollmentId", "sessionId", "publicKey", "capabilities", "revision", "sequence", "lastHumanAt", "idleExpiresAt", "issuedAt", "expiresAt"])
        guard requestedOwn.policyDigest == own.policyDigest, requestedOwn.controlKey == own.controlKey, own.capabilities.contains(cap),
              CommunityControlLease.integer(mobile["version"]) == 1, mobile["deviceKind"] as? String == "mobile", mobile["profileId"] as? String == own.profileID,
              mobile["communityId"] as? String == own.communityID, mobile["controlKey"] is NSNull, mobile["agentDeviceId"] is NSNull,
              let name = mobile["name"] as? String, !name.isEmpty, name.utf8.count <= 120, name == name.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format }),
              let caps = mobile["capabilities"] as? [String], caps == mobileOrder.filter({ caps.contains($0) }), caps.contains(cap.rawValue), !caps.contains("screen.receive.view"), !caps.contains("screen.receive.control"),
              !caps.contains("screen.control") || caps.contains("screen.view"), !caps.contains("screen.receive.control") || caps.contains("screen.receive.view"),
              let revision = CommunityControlLease.integer(mobile["revision"]), revision > 0, let epoch = CommunityControlLease.integer(mobile["keyEpoch"]), epoch > 0 else { throw ApprovalError.invalidPayload }
        for field in ["profileId", "communityId", "enrollmentId", "deviceId"] { guard let id = mobile[field] as? String, CommunityControlLease.validID(id) else { throw ApprovalError.invalidPayload } }
        let mobileKeys = try ["hostPublicKey", "publicKey", "biometricPublicKey"].map { try mobilePoint(mobile[$0]) }
        let useKey = try mobilePoint(use["publicKey"])
        guard Set(mobileKeys).count == 3, !mobileKeys.contains(useKey), useKey != own.controlKey,
              CommunityControlLease.integer(use["version"]) == 1, use["communityId"] as? String == own.communityID, use["enrollmentId"] as? String == mobile["enrollmentId"] as? String,
              CommunityControlLease.integer(use["revision"]) == revision, let useID = use["sessionId"] as? String, CommunityControlLease.validID(useID), useReply.id == useID,
              let sequence = CommunityControlLease.integer(use["sequence"]), sequence >= 0, let human = CommunityControlLease.integer(use["lastHumanAt"]), human >= 0, human <= useReply.at,
              let idle = CommunityControlLease.integer(use["idleExpiresAt"]), idle > now, idle > human, idle <= human + 3_600_000,
              let expiry = CommunityControlLease.integer(use["expiresAt"]), expiry <= idle,
              let useCaps = use["capabilities"] as? [String], useCaps == mobileOrder.filter({ useCaps.contains($0) }), useCaps.contains(cap.rawValue), useCaps.allSatisfy(caps.contains) else { throw ApprovalError.invalidPayload }
        let policyValues: [Any] = [1, mobile["communityId"]!, mobile["profileId"]!, mobile["enrollmentId"]!, mobile["deviceId"]!, NSNull(), "mobile", name, mobileKeys[0], mobileKeys[1], mobileKeys[2], NSNull(), caps, revision, epoch]
        let policyHash = try mobileHash(policyValues)
        let useHash = try mobileHash([1, origin, CommunityControlLease.encodeURL(authority.issuer.x963Representation), own.profileID, own.communityID, mobile["enrollmentId"]!, mobile["deviceId"]!, revision, epoch, useID, useKey, useCaps, 3_600_000], domain: "agentstoz.community-mobile-control/use-policy/v2\0")
        guard CommunityControlLease.integer(t["version"]) == 2, t["purpose"] as? String == purpose, t["senderKind"] as? String == "mobile", t["receiverKind"] as? String == "desktop",
              t["profileId"] as? String == own.profileID, t["communityId"] as? String == own.communityID,
              t["senderDeviceId"] as? String == mobile["deviceId"] as? String, t["senderEnrollmentId"] as? String == mobile["enrollmentId"] as? String,
              t["receiverDeviceId"] as? String == own.deviceID, t["receiverEnrollmentId"] as? String == own.enrollmentID,
              t["senderDeviceId"] as? String != own.deviceID, t["senderEnrollmentId"] as? String != own.enrollmentID,
              t["senderPolicyDigest"] as? String == policyHash, t["receiverPolicyDigest"] as? String == own.policyDigest,
              t["senderUseId"] as? String == useID, t["senderUsePublicKey"] as? String == useKey, t["senderUsePolicyDigest"] as? String == useHash else { throw ApprovalError.invalidPayload }
        for field in ["channelId", "senderConnectionId", "receiverConnectionId"] { guard let id = t[field] as? String, CommunityControlLease.validID(id) else { throw ApprovalError.invalidPayload } }
        guard t["senderConnectionId"] as? String != t["receiverConnectionId"] as? String else { throw ApprovalError.invalidPayload }
        for field in ["receiverBootId", "receiverInstance"] { guard let value = t[field] as? String, value.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { throw ApprovalError.invalidPayload } }
        guard t["receiverBootId"] as? String != t["receiverInstance"] as? String,
              try mobilePoint(t["senderEphemeral"]) != mobilePoint(t["receiverEphemeral"]),
              let nonceA = t["senderNonce"] as? String, let nonceB = t["receiverNonce"] as? String, nonceA != nonceB,
              try CommunityControlLease.decodeURL(nonceA).count == 32, try CommunityControlLease.decodeURL(nonceB).count == 32 else { throw ApprovalError.invalidPayload }
        let bytes = try JSONSerialization.data(withJSONObject: mobileHandshakeFields.map { t[$0]! }, options: [.withoutEscapingSlashes])
        let hash = Data(SHA256.hash(data: Data("agentstoz.community-mobile-control/transcript/v2\0".utf8) + bytes))
        return Data("agentstoz.community-mobile-control/proof/v2\0host\0".utf8) + hash
    }
}
