// Emulator e2e only (J2-SCREEN-SIM, 「Core + 표면만」): compiled by `check-ui.py --screen-gestures` into the disposable
// gesture-probe app, never into AgentsToZMobile or a device build. ScreenControlCore stays unchanged: this is an
// implementation of its public `ScreenFrameTransport` protocol that reaches the fixture Screen host
// (scripts/emulator-e2e/screenFixtureHost.ts) on this Mac's loopback from an owned simulator. It is plain TCP with the
// production 4-byte big-endian framing (`FrameReader`); the key exchange, record channel and video on top of it are
// ScreenControlCore's own, and a transport never grants anything (FrameTransport.swift).
//
// Why not `ScreenClient.open(to:)`: that path requires the Wi-Fi interface on iOS (Transport.swift `parameters()`), so a
// loopback connection from the simulator never becomes ready. Route selection is therefore outside this lane's scope.
#if targetEnvironment(simulator)
import Foundation
import Network
import os
import ScreenControlCore

/// Ports the probe never connects to, even if a caller names them: the installed sidecar, the real AgentsToZ Screen and
/// Appium.
let loopbackProbeDeniedPorts: Set<UInt16> = [3001, 52741, 4723]

enum LoopbackProbeError: Error, Equatable, CustomStringConvertible {
    case refusedPort(UInt16)
    case notLoopback
    var description: String {
        switch self {
        case .refusedPort(let port): "refusedPort(\(port))"
        case .notLoopback: "notLoopback"
        }
    }
}

/// True for the first caller only: settles "ready" against "timed out", or resumes a continuation once.
final class LoopbackProbeOnce: Sendable {
    private let claimed = OSAllocatedUnfairLock(initialState: false)
    func claim() -> Bool { claimed.withLock { claimed in defer { claimed = true }; return !claimed } }
}

/// One TCP connection to 127.0.0.1:<port>, read and written as frames. One reader at a time; writes leave in the order
/// they are enqueued (SecureChannel seals its counters in that order).
final class LoopbackFrameTransport: ScreenFrameTransport {
    private static let queue = DispatchQueue(label: "agentstoz.screen-probe.loopback")
    private let connection: NWConnection
    private let reader: OSAllocatedUnfairLock<FrameReader>
    /// Whether the ready path ran over the loopback interface (measured, not assumed).
    let usesLoopback: Bool

    private init(connection: NWConnection, maxFrame: Int, usesLoopback: Bool) {
        self.connection = connection
        self.usesLoopback = usesLoopback
        reader = OSAllocatedUnfairLock(initialState: FrameReader(maxFrame: maxFrame))
    }

    /// Opens 127.0.0.1:`port` only: an IPv4 literal, never a host name, a LAN address, peer-to-peer or discovery.
    static func open(port: UInt16, maxFrame: Int, timeout: Duration = .seconds(5)) async throws -> LoopbackFrameTransport {
        guard !loopbackProbeDeniedPorts.contains(port), port != 0, let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw LoopbackProbeError.refusedPort(port)
        }
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        (parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        let connection = NWConnection(to: .hostPort(host: .ipv4(.loopback), port: nwPort), using: parameters)
        let settled = LoopbackProbeOnce()
        let watchdog = Task {
            guard (try? await Task.sleep(for: timeout)) != nil else { return }
            if settled.claim() { connection.cancel() }
        }
        defer { watchdog.cancel() }
        do {
            try await connection.probeOpen(on: queue)
            guard settled.claim() else { throw TransportError.timedOut }
        } catch {
            connection.cancel()
            throw settled.claim() ? error : TransportError.timedOut
        }
        let loopback = connection.currentPath?.usesInterfaceType(.loopback) == true
        guard loopback else {
            connection.cancel()
            throw LoopbackProbeError.notLoopback
        }
        return LoopbackFrameTransport(connection: connection, maxFrame: maxFrame, usesLoopback: loopback)
    }

    func setMaxFrame(_ value: Int) { reader.withLock { $0.maxFrame = value } }

    func receive() async throws -> Data {
        while true {
            if let frame = try reader.withLock({ try $0.next() }) { return frame }
            let chunk = try await connection.probeReceiveChunk()
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

    func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        connection.send(content: FrameReader.frame(payload), completion: .contentProcessed { error in
            completion(error.map { LoopbackFrameTransport.transportError($0) })
        })
    }

    func cancel() { connection.cancel() }

    static func transportError(_ error: Error) -> TransportError {
        if let error = error as? TransportError { return error }
        if case .posix(let code)? = error as? NWError, [.ECANCELED, .ECONNRESET, .EPIPE].contains(code) { return .closed }
        return .failed("\(error)")
    }
}

private extension NWConnection {
    /// Starts the connection and waits until it carries data; the caller's watchdog bounds `.waiting`.
    func probeOpen(on queue: DispatchQueue) async throws {
        let once = LoopbackProbeOnce()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready:
                        if once.claim() { continuation.resume() }
                    case .failed(let error):
                        if once.claim() { continuation.resume(throwing: LoopbackFrameTransport.transportError(error)) }
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
    func probeReceiveChunk() async throws -> Data {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, _, error in
                    if let data, !data.isEmpty {
                        continuation.resume(returning: data)
                    } else {
                        continuation.resume(throwing: error.map { LoopbackFrameTransport.transportError($0) } ?? TransportError.closed)
                    }
                }
            }
        } onCancel: {
            cancel()
        }
    }
}
#else
#error("LoopbackFrameTransport is for the owned-simulator gesture probe only (check-ui.py --screen-gestures).")
#endif
