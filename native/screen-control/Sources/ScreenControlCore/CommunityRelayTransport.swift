import Foundation
import CryptoKit
import os

/// Routing facts remain untrusted until protocol 6 binds them into its signed, pinned-identity handshake.
public struct CommunityRelayBinding: Equatable, Sendable {
    public let communityID: String, ownDeviceID: String, ownConnectionID: String
    public let peerDeviceID: String, peerConnectionID: String?, channelID: String
}
public struct CommunityRelayContext: Sendable {
    public let communityID: String, enrollmentID: String, deviceID: String, publicKey: String
    public let role: CommunityRelayRole
    public let sessionID: String?
    public init(communityID: String, enrollmentID: String, deviceID: String, publicKey: String,
                role: CommunityRelayRole, sessionID: String? = nil) throws {
        for id in [communityID, enrollmentID, deviceID] { _ = try AccessValue.id(id) }
        if let sessionID { _ = try AccessValue.id(sessionID) }
        _ = try AccessValue.key(publicKey)
        self.communityID = communityID; self.enrollmentID = enrollmentID; self.deviceID = deviceID
        self.publicKey = publicKey; self.role = role; self.sessionID = sessionID
    }
}

/// One native frame is fragmented below the relay's JSON limit. Fragments are not a cryptographic record layer.
/// The signed protocol-6 handshake and subsequent SecureChannel records still authenticate every frame.
struct CommunityRelayFragment: Sendable {
    static let maximumFrame = 8 * 1024 * 1024 + 25
    static let chunkSize = 180_000
    let channel: UUID, sequence: UInt64, index: Int, count: Int, total: Int, payload: Data, closed: Bool
    func encode() throws -> Data {
        guard (closed && index == 0 && count == 0 && total == 0 && payload.isEmpty)
            || (!closed && total > 0 && total <= Self.maximumFrame && count == (total + Self.chunkSize - 1) / Self.chunkSize
                && index >= 0 && index < count && payload.count == min(Self.chunkSize, total - index * Self.chunkSize)) else { throw TransportError.badFrame }
        var result = Data([1, closed ? 1 : 0]); var uuid = channel.uuid
        result.append(withUnsafeBytes(of: &uuid) { Data($0) })
        for (value, size) in [(sequence, 8), (UInt64(index), 2), (UInt64(count), 2), (UInt64(total), 4)] {
            for byte in stride(from: size - 1, through: 0, by: -1) { result.append(UInt8(truncatingIfNeeded: value >> (byte * 8))) }
        }
        result.append(payload); return result
    }
    static func decode(_ bytes: Data) throws -> Self {
        let raw = [UInt8](bytes)
        guard raw.count >= 34, raw.count <= chunkSize + 34, raw[0] == 1, raw[1] <= 1 else { throw TransportError.badFrame }
        let channel = UUID(uuid: (raw[2], raw[3], raw[4], raw[5], raw[6], raw[7], raw[8], raw[9], raw[10], raw[11], raw[12], raw[13], raw[14], raw[15], raw[16], raw[17]))
        func number(_ start: Int, _ count: Int) -> UInt64 { raw[start..<(start + count)].reduce(0) { ($0 << 8) | UInt64($1) } }
        let value = Self(channel: channel, sequence: number(18, 8), index: Int(number(26, 2)), count: Int(number(28, 2)),
                         total: Int(number(30, 4)), payload: Data(raw.dropFirst(34)), closed: raw[1] == 1)
        _ = try value.encode(); return value
    }
}
struct CommunityRelayAssembly: Sendable {
    var sequence: UInt64 = 0
    private var data = Data(), next = 0, total = 0, count = 0
    private var deadline: ContinuousClock.Instant?
    var bufferedBytes: Int { data.count }
    mutating func append(_ part: CommunityRelayFragment, maxFrame: Int, now: ContinuousClock.Instant = .now) throws -> Data? {
        guard !part.closed, part.sequence == sequence, part.total <= maxFrame, part.total <= CommunityRelayFragment.maximumFrame,
              deadline == nil || now < deadline! else { throw TransportError.badFrame }
        if next == 0 {
            guard part.index == 0 else { throw TransportError.badFrame }
            total = part.total; count = part.count; deadline = now.advanced(by: .seconds(10))
        }
        guard part.index == next, part.count == count, part.total == total else { throw TransportError.badFrame }
        data.append(part.payload); next += 1
        guard data.count <= total else { throw TransportError.badFrame }
        if next != count { return nil }
        guard data.count == total, sequence < UInt64.max else { throw TransportError.badFrame }
        let frame = data; data = Data(); next = 0; total = 0; count = 0; deadline = nil; sequence += 1
        return frame
    }
}

