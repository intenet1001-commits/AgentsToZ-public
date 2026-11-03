import CryptoKit
import Foundation

public struct ScreenCommunityDevice: Sendable {
    public let id: String
    public let name: String
    public let platform: String
    public let grant: ScreenCommunityGrant
    public init(id: String, name: String, platform: String, grant: ScreenCommunityGrant) throws {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id, RegistrationInvite.isShowableName(name),
              platform == "mac" || platform == "ios", platform == "mac" || grant == .none else { throw ScreenCommunityError.malformed }
        self.id = id; self.name = name; self.platform = platform; self.grant = grant
    }
}

public struct ScreenCommunityEnrollmentState: Codable, Sendable {
    public let deviceID: String
    public let hostKey: Data
    public let viewerKey: Data
    public var certificate: ScreenCommunityEnvelope?
    public var submittedID: String?
    public var submittedEnvelope: ScreenCommunityEnvelope?
    public var uncertainMutation = false
    public var pending: ScreenCommunityEnvelope?
    public var minimumRevision: Int64 = 0
    /// Persist before a leave request. Losing a response must never restore this device's outgoing access.
    public var locallyLeft: Bool?
    public init(deviceID: String, hostKey: Data, viewerKey: Data) {
        self.deviceID = deviceID; self.hostKey = hostKey; self.viewerKey = viewerKey
    }
    /// Preparing keys alone is not enrollment and must not start an endless network poll.
    /// Unknown requests remain durable after their receipt window; only automatic polling stops then.
    public func automaticRefreshInterval(at now: Date = Date()) -> TimeInterval? {
        if certificate != nil, locallyLeft != true { return 30 }
        guard submittedID != nil, let envelope = submittedEnvelope,
              let data = try? ScreenCommunityRequest.decodeBase64(envelope.payload),
              let a = try? JSONSerialization.jsonObject(with: data) as? [Any], a.count == 7,
              let at = a[3] as? Double, at.isFinite, at >= 0,
              at / 1000 <= now.timeIntervalSince1970 + 60, at / 1000 + 600 > now.timeIntervalSince1970 else { return nil }
        return 3
    }
}

/// Signed request context fetched after a notification tap; the push itself is not an approval capability.
public struct ScreenCommunityReview: Sendable {
    public let pendingID: String
    public let device: ScreenCommunityDevice
    public let hostKey: Data
    public let viewerKey: Data
    public let expiresAt: Date
    public let revision: Int64
    public let fingerprint: String
    fileprivate let communityID: String
    fileprivate let challenge: String
    public init(response: ScreenCommunityResponse, certificate: ScreenCommunityCertificate, now: Date = Date()) throws {
        let a = try response.enrollmentFields(expectedKind: "pending-review", count: 16)
        guard a[4].string == certificate.communityID, a[7].string == certificate.profileID,
              let revision = a[5].number, revision > 0, let id = a[6].string, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let deviceID = a[8].string, let name = a[9].string, let platform = a[15].string,
              let host = a[10].string, let viewer = a[11].string, let rawGrant = a[12].string,
              let grant = ScreenCommunityGrant(rawValue: rawGrant), let expiry = a[13].number, let challenge = a[14].string,
              challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
        let expires = Date(timeIntervalSince1970: Double(expiry) / 1000)
        guard expires > now, expires <= response.issuedAt.addingTimeInterval(120) else { throw ScreenCommunityError.expired }
        hostKey = try Self.rawKey(host); viewerKey = try Self.rawKey(viewer)
        guard hostKey != viewerKey else { throw ScreenCommunityError.malformed }
        device = try ScreenCommunityDevice(id: deviceID, name: name, platform: platform, grant: grant)
        pendingID = id; communityID = certificate.communityID; self.revision = revision; self.expiresAt = expires; self.challenge = challenge
        fingerprint = SHA256.hash(data: hostKey + viewerKey).prefix(6).map { String(format: "%02x", $0) }.joined()
    }
    fileprivate static func rawKey(_ raw: String) throws -> Data {
        let padded = raw.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - raw.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), ScreenCommunityRequest.base64(bytes) == raw,
              bytes.count == 65, (try? P256.Signing.PublicKey(x963Representation: bytes)) != nil else { throw ScreenCommunityError.malformed }; return bytes
    }
}

