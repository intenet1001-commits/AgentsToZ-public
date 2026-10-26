import Foundation
import Network
import os

// Stage-1 transport (DESIGN 「4) 네트워크」): TCP on the approved network, one length-prefixed frame per handshake
// message or record. The listener asks PreAuthGate before reading a byte, reads at most `preAuthMaxFrame` bytes per
// frame until the device has proved who it is, and cuts the connection at the gate's deadline. Only a completed key
// exchange becomes a session; capture and input start from there, never before.

public enum TransportError: Error, Equatable, Sendable {
    /// A frame length of zero, or above what this stage of the connection accepts.
    case badFrame
    /// Either end closed the connection.
    case closed
    /// The key exchange ran past its deadline.
    case timedOut
    case failed(String)

    init(_ error: Error) {
        if let error = error as? TransportError {
            self = error
        } else if case .posix(let code)? = error as? NWError, [.ECANCELED, .ECONNRESET, .EPIPE].contains(code) {
            self = .closed
        } else {
            self = .failed("\(error)")
        }
    }
}

/// 4-byte big-endian length ‖ payload. Frames come out one at a time against the limit in force at that moment, so
/// the limit can rise after the handshake without re-reading what already arrived.
public struct FrameReader: Sendable {
    static let headerSize = 4
    public var maxFrame: Int
    private var buffer = Data()

    public init(maxFrame: Int) { self.maxFrame = maxFrame }

    public static func frame(_ payload: Data) -> Data { UInt32(payload.count).bigEndianData + payload }

    public mutating func append(_ bytes: Data) { buffer.append(bytes) }

    /// The next complete frame, or nil until more bytes arrive. A bad length throws as soon as its header is in, so
    /// a peer can never make the reader hold a frame larger than `maxFrame`.
    public mutating func next() throws -> Data? {
        let start = buffer.startIndex
        guard buffer.count >= Self.headerSize else { return nil }
        let length = buffer[start..<start + Self.headerSize].reduce(0) { $0 << 8 | Int($1) }
        guard length > 0, length <= maxFrame else { throw TransportError.badFrame }
        guard buffer.count - Self.headerSize >= length else { return nil }
        let end = start + Self.headerSize + length
        let frame = Data(buffer[(start + Self.headerSize)..<end])
        buffer.removeSubrange(start..<end)
        return frame
    }
}

/// True for the first caller only: settles "finished" against "timed out", or resumes a continuation once.
final class Once: Sendable {
    private let claimed = OSAllocatedUnfairLock(initialState: false)
    func claim() -> Bool { claimed.withLock { claimed in defer { claimed = true }; return !claimed } }
}

extension NWConnection {
    /// Starts the connection and waits until it carries data. `.waiting` is a failure here: this transport never
    /// retries by itself. Cancelling the task cancels the connection.
    func open(on queue: DispatchQueue) async throws {
        let once = Once()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready:
                        if once.claim() { continuation.resume() }
                    case .waiting(let error), .failed(let error):
                        if once.claim() { continuation.resume(throwing: TransportError(error)) }
                        self?.cancel()
                    case .cancelled:
                        if once.claim() { continuation.resume(throwing: TransportError.closed) }
                    default:
                        break
                    }
                }
                start(queue: queue)
            }
        } onCancel: {
            cancel()
        }
    }

    /// The next bytes from the peer. Cancelling the task cancels the connection.
    func receiveChunk() async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, _, error in
                    if let data, !data.isEmpty {
                        continuation.resume(returning: data)
                    } else {
                        continuation.resume(throwing: error.map(TransportError.init) ?? .closed)
                    }
                }
            }
        } onCancel: {
            cancel()
        }
    }
}

/// One NWConnection read and written as frames. One reader at a time; writes leave in the order they are enqueued.
final class FramedConnection: Sendable {
    let connection: NWConnection
    private let reader: OSAllocatedUnfairLock<FrameReader>

    init(_ connection: NWConnection, maxFrame: Int) {
        self.connection = connection
        reader = OSAllocatedUnfairLock(initialState: FrameReader(maxFrame: maxFrame))
    }

    func setMaxFrame(_ value: Int) { reader.withLock { $0.maxFrame = value } }

    func receive() async throws -> Data {
        while true {
            if let frame = try reader.withLock({ try $0.next() }) { return frame }
            let chunk = try await connection.receiveChunk()
            reader.withLock { $0.append(chunk) }
        }
    }

