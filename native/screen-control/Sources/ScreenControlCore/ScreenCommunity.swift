import CryptoKit
import Foundation
import CoreFoundation

/// Screen membership is independent of display-only OPS discovery and of phone protocol 4.
/// Only an issuer-pinned response can construct these values; a name or a local JSON file cannot grant access.
public enum ScreenCommunityError: Error, Equatable, Sendable {
    case malformed, invalidSignature, expired, wrongRequest, wrongCommunity, staleRevision, notConfigured
    case service(String)
}

public struct ScreenCommunityEnvelope: Codable, Equatable, Sendable {
    public let payload: String
    public let signature: String
    public var hostSignature: String?
    public init(payload: String, signature: String, hostSignature: String? = nil) {
        self.payload = payload; self.signature = signature; self.hostSignature = hostSignature
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Field.self)
        guard Set(container.allKeys.map(\.stringValue)).isSubset(of: ["payload", "signature", "hostSignature"]) else { throw ScreenCommunityError.malformed }
        payload = try container.decode(String.self, forKey: Field("payload"))
        signature = try container.decode(String.self, forKey: Field("signature"))
        hostSignature = try container.decodeIfPresent(String.self, forKey: Field("hostSignature"))
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Field.self)
        try c.encode(payload, forKey: Field("payload")); try c.encode(signature, forKey: Field("signature"))
        try c.encodeIfPresent(hostSignature, forKey: Field("hostSignature"))
    }
    private struct Field: CodingKey {
        var stringValue: String; var intValue: Int? { nil }
        init(_ value: String) { stringValue = value }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
}

public enum ScreenCommunityGrant: String, Codable, Sendable { case none, view, control }

public struct ScreenCommunityMember: Equatable, Sendable {
    public let enrollmentID: String
    public let deviceID: String
    public let name: String
    public let hostKey: Data
    public let viewerKey: Data
    public let platform: String
    public let grant: ScreenCommunityGrant
    public let admin: Bool
    public let keyEpoch: Int64
    public let joinedAt: Date
    public let route: String?
    public var registrationFingerprint: String { SHA256.hash(data: hostKey + viewerKey).prefix(6).map { String(format: "%02x", $0) }.joined() }

    fileprivate init(_ row: [Any]) throws {
        guard row.count == 10 || row.count == 11 else { throw ScreenCommunityError.malformed }
        enrollmentID = try CommunityValue.uuid(row[0]); deviceID = try CommunityValue.uuid(row[1])
        name = try CommunityValue.name(row[2]); hostKey = try CommunityValue.key(row[3]); viewerKey = try CommunityValue.key(row[4])
        guard hostKey != viewerKey, let raw = row[5] as? String, let grant = ScreenCommunityGrant(rawValue: raw),
              let admin = row[6] as? NSNumber, CFGetTypeID(admin) == CFBooleanGetTypeID() else { throw ScreenCommunityError.malformed }
        let platform = row.count == 11 ? row[10] as? String : "mac"
        guard platform == "mac" || platform == "ios", platform != "ios" || grant == .none else { throw ScreenCommunityError.malformed }
        self.platform = platform!
        self.grant = grant; self.admin = admin.boolValue; keyEpoch = try CommunityValue.integer(row[7])
        guard keyEpoch > 0 else { throw ScreenCommunityError.malformed }
        joinedAt = try CommunityValue.date(row[8])
        if row[9] is NSNull { route = nil }
        else {
            guard let address = row[9] as? String, (try? ScreenPrivateNetworkRoute(address: address)) != nil else { throw ScreenCommunityError.malformed }
            route = address
        }
    }
}

public struct ScreenCommunityCertificate: Sendable {
    public let communityID: String
    public let profileID: String
    public let member: ScreenCommunityMember
    public let expiresAt: Date
    public let envelope: ScreenCommunityEnvelope
}

public struct ScreenCommunityDirectory: Sendable {
    public let communityID: String
    public let profileID: String
    public let name: String
    public let revision: Int64
    public let expiresAt: Date
    public let selfEnrollmentID: String
    public let members: [ScreenCommunityMember]
    public let envelope: ScreenCommunityEnvelope
    public func isCurrent(at date: Date) -> Bool { date < expiresAt }
}

