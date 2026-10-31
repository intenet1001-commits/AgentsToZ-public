import CryptoKit
import Foundation
import os

public enum ScreenRelayError: Error, Sendable { case offline, busy, unavailable, unsupportedVersion, peerWaitExpired }
public enum ScreenRelayProgress: Int, Sendable { case connecting = 0, waiting, paired }

/// The relay is an untrusted byte carrier. It never supplies a screen key or an approval.
public struct ScreenRelayRoute: Codable, Hashable, Sendable {
    public let endpoint: URL
    public let room: String

    public init(endpoint: URL, room: String) throws {
        guard Self.validEndpoint(endpoint), Self.validRoom(room) else { throw RegistrationError.malformed }
        self.endpoint = endpoint
        self.room = room
    }

    public static func validEndpoint(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return parts.scheme == "wss" && parts.host?.isEmpty == false && parts.user == nil && parts.password == nil
            && parts.query == nil && parts.fragment == nil && parts.percentEncodedPath == "/screen-relay"
            && (parts.port == nil || parts.port == 443)
    }

    public static func validRoom(_ room: String) -> Bool {
        let fields = room.split(separator: ".", omittingEmptySubsequences: false)
        return fields.count == 2 && fields[0].count == 64 && fields[0].allSatisfy { "0123456789abcdef".contains($0) }
            && fields[1].count == 43 && fields[1].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    public static func newRoom(fingerprint: Data) -> String {
        fingerprint.map { String(format: "%02x", $0) }.joined() + "." + base64url(randomBytes(32))
    }

    public func matches(fingerprint: Data) -> Bool {
        room.hasPrefix(fingerprint.map { String(format: "%02x", $0) }.joined() + ".")
    }

    private enum CodingKeys: String, CodingKey { case endpoint, room }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(endpoint: values.decode(URL.self, forKey: .endpoint), room: values.decode(String.self, forKey: .room))
    }
}

private func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private final class RelaySessionDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// One WebSocket binary message is one native frame. The TCP length prefix is not sent over WebSocket.
public final class ScreenRelayTransport: ScreenFrameTransport, Sendable {
    public enum Purpose: String, Sendable { case screen, registration }
    private struct State {
        var maxFrame = 16 * 1024
        var closed = false
        var queuedBytes = 0
        var queuedFrames = 0
        var tail: Task<Void, Never>?
    }
    private let state = OSAllocatedUnfairLock(initialState: State())
    private let socket: URLSessionWebSocketTask
    private let session: URLSession
    /// The relay assigns this opaque ID; it is used only for resource accounting, never authentication.
    public let peerID: String

    private init(socket: URLSessionWebSocketTask, session: URLSession, peerID: String) {
        self.socket = socket; self.session = session; self.peerID = peerID
    }

    /// `hostSigner == nil` joins as a controller. A host signs this connection's fresh challenge.
    /// Opening a route happens before the native one-use authentication exchange starts.
    public static func open(route: ScreenRelayRoute, purpose: Purpose, hostSigner: (any TranscriptSigner)? = nil,
                            timeout: Duration = .seconds(10),
                            progress: (@Sendable (ScreenRelayProgress) -> Void)? = nil) async throws -> ScreenRelayTransport {
        for attempt in 0..<7 {
            do {
                do { return try await open(endpoint: route.endpoint, room: route.room, purpose: purpose, hostSigner: hostSigner,
                                           timeout: timeout, version: hostSigner == nil ? 1 : 2, progress: progress) }
                catch ScreenRelayError.unsupportedVersion where hostSigner != nil {
                    // A v1 relay does not know waiting acknowledgements. This is before native authentication;
                    // the device's one-use biometric signer has never been used. Never retry a native auth failure.
                    return try await open(endpoint: route.endpoint, room: route.room, purpose: purpose, hostSigner: hostSigner,
                                          timeout: timeout, version: 1, progress: progress)
                }
            }
            catch ScreenRelayError.offline where hostSigner == nil && attempt < 6 {
                try await Task.sleep(for: .milliseconds(500))
            }
        }
        throw ScreenRelayError.offline
    }

