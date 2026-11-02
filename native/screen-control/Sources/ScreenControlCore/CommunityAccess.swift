import Foundation
import CryptoKit
import CoreFoundation

public enum CommunityCapability: String, Codable, CaseIterable, Sendable {
    case screenView = "screen.view", screenControl = "screen.control", receiveView = "screen.receive.view", receiveControl = "screen.receive.control"
    case communicate = "agent.communicate", teams = "teams.run", agentSettings = "computer-use.agent-settings", browser = "computer-use.browser"
    public var title: String {
        switch self {
        case .screenView: "다른 기기 화면 보기"
        case .screenControl: "다른 기기 화면 조작"
        case .receiveView: "이 Mac 화면 보기 허용"
        case .receiveControl: "이 Mac 화면 조작 허용"
        case .communicate: "에이전트 통신"
        case .teams: "Teams 작업"
        case .agentSettings: "에포트 변경"
        case .browser: "AgentsToZ 브라우저 제어"
        }
    }
    public static func normalized(_ values: [Self], kind: CommunityDeviceKind) throws -> [Self] {
        guard !values.isEmpty, Set(values).count == values.count,
              kind != .mobile || !values.contains(where: { $0 == .receiveView || $0 == .receiveControl }),
              !values.contains(.screenControl) || values.contains(.screenView),
              !values.contains(.receiveControl) || values.contains(.receiveView) else { throw ScreenCommunityError.malformed }
        return allCases.filter { values.contains($0) }
    }
}
public enum CommunityDeviceKind: String, Codable, Sendable { case desktop, mobile }
public struct CommunityAccessPlan: Codable, Equatable, Sendable {
    public let version: Int
    public let profileId: String, deviceId: String, name: String
    public let kind: CommunityDeviceKind
    public let hostKey: String, biometricKey: String, operationKey: String
    public let controlKey: String?
    public let agentDeviceId: String?
    public let capabilities: [CommunityCapability]
    public init(profileId: String, deviceId: String, name: String, kind: CommunityDeviceKind, hostKey: Data, biometricKey: Data, operationKey: Data, controlKey: Data? = nil, agentDeviceId: String? = nil, capabilities: [CommunityCapability]) throws {
        _ = try AccessValue.id(profileId); _ = try AccessValue.id(deviceId)
        let keys = [hostKey, biometricKey, operationKey] + (controlKey.map { [$0] } ?? [])
        guard CommunityAccessName.isValid(name), Set(keys).count == keys.count else { throw ScreenCommunityError.malformed }
        for key in keys { _ = try P256.Signing.PublicKey(x963Representation: key) }
        self.version = 1; self.profileId = profileId; self.deviceId = deviceId; self.name = name; self.kind = kind
        self.hostKey = ScreenCommunityRequest.base64(hostKey); self.biometricKey = ScreenCommunityRequest.base64(biometricKey); self.operationKey = ScreenCommunityRequest.base64(operationKey)
        self.controlKey = controlKey.map(ScreenCommunityRequest.base64); self.agentDeviceId = agentDeviceId
        if let agentDeviceId { _ = try AccessValue.id(agentDeviceId) }
        self.capabilities = try CommunityCapability.normalized(capabilities, kind: kind)
        guard kind != .mobile || (controlKey == nil && agentDeviceId == nil),
              kind != .desktop || !capabilities.contains(where: { $0 == .communicate || $0 == .teams }) || agentDeviceId != nil, kind != .desktop || !capabilities.contains(where: { $0 == .agentSettings || $0 == .browser || $0 == .communicate || $0 == .teams }) || controlKey != nil else { throw ScreenCommunityError.malformed }
    }
    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(version, forKey: .version); try c.encode(profileId, forKey: .profileId); try c.encode(deviceId, forKey: .deviceId)
        try c.encode(name, forKey: .name); try c.encode(kind, forKey: .kind); try c.encode(hostKey, forKey: .hostKey)
        try c.encode(biometricKey, forKey: .biometricKey); try c.encode(operationKey, forKey: .operationKey)
        if let controlKey { try c.encode(controlKey, forKey: .controlKey) } else { try c.encodeNil(forKey: .controlKey) }
        if let agentDeviceId { try c.encode(agentDeviceId, forKey: .agentDeviceId) } else { try c.encodeNil(forKey: .agentDeviceId) }
        try c.encode(capabilities, forKey: .capabilities)
    }
    public var digest: String {
        get throws {
            let data = try JSONSerialization.data(withJSONObject: [version, profileId, deviceId, name, kind.rawValue, hostKey, biometricKey, operationKey, controlKey as Any? ?? NSNull(), agentDeviceId as Any? ?? NSNull(), capabilities.map(\.rawValue)], options: .withoutEscapingSlashes)
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
    }
    static func checked(_ value: Any) throws -> Self {
        let object = try AccessValue.object(value, ["version", "profileId", "deviceId", "name", "kind", "hostKey", "biometricKey", "operationKey", "controlKey", "agentDeviceId", "capabilities"])
        let plan = try JSONDecoder().decode(Self.self, from: JSONSerialization.data(withJSONObject: object))
        guard plan.version == 1 else { throw ScreenCommunityError.malformed }
        return try Self(profileId: plan.profileId, deviceId: plan.deviceId, name: plan.name, kind: plan.kind,
                        hostKey: AccessValue.key(plan.hostKey), biometricKey: AccessValue.key(plan.biometricKey), operationKey: AccessValue.key(plan.operationKey), controlKey: try plan.controlKey.map(AccessValue.key), agentDeviceId: plan.agentDeviceId, capabilities: plan.capabilities)
    }
}
public struct CommunityAuthorization: Sendable {
    public struct Body: Codable, Equatable, Sendable {
        public let version: Int
        public let communityId: String, profileId: String, enrollmentId: String, deviceId: String
        public let deviceKind: CommunityDeviceKind
        public let name: String, hostPublicKey: String, publicKey: String, biometricPublicKey: String
        public let controlKey: String?
    public let agentDeviceId: String?
        public let capabilities: [CommunityCapability]
        public let revision: Int64, keyEpoch: Int64, issuedAt: Int64, expiresAt: Int64
    }
    public let body: Body
    public let envelope: ScreenCommunityEnvelope
    public func isCurrent(at date: Date = Date()) -> Bool { date.timeIntervalSince1970 * 1000 < Double(body.expiresAt) }
}
public struct CommunityUseSession: Sendable {
    public struct Body: Codable, Equatable, Sendable {
        public let version: Int
        public let communityId: String, enrollmentId: String, sessionId: String, publicKey: String
        public let capabilities: [CommunityCapability]
        public let revision: Int64, sequence: Int64, lastHumanAt: Int64, idleExpiresAt: Int64, issuedAt: Int64, expiresAt: Int64
    }
    public let body: Body
    public let envelope: ScreenCommunityEnvelope
}
public struct CommunityAccessReview: Sendable {
    public let plan: CommunityAccessPlan
    public let planId: String, admin: String, digest: String, challenge: String
    public let revision: Int64, expiresAt: Int64
}
public struct CommunityAccessReply: @unchecked Sendable {
    public let kind: String, requestId: String
    public let issuedAt: Int64
    public let envelope: ScreenCommunityEnvelope
    let value: Any
    public static func verify(_ envelope: ScreenCommunityEnvelope, authority: ScreenCommunityAuthority, requestId: String? = nil, now: Date = Date()) throws -> Self {
        guard envelope.hostSignature == nil else { throw ScreenCommunityError.malformed }
        let data = try ScreenCommunityRequest.decodeBase64(envelope.payload, max: 65_536)
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: ScreenCommunityRequest.decodeBase64(envelope.signature, max: 86))
        guard data.count <= 48_000, authority.issuer.isValidSignature(signature, for: Data("agentstoz.community-access.response/v2\0".utf8) + data),
              let fields = try JSONSerialization.jsonObject(with: data) as? [Any], fields.count == 5,
              try AccessValue.integer(fields[0]) == 2, let kind = fields[1] as? String,
              ["prepared", "pending-list", "review", "authorization", "directory", "session", "session-closed", "receipt", "ticket", "error"].contains(kind) else { throw ScreenCommunityError.invalidSignature }
        let id = try AccessValue.id(fields[2]), at = try AccessValue.integer(fields[3]), clock = now.timeIntervalSince1970 * 1000
        guard Double(at) <= clock + 60_000 else { throw ScreenCommunityError.expired }
        if let requestId { guard id == requestId, Double(at) >= clock - 60_000 else { throw ScreenCommunityError.wrongRequest } }
        if kind == "error" {
            let object = try AccessValue.object(fields[4], ["code"])
            guard let code = object["code"] as? String, code.range(of: "^[A-Z_]{1,80}$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
            throw ScreenCommunityError.service(code)
        }
        return Self(kind: kind, requestId: id, issuedAt: at, envelope: envelope, value: fields[4])
    }
    private func authorization(_ value: Any, envelope: ScreenCommunityEnvelope, authority: ScreenCommunityAuthority, now: Date) throws -> CommunityAuthorization {
        let object = try AccessValue.object(value, ["version", "communityId", "profileId", "enrollmentId", "deviceId", "deviceKind", "name", "hostPublicKey", "publicKey", "biometricPublicKey", "controlKey", "agentDeviceId", "capabilities", "revision", "keyEpoch", "issuedAt", "expiresAt"])
        let body = try JSONDecoder().decode(CommunityAuthorization.Body.self, from: JSONSerialization.data(withJSONObject: object))
        for value in [body.communityId, body.profileId, body.enrollmentId, body.deviceId] { _ = try AccessValue.id(value) }
        _ = try AccessValue.key(body.publicKey); _ = try AccessValue.key(body.biometricPublicKey); _ = try AccessValue.key(body.hostPublicKey)
        if let agentDeviceId = body.agentDeviceId { _ = try AccessValue.id(agentDeviceId) }
        if let controlKey = body.controlKey { _ = try AccessValue.key(controlKey) }
        let boundKeys = [body.publicKey, body.biometricPublicKey, body.hostPublicKey] + (body.controlKey.map { [$0] } ?? [])
        guard body.version == 1, body.profileId == authority.profileID, CommunityAccessName.isValid(body.name), Set(boundKeys).count == boundKeys.count,
              body.deviceKind != .mobile || (body.controlKey == nil && body.agentDeviceId == nil),
              body.deviceKind != .desktop || !body.capabilities.contains(where: { $0 == .communicate || $0 == .teams }) || body.agentDeviceId != nil, body.deviceKind != .desktop || !body.capabilities.contains(where: { $0 == .agentSettings || $0 == .browser || $0 == .communicate || $0 == .teams }) || body.controlKey != nil,
              body.revision > 0, body.keyEpoch > 0, body.issuedAt == issuedAt, body.expiresAt > Int64(now.timeIntervalSince1970 * 1000),
              body.expiresAt <= body.issuedAt + 90_000,
              try CommunityCapability.normalized(body.capabilities, kind: body.deviceKind) == body.capabilities else { throw ScreenCommunityError.expired }
        return CommunityAuthorization(body: body, envelope: envelope)
    }
    public func authorization(authority: ScreenCommunityAuthority, now: Date = Date()) throws -> CommunityAuthorization {
        guard kind == "authorization" else { throw ScreenCommunityError.malformed }
        return try authorization(value, envelope: envelope, authority: authority, now: now)
    }
    public func directory(authority: ScreenCommunityAuthority, communityId: String, now: Date = Date()) throws -> [CommunityAuthorization] {
        guard kind == "directory", let values = value as? [Any], !values.isEmpty, values.count <= 32 else { throw ScreenCommunityError.malformed }
        let result = try values.map { try authorization($0, envelope: envelope, authority: authority, now: now) }
        guard result.allSatisfy({ $0.body.communityId == communityId }), Set(result.map { $0.body.enrollmentId }).count == result.count,
              Set(result.map { $0.body.deviceId }).count == result.count, Set(result.map { $0.body.publicKey }).count == result.count else { throw ScreenCommunityError.wrongCommunity }
        return result
    }
    public func session(for authorization: CommunityAuthorization, now: Date = Date()) throws -> CommunityUseSession {
        guard kind == "session", authorization.body.deviceKind == .mobile else { throw ScreenCommunityError.malformed }
        let object = try AccessValue.object(value, ["version", "communityId", "enrollmentId", "sessionId", "publicKey", "capabilities", "revision", "sequence", "lastHumanAt", "idleExpiresAt", "issuedAt", "expiresAt"])
        let body = try JSONDecoder().decode(CommunityUseSession.Body.self, from: JSONSerialization.data(withJSONObject: object))
        _ = try AccessValue.id(body.sessionId); _ = try AccessValue.key(body.publicKey)
        let clock = Int64(now.timeIntervalSince1970 * 1000)
        guard body.version == 1, body.communityId == authorization.body.communityId, body.enrollmentId == authorization.body.enrollmentId,
              body.revision == authorization.body.revision, body.sequence >= 0, body.issuedAt == issuedAt, body.lastHumanAt <= issuedAt,
              body.idleExpiresAt > body.lastHumanAt, body.idleExpiresAt <= body.lastHumanAt + 3_600_000,
              body.expiresAt > clock, body.expiresAt <= min(body.issuedAt + 90_000, body.idleExpiresAt),
              body.publicKey != authorization.body.publicKey, body.publicKey != authorization.body.biometricPublicKey,
              try CommunityCapability.normalized(body.capabilities, kind: .mobile) == body.capabilities,
              Set(body.capabilities).isSubset(of: Set(authorization.body.capabilities)) else { throw ScreenCommunityError.wrongCommunity }
        return CommunityUseSession(body: body, envelope: envelope)
    }
    public func review(authority: ScreenCommunityAuthority, adminId: String, now: Date = Date()) throws -> CommunityAccessReview {
        guard kind == "review" else { throw ScreenCommunityError.malformed }
        let object = try AccessValue.object(value, ["admin", "planId", "digest", "revision", "challenge", "expiresAt", "plan"])
        let plan = try CommunityAccessPlan.checked(object["plan"] as Any)
        let admin = try AccessValue.id(object["admin"] as Any), id = try AccessValue.id(object["planId"] as Any)
        let revision = try AccessValue.integer(object["revision"] as Any), expiry = try AccessValue.integer(object["expiresAt"] as Any)
        guard plan.profileId == authority.profileID, admin == adminId, let digest = object["digest"] as? String, digest == (try plan.digest),
              let challenge = object["challenge"] as? String, try ScreenCommunityRequest.decodeBase64(challenge, max: 43).count == 32,
              revision > 0, expiry > Int64(now.timeIntervalSince1970 * 1000), expiry <= issuedAt + 120_000 else { throw ScreenCommunityError.wrongCommunity }
        return CommunityAccessReview(plan: plan, planId: id, admin: admin, digest: digest, challenge: challenge, revision: revision, expiresAt: expiry)
    }
    public func encodedValue() throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) }
}
public struct CommunityAccessRequest: Sendable {
    public enum Operation: String, Sendable {
        case prepare, status, receipt, list, review, approve, authorization, directory, activity
        case componentStatus = "component-status", componentDirectory = "component-directory", componentTicket = "component-ticket"
        case receiverStatus = "receiver-status", receiverDirectory = "receiver-directory", receiverTicket = "receiver-ticket", receiverSession = "receiver-session"
        case sessionOpen = "session-open", sessionStatus = "session-status", sessionClose = "session-close", relayTicket = "relay-ticket"
    }
    public let operation: Operation, id: String, bytes: Data
    public init(operation: Operation, actor: String?, argumentsJSON: Data, now: Date = Date(), id: UUID = UUID()) throws {
        let arguments = try JSONSerialization.jsonObject(with: argumentsJSON)
        guard let arguments = arguments as? [Any], arguments.count <= 5, actor == nil || (try? AccessValue.id(actor!)) != nil else { throw ScreenCommunityError.malformed }
        let at = now.timeIntervalSince1970 * 1000
        guard at.isFinite, at >= 0, at < 9_007_199_254_740_991 else { throw ScreenCommunityError.malformed }
        self.operation = operation; self.id = id.uuidString.lowercased()
        bytes = try JSONSerialization.data(withJSONObject: [2, operation.rawValue, self.id, Int64(at), ScreenCommunityRequest.base64(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }), actor as Any? ?? NSNull(), arguments], options: .withoutEscapingSlashes)
        guard bytes.count <= 24_000 else { throw ScreenCommunityError.malformed }
    }
    public func signed(by signer: any TranscriptSigner) async throws -> ScreenCommunityEnvelope {
        let signature = try await signer.signature(for: Data("agentstoz.community-access.request/v2\0".utf8) + bytes)
        return ScreenCommunityEnvelope(payload: ScreenCommunityRequest.base64(bytes), signature: ScreenCommunityRequest.base64(signature.rawRepresentation))
    }
    /// Host IPC accepts only fixed read/staging operations for its own identity. Approvals, session activation,
    /// tickets and arbitrary signatures are never delegated to the automatic Screen host key.
    public static func validateHostProof(_ transcript: Data, profileId: String, deviceId: String, hostKey: Data,
                                         biometricKey: Data?, certificate: ScreenCommunityCertificate?, authorization: CommunityAuthorization? = nil, now: Date = Date()) throws {
        let domain = Data("agentstoz.community-access.request/v2\0".utf8)
        guard transcript.starts(with: domain), transcript.count <= 24_100,
              let fields = try JSONSerialization.jsonObject(with: transcript.dropFirst(domain.count)) as? [Any], fields.count == 7,
              try AccessValue.integer(fields[0]) == 2, let raw = fields[1] as? String, let operation = Operation(rawValue: raw),
              let args = fields[6] as? [Any] else { throw ScreenCommunityError.malformed }
        _ = try AccessValue.id(fields[2])
        let at = try AccessValue.integer(fields[3])
        guard abs(Double(at) - now.timeIntervalSince1970 * 1000) <= 60_000, let nonce = fields[4] as? String,
              try ScreenCommunityRequest.decodeBase64(nonce, max: 43).count == 32 else { throw ScreenCommunityError.expired }
        switch operation {
        case .prepare:
            guard fields[5] is NSNull, args.count == 1, let biometricKey else { throw ScreenCommunityError.wrongCommunity }
            let plan = try CommunityAccessPlan.checked(args[0])
            guard plan.profileId == profileId, plan.deviceId == deviceId, plan.kind == .desktop,
                  plan.hostKey == ScreenCommunityRequest.base64(hostKey), plan.biometricKey == ScreenCommunityRequest.base64(biometricKey) else { throw ScreenCommunityError.wrongCommunity }
        case .status, .receipt:
            guard args.count == 1 else { throw ScreenCommunityError.malformed }; _ = try AccessValue.id(args[0])
            if !(fields[5] is NSNull) { guard let certificate, fields[5] as? String == certificate.member.enrollmentID else { throw ScreenCommunityError.wrongCommunity } }
            if operation == .status, !(fields[5] is NSNull) { throw ScreenCommunityError.wrongCommunity }
        case .list, .review:
            guard let certificate, certificate.member.admin, fields[5] as? String == certificate.member.enrollmentID,
                  args.first as? String == certificate.communityID, args.count == (operation == .list ? 1 : 2) else { throw ScreenCommunityError.wrongCommunity }
            if operation == .review { _ = try AccessValue.id(args[1]) }
        case .receiverStatus, .receiverDirectory, .receiverTicket, .receiverSession:
            guard let authorization, authorization.body.deviceKind == .desktop, authorization.body.deviceId == deviceId,
                  authorization.body.profileId == profileId, authorization.body.hostPublicKey == ScreenCommunityRequest.base64(hostKey),
                  authorization.body.capabilities.contains(.receiveView), fields[5] as? String == authorization.body.enrollmentId,
                  args.first as? String == authorization.body.communityId,
                  args.count == (operation == .receiverTicket ? 2 : operation == .receiverSession ? 3 : 1) else { throw ScreenCommunityError.wrongCommunity }
            for arg in args.dropFirst() { _ = try AccessValue.id(arg) }
        default: throw ScreenCommunityError.malformed
        }
    }
}
enum AccessValue {
    static func object(_ value: Any, _ keys: Set<String>) throws -> [String: Any] {
        guard let value = value as? [String: Any], Set(value.keys) == keys else { throw ScreenCommunityError.malformed }; return value
    }
    static func id(_ value: Any) throws -> String {
        guard let value = value as? String, UUID(uuidString: value)?.uuidString.lowercased() == value else { throw ScreenCommunityError.malformed }; return value
    }
    static func integer(_ value: Any) throws -> Int64 {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite,
              value.doubleValue >= 0, value.doubleValue <= 9_007_199_254_740_991, value.doubleValue == Double(value.int64Value) else { throw ScreenCommunityError.malformed }; return value.int64Value
    }
    static func key(_ value: String) throws -> Data {
        let bytes = try ScreenCommunityRequest.decodeBase64(value, max: 87); _ = try P256.Signing.PublicKey(x963Representation: bytes)
        guard bytes.count == 65 else { throw ScreenCommunityError.malformed }; return bytes
    }
}
