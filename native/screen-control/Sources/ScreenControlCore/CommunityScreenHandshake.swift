import Foundation
import CryptoKit

/// Explicit community protocol 6. This is never negotiated through the legacy phone4/Mac5 handshake.
/// The complete issuer credentials, roles, target, transport channel, nonces and ephemeral keys enter both
/// signatures and HKDF. A relay's device name, admission ACK or substituted exchange key cannot grant a session.
public struct CommunityScreenBinding: Equatable, Sendable {
    public let channelId: String, clientConnectionId: String, hostConnectionId: String
    public init(channelId: String, clientConnectionId: String, hostConnectionId: String) throws {
        for id in [channelId, clientConnectionId, hostConnectionId] { _ = try AccessValue.id(id) }
        self.channelId = channelId; self.clientConnectionId = clientConnectionId; self.hostConnectionId = hostConnectionId
    }
}
public struct CommunityScreenAdmission: Sendable {
    public let controller: CommunityAuthorization, receiver: CommunityAuthorization
    public let useSession: CommunityUseSession?
    public let binding: CommunityScreenBinding
    public let canControl: Bool
    public let desktopTrust:CommunityDesktopScreenTrust?
    init(controller:CommunityAuthorization,receiver:CommunityAuthorization,useSession:CommunityUseSession?,binding:CommunityScreenBinding,canControl:Bool,desktopTrust:CommunityDesktopScreenTrust?=nil) {
        self.controller=controller;self.receiver=receiver;self.useSession=useSession;self.binding=binding;self.canControl=canControl;self.desktopTrust=desktopTrust
    }
    public var peerClass: ScreenPeerClass { controller.body.deviceKind == .mobile ? .phone : .controller }
    public var expiresAt: Date {
        Date(timeIntervalSince1970: Double(min(controller.body.expiresAt, receiver.body.expiresAt, useSession?.body.expiresAt ?? Int64.max)) / 1000)
    }
}
private enum CommonScreenWire {
    static let hello = Data("agentstoz.screen-control/v6/hello".utf8)
    static let answer = Data("agentstoz.screen-control/v6/answer".utf8)
    static let finish = Data("agentstoz.screen-control/v6/finish".utf8)
    static let labels = HandshakeLabels(version: 6)
    static let maxFrame = 24_000
    static func fields(_ data: Data, _ count: Int, _ tag: Data) throws -> [Data] {
        guard data.count <= maxFrame else { throw HandshakeError.malformed }
        let fields = try LengthPrefixed.decode(data, count: count)
        guard fields.first == tag else { throw HandshakeError.malformed }; return fields
    }
    static func text(_ data: Data) throws -> String {
        guard let value = String(data: data, encoding: .utf8) else { throw HandshakeError.malformed }; return value
    }
    static func credential(_ data: Data, authority: ScreenCommunityAuthority, now: Date) throws -> CommunityAuthorization {
        let envelope = try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: data)
        return try CommunityAccessReply.verify(envelope, authority: authority, now: now).authorization(authority: authority, now: now)
    }
    static func session(_ data: Data, authorization: CommunityAuthorization, authority: ScreenCommunityAuthority, now: Date) throws -> CommunityUseSession? {
        if authorization.body.deviceKind == .desktop { guard data.isEmpty else { throw HandshakeError.malformed }; return nil }
        let envelope = try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: data)
        return try CommunityAccessReply.verify(envelope, authority: authority, now: now).session(for: authorization, now: now)
    }
    static func controllerKey(_ auth: CommunityAuthorization, _ session: CommunityUseSession?) throws -> P256.Signing.PublicKey {
        try P256.Signing.PublicKey(x963Representation: AccessValue.key(session?.body.publicKey ?? auth.body.publicKey))
    }
    static func admission(controller: CommunityAuthorization, receiver: CommunityAuthorization, session: CommunityUseSession?, binding: CommunityScreenBinding, requestedControl: Bool,authority:ScreenCommunityAuthority,now:Date) throws -> CommunityScreenAdmission {
        let client = controller.body, host = receiver.body
        let scopes = session?.body.capabilities ?? client.capabilities
        guard client.communityId == host.communityId, client.profileId == host.profileId, client.deviceId != host.deviceId,
              host.deviceKind == .desktop, host.capabilities.contains(.receiveView), scopes.contains(.screenView) else { throw ScreenCommunityError.wrongCommunity }
        let trust:CommunityDesktopScreenTrust?
        if client.deviceKind == .desktop,client.capabilities.contains(.desktopTrust),host.capabilities.contains(.desktopTrust) {
            trust=try CommunityDesktopScreenTrust.verified(authority:authority,controller:controller,receiver:receiver,channelId:binding.channelId,now:now)
        } else { trust=nil }
        return .init(controller: controller, receiver: receiver, useSession: session, binding: binding,
                     canControl: requestedControl && scopes.contains(.screenControl) && host.capabilities.contains(.receiveControl),desktopTrust:trust)
    }
    static func hash(_ hello: Data, _ header: Data) -> Data {
        sha256(LengthPrefixed.encode([Data(ScreenControlProtocol.name.utf8), UInt16(6).bigEndianData, hello, header]))
    }
}
public actor CommunityScreenClientHandshake {
    private let authority: ScreenCommunityAuthority
    private let own: CommunityAuthorization, target: CommunityAuthorization
    private let session: CommunityUseSession?
    private let signer: any TranscriptSigner
    private let ephemeral = P256.KeyAgreement.PrivateKey()
    private let requestedControl: Bool
    private let channelId: String, connectionId: String
    private var used = false
    public nonisolated let hello: Data
    public init(authority: ScreenCommunityAuthority, own: CommunityAuthorization, session: CommunityUseSession? = nil,
                target: CommunityAuthorization, signer: any TranscriptSigner, channelId: String, connectionId: String,
                requestedControl: Bool, now: Date = Date()) throws {
        _ = try AccessValue.id(channelId); _ = try AccessValue.id(connectionId)
        let verifiedOwn = try CommonScreenWire.credential(JSONEncoder().encode(own.envelope), authority: authority, now: now)
        let verifiedSession = try CommonScreenWire.session(session.map { try JSONEncoder().encode($0.envelope) } ?? Data(), authorization: verifiedOwn, authority: authority, now: now)
        guard target.isCurrent(at: now), target.body.profileId == authority.profileID,
              try CommonScreenWire.controllerKey(verifiedOwn, verifiedSession).x963Representation == signer.publicKey.x963Representation else { throw ScreenCommunityError.wrongCommunity }
        self.authority = authority; self.own = verifiedOwn; self.target = target; self.session = verifiedSession; self.signer = signer
        self.channelId = channelId; self.connectionId = connectionId; self.requestedControl = requestedControl
        hello = try LengthPrefixed.encode([CommonScreenWire.hello, Data(target.body.deviceId.utf8), Data(channelId.utf8), Data(connectionId.utf8),
            JSONEncoder().encode(verifiedOwn.envelope), verifiedSession.map { try JSONEncoder().encode($0.envelope) } ?? Data(), randomBytes(32), ephemeral.publicKey.x963Representation,
            Data([requestedControl ? 1 : 0])])
    }
    public func finish(_ response: Data, peerConnectionId: String, now: Date = Date()) async throws -> (message: Data, channel: SecureChannel, admission: CommunityScreenAdmission) {
        guard !used else { throw HandshakeError.alreadyUsed }; used = true
        let response = try LengthPrefixed.decode(response, count: 3)
        let header = try CommonScreenWire.fields(response[0], 6, CommonScreenWire.answer)
        let receiver = try CommonScreenWire.credential(header[1], authority: authority, now: now)
        guard own.isCurrent(at: now), session == nil || session!.body.expiresAt > Int64(now.timeIntervalSince1970 * 1000),
              header[2].count == 32, header[3].count == 65, header[5] == sha256(hello),
              receiver.body.deviceId == target.body.deviceId, receiver.body.enrollmentId == target.body.enrollmentId,
              receiver.body.hostPublicKey == target.body.hostPublicKey, receiver.body.revision >= target.body.revision,
              try CommonScreenWire.text(header[4]) == peerConnectionId else { throw HandshakeError.badSignature }
        let binding = try CommunityScreenBinding(channelId: channelId, clientConnectionId: connectionId, hostConnectionId: peerConnectionId)
        let admission = try CommonScreenWire.admission(controller: own, receiver: receiver, session: session, binding: binding, requestedControl: requestedControl,authority:authority,now:now)
        let hash = CommonScreenWire.hash(hello, response[0]), labels = CommonScreenWire.labels
        let key = try P256.Signing.PublicKey(x963Representation: AccessValue.key(receiver.body.hostPublicKey))
        guard key.isValidSignature(try signature(response[1]), for: labels.macSignature + hash) else { throw HandshakeError.badSignature }
        let keys = SessionKeys(secret: try ephemeral.sharedSecretFromKeyAgreement(with: ephemeralKey(header[3])), transcriptHash: hash, labels: labels)
        guard confirmationIsValid(response[2], keys.macConfirm, hash, response[1]) else { throw HandshakeError.badConfirmation }
        let proof = try await signer.signature(for: labels.deviceSignature + hash).rawRepresentation
        return (LengthPrefixed.encode([CommonScreenWire.finish, proof, confirmation(keys.deviceConfirm, hash, proof)]),
                SecureChannel(role: .device, sendKey: keys.deviceToMac, receiveKey: keys.macToDevice, version: 6), admission)
    }
}
public struct CommunityScreenHostHandshake: Sendable {
    private let authority: ScreenCommunityAuthority, own: CommunityAuthorization
    private let signer: any TranscriptSigner
    private let replay: NonceReplayCache
    private let admits: @Sendable (CommunityAuthorization, CommunityUseSession?) async throws -> Void
    public init(authority: ScreenCommunityAuthority, own: CommunityAuthorization, signer: any TranscriptSigner, replay: NonceReplayCache,
                admits: @escaping @Sendable (CommunityAuthorization, CommunityUseSession?) async throws -> Void) throws {
        guard own.body.deviceKind == .desktop, own.body.hostPublicKey == ScreenCommunityRequest.base64(signer.publicKey.x963Representation) else { throw ScreenCommunityError.wrongCommunity }
        self.authority = authority; self.own = own; self.signer = signer; self.replay = replay; self.admits = admits
    }
    public func respond(_ hello: Data, binding: CommunityScreenBinding, now: Date = Date()) async throws -> (message: Data, pending: CommunityScreenPending) {
        let fields = try CommonScreenWire.fields(hello, 9, CommonScreenWire.hello)
        let receiver = try CommonScreenWire.credential(JSONEncoder().encode(own.envelope), authority: authority, now: now)
        guard try CommonScreenWire.text(fields[1]) == receiver.body.deviceId,
              try CommonScreenWire.text(fields[2]) == binding.channelId, try CommonScreenWire.text(fields[3]) == binding.clientConnectionId,
              fields[6].count == 32, fields[7].count == 65, fields[8].count == 1, fields[8].first == 0 || fields[8].first == 1 else { throw HandshakeError.malformed }
        let controller = try CommonScreenWire.credential(fields[4], authority: authority, now: now)
        let session = try CommonScreenWire.session(fields[5], authorization: controller, authority: authority, now: now)
        let admission = try CommonScreenWire.admission(controller: controller, receiver: receiver, session: session, binding: binding, requestedControl: fields[8].first == 1,authority:authority,now:now)
        try await admits(controller, session)
        guard await replay.insert(fields[6]) else { throw HandshakeError.replayedNonce }
        let ephemeral = P256.KeyAgreement.PrivateKey(), labels = CommonScreenWire.labels
        let header = try LengthPrefixed.encode([CommonScreenWire.answer, JSONEncoder().encode(receiver.envelope), randomBytes(32), ephemeral.publicKey.x963Representation,
                                               Data(binding.hostConnectionId.utf8), sha256(hello)])
        let hash = CommonScreenWire.hash(hello, header)
        let keys = SessionKeys(secret: try ephemeral.sharedSecretFromKeyAgreement(with: ephemeralKey(fields[7])), transcriptHash: hash, labels: labels)
        let proof = try await signer.signature(for: labels.macSignature + hash).rawRepresentation
        return (LengthPrefixed.encode([header, proof, confirmation(keys.macConfirm, hash, proof)]),
                CommunityScreenPending(admission: admission, key: try CommonScreenWire.controllerKey(controller, session), hash: hash, keys: keys))
    }
}
public actor CommunityScreenPending {
    public nonisolated let admission: CommunityScreenAdmission
    private let key: P256.Signing.PublicKey, hash: Data, keys: SessionKeys
    private var used = false
    fileprivate init(admission: CommunityScreenAdmission, key: P256.Signing.PublicKey, hash: Data, keys: SessionKeys) {
        self.admission = admission; self.key = key; self.hash = hash; self.keys = keys
    }
    public func confirm(_ data: Data, now: Date = Date()) throws -> SecureChannel {
        guard !used else { throw HandshakeError.alreadyUsed }; used = true
        guard admission.expiresAt > now else { throw ScreenCommunityError.expired }
        let fields = try CommonScreenWire.fields(data, 3, CommonScreenWire.finish)
        guard key.isValidSignature(try signature(fields[1]), for: CommonScreenWire.labels.deviceSignature + hash) else { throw HandshakeError.badSignature }
        guard confirmationIsValid(fields[2], keys.deviceConfirm, hash, fields[1]) else { throw HandshakeError.badConfirmation }
        return SecureChannel(role: .mac, sendKey: keys.macToDevice, receiveKey: keys.deviceToMac, version: 6)
    }
}