public struct ScreenCommunityResponse: @unchecked Sendable {
    public let kind: String
    public let requestID: String?
    public let issuedAt: Date
    public let envelope: ScreenCommunityEnvelope
    private let fields: [Any]
    private init(kind: String, requestID: String?, issuedAt: Date, fields: [Any], envelope: ScreenCommunityEnvelope) {
        self.kind = kind; self.requestID = requestID; self.issuedAt = issuedAt; self.fields = fields; self.envelope = envelope
    }
    public static func verify(_ envelope: ScreenCommunityEnvelope, issuer: P256.Signing.PublicKey,
                              expectedRequestID: String? = nil, now: Date = Date()) throws -> Self {
        guard envelope.hostSignature == nil else { throw ScreenCommunityError.malformed }
        let bytes = try CommunityValue.base64(envelope.payload, max: 65_536)
        let signature = try CommunityValue.base64(envelope.signature, max: 86)
        guard bytes.count <= 48_000, signature.count == 64,
              let sig = try? P256.Signing.ECDSASignature(rawRepresentation: signature),
              issuer.isValidSignature(sig, for: Data("agentstoz.screen-community.response/v1\0".utf8) + bytes)
        else { throw ScreenCommunityError.invalidSignature }
        guard let a = try JSONSerialization.jsonObject(with: bytes) as? [Any], a.count >= 4,
              try CommunityValue.integer(a[0]) == 1, let kind = a[1] as? String,
              ["community-info", "member", "invite", "pending", "pending-list", "pending-review", "enrollment-notice", "push-registered", "push-removed", "directory", "approved", "route", "revoked", "receipt", "error"].contains(kind)
        else { throw ScreenCommunityError.malformed }
        let id = a[2] is NSNull ? nil : try CommunityValue.uuid(a[2])
        let at = try CommunityValue.date(a[3])
        guard at <= now.addingTimeInterval(60) else { throw ScreenCommunityError.expired }
        if let expectedRequestID {
            guard id == expectedRequestID else { throw ScreenCommunityError.wrongRequest }
            guard at >= now.addingTimeInterval(-60) else { throw ScreenCommunityError.expired }
        }
        if kind == "error" {
            guard a.count == 5, let code = a[4] as? String, code.utf8.count <= 80,
                  code.range(of: "^[A-Z_]+$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
            throw ScreenCommunityError.service(code)
        }
        return Self(kind: kind, requestID: id, issuedAt: at, fields: a, envelope: envelope)
    }
    public func certificate(profileID: String, deviceID: String, hostKey: Data, viewerKey: Data, now: Date = Date()) throws -> ScreenCommunityCertificate {
        guard kind == "member", fields.count == 17 || fields.count == 18 else { throw ScreenCommunityError.malformed }
        let cid = try CommunityValue.uuid(fields[4]), profile = try CommunityValue.uuid(fields[5])
        let member = try ScreenCommunityMember(Array(fields[6..<(fields.count - 1)]))
        let expiry = try CommunityValue.date(fields[fields.count - 1])
        guard profile == profileID, member.deviceID == deviceID, member.hostKey == hostKey, member.viewerKey == viewerKey else { throw ScreenCommunityError.wrongCommunity }
        guard expiry > now, expiry <= issuedAt.addingTimeInterval(30 * 24 * 60 * 60), member.joinedAt <= issuedAt else { throw ScreenCommunityError.expired }
        return ScreenCommunityCertificate(communityID: cid, profileID: profile, member: member, expiresAt: expiry, envelope: envelope)
    }
    public func directory(for certificate: ScreenCommunityCertificate, minimumRevision: Int64 = 0, now: Date = Date()) throws -> ScreenCommunityDirectory {
        guard kind == "directory", fields.count == 11 else { throw ScreenCommunityError.malformed }
        let cid = try CommunityValue.uuid(fields[4]), profile = try CommunityValue.uuid(fields[5]), name = try CommunityValue.name(fields[6])
        let revision = try CommunityValue.integer(fields[7]), expiry = try CommunityValue.date(fields[8]), own = try CommunityValue.uuid(fields[9])
        guard cid == certificate.communityID, profile == certificate.profileID, own == certificate.member.enrollmentID else { throw ScreenCommunityError.wrongCommunity }
        guard revision >= minimumRevision else { throw ScreenCommunityError.staleRevision }
        guard revision > 0, expiry > now, expiry <= issuedAt.addingTimeInterval(90), certificate.expiresAt > now,
              let rows = fields[10] as? [[Any]], !rows.isEmpty, rows.count <= 32 else { throw ScreenCommunityError.expired }
        let members = try rows.map { try ScreenCommunityMember($0) }
        guard Set(members.map(\.enrollmentID)).count == members.count, Set(members.map(\.deviceID)).count == members.count,
              Set(members.flatMap { [$0.hostKey, $0.viewerKey] }).count == 2 * members.count,
              let me = members.first(where: { $0.enrollmentID == own }), me.deviceID == certificate.member.deviceID,
              me.hostKey == certificate.member.hostKey, me.viewerKey == certificate.member.viewerKey,
              members.allSatisfy({ $0.joinedAt <= issuedAt }) else { throw ScreenCommunityError.wrongCommunity }
        return ScreenCommunityDirectory(communityID: cid, profileID: profile, name: name, revision: revision,
                                        expiresAt: expiry, selfEnrollmentID: own, members: members, envelope: envelope)
    }
    /// Fixed enrollment DTOs are decoded only after issuer verification, and never become session authority.
    public func enrollmentFields(expectedKind: String, count: Int) throws -> [ScreenCommunityValue] {
        guard kind == expectedKind, fields.count == count else { throw ScreenCommunityError.malformed }
        return try fields.map(ScreenCommunityValue.init)
    }
    /// The outer fresh receipt authenticates an older result. Verify the nested signature and original ID
    /// before releasing a durable unknown-result fence; a signed wrapper alone is insufficient.
    public func recoveredReceipt(originalID: String, issuer: P256.Signing.PublicKey, now: Date = Date()) throws -> Self {
        guard kind == "receipt", fields.count == 6, fields[4] as? String == originalID,
              let raw = fields[5] as? [String: Any], Set(raw.keys) == ["payload", "signature"],
              let payload = raw["payload"] as? String, let signature = raw["signature"] as? String else { throw ScreenCommunityError.wrongRequest }
        let result = try Self.verify(ScreenCommunityEnvelope(payload: payload, signature: signature), issuer: issuer, now: now)
        guard result.requestID == originalID else { throw ScreenCommunityError.wrongRequest }
        return result
    }
}

/// A Sendable JSON value for code/receipt UI. No raw JSON object enters a membership constructor.
public indirect enum ScreenCommunityValue: Sendable, Equatable, Codable {
    case string(String), number(Int64), bool(Bool), null, array([ScreenCommunityValue])
    fileprivate init(_ value: Any) throws {
        if value is NSNull { self = .null }
        else if let value = value as? String { self = .string(value) }
        else if let value = value as? NSNumber {
            self = CFGetTypeID(value) == CFBooleanGetTypeID() ? .bool(value.boolValue) : .number(try CommunityValue.integer(value))
        } else if let value = value as? [Any] { self = .array(try value.map(Self.init)) }
        else { throw ScreenCommunityError.malformed }
    }
    public var string: String? { if case .string(let s) = self { s } else { nil } }
    public var number: Int64? { if case .number(let n) = self { n } else { nil } }
    public var array: [Self]? { if case .array(let a) = self { a } else { nil } }
    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Int64.self), n >= 0, n <= 9_007_199_254_740_991 { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([Self].self) { self = .array(a) }
        else { throw ScreenCommunityError.malformed }
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .null: try c.encodeNil(); case .bool(let b): try c.encode(b); case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s); case .array(let a): try c.encode(a) }
    }
    var json: Any {
        switch self { case .null: NSNull(); case .string(let s): s; case .number(let n): n; case .bool(let b): b; case .array(let a): a.map(\.json) }
    }
}

