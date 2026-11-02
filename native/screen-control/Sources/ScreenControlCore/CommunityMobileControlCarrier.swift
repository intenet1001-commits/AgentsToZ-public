import Foundation

public enum CommunityMobileControlRoutedFrame: Sendable {
    case data(deviceID: String, connectionID: String, payload: Data)
    case ended(deviceID: String, connectionID: String)
}
public protocol CommunityMobileControlWire: Sendable {
    var connectionID: String { get }
    func send(to deviceID: String, payload: Data) async throws
    func receive() async throws -> CommunityMobileControlRoutedFrame
    func close() async
}
private actor CommunityMobileControlInbox {
    var frames: [CommunityMobileControlRoutedFrame] = [], bytes = 0, closed = false
    var waiting: CheckedContinuation<CommunityMobileControlRoutedFrame, Error>?
    func next() async throws -> CommunityMobileControlRoutedFrame {
        guard !closed, waiting == nil else { throw TransportError.closed }
        if !frames.isEmpty { let value = frames.removeFirst(); if case .data(_,_,let data) = value { bytes -= data.count }; return value }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func append(_ value: CommunityMobileControlRoutedFrame) throws {
        guard !closed else { throw TransportError.closed }
        if let waiter = waiting { waiting = nil; waiter.resume(returning: value); return }
        let size: Int; if case .data(_,_,let data) = value { size = data.count } else { size = 0 }
        guard frames.count < 8, bytes + size <= 320_000 else { throw TransportError.closed }
        frames.append(value); bytes += size
    }
    func finish() { closed = true; frames = []; bytes = 0; waiting?.resume(throwing: TransportError.closed); waiting = nil }
}
private final class CommunityMobileControlNoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Mobile-only raw control carrier; it does not share Screen multiplexing, fragmentation, input or capture APIs.
/// CF forwarding acknowledgements confirm routing only, never completion of an effect.
public actor CommunityMobileControlCarrier: CommunityMobileControlWire {
    public typealias Fence = @Sendable () async throws -> Void
    public typealias TicketProvider = @Sendable (String) async throws -> CommunityRelayTicket
    public typealias ProofSigner = @Sendable (CommunityRelayBindProof) async throws -> Data
    public nonisolated let connectionID: String
    private let context: CommunityRelayContext, purpose: CommunityMobileControlPurpose
    private let socket: URLSessionWebSocketTask, session: URLSession, inbox = CommunityMobileControlInbox()
    private let fence: Fence, tickets: TicketProvider
    private var ticket: CommunityRelayTicket, renewing: CommunityRelayTicket?
    private var closed = false, nextWrite: ContinuousClock.Instant = .now
    private var pump: Task<Void,Never>?, renewal: Task<Void,Never>?, expiry: Task<Void,Never>?
    private struct Pending { let continuation: CheckedContinuation<Void,Error>; let timeout: Task<Void,Never> }
    private var pending: [String: Pending] = [:]
    private init(connection: String, context: CommunityRelayContext, purpose: CommunityMobileControlPurpose, socket: URLSessionWebSocketTask, session: URLSession, ticket: CommunityRelayTicket, fence: @escaping Fence, tickets: @escaping TicketProvider) {
        connectionID = connection; self.context = context; self.purpose = purpose; self.socket = socket; self.session = session; self.ticket = ticket; self.fence = fence; self.tickets = tickets
    }
    private static func validate(_ ticket: CommunityRelayTicket, context: CommunityRelayContext, purpose: CommunityMobileControlPurpose, connection: String) throws {
        let b = ticket.body, now = Int64(Date().timeIntervalSince1970 * 1_000)
        guard context.role == .client, context.sessionID != nil, b.deviceKind == .mobile, b.role == .client,
              b.communityId == context.communityID, b.enrollmentId == context.enrollmentID, b.deviceId == context.deviceID,
              b.publicKey == context.publicKey, b.sessionId == context.sessionID, b.connectionId == connection,
              b.purpose.rawValue == purpose.rawValue, b.expiresAt > now, b.leaseExpiresAt > now else { throw ScreenCommunityError.wrongCommunity }
    }
    public static func open(authority: ScreenCommunityAuthority, context: CommunityRelayContext, purpose: CommunityMobileControlPurpose, fence: @escaping Fence, ticketProvider: @escaping TicketProvider, proofSigner: @escaping ProofSigner) async throws -> CommunityMobileControlCarrier {
        try await open(authority: authority, context: context, purpose: purpose, fence: fence, tickets: ticketProvider, signer: proofSigner, fixture: nil)
    }
    #if DEBUG
    static func openFixture(endpoint: URL, authority: ScreenCommunityAuthority, context: CommunityRelayContext, purpose: CommunityMobileControlPurpose, fence: @escaping Fence, ticketProvider: @escaping TicketProvider, proofSigner: @escaping ProofSigner) async throws -> CommunityMobileControlCarrier {
        guard endpoint.scheme == "ws", endpoint.host == "127.0.0.1", endpoint.path == "/relay", let port = endpoint.port,
              ![3001,52741,4723].contains(port), port > 0, endpoint.user == nil, endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil else { throw ScreenCommunityError.malformed }
        return try await open(authority: authority, context: context, purpose: purpose, fence: fence, tickets: ticketProvider, signer: proofSigner, fixture: endpoint)
    }
    #endif
    private static func open(authority: ScreenCommunityAuthority, context: CommunityRelayContext, purpose: CommunityMobileControlPurpose, fence: @escaping Fence, tickets: @escaping TicketProvider, signer: @escaping ProofSigner, fixture: URL?) async throws -> CommunityMobileControlCarrier {
        try await fence(); let connection = UUID().uuidString.lowercased(), ticket = try await tickets(connection)
        try validate(ticket, context: context, purpose: purpose, connection: connection)
        var url = URLComponents(url: authority.origin, resolvingAgainstBaseURL: false)!; url.scheme = "wss"; url.path = "/relay"
        guard let endpoint = url.url, url.query == nil, url.fragment == nil else { throw ScreenCommunityError.malformed }
        let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCache = nil; config.urlCredentialStorage = nil; config.allowsCellularAccess = true
        let session = URLSession(configuration: config, delegate: CommunityMobileControlNoRedirects(), delegateQueue: nil)
        var request = URLRequest(url: fixture ?? endpoint)
        request.setValue("AgentsToZ \(ticket.envelope.payload).\(ticket.envelope.signature)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request); socket.maximumMessageSize = 65_536; socket.resume()
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    let challenge = try CommunityMobileControlJSON.object(await object(socket), maximum: 65_536)
                    guard Set(challenge.keys) == ["type","ticketId","connectionId","challenge"], challenge["type"] as? String == "challenge",
                          challenge["ticketId"] as? String == ticket.body.ticketId, challenge["connectionId"] as? String == connection,
                          let nonce = challenge["challenge"] as? String else { throw TransportError.badFrame }
                    try await fence(); let signature = try await signer(CommunityRelayBindProof(ticket: ticket, challenge: nonce))
                    guard signature.count == 64 else { throw ScreenCommunityError.invalidSignature }
                    try await send(CommunityMobileControlBytes.json(["type":"proof","signature":ScreenCommunityRequest.base64(signature)]), socket: socket)
                    let ready = try CommunityMobileControlJSON.object(await object(socket), maximum: 65_536)
                    guard Set(ready.keys) == ["type","connectionId","leaseExpiresAt"], ready["type"] as? String == "ready", ready["connectionId"] as? String == connection,
                          try AccessValue.integer(ready["leaseExpiresAt"] as Any) == ticket.body.leaseExpiresAt else { throw TransportError.badFrame }
                    try await fence()
                }
                group.addTask { try await Task.sleep(for: .seconds(10)); socket.cancel(with: .goingAway, reason: nil); throw TransportError.timedOut }
                defer { group.cancelAll() }; _ = try await group.next()
            }
            let value = Self(connection: connection, context: context, purpose: purpose, socket: socket, session: session, ticket: ticket, fence: fence, tickets: tickets)
            await value.start(); return value
        } catch { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel(); throw error }
    }
    private static func object(_ socket: URLSessionWebSocketTask) async throws -> Data {
        let data: Data
        switch try await socket.receive() { case .data(let bytes): data = bytes; case .string(let text): data = Data(text.utf8); @unknown default: throw TransportError.badFrame }
        guard data.count <= 65_536 else { throw TransportError.badFrame }; return data
    }
    private static func send(_ data: Data, socket: URLSessionWebSocketTask) async throws {
        guard data.count <= 65_536, let text = String(data: data, encoding: .utf8) else { throw TransportError.badFrame }
        try await socket.send(.string(text))
    }
    private func start() {
        pump = Task { [weak self, socket] in
            do { while !Task.isCancelled { let value = try await Self.object(socket); guard let self else { return }; try await self.handle(value) } }
            catch { await self?.close() }
        }
        armLease()
    }
    private func armLease() {
        expiry?.cancel(); renewal?.cancel()
        let remaining = ticket.body.leaseExpiresAt - Int64(Date().timeIntervalSince1970 * 1_000)
        expiry = Task { [weak self] in try? await Task.sleep(for: .milliseconds(max(0,remaining))); guard !Task.isCancelled else { return }; await self?.close() }
        renewal = Task { [weak self] in try? await Task.sleep(for: .milliseconds(max(1_000,remaining - 20_000))); guard !Task.isCancelled else { return }; await self?.renew() }
    }
    private func renew() async {
        do {
            try await fence(); let next = try await tickets(connectionID); try Self.validate(next, context: context, purpose: purpose, connection: connectionID)
            guard !closed, next.body.revision == ticket.body.revision, ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else { throw TransportError.closed }
            renewing = next; try await Self.send(CommunityMobileControlBytes.json(["type":"authorize","ticket":try JSONSerialization.jsonObject(with: JSONEncoder().encode(next.envelope))]), socket: socket)
        } catch { await close() }
    }
    private func handle(_ data: Data) async throws {
        let value = try CommunityMobileControlJSON.object(data, maximum: 65_536)
        try await fence(); guard !closed, ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else { throw TransportError.closed }
        switch value["type"] as? String {
        case "authorized":
            guard Set(value.keys) == ["type","leaseExpiresAt"], let next = renewing, try AccessValue.integer(value["leaseExpiresAt"] as Any) == next.body.leaseExpiresAt else { throw TransportError.badFrame }
            ticket = next; renewing = nil; armLease()
        case "forwarded":
            guard Set(value.keys) == ["type","id","reachable"], let id = value["id"] as? String, let reachable = value["reachable"] as? Bool else { throw TransportError.badFrame }
            if let entry = pending.removeValue(forKey: id) { entry.timeout.cancel(); if reachable { entry.continuation.resume() } else { entry.continuation.resume(throwing: TransportError.closed) } }
        case "peer-ended":
            guard Set(value.keys) == ["type","from","fromConnection"], let from = value["from"] as? String, let connection = value["fromConnection"] as? String,
                  CommunityMobileControlBytes.id(from), CommunityMobileControlBytes.id(connection) else { throw TransportError.badFrame }
            try await inbox.append(.ended(deviceID: from, connectionID: connection))
        case "data":
            guard Set(value.keys) == ["type","from","fromConnection","id","ciphertext"], let from = value["from"] as? String, let connection = value["fromConnection"] as? String,
                  let id = value["id"] as? String, let encoded = value["ciphertext"] as? String,
                  [from,connection,id].allSatisfy(CommunityMobileControlBytes.id), from != context.deviceID else { throw TransportError.badFrame }
            let data = try ScreenCommunityRequest.decodeBase64(encoded, max: 54_000)
            guard data.count <= 40_000, ScreenCommunityRequest.base64(data) == encoded else { throw TransportError.badFrame }
            try await inbox.append(.data(deviceID: from, connectionID: connection, payload: data))
        default: throw TransportError.badFrame
        }
    }
    public func send(to deviceID: String, payload: Data) async throws {
        try await fence(); guard !closed, CommunityMobileControlBytes.id(deviceID), deviceID != context.deviceID, payload.count <= 40_000, pending.count < 16,
              ticket.body.leaseExpiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else { throw TransportError.closed }
        let id = UUID().uuidString.lowercased(), value: [String: Any] = ["type":"data","to":deviceID,"id":id,"ciphertext":ScreenCommunityRequest.base64(payload)]
        let wire = try CommunityMobileControlBytes.json(value), size = wire.count; guard size <= 65_536 else { throw TransportError.badFrame }
        let now = ContinuousClock.now, scheduled = max(now,nextWrite); nextWrite = scheduled.advanced(by: .seconds(Double(size) / 160_000))
        if scheduled > now { try await Task.sleep(until: scheduled, clock: .continuous) }
        try await fence(); guard !closed else { throw TransportError.closed }
        try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in try? await Task.sleep(for: .seconds(5)); guard !Task.isCancelled else { return }; await self?.failed(id) }
            pending[id] = Pending(continuation: continuation, timeout: timeout)
            Task { [weak self, socket] in do { try await Self.send(wire, socket: socket) } catch { await self?.failed(id) } }
        }
    }
    private func failed(_ id: String) { if let entry = pending.removeValue(forKey: id) { entry.timeout.cancel(); entry.continuation.resume(throwing: TransportError.timedOut) } }
    public func receive() async throws -> CommunityMobileControlRoutedFrame { try await fence(); let value = try await inbox.next(); try await fence(); return value }
    deinit { pump?.cancel(); renewal?.cancel(); expiry?.cancel(); socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
    public func close() async {
        guard !closed else { return }; closed = true; pump?.cancel(); renewal?.cancel(); expiry?.cancel()
        socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel()
        for entry in pending.values { entry.timeout.cancel(); entry.continuation.resume(throwing: TransportError.closed) }; pending = [:]; await inbox.finish()
    }
}