private actor CommunityFrameInbox {
    private var frames: [Data] = [], bytes = 0, closed = false
    private var reader: CheckedContinuation<Data, Error>?
    func receive() async throws -> Data {
        guard !closed else { throw TransportError.closed }
        if !frames.isEmpty { let frame = frames.removeFirst(); bytes -= frame.count; return frame }
        guard reader == nil else { throw TransportError.badFrame }
        return try await withCheckedThrowingContinuation { reader = $0 }
    }
    func append(_ frame: Data) throws {
        guard !closed, frames.count < 16, bytes + frame.count <= 16 * 1024 * 1024 else { throw TransportError.closed }
        if let pending = reader { reader = nil; pending.resume(returning: frame) }
        else { frames.append(frame); bytes += frame.count }
    }
    func close() { guard !closed else { return }; closed = true; frames = []; bytes = 0; reader?.resume(throwing: TransportError.closed); reader = nil }
}

/// A virtual ordered stream on a shared WSS connection. Closing one peer never replays it through another route.
public final class CommunityRelayFrameTransport: ScreenFrameTransport, Sendable {
    private struct State {
        var maxFrame = 16 * 1024, closed = false, queuedFrames = 0, queuedBytes = 0
        var tail: Task<Void, Never>?, sequence: UInt64 = 0
        var peerConnectionID: String?
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let inbox = CommunityFrameInbox()
    private let hub: CommunityRelayHubConnection
    private let context: CommunityRelayContext
    public let channelID: String, peerDeviceID: String, ownConnectionID: String
    fileprivate init(hub: CommunityRelayHubConnection, context: CommunityRelayContext, channel: UUID, peer: String,
                     ownConnection: String, peerConnection: String?) {
        self.hub = hub; self.context = context; self.channelID = channel.uuidString.lowercased()
        self.peerDeviceID = peer; self.ownConnectionID = ownConnection
        state.withLock { $0.peerConnectionID = peerConnection }
    }
    public var binding: CommunityRelayBinding { state.withLock {
        CommunityRelayBinding(communityID: context.communityID, ownDeviceID: context.deviceID, ownConnectionID: ownConnectionID,
                              peerDeviceID: peerDeviceID, peerConnectionID: $0.peerConnectionID, channelID: channelID)
    } }
    public func setMaxFrame(_ value: Int) { state.withLock { $0.maxFrame = min(max(1, value), CommunityRelayFragment.maximumFrame) } }
    fileprivate var maxFrame: Int { state.withLock { $0.maxFrame } }
    fileprivate func bind(peerConnection: String) throws {
        try state.withLock { value in
            guard !value.closed, value.peerConnectionID == nil || value.peerConnectionID == peerConnection else { throw TransportError.closed }
            value.peerConnectionID = peerConnection
        }
    }
    fileprivate func accept(_ frame: Data) async throws { try await inbox.append(frame) }
    public func receive() async throws -> Data {
        try await withTaskCancellationHandler { try await inbox.receive() } onCancel: { self.cancel() }
    }
    public func send(_ payload: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueue(payload) { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } }
        }
    }
    public func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        let admitted = state.withLock { value in
            guard !value.closed, !payload.isEmpty, payload.count <= value.maxFrame, value.sequence < UInt64.max,
                  value.queuedFrames < 16, value.queuedBytes + payload.count <= 16 * 1024 * 1024 else { return false }
            let sequence = value.sequence, previous = value.tail
            value.sequence += 1; value.queuedFrames += 1; value.queuedBytes += payload.count
            value.tail = Task { [self] in
                await previous?.value
                var sendError: TransportError?
                do {
                    guard !state.withLock({ $0.closed }) else { throw TransportError.closed }
                    try await hub.send(payload, on: self, sequence: sequence)
                } catch { sendError = .closed; cancel() }
                state.withLock { $0.queuedFrames -= 1; $0.queuedBytes -= payload.count }; completion(sendError)
            }
            return true
        }
        if !admitted { completion(.closed); cancel() }
    }
    fileprivate func ended() {
        let changed = state.withLock { value in guard !value.closed else { return false }; value.closed = true; return true }
        if changed { Task { await inbox.close() } }
    }
    public func cancel() { ended(); Task { await hub.remove(channelID, notify: true) } }
}

