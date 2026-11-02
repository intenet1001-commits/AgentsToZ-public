import Foundation
import CryptoKit

public enum CommunityMobileControlPurpose: String, Codable, CaseIterable, Sendable {
    case agent = "mobile-agent", teams = "mobile-teams", agentSettings = "mobile-agent-settings", browser = "mobile-browser"
    public var capability: CommunityCapability { switch self { case .agent: .communicate; case .teams: .teams; case .agentSettings: .agentSettings; case .browser: .browser } }
    public var title: String { capability.title }
}
public enum CommunityMobileControlRole: String, Codable, Sendable { case client, host }

enum CommunityMobileControlBytes {
    static func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) }
    static func hash(_ bytes: Data) -> Data { Data(SHA256.hash(data: bytes)) }
    static func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
    static func id(_ text: String) -> Bool { UUID(uuidString: text)?.uuidString.lowercased() == text }
    static func key(_ text: String) throws -> P256.Signing.PublicKey { try P256.Signing.PublicKey(x963Representation: decode(text, bytes: 65)) }
    static func decode(_ text: String, bytes: Int) throws -> Data {
        let data = try ScreenCommunityRequest.decodeBase64(text, max: (bytes * 4 + 2) / 3)
        guard data.count == bytes, ScreenCommunityRequest.base64(data) == text else { throw ScreenCommunityError.malformed }; return data
    }
    static func verified(_ auth: CommunityAuthorization, authority: ScreenCommunityAuthority, now: Date) throws {
        let reply = try CommunityAccessReply.verify(auth.envelope, authority: authority, now: now)
        let candidates = reply.kind == "authorization" ? [try reply.authorization(authority: authority, now: now)] : try reply.directory(authority: authority, communityId: auth.body.communityId, now: now)
        guard candidates.filter({ $0.body == auth.body }).count == 1 else { throw ScreenCommunityError.wrongCommunity }
    }
}

