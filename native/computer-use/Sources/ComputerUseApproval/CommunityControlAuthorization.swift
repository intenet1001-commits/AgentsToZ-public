import Foundation
import CoreFoundation
import CryptoKit

/// These capabilities authorize dedicated adapters. They are never a desktop/window input grant.
public enum CommunityControlCapability: String, Codable, CaseIterable, Sendable {
    case agentCommunicate = "agent.communicate"
    case teamsRun = "teams.run"
    case agentSettings = "computer-use.agent-settings"
    case browser = "computer-use.browser"
}

public struct CommunityControlAuthority: Sendable {
    public let issuer: P256.Signing.PublicKey
    public let profileID: String
    public let origin: URL?
    public init(issuer: P256.Signing.PublicKey, profileID: String, origin: URL? = nil) {
        self.issuer = issuer; self.profileID = profileID; self.origin = origin
    }
    /// Trust is sealed in the signed Control bundle; no request, runtime file or environment chooses it.
    public static var configured: Self? {
#if CONTROL_COMMUNITY_QA
        guard Bundle.main.infoDictionary?[CommunityControlBundleConfiguration.infoKey] == nil else { return nil }
        guard let bytes = try? CommunityControlLease.decodeURL("BBBrsAeK5pOokQ3HXnIBqqMzAhWIGKtuS6LZnsyhNn_W8xzzKVd7sTG1tTBYTuIlm6QVkBS9O5faAJmz1Tesvu8"),
              let key = try? P256.Signing.PublicKey(x963Representation: bytes) else { return nil }
        return Self(issuer: key, profileID: "51c574e8-2109-4065-92e0-66523c206fe8", origin: URL(string: "https://agentstoz-screen-community.agentstoz-screen-community.workers.dev"))
#else
        guard let config = CommunityControlBundleConfiguration.parse(info: Bundle.main.infoDictionary ?? [:]) else { return nil }
        return Self(issuer: config.issuer, profileID: config.profileID, origin: config.origin)
#endif
    }
}

/// Constructible only by the issuer verifier. The Control candidate private key is checked separately at installation.
public struct CommunityControlLease: Sendable {
    public let communityID: String, profileID: String, enrollmentID: String, deviceID: String, controlKey: String
    public let agentDeviceID: String?
    public let capabilities: Set<CommunityControlCapability>
    public let revision: Int64, keyEpoch: Int64, issuedAt: Int64, expiresAt: Int64
    public let policyDigest: String
    private init(body: [String: Any], capabilities: Set<CommunityControlCapability>, digest: String) {
        communityID = body["communityId"] as! String; profileID = body["profileId"] as! String
        enrollmentID = body["enrollmentId"] as! String; deviceID = body["deviceId"] as! String
        controlKey = body["controlKey"] as! String; self.capabilities = capabilities
        agentDeviceID = body["agentDeviceId"] as? String
        revision = Self.integer(body["revision"])!; keyEpoch = Self.integer(body["keyEpoch"])!
        issuedAt = Self.integer(body["issuedAt"])!; expiresAt = Self.integer(body["expiresAt"])!
        policyDigest = digest
    }