    func send(_ payload: Data) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                enqueue(payload) { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                }
            }
        } onCancel: {
            cancel()
        }
    }

    /// Hands the frame to the connection now; `completion` runs once the bytes are processed or the connection fails.
    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        connection.send(content: FrameReader.frame(payload), completion: .contentProcessed { error in
            completion(error.map(TransportError.init))
        })
    }

    func cancel() { connection.cancel() }
}

/// A connection after the key exchange: every frame is one record of the channel. A refused record, a bad frame or
/// a closed channel closes the connection; nothing is retried past a forged record. Any number of senders, one
/// receiver at a time.
public final class SecureConnection: Sendable {
    public static let maxFrame = SecureChannel.maxPayload + SecureChannel.headerSize + SecureChannel.tagSize

    let framed: FramedConnection
    let channel: SecureChannel
    private let sending = OSAllocatedUnfairLock()

    init(framed: FramedConnection, channel: SecureChannel) {
        self.framed = framed
        self.channel = channel
        framed.setMaxFrame(Self.maxFrame)
    }

    /// The protocol version the key exchange settled on: 1 with a version-1 peer, whose session has none of version 2's
    /// control messages.
    public var version: UInt16 { channel.version }

    /// Seals and enqueues under one lock, so records leave in counter order however many tasks send at once.
    public func send(_ type: RecordType, _ payload: Data) async throws {
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                do {
                    try sending.withLock {
                        framed.enqueue(try channel.seal(type, payload)) { error in
                            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                        }
                    }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        } catch {
            close()
            throw error
        }
    }

    /// Sends one control message. Refused before anything is sealed, and without closing the session, when this end is
    /// not the message's sender (`wrongDirection`), when the session's version predates it (`notNegotiated`: a
    /// version-1 peer never sees a version-2 message), or when its values would not decode (`malformed`).
    public func send(_ message: ControlMessage) async throws {
        guard message.sender == channel.role else { throw ChannelError.wrongDirection }
        guard message.minimumVersion <= channel.version else { throw ChannelError.notNegotiated }
        guard (try? ControlMessage(decoding: message.encoded, version: channel.version)) == message else {
            throw ChannelError.malformed
        }
        try await send(.control, message.encoded)
    }

    /// The next record. Callers decode or inject only what this returns.
    public func receive() async throws -> (type: RecordType, payload: Data) {
        do {
            return try channel.open(try await framed.receive())
        } catch {
            close()
            throw error
        }
    }

    public func close() { framed.cancel() }
}

// MARK: - Mac side

public struct MacSession: Sendable {
    public let deviceID: Data
    public let peer: PeerKey
    public let connection: SecureConnection
}

/// The Mac's screen listener. No Bonjour, no peer-to-peer, local-network peers only. `host` binds it to one local
/// address: the approved network's, or loopback in checks.
public final class ScreenListener: Sendable {
    /// For the audit log and the registered devices.
    public enum Event: Equatable, Sendable {
        case refused(PeerKey, PreAuthRefusal)
        case failed(PeerKey, reason: String)
        case blocked(PeerKey, until: ContinuousClock.Instant)
    }

    /// Every handshake message fits several times over; nothing larger is read before authentication.
    public static let preAuthMaxFrame = 1024

    /// Completed key exchanges, in order. One consumer.
    public let sessions: AsyncStream<MacSession>
    /// One consumer. Keeps only the newest events while nobody reads, because every refused connection makes one.
    public let events: AsyncStream<Event>
    private let sessionSink: AsyncStream<MacSession>.Continuation
    private let eventSink: AsyncStream<Event>.Continuation
    private let listener: NWListener
    private let queue = DispatchQueue(label: "agentstoz.screen-control.listener")
    private let handshake: MacHandshake
    private let gate: PreAuthGate

    public init(handshake: MacHandshake, gate: PreAuthGate, host: NWEndpoint.Host? = nil, port: NWEndpoint.Port = .any) throws {
        listener = try Self.makeListener(host: host, port: port)
        self.handshake = handshake
        self.gate = gate
        (sessions, sessionSink) = AsyncStream.makeStream()
        (events, eventSink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(256))
    }

    /// Local-network peers only, no peer-to-peer, no delay; bound to `host` when given.
    static func makeListener(host: NWEndpoint.Host?, port: NWEndpoint.Port) throws -> NWListener {
        let parameters = NWParameters.tcp
        parameters.acceptLocalOnly = true
        parameters.includePeerToPeer = false
        (parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        guard let host else { return try NWListener(using: parameters, on: port) }
        parameters.requiredLocalEndpoint = .hostPort(host: host, port: port)
        return try NWListener(using: parameters)
    }

    /// Starts listening and returns the port once the listener is ready.
    public func start() async throws -> NWEndpoint.Port {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            Task { await self.handle(connection) }
        }
        return try await listener.ready(on: queue)
    }