public struct ScreenCommunityRequest: Sendable {
    public enum Operation: String, Sendable { case discover, bootstrap, invite, join, entry, receipt, recover, lookup, review, approve, directory, route, revoke, leave
        case approveEntry = "approve-entry", pushRegister = "push-register", pushRemove = "push-remove" }
    public let id: String
    public let operation: Operation
    public let bytes: Data
    public init(operation: Operation, actor: String?, arguments: [ScreenCommunityValue], now: Date = Date(), id: UUID = UUID()) throws {
        guard arguments.count <= 8, actor == nil || (try? CommunityValue.uuid(actor!)) != nil else { throw ScreenCommunityError.malformed }
        self.id = id.uuidString.lowercased(); self.operation = operation
        let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let at = now.timeIntervalSince1970 * 1000
        guard at.isFinite, at >= 0, at < 9_007_199_254_740_991 else { throw ScreenCommunityError.malformed }
        bytes = try JSONSerialization.data(withJSONObject: [1, operation.rawValue, self.id, Int64(at), Self.base64(nonce), actor as Any? ?? NSNull(), arguments.map(\.json)], options: [.withoutEscapingSlashes])
        guard bytes.count <= 24_000 else { throw ScreenCommunityError.malformed }
    }
    public var transcript: Data { Data("agentstoz.screen-community.request/v1\0".utf8) + bytes }
    public func signed(by signer: any TranscriptSigner, hostSigner: (any TranscriptSigner)? = nil) async throws -> ScreenCommunityEnvelope {
        let signature = try await signer.signature(for: transcript)
        let host = try await hostSigner?.signature(for: transcript)
        guard operation == .bootstrap ? host != nil : host == nil else { throw ScreenCommunityError.malformed }
        return ScreenCommunityEnvelope(payload: Self.base64(bytes), signature: Self.base64(signature.rawRepresentation), hostSignature: host.map { Self.base64($0.rawRepresentation) })
    }
    public static func base64(_ bytes: Data) -> String { bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    public static func decodeBase64(_ string: String, max: Int = 32_768) throws -> Data { try CommunityValue.base64(string, max: max) }
    public static func key(_ signer: any TranscriptSigner) -> String { base64(signer.publicKey.x963Representation) }
    /// A biometric signature is allowed only for the exact action and arguments the person's UI just reviewed.
    /// The audited Screen broker supplies the fresh nonce/ID. Its prepared payload cannot substitute another action.
    public static func signPrepared(_ payload: String, operation: Operation, actor: String?, arguments: [ScreenCommunityValue],
                                    signer: any TranscriptSigner, now: Date = Date()) async throws -> String {
        guard [.bootstrap, .approve, .approveEntry, .pushRegister, .pushRemove, .revoke, .leave].contains(operation) else { throw ScreenCommunityError.malformed }
        let bytes = try CommunityValue.base64(payload, max: 32_768)
        guard let a = try JSONSerialization.jsonObject(with: bytes) as? [Any], a.count == 7,
              try CommunityValue.integer(a[0]) == 1, a[1] as? String == operation.rawValue,
              (try? CommunityValue.uuid(a[2])) != nil, let nonce = a[4] as? String,
              try CommunityValue.base64(nonce, max: 43).count == 32,
              (a[5] is NSNull ? nil : a[5] as? String) == actor,
              let args = a[6] as? [Any], try args.map(ScreenCommunityValue.init) == arguments,
              abs(try CommunityValue.date(a[3]).timeIntervalSince(now)) <= 60 else { throw ScreenCommunityError.malformed }
        return base64(try await signer.signature(for: Data("agentstoz.screen-community.request/v1\0".utf8) + bytes).rawRepresentation)
    }
}

private enum CommunityValue {
    static func base64(_ value: String, max: Int) throws -> Data {
        guard !value.isEmpty, value.utf8.count <= max, value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), ScreenCommunityRequest.base64(data) == value else { throw ScreenCommunityError.malformed }
        return data
    }
    static func key(_ value: Any) throws -> Data {
        guard let value = value as? String else { throw ScreenCommunityError.malformed }
        let raw = try base64(value, max: 87)
        guard raw.count == 65, raw.first == 4, (try? P256.Signing.PublicKey(x963Representation: raw)) != nil else { throw ScreenCommunityError.malformed }
        return raw
    }
    static func uuid(_ value: Any) throws -> String {
        guard let s = value as? String, UUID(uuidString: s)?.uuidString.lowercased() == s else { throw ScreenCommunityError.malformed }; return s
    }
    static func name(_ value: Any) throws -> String {
        guard let s = value as? String, !s.isEmpty, s.utf8.count <= 120, s.trimmingCharacters(in: .whitespacesAndNewlines) == s,
              !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format }) else { throw ScreenCommunityError.malformed }; return s
    }
    static func integer(_ value: Any) throws -> Int64 {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991, n.doubleValue.rounded(.towardZero) == n.doubleValue else { throw ScreenCommunityError.malformed }; return n.int64Value
    }
    static func date(_ value: Any) throws -> Date { Date(timeIntervalSince1970: Double(try integer(value)) / 1000) }
}
