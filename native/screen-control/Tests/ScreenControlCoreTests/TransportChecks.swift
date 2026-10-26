import Foundation
import Network
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Transport checks over real TCP on 127.0.0.1: the listener, the gate and the key exchange working together.

/// Runs `body`, failing the check if it takes longer than `seconds`. Network waits here all end on cancellation.
func within<T: Sendable>(_ seconds: Double, line: Int = #line, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T?.self) { group in
        group.addTask { try await body() }
        group.addTask { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))); return nil }
        defer { group.cancelAll() }
        guard case let value?? = try await group.next() else { throw CheckFailure(description: "line \(line): timed out after \(seconds)s") }
        return value
    }
}

func roomyPolicy() -> PreAuthPolicy {
    var policy = PreAuthPolicy()
    policy.peerRate = 100; policy.peerBurst = 100
    policy.globalRate = 100; policy.globalBurst = 100
    return policy
}

func loopbackListener(_ mac: MacHandshake, policy: PreAuthPolicy = roomyPolicy()) async throws -> (ScreenListener, NWEndpoint) {
    let listener = try ScreenListener(handshake: mac, gate: PreAuthGate(policy: policy), host: .ipv4(.loopback))
    let port = try await within(5) { try await listener.start() }
    return (listener, .hostPort(host: .ipv4(.loopback), port: port))
}

func nextSession(_ listener: ScreenListener, line: Int = #line) async throws -> MacSession {
    try await within(5, line: line) {
        var sessions = listener.sessions.makeAsyncIterator()
        guard let session = await sessions.next() else { throw CheckFailure(description: "line \(line): listener stopped") }
        return session
    }
}

func nextEvent(_ listener: ScreenListener, line: Int = #line) async throws -> ScreenListener.Event {
    try await within(5, line: line) {
        var events = listener.events.makeAsyncIterator()
        guard let event = await events.next() else { throw CheckFailure(description: "line \(line): listener stopped") }
        return event
    }
}

/// A TCP connection that speaks no handshake: what a LAN attacker can open.
func rawConnection(to endpoint: NWEndpoint) async throws -> FramedConnection {
    let connection = NWConnection(to: endpoint, using: .tcp)
    try await within(5) { try await connection.open(on: ScreenClient.queue) }
    return FramedConnection(connection, maxFrame: SecureConnection.maxFrame)
}

/// Fails the check unless the other end closes the connection within `seconds`.
func waitForEnd(_ framed: FramedConnection, within seconds: Double = 3, line: Int = #line) async throws {
    _ = try await within(seconds, line: line) {
        do { while true { _ = try await framed.receive() } } catch {}
        return true
    }
}

/// Accepts TCP connections and never answers: a stalled or fake Mac.
final class SilentListener: Sendable {
    private let listener: NWListener
    private let held = OSAllocatedUnfairLock<[NWConnection]>(initialState: [])

    init() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
    }

    func start() async throws -> NWEndpoint.Port {
        listener.newConnectionHandler = { [held] connection in
            connection.start(queue: ScreenClient.queue)
            held.withLock { $0.append(connection) }
        }
        let once = Once()
        return try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready: if once.claim() { continuation.resume(returning: listener.port ?? .any) }
                case .failed(let error), .waiting(let error): if once.claim() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: ScreenClient.queue)
        }
    }

    func stop() {
        listener.cancel()
        held.withLock { $0.forEach { $0.cancel() } }
    }
}

extension ScreenControlChecks {
    func testFrameReaderChecksEveryLengthBeforeBuffering() async throws {
        var reader = FrameReader(maxFrame: 8)
        let stream = FrameReader.frame(Data("one".utf8)) + FrameReader.frame(Data("two!".utf8)) + FrameReader.frame(Data(count: 8))
        // Byte by byte, a header split across reads, several frames in one read: the same frames come out.
        for chunk in stride(from: 0, to: 7, by: 1).map({ stream.dropFirst($0).prefix(1) }) { reader.append(Data(chunk)) }
        try check(try reader.next() == Data("one".utf8) && reader.next() == nil, "first frame, then wait for more")
        reader.append(stream.dropFirst(7))
        try check(try reader.next() == Data("two!".utf8) && reader.next() == Data(count: 8) && reader.next() == nil,
                  "the rest in order; exactly the limit is allowed")
        // A length is refused as soon as its header is in, before any payload arrives.
        var over = FrameReader(maxFrame: 8)
        over.append(UInt32(9).bigEndianData)
        try await expectError(TransportError.badFrame) { _ = try over.next() }
        var empty = FrameReader(maxFrame: 8)
        empty.append(UInt32(0).bigEndianData)
        try await expectError(TransportError.badFrame) { _ = try empty.next() }
        // The limit can rise between frames without re-reading what is buffered.
        var rising = FrameReader(maxFrame: 4)
        rising.append(FrameReader.frame(Data("hi".utf8)) + FrameReader.frame(Data(count: 6)))
        try check(try rising.next() == Data("hi".utf8), "small frame under the first limit")
        rising.maxFrame = 6
        try check(try rising.next() == Data(count: 6), "next frame under the raised limit")
    }