private final class CommunityRelayNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
private struct CommunityRelayObject: @unchecked Sendable { let fields: [String: Any] }

/// Native header-capable WSS transport. This is not a person-session launcher and never enables capture/input.
public final class CommunityRelayMultiplexer: Sendable {
    public typealias TicketProvider = @Sendable (String) async throws -> CommunityRelayTicket
    public typealias ProofSigner = @Sendable (CommunityRelayBindProof) async throws -> Data
    public typealias Incoming = @Sendable (CommunityRelayFrameTransport) async -> Void
    private let hub: CommunityRelayHubConnection
    private init(hub: CommunityRelayHubConnection) { self.hub = hub }
    public static func open(authority: ScreenCommunityAuthority, context: CommunityRelayContext,
                            ticketProvider: @escaping TicketProvider, proofSigner: @escaping ProofSigner,
                            incoming: @escaping Incoming = { $0.cancel() }) async throws -> CommunityRelayMultiplexer {
        let hub = try await CommunityRelayHubConnection.open(authority: authority, context: context, tickets: ticketProvider, signer: proofSigner, incoming: incoming)
        return Self(hub: hub)
    }
    public func openChannel(to deviceID: String) async throws -> CommunityRelayFrameTransport { try await hub.channel(to: deviceID) }
    public var isClosed: Bool { get async { await hub.isClosed } }
    public func cancel() { Task { await hub.close() } }
    deinit { let connection = hub; Task { await connection.close() } }
    #if DEBUG
    /// Actual-socket fixture seam. Release builds and normal app authority configuration cannot select plaintext WS.
    static func openFixture(endpoint: URL, authority: ScreenCommunityAuthority, context: CommunityRelayContext,
                            ticketProvider: @escaping TicketProvider, proofSigner: @escaping ProofSigner,
                            incoming: @escaping Incoming = { $0.cancel() }) async throws -> CommunityRelayMultiplexer {
        guard endpoint.scheme == "ws", endpoint.host == "127.0.0.1", endpoint.path == "/relay", let port = endpoint.port,
              port > 0, ![3001, 52741, 4723].contains(port), endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil else { throw ScreenCommunityError.malformed }
        let hub = try await CommunityRelayHubConnection.open(authority: authority, context: context, tickets: ticketProvider,
            signer: proofSigner, incoming: incoming, fixtureEndpoint: endpoint)
        return Self(hub: hub)
    }
    #endif
}

