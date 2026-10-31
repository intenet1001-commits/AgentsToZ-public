import Foundation

/// An ordered frame stream. Transport admission never grants screen/input authority: every implementation
/// must pass the same QR registration or pinned-key handshake before SecureConnection can be constructed.
public protocol ScreenFrameTransport: Sendable {
    func setMaxFrame(_ value: Int)
    func receive() async throws -> Data
    func send(_ payload: Data) async throws
    /// Enqueues synchronously, preserving the order in which SecureChannel seals its counters.
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void)
    func cancel()
}

/// The authenticated part is independent of LAN, nearby P2P, or the untrusted Internet relay.
public enum ScreenTransportHandshake {
    public static func connect(over framed: any ScreenFrameTransport, handshake: DeviceHandshake,
                               signer: any TranscriptSigner, timeout: Duration = .seconds(5)) async throws -> SecureConnection {
        framed.setMaxFrame(ScreenListener.preAuthMaxFrame)
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(for: timeout)) != nil else { return }
            if settled.claim() { framed.cancel() }
        }
        defer { watchdog.cancel() }
        do {
            try await framed.send(handshake.hello)
            let (finish, channel) = try await handshake.finish(macHello: try await framed.receive(), signer: signer)
            try await framed.send(finish)
            guard settled.claim() else { throw TransportError.timedOut }
            return SecureConnection(framed: framed, channel: channel)
        } catch {
            framed.cancel()
            throw settled.claim() ? error : TransportError.timedOut
        }
    }

    /// Reads nothing before the existing admission gate accepts this peer. The same five-second deadline,
    /// registration lifetime and signed key confirmation apply to every network path.
    public static func accept(over framed: any ScreenFrameTransport, peer: PeerKey, handshake: MacHandshake,
                              gate: PreAuthGate) async throws -> MacSession {
        framed.setMaxFrame(ScreenListener.preAuthMaxFrame)
        let ticket: PreAuthTicket
        switch await gate.admit(peer, at: .now) {
        case .success(let admitted): ticket = admitted
        case .failure(let refusal): framed.cancel(); throw refusal
        }
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(until: ticket.deadline, clock: .continuous)) != nil else { return }
            if settled.claim() { framed.cancel() }
        }
        defer { watchdog.cancel() }
        do {
            let (reply, pending) = try await handshake.respond(to: try await framed.receive())
            try await framed.send(reply)
            let channel = try await pending.confirm(try await framed.receive())
            guard settled.claim() else { throw TransportError.timedOut }
            _ = await gate.finish(ticket, succeeded: true, at: .now)
            return MacSession(deviceID: pending.deviceID, peer: peer,
                              connection: SecureConnection(framed: framed, channel: channel))
        } catch {
            framed.cancel()
            _ = await gate.finish(ticket, succeeded: false, at: .now)
            throw settled.claim() ? error : TransportError.timedOut
        }
    }
}
