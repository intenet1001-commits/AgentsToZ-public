import Foundation
import CryptoKit
import Security

/// Closed component-key uses. None is a screen/CGEvent grant or an arbitrary signing oracle.
public enum CommunityComponentProof {
    public static func capability(_ purpose: String) throws -> CommunityControlCapability {
        switch purpose { case "agent", "mobile-agent": return .agentCommunicate; case "teams", "mobile-teams": return .teamsRun; case "mobile-agent-settings": return .agentSettings; case "mobile-browser": return .browser; default: throw ApprovalError.invalidPayload }
    }
    private static func exact(_ object: [String: Any], _ keys: Set<String>) throws {
        guard Set(object.keys) == keys else { throw ApprovalError.invalidPayload }
    }
    private static func point(_ value: Any?) throws -> String {
        guard let text = value as? String else { throw ApprovalError.invalidPayload }
        _ = try P256.Signing.PublicKey(x963Representation: CommunityControlLease.decodeURL(text)); return text
    }
    private static func token(_ value: Any?, length: Int) throws -> String {
        guard let text = value as? String, try CommunityControlLease.decodeURL(text).count == length else { throw ApprovalError.invalidPayload }
        return text
    }
    public static func accessBytes(_ payload: [String: Any], communityID: String, enrollmentID: String,
                                   purpose: String, now: Int64) throws -> Data {
        _ = try capability(purpose); try exact(payload, ["kind", "request"])
        guard payload["kind"] as? String == "access", let request = payload["request"] as? [String: Any] else { throw ApprovalError.invalidPayload }
        try exact(request, ["operation", "requestId", "observedAt", "nonce", "actor", "args"])
        guard let operation = request["operation"] as? String, ["component-status", "component-directory", "component-ticket", "component-session"].contains(operation),
              let id = request["requestId"] as? String, CommunityControlLease.validID(id),
              let at = CommunityControlLease.integer(request["observedAt"]), at >= now - 60_000, at <= now + 60_000,
              request["actor"] as? String == enrollmentID, let args = request["args"] as? [Any], args.first as? String == communityID else { throw ApprovalError.invalidPayload }
        let nonce = try token(request["nonce"], length: 32)
        if operation == "component-ticket" {
            guard args.count == 4, args[1] as? String == purpose, let connection = args[2] as? String,
                  CommunityControlLease.validID(connection), let role = args[3] as? String, ["host", "client"].contains(role), !purpose.hasPrefix("mobile-") || role == "host" else { throw ApprovalError.invalidPayload }
        } else if operation == "component-session" {
            guard purpose.hasPrefix("mobile-"), args.count == 4, args[1] as? String == purpose,
                  let mobile = args[2] as? String, let use = args[3] as? String,
                  CommunityControlLease.validID(mobile), CommunityControlLease.validID(use) else { throw ApprovalError.invalidPayload }
        } else { guard args.count == 1 else { throw ApprovalError.invalidPayload } }
        let data = try JSONSerialization.data(withJSONObject: [2, operation, id, at, nonce, enrollmentID, args], options: [.withoutEscapingSlashes])
        guard data.count <= 12_000 else { throw ApprovalError.invalidPayload }; return data
    }
    public static func relayBytes(_ payload: [String: Any], authority: CommunityControlAuthority, own: CommunityControlLease,
                                  purpose: String, now: Int64) throws -> Data {
        try exact(payload, ["kind", "ticket", "challenge"])
        guard payload["kind"] as? String == "relay-bind", let ticket = payload["ticket"] as? [String: Any] else { throw ApprovalError.invalidPayload }
        let fields = try response(ticket, authority: authority, now: now)
        guard fields[1] as? String == "ticket", let body = fields[4] as? [String: Any] else { throw ApprovalError.invalidPayload }
        try exact(body, ["version", "ticketId", "communityId", "enrollmentId", "deviceId", "deviceKind", "connectionId", "publicKey", "purpose", "role", "sessionId", "revision", "issuedAt", "expiresAt", "leaseExpiresAt"])
        guard CommunityControlLease.integer(body["version"]) == 1, body["communityId"] as? String == own.communityID,
              body["enrollmentId"] as? String == own.enrollmentID, body["deviceId"] as? String == own.deviceID,
              body["deviceKind"] as? String == "desktop", body["publicKey"] as? String == own.controlKey,
              body["purpose"] as? String == purpose, let role = body["role"] as? String, ["host", "client"].contains(role),
              body["sessionId"] is NSNull, CommunityControlLease.integer(body["revision"]) == own.revision,
              let id = body["ticketId"] as? String, CommunityControlLease.validID(id), fields[2] as? String == id,
              let connection = body["connectionId"] as? String, CommunityControlLease.validID(connection),
              let at = CommunityControlLease.integer(body["issuedAt"]), CommunityControlLease.integer(fields[3]) == at,
              let expiry = CommunityControlLease.integer(body["expiresAt"]), expiry > now, expiry <= at + 30_000,
              let leaseExpiry = CommunityControlLease.integer(body["leaseExpiresAt"]), leaseExpiry >= expiry, leaseExpiry <= at + 90_000 else { throw ApprovalError.invalidPayload }
        let challenge = try token(payload["challenge"], length: 32)
        return try JSONSerialization.data(withJSONObject: ["agentstoz.relay.bind/v2", id, connection, challenge], options: [.withoutEscapingSlashes])
    }
    public static let handshakeFields = ["version", "purpose", "profileId", "communityId", "senderDeviceId", "receiverDeviceId",
        "senderAgentDeviceId", "receiverAgentDeviceId", "senderEnrollmentId", "receiverEnrollmentId", "senderCertificateHash", "receiverCertificateHash",
        "session", "instance", "receiverBootId", "senderEphemeral", "receiverEphemeral", "senderNonce", "receiverNonce"]
    public static func handshakeBytes(_ transcript: [String: Any]) throws -> Data {
        try exact(transcript, Set(handshakeFields))
        guard CommunityControlLease.integer(transcript["version"]) == 1, let purpose = transcript["purpose"] as? String else { throw ApprovalError.invalidPayload }
        _ = try capability(purpose); guard !purpose.hasPrefix("mobile-") else { throw ApprovalError.invalidPayload }
        for field in ["profileId", "communityId", "senderDeviceId", "receiverDeviceId", "senderAgentDeviceId", "receiverAgentDeviceId", "senderEnrollmentId", "receiverEnrollmentId"] {
            guard let id = transcript[field] as? String, CommunityControlLease.validID(id) else { throw ApprovalError.invalidPayload }
        }
        guard transcript["senderDeviceId"] as? String != transcript["receiverDeviceId"] as? String,
              transcript["senderAgentDeviceId"] as? String != transcript["receiverAgentDeviceId"] as? String,
              transcript["senderEnrollmentId"] as? String != transcript["receiverEnrollmentId"] as? String else { throw ApprovalError.invalidPayload }
        for field in ["session", "instance", "receiverBootId", "senderCertificateHash", "receiverCertificateHash"] {
            let length = field.hasSuffix("Hash") ? 64 : 32
            guard let value = transcript[field] as? String, value.range(of: "^[0-9a-f]{\(length)}$", options: .regularExpression) != nil else { throw ApprovalError.invalidPayload }
        }
        guard try point(transcript["senderEphemeral"]) != point(transcript["receiverEphemeral"]),
              try token(transcript["senderNonce"], length: 32) != token(transcript["receiverNonce"], length: 32) else { throw ApprovalError.invalidPayload }
        return try JSONSerialization.data(withJSONObject: handshakeFields.map { transcript[$0]! }, options: [.withoutEscapingSlashes])
    }
    public static func handshakeMessage(_ payload: [String: Any], authority: CommunityControlAuthority, own: CommunityControlLease,
                                        purpose: String, now: Int64) throws -> Data {
        try exact(payload, ["kind", "role", "transcript", "ownAuthorization", "peerAuthorization"])
        guard payload["kind"] as? String == "handshake", let role = payload["role"] as? String, ["sender", "receiver"].contains(role),
              let transcript = payload["transcript"] as? [String: Any], transcript["purpose"] as? String == purpose,
              let ownEnvelope = payload["ownAuthorization"] as? [String: Any], let peerEnvelope = payload["peerAuthorization"] as? [String: Any] else { throw ApprovalError.invalidPayload }
        guard !purpose.hasPrefix("mobile-") else { throw ApprovalError.invalidPayload }
        let peerRole = role == "sender" ? "receiver" : "sender"
        guard let peerID = transcript[peerRole + "DeviceId"] as? String else { throw ApprovalError.invalidPayload }
        let bytes = try handshakeBytes(transcript), requestedOwn = try CommunityControlLease.verify(envelope: ownEnvelope, deviceID: own.deviceID, authority: authority, now: now),
            peer = try CommunityControlLease.verify(envelope: peerEnvelope, deviceID: peerID, authority: authority, now: now), cap = try capability(purpose)
        guard requestedOwn.policyDigest == own.policyDigest, requestedOwn.controlKey == own.controlKey,
              peer.profileID == own.profileID, peer.communityID == own.communityID, peer.deviceID != own.deviceID,
              peer.controlKey != own.controlKey, own.capabilities.contains(cap), peer.capabilities.contains(cap),
              transcript["profileId"] as? String == own.profileID, transcript["communityId"] as? String == own.communityID else { throw ApprovalError.invalidPayload }
        for (label, lease) in [(role, own), (role == "sender" ? "receiver" : "sender", peer)] {
            guard transcript[label + "DeviceId"] as? String == lease.deviceID,
                  transcript[label + "AgentDeviceId"] as? String == lease.agentDeviceID,
                  transcript[label + "EnrollmentId"] as? String == lease.enrollmentID,
                  transcript[label + "CertificateHash"] as? String == lease.policyDigest else { throw ApprovalError.invalidPayload }
        }
        // Include role in the signed domain, so a sender's proof cannot be reflected as the receiver's.
        return Data("agentstoz.community-component.handshake/v1\0\(role)\0".utf8) + bytes
    }
    public static func sign(_ data: Data, key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let der = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else { throw ApprovalError.signing }
        return try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation
    }
    private static func response(_ envelope: [String: Any], authority: CommunityControlAuthority, now: Int64) throws -> [Any] {
        try exact(envelope, ["payload", "signature"])
        guard let payload = envelope["payload"] as? String, let signature = envelope["signature"] as? String else { throw ApprovalError.invalidPayload }
        let data = try CommunityControlLease.decodeURL(payload), sig = try P256.Signing.ECDSASignature(rawRepresentation: CommunityControlLease.decodeURL(signature))
        guard data.count <= 48_000, authority.issuer.isValidSignature(sig, for: Data("agentstoz.community-access.response/v2\0".utf8) + data),
              let fields = try JSONSerialization.jsonObject(with: data) as? [Any], fields.count == 5,
              CommunityControlLease.integer(fields[0]) == 2, let at = CommunityControlLease.integer(fields[3]), at <= now + 60_000, at >= now - 60_000 else { throw ApprovalError.invalidPayload }
        return fields
    }
}