    #if DEBUG
    /// The actual-socket test fixture is deliberately unavailable in release builds or app route storage.
    static func openFixture(endpoint: URL, room: String, purpose: Purpose, hostSigner: (any TranscriptSigner)? = nil,
                            timeout: Duration = .seconds(5), peerTimeout: Duration = .seconds(110), version: Int? = nil,
                            progress: (@Sendable (ScreenRelayProgress) -> Void)? = nil) async throws -> ScreenRelayTransport {
        guard endpoint.scheme == "ws", endpoint.host == "127.0.0.1", endpoint.path == "/screen-relay",
              endpoint.user == nil, endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil,
              ScreenRelayRoute.validRoom(room) else { throw RegistrationError.malformed }
        return try await open(endpoint: endpoint, room: room, purpose: purpose, hostSigner: hostSigner, timeout: timeout,
                              version: version ?? (hostSigner == nil ? 1 : 2), progress: progress, peerTimeout: peerTimeout)
    }
    #endif

    private static func open(endpoint: URL, room: String, purpose: Purpose, hostSigner: (any TranscriptSigner)?, timeout: Duration,
                             version: Int, progress: (@Sendable (ScreenRelayProgress) -> Void)?,
                             peerTimeout: Duration = .seconds(110)) async throws -> ScreenRelayTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.allowsCellularAccess = true
        let session = URLSession(configuration: configuration, delegate: RelaySessionDelegate(), delegateQueue: nil)
        let socket = session.webSocketTask(with: endpoint)
        // CFNetwork on macOS 26 retains the initial socket buffering limit after resume. Changing it during
        // key confirmation made legitimate video fail with EMSGSIZE in the actual-socket regression.
        // Reserve one bounded record buffer; receive() still rejects pre-auth frames above the native 1 KiB cap.
        socket.maximumMessageSize = 8 * 1024 * 1024 + 25
        let deadline = Task {
            guard (try? await Task.sleep(for: timeout)) != nil else { return }
            socket.cancel(with: .goingAway, reason: nil)
        }
        defer { deadline.cancel() }
        let peerWaitExpired = OSAllocatedUnfairLock(initialState: false)
        var peerDeadline: Task<Void, Never>?
        defer { peerDeadline?.cancel() }
        progress?(.connecting)
        socket.resume()
        return try await withTaskCancellationHandler {
        do {
            let challenge = try await control(socket)
            guard challenge["type"] as? String == "challenge", challenge.count == 2,
                  let nonce = challenge["nonce"] as? String, nonce.count == 43,
                  nonce.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
                throw TransportError.failed("릴레이 응답 형식이 올바르지 않습니다")
            }
            var join: [String: Any] = ["type": "join", "version": version, "purpose": purpose.rawValue,
                                       "role": hostSigner == nil ? "controller" : "host", "room": room]
            if let hostSigner {
                guard room.hasPrefix(ScreenControlIdentity.fingerprint(of: hostSigner.publicKey).map { String(format: "%02x", $0) }.joined() + ".") else {
                    throw RegistrationError.mismatch
                }
                let transcript = Data(("agentstoz.screen-relay/v\(version) host\n" + purpose.rawValue + "\n" + room + "\n" + nonce).utf8)
                join["publicKey"] = hostSigner.publicKey.x963Representation.base64EncodedString()
                join["signature"] = try await hostSigner.signature(for: transcript).rawRepresentation.base64EncodedString()
            }
            try await socket.send(.string(String(decoding: JSONSerialization.data(withJSONObject: join), as: UTF8.self)))
            if hostSigner != nil, version == 1 {
                // A v1 relay has no admission acknowledgement. Keep the signed join alive for a bounded peer wait,
                // without claiming verified waiting. Challenge and join still had the short connection deadline.
                deadline.cancel()
                peerDeadline = Task {
                    guard (try? await Task.sleep(for: peerTimeout)) != nil else { return }
                    peerWaitExpired.withLock { $0 = true }
                    socket.cancel(with: .goingAway, reason: nil)
                }
            }
            var paired = try await control(socket)
            if hostSigner != nil, version == 2 {
                guard paired["type"] as? String == "waiting", paired["version"] as? Int == 2, paired.count == 2 else {
                    throw TransportError.badFrame
                }
                // TLS/challenge/admission use timeout. Waiting for a phone gets its own bounded window, below the
                // relay's 120s waiting limit, so a ready Mac no longer disappears every 30 seconds.
                deadline.cancel()
                peerDeadline = Task {
                    guard (try? await Task.sleep(for: peerTimeout)) != nil else { return }
                    peerWaitExpired.withLock { $0 = true }
                    socket.cancel(with: .goingAway, reason: nil)
                }
                progress?(.waiting)
                paired = try await control(socket)
            }
            guard paired["type"] as? String == "paired", paired.count == 2,
                  let peerID = paired["peerId"] as? String, peerID.utf8.count == 22,
                  peerID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
                throw TransportError.failed("릴레이에서 Mac을 연결하지 못했습니다")
            }
            progress?(.paired)
            return ScreenRelayTransport(socket: socket, session: session, peerID: peerID)
        } catch {
            socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel()
            if peerWaitExpired.withLock({ $0 }) { throw ScreenRelayError.peerWaitExpired }
            throw error
        }
        } onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }
    }

    private static func control(_ socket: URLSessionWebSocketTask) async throws -> [String: Any] {
        guard case .string(let text) = try await socket.receive(), text.utf8.count <= 2048,
              let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
            throw TransportError.closed
        }
        if object["type"] as? String == "error" {
            guard object.count == 2, object["code"] is String else { throw TransportError.badFrame }
            switch object["code"] as? String {
            case "offline": throw ScreenRelayError.offline
            case "busy": throw ScreenRelayError.busy
            case "malformed": throw ScreenRelayError.unsupportedVersion
            default: throw ScreenRelayError.unavailable
            }
        }
        return object
    }

    public func setMaxFrame(_ value: Int) {
        state.withLock { $0.maxFrame = value }
    }

    public func receive() async throws -> Data {
        guard !state.withLock({ $0.closed }) else { throw TransportError.closed }
        guard case .data(let payload) = try await socket.receive(), !payload.isEmpty,
              state.withLock({ !$0.closed && payload.count <= $0.maxFrame }) else {
            cancel(); throw TransportError.closed
        }
        return payload
    }

    public func send(_ payload: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueue(payload) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    public func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        enqueueMessage(.data(payload), bytes: payload.count, completion: completion)
    }

    /// A resource-budget signal only, sent after MacHandshake key confirmation succeeds.
    public func authenticated() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueueMessage(.string("{\"type\":\"authenticated\"}"), bytes: 24) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    private func enqueueMessage(_ message: URLSessionWebSocketTask.Message, bytes: Int,
                                completion: @escaping @Sendable (TransportError?) -> Void) {
        let admitted = state.withLock { value in
            guard !value.closed, bytes > 0, bytes <= value.maxFrame, value.queuedFrames < 16,
                  value.queuedBytes + bytes <= 16 * 1024 * 1024 else { return false }
            value.queuedFrames += 1; value.queuedBytes += bytes
            let previous = value.tail
            value.tail = Task { [self] in
                await previous?.value
                var sendError: TransportError?
                do {
                    guard !state.withLock({ $0.closed }) else { throw TransportError.closed }
                    try await socket.send(message)
                } catch { sendError = .closed; cancel() }
                state.withLock { $0.queuedFrames -= 1; $0.queuedBytes -= bytes }
                completion(sendError)
            }
            return true
        }
        if !admitted { cancel(); completion(.closed) }
    }

    public func cancel() {
        let shouldClose = state.withLock { value in
            guard !value.closed else { return false }
            value.closed = true; return true
        }
        if shouldClose { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
    }

    deinit { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}