    public static func verify(envelope: [String: Any], requestID: String? = nil, deviceID: String? = nil, authority: CommunityControlAuthority,
                              now: Int64) throws -> Self {
        guard Set(envelope.keys) == ["payload", "signature"], let payload = envelope["payload"] as? String,
              let signature = envelope["signature"] as? String, requestID.map(validID) ?? true, validID(authority.profileID),
              now >= 0, now <= 9_007_199_254_650_991 else { throw ApprovalError.invalidPayload }
        let bytes = try decodeURL(payload), rawSignature = try decodeURL(signature)
        guard bytes.count <= 48_000, rawSignature.count == 64,
              let signed = try? P256.Signing.ECDSASignature(rawRepresentation: rawSignature),
              authority.issuer.isValidSignature(signed, for: Data("agentstoz.community-access.response/v2\0".utf8) + bytes),
              let fields = try? JSONSerialization.jsonObject(with: bytes) as? [Any], fields.count == 5,
              integer(fields[0]) == 2, let kind = fields[1] as? String, ["authorization", "directory"].contains(kind), let responseID = fields[2] as? String,
              validID(responseID), requestID == nil || responseID == requestID,
              let at = integer(fields[3]), at >= 0, at <= now + 60_000, at >= now - 60_000,
              let body = selectedBody(fields[4], kind: kind, deviceID: deviceID), Set(body.keys) == ["version", "communityId", "profileId",
                "enrollmentId", "deviceId", "deviceKind", "name", "hostPublicKey", "publicKey", "biometricPublicKey",
                "controlKey", "agentDeviceId", "capabilities", "revision", "keyEpoch", "issuedAt", "expiresAt"],
              integer(body["version"]) == 1, body["deviceKind"] as? String == "desktop",
              body["profileId"] as? String == authority.profileID,
              let name = body["name"] as? String, (1...120).contains(name.utf8.count), name == name.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format }),
              let caps = body["capabilities"] as? [String], !caps.isEmpty,
              let revision = integer(body["revision"]), revision > 0,
              let epoch = integer(body["keyEpoch"]), epoch > 0,
              integer(body["issuedAt"]) == at, let expires = integer(body["expiresAt"]),
              expires > now, expires > at, expires <= at + 90_000 else { throw ApprovalError.invalidPayload }
        for field in ["communityId", "profileId", "enrollmentId", "deviceId"] {
            guard let id = body[field] as? String, validID(id) else { throw ApprovalError.invalidPayload }
        }
        let keys = try ["hostPublicKey", "publicKey", "biometricPublicKey", "controlKey"].map { field -> String in
            guard let text = body[field] as? String else { throw ApprovalError.invalidPayload }
            _ = try P256.Signing.PublicKey(x963Representation: decodeURL(text)); return text
        }
        guard Set(keys).count == keys.count else { throw ApprovalError.invalidPayload }
        let order = ["screen.view", "screen.control", "screen.receive.view", "screen.receive.control", "agent.communicate",
                     "teams.run", "computer-use.agent-settings", "computer-use.browser"]
        guard caps == order.filter({ caps.contains($0) }), !caps.contains("screen.control") || caps.contains("screen.view"),
              !caps.contains("screen.receive.control") || caps.contains("screen.receive.view") else { throw ApprovalError.invalidPayload }
        let agentDeviceID = body["agentDeviceId"] as? String
        guard body["agentDeviceId"] is NSNull || agentDeviceID.map(validID) == true,
              !caps.contains("agent.communicate") && !caps.contains("teams.run") || agentDeviceID != nil else { throw ApprovalError.invalidPayload }
        // The policy fingerprint excludes renewable timestamps, but includes every identity and granted capability.
        let values: [Any] = [1, body["communityId"]!, body["profileId"]!, body["enrollmentId"]!, body["deviceId"]!,
            body["agentDeviceId"]!, body["deviceKind"]!, body["name"]!, body["hostPublicKey"]!, body["publicKey"]!,
            body["biometricPublicKey"]!, body["controlKey"]!, caps, revision, epoch]
        let data = try JSONSerialization.data(withJSONObject: values, options: [.withoutEscapingSlashes])
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return Self(body: body, capabilities: Set(caps.compactMap(CommunityControlCapability.init(rawValue:))), digest: digest)
    }
    private static func selectedBody(_ value: Any, kind: String, deviceID: String?) -> [String: Any]? {
        if kind == "authorization" { guard let body = value as? [String: Any], deviceID == nil || body["deviceId"] as? String == deviceID else { return nil }; return body }
        guard let deviceID, let rows = value as? [[String: Any]], !rows.isEmpty, rows.count <= 32 else { return nil }
        let selected = rows.filter { $0["deviceId"] as? String == deviceID }; return selected.count == 1 ? selected[0] : nil
    }
    public static func validID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    public static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded(.towardZero) == n.doubleValue, abs(n.doubleValue) <= 9_007_199_254_740_991 else { return nil }
        return n.int64Value
    }
    public static func encodeURL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    public static func decodeURL(_ value: String) throws -> Data {
        guard value.utf8.count <= 65_536, !value.isEmpty,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let bytes = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
                + String(repeating: "=", count: (4 - value.count % 4) % 4)), encodeURL(bytes) == value else { throw ApprovalError.invalidPayload }
        return bytes
    }
}