    /// Stops accepting. Sessions already handed out stay open; their owner closes them.
    public func stop() {
        listener.cancel()
        sessionSink.finish()
        eventSink.finish()
    }

    func handle(_ connection: NWConnection) async {
        guard let peer = PeerKey(connection.endpoint) else { return connection.cancel() }
        let ticket: PreAuthTicket
        switch await gate.admit(peer, at: .now) {
        case .failure(let reason):
            connection.cancel()
            eventSink.yield(.refused(peer, reason))
            return
        case .success(let admitted):
            ticket = admitted
        }
        let framed = FramedConnection(connection, maxFrame: Self.preAuthMaxFrame)
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(until: ticket.deadline, clock: .continuous)) != nil else { return }
            if settled.claim() { connection.cancel() }
        }
        do {
            try await connection.open(on: queue)
            let (reply, pending) = try await handshake.respond(to: try await framed.receive())
            try await framed.send(reply)
            let channel = try await pending.confirm(try await framed.receive())
            guard settled.claim() else { throw TransportError.timedOut }
            watchdog.cancel()
            await report(gate.finish(ticket, succeeded: true, at: .now))
            let session = MacSession(deviceID: pending.deviceID, peer: peer,
                                     connection: SecureConnection(framed: framed, channel: channel))
            if case .terminated = sessionSink.yield(session) { session.connection.close() }
        } catch {
            let reason = settled.claim() ? error : TransportError.timedOut
            watchdog.cancel()
            connection.cancel()
            eventSink.yield(.failed(peer, reason: "\(reason)"))
            await report(gate.finish(ticket, succeeded: false, at: .now))
        }
    }

    private func report(_ event: PreAuthGate.Event?) async {
        for case .blocked(let peer, let until) in [event].compactMap({ $0 }) + (await gate.takeEvents()) {
            eventSink.yield(.blocked(peer, until: until))
        }
    }
}

extension NWListener {
    /// Starts the listener and returns its port once it is ready.
    func ready(on queue: DispatchQueue) async throws -> NWEndpoint.Port {
        let once = Once()
        return try await withCheckedThrowingContinuation { continuation in
            stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if once.claim() { continuation.resume(returning: self?.port ?? .any) }
                case .waiting(let error), .failed(let error):
                    if once.claim() { continuation.resume(throwing: TransportError(error)) }
                    self?.cancel()
                case .cancelled:
                    if once.claim() { continuation.resume(throwing: TransportError.closed) }
                default:
                    break
                }
            }
            start(queue: queue)
        }
    }
}

// MARK: - Phone side

public enum ScreenClient {
    static let queue = DispatchQueue(label: "agentstoz.screen-control.client")

    /// TCP with no delay, never peer-to-peer and never cellular.
    static func parameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        parameters.prohibitedInterfaceTypes = [.cellular]
        (parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        return parameters
    }

    /// Connects to a Mac's screen listener and runs the key exchange. `handshake` is for this one attempt. Never over
    /// cellular: stage 1 is the approved Wi‑Fi only. The phone should finish Face ID before calling this, so the
    /// Mac's deadline covers the network and the cryptography, not the person (DESIGN 「구현 현황」).
    public static func connect(to endpoint: NWEndpoint, handshake: DeviceHandshake, signer: TranscriptSigner,
                               timeout: Duration = .seconds(5)) async throws -> SecureConnection {
        let connection = NWConnection(to: endpoint, using: parameters())
        let framed = FramedConnection(connection, maxFrame: ScreenListener.preAuthMaxFrame)
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(for: timeout)) != nil else { return }
            if settled.claim() { connection.cancel() }
        }
        defer { watchdog.cancel() }
        do {
            try await connection.open(on: queue)
            try await framed.send(handshake.hello)
            let (finish, channel) = try await handshake.finish(macHello: try await framed.receive(), signer: signer)
            try await framed.send(finish)
            guard settled.claim() else { throw TransportError.timedOut }
            return SecureConnection(framed: framed, channel: channel)
        } catch {
            connection.cancel()
            throw settled.claim() ? error : TransportError.timedOut
        }
    }
}