/// Shared registration state for Mac, iPad and iPhone. Storage adapters own the keychain; tests inject memory.
/// There is no screen-session start/input method here. Uncertain writes are recovered by receipt/exact-key lookup.
public actor ScreenCommunityEnrollment {
    public typealias Save = @Sendable (ScreenCommunityEnrollmentState) throws -> Void
    public typealias Exchange = @Sendable (ScreenCommunityEnvelope, String) async throws -> ScreenCommunityResponse
    private let authority: ScreenCommunityAuthority
    private let device: ScreenCommunityDevice
    private let identity: any TranscriptSigner
    private let viewerKey: Data
    private let save: Save
    private let exchange: Exchange
    private let now: @Sendable () -> Date
    private var state: ScreenCommunityEnrollmentState
    private var busy = false

    public init(authority: ScreenCommunityAuthority, device: ScreenCommunityDevice, identity: any TranscriptSigner,
                viewerKey: Data, state: ScreenCommunityEnrollmentState?, save: @escaping Save,
                exchange: Exchange? = nil, now: @escaping @Sendable () -> Date = { Date() }) throws {
        _ = try P256.Signing.PublicKey(x963Representation: viewerKey)
        guard identity.publicKey.x963Representation != viewerKey else { throw ScreenCommunityError.malformed }
        self.authority = authority; self.device = device; self.identity = identity; self.viewerKey = viewerKey; self.save = save; self.now = now
        if let state {
            guard state.deviceID == device.id, state.hostKey == identity.publicKey.x963Representation, state.viewerKey == viewerKey else { throw ScreenCommunityError.wrongCommunity }
            self.state = state
        } else { self.state = ScreenCommunityEnrollmentState(deviceID: device.id, hostKey: identity.publicKey.x963Representation, viewerKey: viewerKey) }
        self.exchange = exchange ?? { try await ScreenCommunityHTTP(authority: authority).send($0, expectedRequestID: $1) }
    }
    public func snapshot() -> ScreenCommunityEnrollmentState { state }
    private func store() throws { try save(state) }
    private func request(_ op: ScreenCommunityRequest.Operation, actor: String?, _ args: [ScreenCommunityValue], signer: (any TranscriptSigner)? = nil,
                         mutation: Bool = false, hostProof: Bool = false) async throws -> ScreenCommunityResponse {
        if mutation { guard !state.uncertainMutation else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") } }
        let request = try ScreenCommunityRequest(operation: op, actor: actor, arguments: args, now: now())
        let envelope = try await request.signed(by: signer ?? identity, hostSigner: hostProof ? identity : nil)
        if mutation {
            let before = state
            state.submittedID = request.id; state.submittedEnvelope = envelope; state.uncertainMutation = true
            do { try store() } catch { state = before; throw error }
        }
        do {
            let result = try await exchange(envelope, request.id)
            let kinds: [ScreenCommunityRequest.Operation: String] = [.bootstrap: "member", .join: "pending", .entry: "pending", .approve: "approved",
                .approveEntry: "approved", .revoke: "revoked", .leave: "revoked", .route: "route", .pushRegister: "push-registered", .pushRemove: "push-removed"]
            if mutation { guard result.kind == kinds[op] else { throw ScreenCommunityError.malformed } }
            if mutation { state.uncertainMutation = false; try store() }
            return result
        } catch ScreenCommunityError.service(let code) where !["UNAVAILABLE", "SERVICE_UNAVAILABLE", "REQUEST_CONFLICT"].contains(code) {
            // This is a verified rejection, not a lost transport reply. A later explicit user action may retry.
            if mutation {
                state.uncertainMutation = false
                if [.bootstrap, .join, .entry].contains(op) { state.submittedID = nil; state.submittedEnvelope = nil }
                try store()
            }
            if [.directory, .recover].contains(op), ["NOT_ENROLLED", "REGISTRATION_REVOKED"].contains(code), state.certificate != nil {
                state.certificate = nil; state.pending = nil; state.locallyLeft = true
                if !state.uncertainMutation { state.submittedID = nil; state.submittedEnvelope = nil }
                try store()
            }
            throw ScreenCommunityError.service(code)
        }
    }
    public func certificate() throws -> ScreenCommunityCertificate {
        guard state.locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        return try storedCertificate()
    }
    /// Refresh only the signed self-member certificate, even when an older certificate is still valid.
    /// Replaying a historical enrollment receipt must never leave management-role UI stale.
    /// This read does not clear a mutation journal, change keys or request biometric approval.
    public func refreshSelfCertificate() async throws -> ScreenCommunityCertificate {
        try enter();defer { busy=false }
        guard state.locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        let response=try await request(.recover,actor:nil,[.string(authority.profileID),.string(device.id),.string(ScreenCommunityRequest.key(identity)),.string(ScreenCommunityRequest.base64(viewerKey))])
        let certificate=try response.certificate(profileID:authority.profileID,deviceID:device.id,hostKey:identity.publicKey.x963Representation,viewerKey:viewerKey,now:now())
        state.certificate=response.envelope;try store();return certificate
    }
    private func storedCertificate() throws -> ScreenCommunityCertificate {
        guard let envelope = state.certificate else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return try ScreenCommunityResponse.verify(envelope, issuer: authority.issuer, now: now())
            .certificate(profileID: authority.profileID, deviceID: device.id, hostKey: identity.publicKey.x963Representation, viewerKey: viewerKey, now: now())
    }
    private func accept(_ response: ScreenCommunityResponse) throws {
        if response.kind == "member" {
            _ = try response.certificate(profileID: authority.profileID, deviceID: device.id, hostKey: identity.publicKey.x963Representation, viewerKey: viewerKey, now: now())
            state.certificate = response.envelope; state.pending = nil
        } else if response.kind == "pending" {
            let a = try response.enrollmentFields(expectedKind: "pending", count: 13)
            guard a[6].string == authority.profileID, a[10].string == device.id, a[11].string == ScreenCommunityRequest.key(identity),
                  a[12].string == ScreenCommunityRequest.base64(viewerKey), let deadline = a[8].number,
                  Double(deadline) / 1000 > now().timeIntervalSince1970 else { throw ScreenCommunityError.wrongCommunity }
            state.pending = response.envelope
        } else { throw ScreenCommunityError.malformed }
        try store()
    }
    public func discover() async throws -> String {
        try enter(); defer { busy = false }
        let response = try await request(.discover, actor: nil, [.string(ScreenCommunityRequest.key(identity)), .string(authority.profileID)])
        let a = try response.enrollmentFields(expectedKind: "community-info", count: 7)
        guard a[5].string == authority.profileID, let id = a[4].string, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ScreenCommunityError.wrongCommunity }; return id
    }
    public func pendingRequests() async throws -> ScreenCommunityResponse {
        try enter(); defer { busy = false }; let certificate = try certificate()
        guard certificate.member.admin else { throw ScreenCommunityError.service("ADMIN_REQUIRED") }
        return try await request(.lookup, actor: certificate.member.enrollmentID, [.string(certificate.communityID)])
    }
    private func enter() throws { guard !busy else { throw ScreenCommunityError.service("BUSY") }; busy = true }
    public func join(communityID: String, invitation: String? = nil) async throws {
        try enter(); defer { busy = false }
        guard state.certificate == nil, state.submittedID == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
        // A new explicit join stages a new approval, using the same device keys. It does not revive old membership.
        if state.locallyLeft == true { state.locallyLeft = false; try store() }
        var args: [ScreenCommunityValue] = [.string(authority.profileID), .string(device.id), .string(device.name), .string(ScreenCommunityRequest.key(identity)),
            .string(ScreenCommunityRequest.base64(viewerKey)), .string(device.grant.rawValue), .string(invitation ?? communityID), .string(device.platform)]
        // The server validates a public community ID. It may only stage a pending request, never grant access.
        if let invitation { guard invitation.range(of: "^[0-9]{8}$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed } }
        else { guard UUID(uuidString: communityID)?.uuidString.lowercased() == communityID else { throw ScreenCommunityError.malformed } }
        let response = try await request(invitation == nil ? .entry : .join, actor: nil, args, mutation: true)
        args.removeAll(); try accept(response)
    }
    public func createCommunity(name: String, approvedSigner: any TranscriptSigner) async throws {
        try enter(); defer { busy = false }
        guard state.certificate == nil, state.submittedID == nil, approvedSigner.publicKey.x963Representation == viewerKey else { throw ScreenCommunityError.wrongCommunity }
        let response = try await request(.bootstrap, actor: nil, [.string(authority.profileID), .string(device.id), .string(device.name),
            .string(ScreenCommunityRequest.key(identity)), .string(ScreenCommunityRequest.base64(viewerKey)), .string(device.grant.rawValue), .string(name), .string(device.platform)],
            signer: approvedSigner, mutation: true, hostProof: true)
        try accept(response)
    }
    public func recover() async throws {
        try enter(); defer { busy = false }
        if let id = state.submittedID {
            do {
                let response = try await request(.receipt, actor: nil, [.string(id)])
                if response.kind == "member" || response.kind == "pending" {
                    guard state.locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                    try accept(response); state.uncertainMutation = false; try store(); return
                }
                if response.kind == "receipt" {
                    let original = try response.recoveredReceipt(originalID: id, issuer: authority.issuer, now: now())
                    try finishRecoveredMutation(original)
                    return
                }
            } catch ScreenCommunityError.service(let code) where ["RECEIPT_NOT_FOUND", "CODE_EXPIRED_OR_USED"].contains(code) {
                // Expired staging is a definitive refusal, not an unknown approval/revocation result.
                if code == "CODE_EXPIRED_OR_USED", state.pending != nil, !state.uncertainMutation {
                    state.pending = nil; state.submittedID = nil; state.submittedEnvelope = nil; try store()
                }
            }
        }
        guard state.locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        let response = try await request(.recover, actor: nil, [.string(authority.profileID), .string(device.id),
            .string(ScreenCommunityRequest.key(identity)), .string(ScreenCommunityRequest.base64(viewerKey))])
        try accept(response)
    }
    private func finishRecoveredMutation(_ result: ScreenCommunityResponse) throws {
        guard let envelope = state.submittedEnvelope,
              let raw = try JSONSerialization.jsonObject(with: ScreenCommunityRequest.decodeBase64(envelope.payload)) as? [Any], raw.count == 7,
              let operation = raw[1] as? String, let arguments = raw[6] as? [Any] else { throw ScreenCommunityError.malformed }
        if ["bootstrap", "join", "entry"].contains(operation) {
            guard state.locallyLeft != true, result.kind == (operation == "bootstrap" ? "member" : "pending") else { throw ScreenCommunityError.malformed }
            try accept(result)
            state.uncertainMutation = false
            try store()
            return
        }
        let expected: [String: String] = ["approve": "approved", "approve-entry": "approved", "revoke": "revoked", "leave": "revoked",
            "route": "route", "push-register": "push-registered", "push-remove": "push-removed"]
        guard result.kind == expected[operation] else { throw ScreenCommunityError.malformed }
        if operation == "leave" || operation == "revoke" {
            let a = try result.enrollmentFields(expectedKind: "revoked", count: 7)
            let target = operation == "leave" ? raw[5] as? String : arguments.dropFirst().first as? String
            guard a[4].string == arguments.first as? String, a[6].string == target,
                  let revision = a[5].number, revision >= state.minimumRevision else { throw ScreenCommunityError.wrongCommunity }
            state.minimumRevision = revision
            if operation == "leave" { state.certificate = nil; state.pending = nil }
        }
        state.uncertainMutation = false; state.submittedID = nil; state.submittedEnvelope = nil; try store()
    }
    /// Only the issuer's current directory can select a revocation target; display names are not authority.
    public func revoke(_ member: ScreenCommunityMember, directory: ScreenCommunityDirectory, approvedSigner: any TranscriptSigner) async throws {
        try enter(); defer { busy = false }; let certificate = try certificate()
        guard certificate.member.admin, directory.communityID == certificate.communityID, directory.isCurrent(at: now()),
              directory.revision >= state.minimumRevision, directory.members.contains(member), member.enrollmentID != certificate.member.enrollmentID,
              approvedSigner.publicKey.x963Representation == viewerKey else { throw ScreenCommunityError.wrongCommunity }
        let result = try await request(.revoke, actor: certificate.member.enrollmentID, [.string(certificate.communityID),
            .string(member.enrollmentID), .number(directory.revision)], signer: approvedSigner, mutation: true)
        try finishRecoveredMutation(result)
    }
    public func leave() async throws {
        try enter(); defer { busy = false }
        guard !state.uncertainMutation else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
        let certificate = try storedCertificate()
        let before = state; state.locallyLeft = true
        do { try store() } catch { state = before; throw error }
        do {
            let result = try await request(.leave, actor: certificate.member.enrollmentID, [.string(certificate.communityID)], mutation: true)
            try finishRecoveredMutation(result)
        } catch ScreenCommunityError.service(let code) where !state.uncertainMutation {
            // A signed refusal (e.g. the last administrator) did not remove membership. Do not strand the owner.
            state.locallyLeft = false; try store(); throw ScreenCommunityError.service(code)
        }
    }
    public func directory(prepareHost: (@Sendable (ScreenCommunityCertificate) async throws -> Void)? = nil) async throws -> ScreenCommunityDirectory {
        try enter(); defer { busy = false }
        let certificate = try certificate()
        // A newly enrolled Screen must receive its issuer-verified certificate before its host key may
        // sign a member-directory request. Reversing these operations strands the first administrator.
        try await prepareHost?(certificate)
        let response = try await request(.directory, actor: certificate.member.enrollmentID, [.string(certificate.communityID)])
        let directory = try response.directory(for: certificate, minimumRevision: state.minimumRevision, now: now())
        if directory.revision != state.minimumRevision { state.minimumRevision = directory.revision; try store() }
        return directory
    }
    public func review(pendingID: String) async throws -> ScreenCommunityReview {
        try enter(); defer { busy = false }; let certificate = try certificate()
        guard certificate.member.admin else { throw ScreenCommunityError.service("ADMIN_REQUIRED") }
        let response = try await request(.review, actor: certificate.member.enrollmentID, [.string(certificate.communityID), .string(pendingID)])
        return try ScreenCommunityReview(response: response, certificate: certificate, now: now())
    }
    public func approve(_ review: ScreenCommunityReview, grant: ScreenCommunityGrant, administrator: Bool = false,
                        approvedSigner: any TranscriptSigner) async throws {
        try enter(); defer { busy = false }; let certificate = try certificate()
        guard certificate.member.admin, review.communityID == certificate.communityID, review.expiresAt > now(),
              approvedSigner.publicKey.x963Representation == viewerKey else { throw ScreenCommunityError.wrongCommunity }
        _ = try await request(.approveEntry, actor: certificate.member.enrollmentID, [.string(certificate.communityID), .string(review.pendingID),
            .string(review.challenge), .string(grant.rawValue), .bool(administrator), .number(review.revision)], signer: approvedSigner, mutation: true)
    }
    public func subscribe(token: Data, environment: String, topic: String, approvedSigner: any TranscriptSigner) async throws {
        try enter(); defer { busy = false }; let certificate = try certificate()
        guard certificate.member.admin, approvedSigner.publicKey.x963Representation == viewerKey else { throw ScreenCommunityError.wrongCommunity }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        _ = try await request(.pushRegister, actor: certificate.member.enrollmentID, [.string(certificate.communityID), .string(hex), .string(environment), .string(topic)],
                              signer: approvedSigner, mutation: true)
    }
    public func pendingFromNotification(_ envelope: ScreenCommunityEnvelope) throws -> String {
        let certificate = try certificate()
        let response = try ScreenCommunityResponse.verify(envelope, issuer: authority.issuer, now: now())
        let a = try response.enrollmentFields(expectedKind: "enrollment-notice", count: 8)
        guard certificate.member.admin, a[4].string == certificate.communityID, let id = a[5].string, response.requestID == id,
              UUID(uuidString: id)?.uuidString.lowercased() == id, let expiry = a[6].number,
              Double(expiry) / 1000 > now().timeIntervalSince1970,
              Double(expiry) / 1000 <= response.issuedAt.addingTimeInterval(300).timeIntervalSince1970 else { throw ScreenCommunityError.wrongCommunity }
        return id // Only opens a review. A fresh signed context and a separate biometric approval are still required.
    }
}