public enum CommunityMobileControlPolicy {
    public static func authorizationDigest(_ auth: CommunityAuthorization) throws -> String {
        let b = auth.body
        let values: [Any] = [b.version,b.communityId,b.profileId,b.enrollmentId,b.deviceId,b.agentDeviceId as Any? ?? NSNull(),b.deviceKind.rawValue,b.name,b.hostPublicKey,b.publicKey,b.biometricPublicKey,b.controlKey as Any? ?? NSNull(),b.capabilities.map(\.rawValue),b.revision,b.keyEpoch]
        return CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(try CommunityMobileControlBytes.json(values)))
    }
    public static func useDigest(authority: ScreenCommunityAuthority, authorization auth: CommunityAuthorization, session use: CommunityUseSession) throws -> String {
        let b = auth.body, s = use.body
        guard s.communityId == b.communityId, s.enrollmentId == b.enrollmentId, s.revision == b.revision else { throw ScreenCommunityError.wrongCommunity }
        let values: [Any] = [s.version,authority.origin.absoluteString,ScreenCommunityRequest.base64(authority.issuer.x963Representation),b.profileId,b.communityId,b.enrollmentId,b.deviceId,b.revision,b.keyEpoch,s.sessionId,s.publicKey,s.capabilities.map(\.rawValue),3_600_000]
        return CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(Data("agentstoz.community-mobile-control/use-policy/v2\0".utf8) + (try CommunityMobileControlBytes.json(values))))
    }
    public static func receiptOwner(_ auth: CommunityAuthorization) throws -> String {
        let b = auth.body
        return CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(Data("agentstoz.community-mobile-control/receipt-owner/v2\0".utf8) + (try CommunityMobileControlBytes.json([b.profileId,b.communityId,b.enrollmentId,b.deviceId,b.keyEpoch,b.publicKey]))))
    }
    public static func validate(authority: ScreenCommunityAuthority, mobile: CommunityAuthorization, session: CommunityUseSession, receiver: CommunityAuthorization, purpose: CommunityMobileControlPurpose, now: Date = Date()) throws {
        try CommunityMobileControlBytes.verified(mobile, authority: authority, now: now)
        try CommunityMobileControlBytes.verified(receiver, authority: authority, now: now)
        let s = try CommunityAccessReply.verify(session.envelope, authority: authority, now: now).session(for: mobile, now: now)
        let a = mobile.body, b = receiver.body, u = s.body, clock = Int64(now.timeIntervalSince1970 * 1000)
        let safe = Int64(9_007_199_254_740_991)
        let counters = [a.revision,a.keyEpoch,a.issuedAt,a.expiresAt,b.revision,b.keyEpoch,b.issuedAt,b.expiresAt,
            u.revision,u.sequence,u.lastHumanAt,u.idleExpiresAt,u.issuedAt,u.expiresAt]
        guard counters.allSatisfy({ $0 >= 0 && $0 <= safe }),
              [a.name,b.name].allSatisfy(CommunityAccessName.isValid),
              [a.issuedAt,b.issuedAt,u.issuedAt].allSatisfy({ $0 <= clock + 5_000 }),
              a.expiresAt > a.issuedAt, b.expiresAt > b.issuedAt, u.expiresAt > u.issuedAt else { throw ScreenCommunityError.expired }
        guard u == session.body, a.deviceKind == .mobile, b.deviceKind == .desktop, a.controlKey == nil, a.agentDeviceId == nil,
              a.profileId == authority.profileID, b.profileId == a.profileId, a.communityId == b.communityId,
              a.deviceId != b.deviceId, a.enrollmentId != b.enrollmentId, let control = b.controlKey,
              a.capabilities.contains(purpose.capability), b.capabilities.contains(purpose.capability), u.capabilities.contains(purpose.capability),
              Set(u.capabilities).isSubset(of: Set(a.capabilities)), u.capabilities == (try CommunityCapability.normalized(u.capabilities, kind: .mobile)),
              u.idleExpiresAt > clock, u.idleExpiresAt <= u.lastHumanAt + 3_600_000, u.lastHumanAt <= clock + 60_000,
              ![a.hostPublicKey,a.publicKey,a.biometricPublicKey,control].contains(u.publicKey),
              a.revision == u.revision, a.enrollmentId == u.enrollmentId, a.communityId == u.communityId else { throw ScreenCommunityError.wrongCommunity }
        _ = try CommunityMobileControlBytes.key(control); _ = try CommunityMobileControlBytes.key(u.publicKey)
    }
}

