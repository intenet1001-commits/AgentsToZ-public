import Foundation
import CryptoKit

public struct CommunityMobileControlContext: Sendable {
    public let authority: ScreenCommunityAuthority, mobile: CommunityAuthorization, session: CommunityUseSession, receiver: CommunityAuthorization
    public let purpose: CommunityMobileControlPurpose
    public init(authority: ScreenCommunityAuthority, mobile: CommunityAuthorization, session: CommunityUseSession, receiver: CommunityAuthorization, purpose: CommunityMobileControlPurpose, now: Date = Date()) throws {
        try CommunityMobileControlPolicy.validate(authority: authority, mobile: mobile, session: session, receiver: receiver, purpose: purpose, now: now)
        self.authority = authority; self.mobile = mobile; self.session = session; self.receiver = receiver; self.purpose = purpose
    }
    func sameEpisode(as initial: Self, now: Date = Date()) throws {
        try CommunityMobileControlPolicy.validate(authority: authority, mobile: mobile, session: session, receiver: receiver, purpose: purpose, now: now)
        guard purpose == initial.purpose, authority.origin == initial.authority.origin, authority.profileID == initial.authority.profileID,
              authority.issuer.x963Representation == initial.authority.issuer.x963Representation,
              try CommunityMobileControlPolicy.authorizationDigest(mobile) == CommunityMobileControlPolicy.authorizationDigest(initial.mobile),
              try CommunityMobileControlPolicy.authorizationDigest(receiver) == CommunityMobileControlPolicy.authorizationDigest(initial.receiver),
              try CommunityMobileControlPolicy.useDigest(authority: authority, authorization: mobile, session: session) == CommunityMobileControlPolicy.useDigest(authority: initial.authority, authorization: initial.mobile, session: initial.session) else { throw ScreenCommunityError.wrongCommunity }
    }
}
/// Constructed by the client only after the target's proof and key confirmation. The RAM-key owner rechecks this
/// structured context against its own current episode before signing; bytes alone are never a signing request.
public struct CommunityMobileControlProof: Sendable {
    public let context: CommunityMobileControlContext, transcript: CommunityMobileControlTranscript
    public let role: CommunityMobileControlRole
    public func validate(current: CommunityMobileControlContext, now: Date = Date()) throws {
        guard role == .client else { throw ScreenCommunityError.malformed }; try current.sameEpisode(as: context, now: now)
        try transcript.validate(authority: current.authority, mobile: current.mobile, session: current.session, receiver: current.receiver, purpose: current.purpose, now: now)
    }
    public var bytes: Data { get throws { try transcript.proofBytes(role: role) } }
}
public enum CommunityMobileControlClientError: Error, Sendable { case notDispatched, unknown, closed }