    func testTransportCarriesRecordsOverLoopback() async throws {
        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        defer { listener.stop() }
        func connect() async throws -> (phone: SecureConnection, mac: MacSession) {
            let phone = try await within(5) {
                try await ScreenClient.connect(to: endpoint, handshake: fixture.device(), signer: fixture.deviceSigner)
            }
            return (phone, try await nextSession(listener))
        }

        let (phone, mac) = try await connect()
        try check(mac.deviceID == ScreenControlIdentity.fingerprint(of: fixture.deviceSigner.publicKey)
                  && mac.peer == PeerKey(host: "127.0.0.1"), "the session names the device and the peer")
        try await phone.send(.input, Data("tap".utf8))
        let input = try await within(3) { try await mac.connection.receive() }
        try check(input.type == .input && input.payload == Data("tap".utf8), "input reaches the Mac")

        // A frame far larger than one TCP read arrives whole.
        let picture = randomBytes(3 << 20)
        async let sent: Void = mac.connection.send(.video, picture)
        let video = try await within(5) { try await phone.receive() }
        try await sent
        try check(video.type == .video && video.payload == picture, "a 3 MiB frame arrives whole")

        // Many tasks sending at once still put records on the wire in counter order.
        let burst = 4000
        async let received: Int = within(10) {
            for _ in 0..<burst { _ = try await phone.receive() }
            return burst
        }
        try await withThrowingTaskGroup(of: Void.self) { group in
            for n in 0..<burst { group.addTask { try await mac.connection.send(.control, UInt16(n).bigEndianData) } }
            try await group.waitForAll()
        }
        try check(try await received == burst, "concurrent sends all open on the other side")

        // Even after authentication a frame has a ceiling, and going over it ends the connection.
        phone.framed.connection.send(content: UInt32(SecureConnection.maxFrame + 1).bigEndianData, completion: .idempotent)
        try await expectError(TransportError.badFrame) { _ = try await within(3) { try await mac.connection.receive() } }
        try await waitForEnd(phone.framed)

        // A frame that is not a record of this channel ends the connection.
        let (forger, forged) = try await connect()
        try await forger.framed.send(randomBytes(40))
        do {
            _ = try await within(3) { try await forged.connection.receive() }
            throw CheckFailure(description: "a forged record was accepted")
        } catch is ChannelError {}
        try await waitForEnd(forger.framed)

        // A Mac that accepts and then says nothing cannot hold the phone past its timeout.
        let silent = try SilentListener()
        defer { silent.stop() }
        let silentPort = try await within(5) { try await silent.start() }
        try await expectError(TransportError.timedOut) {
            _ = try await within(3) {
                try await ScreenClient.connect(to: .hostPort(host: .ipv4(.loopback), port: silentPort), handshake: fixture.device(),
                                               signer: fixture.deviceSigner, timeout: .milliseconds(300))
            }
        }

        // The phone hanging up is a clean close on the Mac.
        let (leaving, left) = try await connect()
        leaving.close()
        try await expectError(TransportError.closed) { _ = try await within(3) { try await left.connection.receive() } }
    }

    func testListenerBoundsAttemptsBeforeAuthentication() async throws {
        var policy = roomyPolicy()
        policy.deadline = .milliseconds(400)
        policy.failuresBeforeBlock = 4
        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac, policy: policy)
        defer { listener.stop() }
        let local = PeerKey(host: "127.0.0.1")!

        // A connection that sends nothing holds this address's only slot, and the Mac cuts it at the deadline.
        let holder = try await rawConnection(to: endpoint)
        try await Task.sleep(for: .milliseconds(150))
        do {
            _ = try await ScreenClient.connect(to: endpoint, handshake: fixture.device(), signer: fixture.deviceSigner,
                                               timeout: .seconds(2))
            throw CheckFailure(description: "a second attempt from the same address got through")
        } catch is TransportError {}
        try check(try await nextEvent(listener) == .refused(local, .busy), "refused while the slot is held")
        try await waitForEnd(holder)
        try check(try await nextEvent(listener) == .failed(local, reason: "\(TransportError.timedOut)"), "cut at the deadline")

        // Nothing over 1 KiB is read before authentication: a larger length ends the connection at once.
        let flooder = try await rawConnection(to: endpoint)
        flooder.connection.send(content: UInt32(1025).bigEndianData, completion: .idempotent)
        try await waitForEnd(flooder)
        try check(try await nextEvent(listener) == .failed(local, reason: "\(TransportError.badFrame)"), "oversized hello")

        // Garbage, and a device the Mac never registered.
        let garbage = try await rawConnection(to: endpoint)
        try await garbage.send(randomBytes(146))
        try await waitForEnd(garbage)
        try check(try await nextEvent(listener) == .failed(local, reason: "\(HandshakeError.malformed)"), "garbage hello")
        let stranger = SoftwareSigner()
        do {
            _ = try await ScreenClient.connect(to: endpoint, handshake: DeviceHandshake(
                mac: pinned(fixture.macSigner.publicKey), devicePublicKey: stranger.publicKey), signer: stranger)
            throw CheckFailure(description: "an unregistered device got through")
        } catch is TransportError {}
        try check(try await nextEvent(listener) == .failed(local, reason: "\(HandshakeError.unknownDevice)"), "unknown device")

        // The fourth failure blocks the address and says so; the next attempt is turned away unread.
        guard case .blocked(local, _) = try await nextEvent(listener) else { throw CheckFailure(description: "no block reported") }
        let blocked = try await rawConnection(to: endpoint)
        try await waitForEnd(blocked)
        try check(try await nextEvent(listener) == .refused(local, .blocked), "blocked address refused")
    }
}