public struct CommunityMobileControlTranscript: Codable, Equatable, Sendable {
    public let version: Int
    public let purpose: CommunityMobileControlPurpose
    public let profileId, communityId, channelId, senderKind, receiverKind: String
    public let senderDeviceId, receiverDeviceId, senderEnrollmentId, receiverEnrollmentId: String
    public let senderPolicyDigest, receiverPolicyDigest, senderUseId, senderUsePublicKey, senderUsePolicyDigest: String
    public let senderConnectionId, receiverConnectionId, receiverBootId, receiverInstance: String
    public let senderEphemeral, receiverEphemeral, senderNonce, receiverNonce: String
    public static let fields = ["version","purpose","profileId","communityId","channelId","senderKind","receiverKind","senderDeviceId","receiverDeviceId","senderEnrollmentId","receiverEnrollmentId","senderPolicyDigest","receiverPolicyDigest","senderUseId","senderUsePublicKey","senderUsePolicyDigest","senderConnectionId","receiverConnectionId","receiverBootId","receiverInstance","senderEphemeral","receiverEphemeral","senderNonce","receiverNonce"]
    public static func decode(_ data: Data) throws -> Self {
        let value = try CommunityMobileControlJSON.object(data, maximum: 8_000)
        guard Set(value.keys) == Set(fields) else { throw ScreenCommunityError.malformed }
        let t = try JSONDecoder().decode(Self.self, from: CommunityMobileControlBytes.json(value)); try t.validateShape(); return t
    }
    private func validateShape() throws {
        guard version == 2, senderKind == "mobile", receiverKind == "desktop",
              [profileId,communityId,channelId,senderDeviceId,receiverDeviceId,senderEnrollmentId,receiverEnrollmentId,senderUseId,senderConnectionId,receiverConnectionId].allSatisfy(CommunityMobileControlBytes.id),
              [senderPolicyDigest,receiverPolicyDigest,senderUsePolicyDigest].allSatisfy({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }),
              [receiverBootId,receiverInstance].allSatisfy({ $0.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil }),
              senderDeviceId != receiverDeviceId, senderEnrollmentId != receiverEnrollmentId, senderConnectionId != receiverConnectionId,
              senderEphemeral != receiverEphemeral, senderNonce != receiverNonce else { throw ScreenCommunityError.malformed }
        _ = try CommunityMobileControlBytes.key(senderUsePublicKey); _ = try CommunityMobileControlBytes.key(senderEphemeral); _ = try CommunityMobileControlBytes.key(receiverEphemeral)
        _ = try CommunityMobileControlBytes.decode(senderNonce, bytes: 32); _ = try CommunityMobileControlBytes.decode(receiverNonce, bytes: 32)
    }
    public func validate(authority: ScreenCommunityAuthority, mobile: CommunityAuthorization, session: CommunityUseSession, receiver: CommunityAuthorization, purpose expectedPurpose: CommunityMobileControlPurpose, now: Date = Date()) throws {
        try validateShape(); try CommunityMobileControlPolicy.validate(authority: authority, mobile: mobile, session: session, receiver: receiver, purpose: purpose, now: now)
        let identityKeys = [mobile.body.hostPublicKey,mobile.body.publicKey,mobile.body.biometricPublicKey,session.body.publicKey,
            receiver.body.hostPublicKey,receiver.body.publicKey,receiver.body.biometricPublicKey,receiver.body.controlKey ?? ""]
        guard purpose == expectedPurpose, profileId == mobile.body.profileId, communityId == mobile.body.communityId,
              !identityKeys.contains(senderEphemeral), !identityKeys.contains(receiverEphemeral),
              senderDeviceId == mobile.body.deviceId, receiverDeviceId == receiver.body.deviceId,
              senderEnrollmentId == mobile.body.enrollmentId, receiverEnrollmentId == receiver.body.enrollmentId,
              senderPolicyDigest == (try CommunityMobileControlPolicy.authorizationDigest(mobile)), receiverPolicyDigest == (try CommunityMobileControlPolicy.authorizationDigest(receiver)),
              senderUseId == session.body.sessionId, senderUsePublicKey == session.body.publicKey,
              senderUsePolicyDigest == (try CommunityMobileControlPolicy.useDigest(authority: authority, authorization: mobile, session: session)) else { throw ScreenCommunityError.wrongCommunity }
    }
    public var canonicalBytes: Data { get throws {
        try validateShape()
        return try CommunityMobileControlBytes.json([version,purpose.rawValue,profileId,communityId,channelId,senderKind,receiverKind,senderDeviceId,receiverDeviceId,senderEnrollmentId,receiverEnrollmentId,senderPolicyDigest,receiverPolicyDigest,senderUseId,senderUsePublicKey,senderUsePolicyDigest,senderConnectionId,receiverConnectionId,receiverBootId,receiverInstance,senderEphemeral,receiverEphemeral,senderNonce,receiverNonce])
    } }
    public var hash: Data { get throws { CommunityMobileControlBytes.hash(Data("agentstoz.community-mobile-control/transcript/v2\0".utf8) + (try canonicalBytes)) } }
    public func proofBytes(role: CommunityMobileControlRole) throws -> Data { Data(("agentstoz.community-mobile-control/proof/v2\0" + role.rawValue + "\0").utf8) + (try hash) }
}
