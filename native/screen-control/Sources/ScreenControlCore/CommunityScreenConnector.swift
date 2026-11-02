import Foundation

private final class OwnedCommunityScreenTransport: ScreenFrameTransport, Sendable {
    let stream: CommunityRelayFrameTransport
    let owner: CommunityRelayMultiplexer
    init(stream: CommunityRelayFrameTransport, owner: CommunityRelayMultiplexer) { self.stream = stream; self.owner = owner }
    func setMaxFrame(_ value: Int) { stream.setMaxFrame(value) }
    func receive() async throws -> Data { try await stream.receive() }
    func send(_ payload: Data) async throws { try await stream.send(payload) }
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) { stream.enqueue(payload, completion: completion) }
    func cancel() { stream.cancel(); owner.cancel() }
}
public enum CommunityScreenConnector {
    public struct Incoming: Sendable { public let session: MacSession, admission: CommunityScreenAdmission }
    /// Called only from the human Viewer's existing guarded connection action. No biometric prompt or legacy route
    /// fallback is hidden here. Native private-key proof replaces repeat biometric proof for an enrolled desktop.
    public static func connect(authority: ScreenCommunityAuthority, own: CommunityAuthorization, session: CommunityUseSession? = nil,
                               target: CommunityAuthorization, signer: any TranscriptSigner,
                               ticketProvider: @escaping CommunityRelayMultiplexer.TicketProvider,
                               signerProvider: (@Sendable () async throws -> any TranscriptSigner)? = nil,
                               timeout: Duration = .seconds(10)) async throws -> ScreenTargetConnector.Connected {
        let context = try CommunityRelayContext(communityID: own.body.communityId, enrollmentID: own.body.enrollmentId, deviceID: own.body.deviceId,
            publicKey: session?.body.publicKey ?? own.body.publicKey, role: .client, sessionID: session?.body.sessionId)
        let mux = try await CommunityRelayMultiplexer.open(authority: authority, context: context, ticketProvider: ticketProvider,
            proofSigner: { proof in
                let current = try await signerProvider?() ?? signer
                return try await proof.signed(by: current)
            })
        do {
            let stream = try await mux.openChannel(to: target.body.deviceId)
            let transport = OwnedCommunityScreenTransport(stream: stream, owner: mux)
            let handshake = try CommunityScreenClientHandshake(authority: authority, own: own, session: session, target: target, signer: signer,
                channelId: stream.channelID, connectionId: stream.ownConnectionID, requestedControl: own.body.capabilities.contains(.screenControl))
            let settled = Once()
            let deadline = Task { if (try? await Task.sleep(for: timeout)) != nil, settled.claim() { transport.cancel() } }
            defer { deadline.cancel() }
            do {
                try await transport.send(handshake.hello)
                let response = try await transport.receive()
                guard let connection = stream.binding.peerConnectionID else { throw HandshakeError.badSignature }
                let finish = try await handshake.finish(response, peerConnectionId: connection)
                try await transport.send(finish.message)
                guard settled.claim() else { throw TransportError.timedOut }
                let viewer = ScreenViewer(connection: SecureConnection(framed: transport, channel: finish.channel))
                return ScreenTargetConnector.Connected(viewer: viewer, path: .communityCloudflare(deviceId: target.body.deviceId), unreachable: [])
            } catch { transport.cancel(); throw settled.claim() ? error : TransportError.timedOut }
        } catch { mux.cancel(); throw error }
    }
    public static func accept(over stream: CommunityRelayFrameTransport, handshake: CommunityScreenHostHandshake,
                              peer: PeerKey, gate: PreAuthGate, timeout: Duration = .seconds(5)) async throws -> Incoming {
        let ticket: PreAuthTicket
        switch await gate.admit(peer, at: .now) {
        case .success(let admitted): ticket = admitted
        case .failure(let error): stream.cancel(); throw error
        }
        let settled = Once()
        let deadline = Task { if (try? await Task.sleep(for: timeout)) != nil, settled.claim() { stream.cancel() } }
        defer { deadline.cancel() }
        do {
            let hello = try await stream.receive(), binding = stream.binding
            guard let connection = binding.peerConnectionID else { throw HandshakeError.badSignature }
            let authenticatedBinding = try CommunityScreenBinding(channelId: binding.channelID, clientConnectionId: connection, hostConnectionId: binding.ownConnectionID)
            let response = try await handshake.respond(hello, binding: authenticatedBinding)
            guard response.pending.admission.controller.body.deviceId == binding.peerDeviceID else { throw HandshakeError.badSignature }
            try await stream.send(response.message)
            let channel = try await response.pending.confirm(stream.receive())
            guard settled.claim() else { throw TransportError.timedOut }
            _ = await gate.finish(ticket, succeeded: true, at: .now)
            let admission = response.pending.admission
            // Arbitration identifies the enrolled device, rather than its changing mobile episode key. A fresh
            // episode from the same device replaces its interrupted stream; the handshake still proves the RAM key.
            let key = try CommonScreenCredentialKey.key(for: admission.controller)
            return Incoming(session: MacSession(deviceID: ScreenControlIdentity.fingerprint(of: key), peer: peer, peerClass: admission.peerClass,
                connection: SecureConnection(framed: stream, channel: channel)), admission: admission)
        } catch {
            _ = await gate.finish(ticket, succeeded: false, at: .now); stream.cancel()
            throw settled.claim() ? error : TransportError.timedOut
        }
    }
}

import CryptoKit
private enum CommonScreenCredentialKey {
    static func key(for authorization: CommunityAuthorization) throws -> P256.Signing.PublicKey {
        try P256.Signing.PublicKey(x963Representation: AccessValue.key(authorization.body.publicKey))
    }
}