private actor CommunityRelayHubConnection {
    private struct Stream { let transport: CommunityRelayFrameTransport; var assembly = CommunityRelayAssembly(); var timeout: Task<Void, Never>? }
    private struct Pending { let continuation: CheckedContinuation<Void, Error>; let timeout: Task<Void, Never> }
    private let context: CommunityRelayContext, connectionID: String
    private let socket: URLSessionWebSocketTask, session: URLSession
    private let tickets: CommunityRelayMultiplexer.TicketProvider, incoming: CommunityRelayMultiplexer.Incoming
    private var ticket: CommunityRelayTicket, renewing: CommunityRelayTicket?
    private var streams: [String: Stream] = [:], pending: [String: Pending] = [:]
    private var closed = false, nextSend: ContinuousClock.Instant = .now
    var isClosed: Bool { closed }
    private var pump: Task<Void, Never>?, renewal: Task<Void, Never>?, expiry: Task<Void, Never>?
    private init(context: CommunityRelayContext, connection: String, socket: URLSessionWebSocketTask, session: URLSession,
                 ticket: CommunityRelayTicket, tickets: @escaping CommunityRelayMultiplexer.TicketProvider, incoming: @escaping CommunityRelayMultiplexer.Incoming) {
        self.context = context; self.connectionID = connection; self.socket = socket; self.session = session
        self.ticket = ticket; self.tickets = tickets; self.incoming = incoming
    }
    private static func validate(_ ticket: CommunityRelayTicket, context: CommunityRelayContext, connection: String) throws {
        let body = ticket.body, now = Int64(Date().timeIntervalSince1970 * 1000)
        guard body.communityId == context.communityID, body.enrollmentId == context.enrollmentID, body.deviceId == context.deviceID,
              body.connectionId == connection, body.publicKey == context.publicKey, body.purpose == .screen, body.role == context.role,
              body.sessionId == context.sessionID, body.expiresAt > now, body.leaseExpiresAt > now else { throw ScreenCommunityError.wrongCommunity }
    }
    static func open(authority: ScreenCommunityAuthority, context: CommunityRelayContext,
                     tickets: @escaping CommunityRelayMultiplexer.TicketProvider, signer: @escaping CommunityRelayMultiplexer.ProofSigner,
                     incoming: @escaping CommunityRelayMultiplexer.Incoming, fixtureEndpoint: URL? = nil) async throws -> CommunityRelayHubConnection {
        let connection = UUID().uuidString.lowercased(), ticket = try await tickets(connection)
        try validate(ticket, context: context, connection: connection)
        var components = URLComponents(url: authority.origin, resolvingAgainstBaseURL: false)!
        components.scheme = "wss"; components.path = "/relay"
        guard let productionEndpoint = components.url, components.query == nil, components.fragment == nil else { throw ScreenCommunityError.malformed }
        let endpoint: URL
        #if DEBUG
        endpoint = fixtureEndpoint ?? productionEndpoint
        #else
        endpoint = productionEndpoint
        #endif
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false; configuration.allowsCellularAccess = true
        let session = URLSession(configuration: configuration, delegate: CommunityRelayNoRedirects(), delegateQueue: nil)
        var request = URLRequest(url: endpoint); request.setValue("AgentsToZ \(ticket.envelope.payload).\(ticket.envelope.signature)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request); socket.maximumMessageSize = 262_144
        let watchdog = Task { if (try? await Task.sleep(for: .seconds(10))) != nil { socket.cancel(with: .goingAway, reason: nil) } }
        defer { watchdog.cancel() }; socket.resume()
        return try await withTaskCancellationHandler {
            do {
                let challenge = try await object(socket).fields
                guard Set(challenge.keys) == ["type", "ticketId", "connectionId", "challenge"], challenge["type"] as? String == "challenge",
                      challenge["ticketId"] as? String == ticket.body.ticketId, challenge["connectionId"] as? String == connection,
                      let nonce = challenge["challenge"] as? String else { throw TransportError.badFrame }
                let proof = try CommunityRelayBindProof(ticket: ticket, challenge: nonce), signature = try await signer(proof)
                guard signature.count == 64 else { throw ScreenCommunityError.invalidSignature }
                try await sendObject(["type": "proof", "signature": ScreenCommunityRequest.base64(signature)], socket: socket)
                let ready = try await object(socket).fields
                guard Set(ready.keys) == ["type", "connectionId", "leaseExpiresAt"], ready["type"] as? String == "ready",
                      ready["connectionId"] as? String == connection, try AccessValue.integer(ready["leaseExpiresAt"] as Any) == ticket.body.leaseExpiresAt else { throw TransportError.badFrame }
                let hub = Self(context: context, connection: connection, socket: socket, session: session, ticket: ticket, tickets: tickets, incoming: incoming)
                await hub.start(); return hub
            } catch { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel(); throw error }
        } onCancel: { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
    }
    private static func object(_ socket: URLSessionWebSocketTask) async throws -> CommunityRelayObject {
        guard case .string(let text) = try await socket.receive(), text.utf8.count <= 262_144,
              let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw TransportError.badFrame }
        return CommunityRelayObject(fields: object)
    }
    private static func sendObject(_ object: [String: Any], socket: URLSessionWebSocketTask) async throws {
        let data = try JSONSerialization.data(withJSONObject: object, options: .withoutEscapingSlashes)
        guard data.count <= 262_144 else { throw TransportError.badFrame }
        try await socket.send(.string(String(decoding: data, as: UTF8.self)))
    }
    private func start() {
        armLease()
        pump = Task { [self] in
            do { while !Task.isCancelled { try await handle(Self.object(socket)) } }
            catch { close() }
        }
    }
    private func armLease() {
        expiry?.cancel(); renewal?.cancel()
        let remaining = ticket.body.leaseExpiresAt - Int64(Date().timeIntervalSince1970 * 1000)
        guard !closed, remaining > 0 else { close(); return }
        expiry = Task { [weak self] in if (try? await Task.sleep(for: .milliseconds(remaining))) != nil { await self?.close() } }
        renewal = Task { [weak self] in
            guard (try? await Task.sleep(for: .milliseconds(min(60_000, max(1, remaining * 2 / 3))))) != nil else { return }
            await self?.renew()
        }
    }
    private func renew() async {
        do {
            let next = try await tickets(connectionID); try Self.validate(next, context: context, connection: connectionID)
            guard !closed, ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1000), next.body.revision >= ticket.body.revision else { throw TransportError.closed }
            renewing = next
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(next.envelope))
            try await Self.sendObject(["type": "authorize", "ticket": object], socket: socket)
        } catch { close() }
    }
    func channel(to peer: String) throws -> CommunityRelayFrameTransport {
        _ = try AccessValue.id(peer)
        guard !closed, context.role == .client, peer != context.deviceID, streams.count < 8 else { throw TransportError.closed }
        return create(channel: UUID(), peer: peer, peerConnection: nil)
    }
    private func create(channel: UUID, peer: String, peerConnection: String?) -> CommunityRelayFrameTransport {
        let stream = CommunityRelayFrameTransport(hub: self, context: context, channel: channel, peer: peer,
                                                  ownConnection: connectionID, peerConnection: peerConnection)
        streams[stream.channelID] = Stream(transport: stream); return stream
    }
    private func handle(_ wrapped: CommunityRelayObject) async throws {
        let object = wrapped.fields
        guard !closed, ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { throw TransportError.closed }
        if object["type"] as? String == "authorized" {
            guard Set(object.keys) == ["type", "leaseExpiresAt"], let next = renewing,
                  try AccessValue.integer(object["leaseExpiresAt"] as Any) == next.body.leaseExpiresAt else { throw TransportError.badFrame }
            ticket = next; renewing = nil; armLease(); return
        }
        if object["type"] as? String == "forwarded" {
            guard Set(object.keys) == ["type", "id", "reachable"], let id = object["id"] as? String,
                  let reachable = object["reachable"] as? Bool else { throw TransportError.badFrame }
            _ = try AccessValue.id(id)
            guard let result = pending.removeValue(forKey: id) else { return } // Late ACKs never restore uncertain requests.
            result.timeout.cancel()
            // Forwarding confirms only routing. Native protocol key confirmation and records prove peer receipt.
            if reachable { result.continuation.resume() } else { result.continuation.resume(throwing: TransportError.closed) }; return
        }
        if object["type"] as? String == "peer-ended" {
            guard Set(object.keys) == ["type", "from", "fromConnection"], let peer = object["from"] as? String,
                  let connection = object["fromConnection"] as? String else { throw TransportError.badFrame }
            _ = try AccessValue.id(peer); _ = try AccessValue.id(connection)
            let ended = streams.filter { $0.value.transport.peerDeviceID == peer && $0.value.transport.binding.peerConnectionID == connection }.map(\.key)
            for id in ended { remove(id) }; return
        }
        guard Set(object.keys) == ["type", "from", "fromConnection", "id", "ciphertext"], object["type"] as? String == "data",
              let peer = object["from"] as? String, let peerConnection = object["fromConnection"] as? String,
              let messageID = object["id"] as? String, let ciphertext = object["ciphertext"] as? String else { throw TransportError.badFrame }
        for id in [peer, peerConnection, messageID] { _ = try AccessValue.id(id) }
        guard peer != context.deviceID else { throw TransportError.badFrame }
        let fragment = try CommunityRelayFragment.decode(ScreenCommunityRequest.decodeBase64(ciphertext, max: 250_000))
        let id = fragment.channel.uuidString.lowercased()
        if streams[id] == nil {
            guard context.role == .host, !fragment.closed, fragment.index == 0, fragment.sequence == 0,
                  fragment.total <= 16 * 1024, streams.count < 8 else { return }
            let created = create(channel: fragment.channel, peer: peer, peerConnection: peerConnection)
            Task { await incoming(created) }
        }
        guard var stream = streams[id], stream.transport.peerDeviceID == peer else { return }
        do {
            try stream.transport.bind(peerConnection: peerConnection)
            if fragment.closed { remove(id); return }
            let frame = try stream.assembly.append(fragment, maxFrame: stream.transport.maxFrame)
            let aggregate = streams.filter { $0.key != id }.values.reduce(stream.assembly.bufferedBytes) { $0 + $1.assembly.bufferedBytes }
            guard aggregate <= 16 * 1024 * 1024 else { throw TransportError.badFrame }
            if let frame { stream.timeout?.cancel(); stream.timeout = nil; streams[id] = stream; try await stream.transport.accept(frame) }
            else {
                if stream.timeout == nil { stream.timeout = Task { [weak self] in
                    if (try? await Task.sleep(for: .seconds(10))) != nil { await self?.remove(id) }
                } }
                streams[id] = stream
            }
        } catch { remove(id) }
    }
    func send(_ payload: Data, on stream: CommunityRelayFrameTransport, sequence: UInt64) async throws {
        guard !closed, streams[stream.channelID]?.transport === stream, let channel = UUID(uuidString: stream.channelID) else { throw TransportError.closed }
        let count = (payload.count + CommunityRelayFragment.chunkSize - 1) / CommunityRelayFragment.chunkSize
        for index in 0..<count {
            let start = index * CommunityRelayFragment.chunkSize, end = min(payload.count, start + CommunityRelayFragment.chunkSize)
            let fragment = CommunityRelayFragment(channel: channel, sequence: sequence, index: index, count: count,
                                                   total: payload.count, payload: Data(payload[(payload.startIndex + start)..<(payload.startIndex + end)]), closed: false)
            try await route(try fragment.encode(), to: stream.peerDeviceID)
        }
    }
    private func route(_ data: Data, to peer: String) async throws {
        guard !closed, pending.count < 32 else { throw TransportError.closed }
        let id = UUID().uuidString.lowercased(), text = ScreenCommunityRequest.base64(data)
        // Leaky pacing keeps large frames below the DO byte budget without a burst at a one-second boundary.
        let now = ContinuousClock.now, scheduled = max(now, nextSend)
        nextSend = scheduled.advanced(by: .nanoseconds(Int64((Double(text.utf8.count + 256) / 2_000_000) * 1_000_000_000)))
        if scheduled > now { try await Task.sleep(until: scheduled, clock: .continuous) }
        guard !closed, ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { throw TransportError.closed }
        try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in if (try? await Task.sleep(for: .seconds(5))) != nil { await self?.fail(id) } }
            pending[id] = Pending(continuation: continuation, timeout: timeout)
            Task { [weak self, socket] in
                do { try await Self.sendObject(["type": "data", "to": peer, "id": id, "ciphertext": text], socket: socket) }
                catch { await self?.fail(id) }
            }
        }
    }
    private func fail(_ id: String) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout.cancel(); entry.continuation.resume(throwing: TransportError.timedOut)
    }
    func remove(_ id: String, notify: Bool = false) {
        guard let stream = streams.removeValue(forKey: id) else { return }; stream.timeout?.cancel(); stream.transport.ended()
        if notify, !closed, let channel = UUID(uuidString: id) {
            Task { [weak self] in
                let close = CommunityRelayFragment(channel: channel, sequence: 0, index: 0, count: 0, total: 0, payload: Data(), closed: true)
                if let data = try? close.encode() { try? await self?.route(data, to: stream.transport.peerDeviceID) }
            }
        }
    }
    func close() {
        guard !closed else { return }; closed = true; pump?.cancel(); renewal?.cancel(); expiry?.cancel()
        socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel()
        for stream in streams.values { stream.timeout?.cancel(); stream.transport.ended() }; streams = [:]
        for entry in pending.values { entry.timeout.cancel(); entry.continuation.resume(throwing: TransportError.closed) }; pending = [:]
    }
}
