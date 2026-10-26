import Foundation
import Network
import os

// Registration over TCP (DESIGN 「켜기와 기기 등록」). The phone sends one request; the Mac answers with its
// acknowledgement, and once the person at the Mac has decided, with its verdict. The Mac listens on a port of its own
// only while its QR is on screen, behind the same pre-authentication limits as the screen listener.
//
// Frames: request = [record, proof, attestation, attestation key ID] (length-prefixed). Replies start with one byte:
// 1 and the acknowledgement, then 1 and the approval signature; or 0 alone for a refusal, which never says why.

enum RegistrationWire {
    /// The attestation object is the largest field, about 5 KB.
    static let maxFrame = 16 * 1024
    static let accepted: UInt8 = 1, refused: UInt8 = 0

    static func reply(_ payload: Data?) -> Data { payload.map { Data([accepted]) + $0 } ?? Data([refused]) }

    static func open(_ reply: Data) throws -> Data {
        guard let tag = reply.first else { throw RegistrationError.malformed }
        guard tag == accepted, reply.count > 1 else {
            throw tag == refused && reply.count == 1 ? RegistrationError.refused : RegistrationError.malformed
        }
        return reply.dropFirst()
    }
}

/// A verified request waiting for the person at the Mac. Exactly one of `approve` or `refuse` reaches the phone.
public final class PendingRegistration: Sendable {
    public let acceptance: RegistrationAcceptance
    public let peer: PeerKey
    let framed: FramedConnection
    let signer: TranscriptSigner
    private let decided = Once()

    init(acceptance: RegistrationAcceptance, peer: PeerKey, framed: FramedConnection, signer: TranscriptSigner) {
        self.acceptance = acceptance
        self.peer = peer
        self.framed = framed
        self.signer = signer
    }

    /// Call only after Touch ID or the password approved this device and the registry holds it.
    public func approve() async throws {
        guard decided.claim() else { return }
        defer { framed.cancel() }
        try await framed.send(RegistrationWire.reply(try await RegistrationApproval.make(for: acceptance.record, signer: signer)))
    }

    public func refuse() async {
        guard decided.claim() else { return }
        try? await framed.send(RegistrationWire.reply(nil))
        framed.cancel()
    }
}

/// The Mac's registration listener for one QR. Local-network peers only, bound to `host`.
public final class RegistrationListener: Sendable {
    public enum Outcome: Sendable {
        /// The request checked out and its acknowledgement is on its way: show the SAS and ask the person.
        case pending(PendingRegistration)
        /// A request named this QR's code and failed; the QR is used up. Close it.
        case failed(PeerKey, RegistrationError)
    }

    /// One consumer.
    public let outcomes: AsyncStream<Outcome>
    private let sink: AsyncStream<Outcome>.Continuation
    private let listener: NWListener
    private let queue = DispatchQueue(label: "agentstoz.screen-control.registration")
    private let window: RegistrationWindow
    private let signer: TranscriptSigner
    private let gate: PreAuthGate

    /// `signer` is the Mac identity key the window was opened with.
    public init(window: RegistrationWindow, signer: TranscriptSigner, gate: PreAuthGate,
                host: NWEndpoint.Host? = nil, port: NWEndpoint.Port = .any) throws {
        listener = try ScreenListener.makeListener(host: host, port: port)
        self.window = window
        self.signer = signer
        self.gate = gate
        (outcomes, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16))
    }

    public func start() async throws -> NWEndpoint.Port {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            Task { await self.handle(connection) }
        }
        return try await listener.ready(on: queue)
    }

    public func stop() {
        listener.cancel()
        sink.finish()
    }

    func handle(_ connection: NWConnection) async {
        guard let peer = PeerKey(connection.endpoint) else { return connection.cancel() }
        guard case .success(let ticket) = await gate.admit(peer, at: .now) else { return connection.cancel() }
        let framed = FramedConnection(connection, maxFrame: RegistrationWire.maxFrame)
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(until: ticket.deadline, clock: .continuous)) != nil else { return }
            if settled.claim() { connection.cancel() }
        }
        do {
            try await connection.open(on: queue)
            guard let fields = try? LengthPrefixed.decode(try await framed.receive(), count: 4) else {
                throw RegistrationError.malformed
            }
            let acceptance = try await window.verify(record: fields[0], proof: fields[1], attestation: fields[2],
                                                     attestationKeyID: fields[3], now: .now)
            try await framed.send(RegistrationWire.reply(acceptance.acknowledgement))
            guard settled.claim() else { throw TransportError.timedOut }
            watchdog.cancel()
            _ = await gate.finish(ticket, succeeded: true, at: .now)
            let pending = PendingRegistration(acceptance: acceptance, peer: peer, framed: framed, signer: signer)
            if case .terminated = sink.yield(.pending(pending)) { await pending.refuse() }
        } catch {
            watchdog.cancel()
            _ = settled.claim()
            if !(await window.isOpen(at: .now)) {
                // The attempt named this QR's code, so the window is used up whatever went wrong.
                try? await framed.send(RegistrationWire.reply(nil))
                sink.yield(.failed(peer, error as? RegistrationError ?? .refused))
            }
            connection.cancel()
            _ = await gate.finish(ticket, succeeded: false, at: .now)
        }
    }
}

/// The phone's side of registration.
public enum RegistrationClient {
    /// Sends the request, checks the Mac's acknowledgement against the QR fingerprint, shows the SAS through
    /// `showSAS`, then waits for the person at the Mac. Returns the pinned Mac only when the Mac signed its approval.
    public static func register(to endpoint: NWEndpoint, record: RegistrationRecord, code: RegistrationCode,
                                attestation: Data, attestationKeyID: Data,
                                showSAS: @escaping @Sendable (String) async -> Void,
                                timeout: Duration = .seconds(10),
                                decisionTimeout: Duration = .seconds(180)) async throws -> PinnedMac {
        let connection = NWConnection(to: endpoint, using: ScreenClient.parameters())
        let framed = FramedConnection(connection, maxFrame: RegistrationWire.maxFrame)
        let deadline = OSAllocatedUnfairLock(initialState: ContinuousClock.now + timeout)
        let watchdog = Task {
            while true {
                let until = deadline.withLock { $0 }
                guard (try? await Task.sleep(until: until, clock: .continuous)) != nil else { return }
                if deadline.withLock({ $0 }) <= .now { return connection.cancel() }
            }
        }
        defer {
            watchdog.cancel()
            connection.cancel()
        }
        do {
            try await connection.open(on: ScreenClient.queue)
            try await framed.send(LengthPrefixed.encode([record.encoded(), RegistrationProof.proof(for: record, code: code),
                                                         attestation, attestationKeyID]))
            let (sas, mac) = try RegistrationAcknowledgement.open(try RegistrationWire.open(try await framed.receive()),
                                                                  for: record, code: code)
            deadline.withLock { $0 = .now + decisionTimeout }
            await showSAS(sas)
            let approval = try RegistrationWire.open(try await framed.receive())
            guard RegistrationApproval.isValid(approval, for: record, mac: mac) else { throw RegistrationError.badAcknowledgement }
            return mac
        } catch let error as RegistrationError {
            throw error
        } catch {
            throw deadline.withLock({ $0 }) <= .now ? TransportError.timedOut : error
        }
    }
}