/// A channel is one target/purpose/episode. Every request and response rechecks the current foreground key owner.
/// No retry/fallback, no private-key serialization, and no automatic consumed acknowledgement.
public actor CommunityMobileControlClient {
    public typealias ContextProvider = @Sendable () async throws -> CommunityMobileControlContext
    public typealias ProofSigner = @Sendable (CommunityMobileControlProof) async throws -> Data
    public nonisolated let channelID: String
    private let initial: CommunityMobileControlContext, current: ContextProvider, signer: ProofSigner, wire: any CommunityMobileControlWire
    private let nonce: String
    private var agreement: P256.KeyAgreement.PrivateKey?
    private var cipher: CommunityMobileControlCipher?, transcript: CommunityMobileControlTranscript?
    private var active = false, closed = false, pump: Task<Void,Never>?
    private struct Pending { let continuation: CheckedContinuation<CommunityMobileControlResponse,Error>; let timeout: Task<Void,Never> }
    private var pending: [String:Pending] = [:]
    private init(context: CommunityMobileControlContext, wire: any CommunityMobileControlWire, current: @escaping ContextProvider, signer: @escaping ProofSigner) {
        initial = context; self.wire = wire; self.current = current; self.signer = signer
        channelID = UUID().uuidString.lowercased(); agreement = P256.KeyAgreement.PrivateKey()
        nonce = SymmetricKey(size: .bits256).withUnsafeBytes { ScreenCommunityRequest.base64(Data($0)) }
    }
    public static func connect(context: CommunityMobileControlContext, wire: any CommunityMobileControlWire, current: @escaping ContextProvider, signer: @escaping ProofSigner) async throws -> CommunityMobileControlClient {
        let client = Self(context: context, wire: wire, current: current, signer: signer)
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask { try await client.handshake() }
                group.addTask { try await Task.sleep(for: .seconds(10)); await client.close(); throw TransportError.timedOut }
                defer { group.cancelAll() }; _ = try await group.next()
            }
            await client.startPump(); return client
        } catch { await client.close(); throw error }
    }
    private func fresh() async throws -> CommunityMobileControlContext {
        guard !closed else { throw CommunityMobileControlClientError.closed }
        do {
            let value = try await current(); try value.sameEpisode(as: initial)
            guard !closed else { throw CommunityMobileControlClientError.closed }; return value
        } catch { await close(); throw error }
    }
    private static func envelope(_ value: Any) throws -> ScreenCommunityEnvelope {
        let object = try AccessValue.object(value, ["payload","signature"])
        return try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: CommunityMobileControlBytes.json(object))
    }
    private func nextHandshake() async throws -> (Data,String) {
        for _ in 0..<8 {
            switch try await wire.receive() {
            case .ended(let device,_): if device == initial.receiver.body.deviceId { throw TransportError.closed }
            case .data(let device,let connection,let bytes):
                if device == initial.receiver.body.deviceId { guard bytes.count <= 32_000 else { throw TransportError.badFrame }; return (bytes,connection) }
            }
        }
        throw TransportError.badFrame
    }
    private func handshake() async throws {
        let context = try await fresh(); guard let agreement else { throw TransportError.closed }
        let ephemeral = ScreenCommunityRequest.base64(agreement.publicKey.x963Representation)
        let hello: [String:Any] = ["v":2,"type":"hello","purpose":context.purpose.rawValue,"channelId":channelID,
            "senderAuthorization":try JSONSerialization.jsonObject(with: JSONEncoder().encode(context.mobile.envelope)),
            "senderUseSession":try JSONSerialization.jsonObject(with: JSONEncoder().encode(context.session.envelope)),
            "expectedReceiver":["deviceId":context.receiver.body.deviceId,"enrollmentId":context.receiver.body.enrollmentId,"policyDigest":try CommunityMobileControlPolicy.authorizationDigest(context.receiver)],
            "senderConnectionId":wire.connectionID,"receiverConnectionId":NSNull(),"senderEphemeral":ephemeral,"senderNonce":nonce]
        try await wire.send(to: context.receiver.body.deviceId, payload: CommunityMobileControlBytes.json(hello))
        let (challengeData,fromConnection) = try await nextHandshake(), challenge = try CommunityMobileControlJSON.object(challengeData, maximum: 32_000)
        guard Set(challenge.keys) == ["v","type","transcript","receiverAuthorization","hostProof","hostConfirmation"],
              try AccessValue.integer(challenge["v"] as Any) == 2, challenge["type"] as? String == "challenge",
              let proofText = challenge["hostProof"] as? String, let confirmationText = challenge["hostConfirmation"] as? String else { throw TransportError.badFrame }
        let t = try CommunityMobileControlTranscript.decode(CommunityMobileControlBytes.json(challenge["transcript"] as Any))
        let renewed = try await fresh()
        let reply = try CommunityAccessReply.verify(Self.envelope(challenge["receiverAuthorization"] as Any), authority: renewed.authority)
        let peer: CommunityAuthorization
        if reply.kind == "authorization" { peer = try reply.authorization(authority: renewed.authority) }
        else { let peers = try reply.directory(authority: renewed.authority, communityId: renewed.mobile.body.communityId); guard let match = peers.first(where: { $0.body.deviceId == renewed.receiver.body.deviceId }) else { throw ScreenCommunityError.wrongCommunity }; peer = match }
        let signingContext = try CommunityMobileControlContext(authority: renewed.authority, mobile: renewed.mobile, session: renewed.session, receiver: peer, purpose: renewed.purpose)
        try signingContext.sameEpisode(as: initial)
        try t.validate(authority: renewed.authority, mobile: renewed.mobile, session: renewed.session, receiver: peer, purpose: initial.purpose)
        guard t.channelId == channelID, t.senderConnectionId == wire.connectionID, t.receiverConnectionId == fromConnection,
              t.senderEphemeral == ephemeral, t.senderNonce == nonce else { throw ScreenCommunityError.wrongCommunity }
        let hostProof = try CommunityMobileControlBytes.decode(proofText, bytes: 64), hostConfirm = try CommunityMobileControlBytes.decode(confirmationText, bytes: 32)
        let hostKey = try CommunityMobileControlBytes.key(peer.body.controlKey!)
        guard try hostKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: hostProof), for: t.proofBytes(role: .host)) else { throw ScreenCommunityError.invalidSignature }
        var cipher = try CommunityMobileControlCipher(privateKey: agreement, transcript: t, role: .client)
        guard let keys = cipher.keys, try keys.verifiesConfirmation(hostConfirm, role: .host, signature: hostProof) else { throw ScreenCommunityError.invalidSignature }
        let request = CommunityMobileControlProof(context: signingContext, transcript: t, role: .client)
        let clientProof = try await signer(request); try request.validate(current: await fresh())
        guard try CommunityMobileControlBytes.key(renewed.session.body.publicKey).isValidSignature(P256.Signing.ECDSASignature(rawRepresentation: clientProof), for: request.bytes) else { throw ScreenCommunityError.invalidSignature }
        let finish: [String:Any] = ["v":2,"type":"finish","channelId":channelID,"clientProof":ScreenCommunityRequest.base64(clientProof),"clientConfirmation":ScreenCommunityRequest.base64(try keys.confirmation(role: .client, signature: clientProof))]
        try await wire.send(to: peer.body.deviceId, payload: CommunityMobileControlBytes.json(finish))
        let (readyData,readyFrom) = try await nextHandshake(), ready = try CommunityMobileControlJSON.object(readyData, maximum: 32_000)
        guard readyFrom == fromConnection, Set(ready.keys) == ["v","type","channelId","confirmation"], try AccessValue.integer(ready["v"] as Any) == 2,
              ready["type"] as? String == "ready", ready["channelId"] as? String == channelID, let readyText = ready["confirmation"] as? String,
              try keys.verifiesReady(CommunityMobileControlBytes.decode(readyText, bytes: 32), clientSignature: clientProof, hostSignature: hostProof) else { throw ScreenCommunityError.invalidSignature }
        _ = try await fresh(); guard !closed else { cipher.destroy(); throw TransportError.closed }
        self.cipher = cipher; transcript = t; self.agreement = nil; active = true
    }
    private func startPump() {
        pump = Task { [weak self, wire] in
            do { while !Task.isCancelled { let value = try await wire.receive(); guard let self else { return }; try await self.handle(value) } }
            catch { await self?.close() }
        }
    }
    private func handle(_ value: CommunityMobileControlRoutedFrame) async throws {
        _ = try await fresh(); guard active, let t = transcript else { throw TransportError.closed }
        switch value {
        case .ended(let device,let connection): if device == t.receiverDeviceId && connection == t.receiverConnectionId { throw TransportError.closed }
        case .data(let device,let connection,let payload):
            guard device == t.receiverDeviceId, connection == t.receiverConnectionId, var cipher else { throw ScreenCommunityError.wrongCommunity }
            let opened = try cipher.open(payload, fromConnectionID: connection); self.cipher = cipher
            let response = try CommunityMobileControlResponse.decode(opened.plaintext, expectedRequestID: opened.requestID)
            if let entry = pending.removeValue(forKey: response.requestID) { entry.timeout.cancel(); entry.continuation.resume(returning: response) }
            // A late response is never a consumed receipt and never revives a timed-out request.
        }
    }
    /// Effect callers persist their operation journal before calling. Unknown returns only to original-ID receipt UI.
    public func request(_ request: CommunityMobileControlRequest) async throws -> CommunityMobileControlResponse {
        guard active, !closed else { throw CommunityMobileControlClientError.notDispatched }
        _ = try await fresh()
        guard active, !closed, pending.count < 8, pending[request.requestID] == nil, var cipher else { throw CommunityMobileControlClientError.notDispatched }
        if request.mode == .effect, request.operation?.isAdmissible() != true { throw CommunityMobileControlClientError.notDispatched }
        let payload = try cipher.seal(request.encoded, requestID: request.requestID); self.cipher = cipher
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in try? await Task.sleep(for: .seconds(15)); guard !Task.isCancelled else { return }; await self?.failed(request.requestID) }
            pending[request.requestID] = Pending(continuation: continuation, timeout: timeout)
            Task { [weak self, wire, initial] in do { try await wire.send(to: initial.receiver.body.deviceId, payload: payload) } catch { await self?.failed(request.requestID) } }
        }
    }
    private func failed(_ id: String) { if let entry = pending.removeValue(forKey: id) { entry.timeout.cancel(); entry.continuation.resume(throwing: CommunityMobileControlClientError.unknown) } }
    deinit { pump?.cancel(); let connection = wire; Task { await connection.close() } }
    public func close() async {
        guard !closed else { return }; closed = true; active = false; pump?.cancel(); agreement = nil; cipher?.destroy(); cipher = nil
        for entry in pending.values { entry.timeout.cancel(); entry.continuation.resume(throwing: CommunityMobileControlClientError.unknown) }; pending = [:]
        await wire.close()
    }
}
