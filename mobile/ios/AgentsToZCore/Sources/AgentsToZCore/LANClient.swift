import Foundation

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Where a resumable session token is kept between launches.
///
/// The QR's pairing token is still never stored — that one is single use and the comment on
/// `LANPairing` stands. The *session* token is a different thing: the host keeps the session for
/// 30 days precisely so a phone can come back, and the Mac's own web page moved its copy out of
/// per-tab storage for the same reason. Holding nothing meant every screen lock cost a walk to
/// the Mac, because a consumed QR cannot be scanned twice.
public protocol RemoteSessionStore: Sendable {
    func token(origin: String) -> String?
    func save(token: String, origin: String)
    func clear(origin: String)
}

/// Default for tests and for any host that has not supplied a real one. Keeps the previous
/// behaviour exactly: nothing survives the process.
public final class EphemeralSessionStore: RemoteSessionStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]
    public init() {}
    public func token(origin: String) -> String? { lock.lock(); defer { lock.unlock() }; return tokens[origin] }
    public func save(token: String, origin: String) { lock.lock(); defer { lock.unlock() }; tokens[origin] = token }
    public func clear(origin: String) { lock.lock(); defer { lock.unlock() }; tokens[origin] = nil }
}

/// One session and one request at a time. Closing cancels outstanding I/O; no background timers,
/// persisted QR, or action replay.
public actor LANClient {
    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var sessionToken: String?
    private var origin: String?
    private var snapshot: RemoteSnapshot?
    private var expiresAt: Date?
    private var busy = false
    private var generation = UUID()
    private let store: RemoteSessionStore

    public init(store: RemoteSessionStore = EphemeralSessionStore()) { self.store = store }

    /// Ends the session for good: the host is told, and the stored token is dropped so the next
    /// launch does not try to resume something the user chose to end.
    ///
    /// Telling the host matters now. A plain socket close means "away, I will be back", so
    /// without `session.end` a phone the user deliberately disconnected stayed listed on the Mac
    /// until its 30-day deadline. Best effort: an older Mac rejects the frame, and the close below
    /// happens either way.
    public func disconnect() async {
        if let socket, let token = sessionToken {
            let body: [String: Any] = ["type": "session.end", "protocolVersion": RemoteWire.version, "sessionToken": token]
            if let data = try? JSONSerialization.data(withJSONObject: body),
               let text = String(data: data, encoding: .utf8) {
                try? await socket.send(.string(text))
            }
        }
        forget()
    }

    /// Drop the session locally without telling the host — for paths where the socket is already
    /// gone, or where the caller has just been told the session ended.
    public func forget() {
        if let origin { store.clear(origin: origin) }
        teardown()
        origin = nil
    }

    /// Drops the socket but keeps the right to come back. This is what backgrounding does: the
    /// host preserves a session across a plain close, so throwing the token away here would
    /// re-create exactly the walk-to-the-Mac loop this exists to remove.
    public func suspend() {
        teardown()
    }

    private func teardown() {
        generation = UUID()
        socket?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        socket = nil; session = nil; sessionToken = nil; snapshot = nil; expiresAt = nil; busy = false
    }

    /// Whether `resume(origin:)` has something to work with.
    public func canResume(origin: String) -> Bool { store.token(origin: origin) != nil }

    /// Reconnect to a host we have paired with before, without a new QR.
    public func resume(origin: String) async throws -> RemoteSnapshot {
        guard !busy else { throw RemoteFailure.busy }
        guard let stored = store.token(origin: origin), LANPairing.validToken(stored),
              let url = Self.webSocketURL(origin: origin) else { throw RemoteFailure.disconnected }
        teardown()
        let current = generation
        busy = true
        defer { if generation == current { busy = false } }
        let task = openSocket(origin: origin, url: url)
        do {
            let reply = try await exchange([
                "type": "session.restore", "protocolVersion": RemoteWire.version, "sessionToken": stored,
            ], task: task)
            guard generation == current else { throw RemoteFailure.disconnected }
            guard reply.type == "session.restored" else { throw Self.failure(for: reply) }
            let value = try adopt(reply, origin: origin, expectedToken: stored)
            return value
        } catch {
            let failure = Self.publicFailure(error, task: task)
            if generation == current {
                // A host that no longer knows this token will never know it again; anything else
                // (Mac asleep, Wi-Fi gone) keeps the token so the next attempt can still work.
                if failure.endsStoredSession { store.clear(origin: origin) }
                teardown()
            }
            throw failure
        }
    }

    public func connect(_ pairing: LANPairing) async throws -> RemoteSnapshot {
        guard !busy else { throw RemoteFailure.busy }
        forget()
        let current = generation
        busy = true
        defer { if generation == current { busy = false } }
        let task = openSocket(origin: pairing.origin, url: pairing.webSocketURL)
        do {
            let reply = try await exchange(["type": "controller.pair", "protocolVersion": RemoteWire.version, "token": pairing.token], task: task)
            guard generation == current else { throw RemoteFailure.disconnected }
            guard reply.type == "session.ready" else { throw Self.failure(for: reply) }
            return try adopt(reply, origin: pairing.origin, expectedToken: nil)
        } catch {
            if generation == current { forget() }
            throw Self.publicFailure(error, task: task)
        }
    }

    @discardableResult
    private func openSocket(origin value: String, url: URL) -> URLSessionWebSocketTask {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        let transport = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue(value, forHTTPHeaderField: "Origin")
        let task = transport.webSocketTask(with: request)
        task.maximumMessageSize = RemoteWire.maximumBytes
        session = transport; socket = task; origin = value; task.resume()
        return task
    }

    /// Accept a `session.ready` or `session.restored` and remember enough to come back.
    /// `expectedToken` is set on resume: the host must return the same session, not a new one.
    private func adopt(_ reply: RemoteReply, origin value: String, expectedToken: String?) throws -> RemoteSnapshot {
        guard reply.protocolVersion == RemoteWire.version,
              let token = reply.sessionToken, LANPairing.validToken(token),
              expectedToken == nil || token == expectedToken,
              let host = reply.hostName, !host.isEmpty, host.utf8.count <= 1024,
              let expiry = RemoteWire.date(reply.expiresAt), expiry > Date(),
              let idle = RemoteWire.date(reply.idleExpiresAt), idle > Date(),
              let projects = reply.projects, let count = reply.projectCount else { throw RemoteFailure.invalidResponse }
        sessionToken = token; expiresAt = min(expiry, idle); origin = value
        store.save(token: token, origin: value)
        let value = RemoteSnapshot(hostName: host, projects: projects, projectCount: count, nextPage: reply.nextPage)
        snapshot = value
        return value
    }

    /// Whether a remembered address is still one this client would connect to. The app stores
    /// the origin outside the Keychain (it is not a secret), so it has to be re-validated on the
    /// way back in rather than trusted because it was written by us once.
    public static func resumableOrigin(_ value: String) -> Bool {
        guard value.hasPrefix("http://"), webSocketURL(origin: value) != nil else { return false }
        let rest = value.dropFirst("http://".count).split(separator: ":", omittingEmptySubsequences: false)
        guard rest.count == 2, let port = Int(rest[1]), (1024...65535).contains(port) else { return false }
        return LANPairing.privateIPv4(String(rest[0]))
    }

    static func webSocketURL(origin: String) -> URL? {
        guard origin.hasPrefix("http://") else { return nil }
        return URL(string: origin.replacingOccurrences(of: "http://", with: "ws://") + "/remote/ws")
    }

    /// Turn a host frame that is not what we asked for into the right failure. `error` and
    /// `session.closed` used to be rejected as malformed, so the reason never reached the user.
    private static func failure(for reply: RemoteReply) -> RemoteFailure {
        switch reply.type {
        case "error":
            .hostRefused(code: reply.error?.code ?? "UNKNOWN", message: reply.error?.displayMessage)
        case "session.closed":
            .sessionEnded(reason: reply.reason.flatMap { $0.utf8.count <= 1024 ? $0 : nil })
        default:
            .invalidResponse
        }
    }

    public func refresh(loadMore: Bool = false) async throws -> RemoteSnapshot {
        guard !busy else { throw RemoteFailure.busy }
        guard let before = snapshot else { throw RemoteFailure.disconnected }
        let current = generation
        let page = loadMore ? before.nextPage : 0
        guard let page else { return before }
        let reply = try await action("projects.list", extra: ["page": page])
        guard generation == current else { throw RemoteFailure.disconnected }
        guard reply.page == page, let projects = reply.projects, let count = reply.projectCount,
              reply.nextPage == nil || reply.nextPage! > page else { forget(); throw RemoteFailure.invalidResponse }
        var merged = loadMore ? before.projects : []
        let returnedIDs = Set(projects.map(\.id))
        merged.removeAll { returnedIDs.contains($0.id) }; merged += projects
        guard merged.count <= 500, merged.count <= count else { forget(); throw RemoteFailure.invalidResponse }
        let value = RemoteSnapshot(hostName: before.hostName, projects: merged, projectCount: count, nextPage: reply.nextPage)
        snapshot = value
        return value
    }

    /// The UI confirms the selected project and action before calling this.
    /// The Mac independently checks its live registration and action allowlist.
    public func perform(_ operation: ProjectAction, controlID: String) async throws {
        let current = generation
        guard let project = snapshot?.projects.first(where: { $0.id == controlID }),
              project.availableActions.contains(operation) else { throw RemoteFailure.denied }
        let reply = try await action(operation.rawValue, extra: ["controlId": controlID, "remoteConfirmed": true])
        guard generation == current else { throw RemoteFailure.disconnected }
        guard let project = reply.project, project.id == controlID else { forget(); throw RemoteFailure.invalidResponse }
        if let old = snapshot {
            snapshot = RemoteSnapshot(hostName: old.hostName, projects: old.projects.map { $0.id == controlID ? project : $0 },
                                      projectCount: old.projectCount, nextPage: old.nextPage)
        }
    }

    private func action(_ action: String, extra: [String: Any]) async throws -> RemoteReply {
        guard !busy else { throw RemoteFailure.busy }
        guard let task = socket, let token = sessionToken, let expiry = expiresAt, expiry > Date() else {
            forget(); throw RemoteFailure.disconnected
        }
        let current = generation
        busy = true
        defer { if generation == current { busy = false } }
        let id = UUID().uuidString
        var body: [String: Any] = ["type": "action.request", "protocolVersion": RemoteWire.version,
                                  "sessionToken": token, "actionId": id, "action": action]
        body.merge(extra) { _, value in value }
        do {
            let reply = try await exchange(body, task: task)
            guard generation == current else { throw RemoteFailure.disconnected }
            if reply.type != "action.result" { throw Self.failure(for: reply) }
            guard reply.actionId == id, reply.ok != nil else { throw RemoteFailure.invalidResponse }
            // The host answered. A refusal — rate limited, cancelled mid-flight, not available
            // right now — is an application answer on a healthy socket. Tearing the session down
            // here meant a retriable RATE_LIMITED cost a walk to the Mac for a new QR.
            guard reply.ok == true else {
                throw RemoteFailure.hostRefused(code: reply.error?.code ?? "ACTION_FAILED",
                                                message: reply.error?.displayMessage)
            }
            return reply
        } catch {
            let failure = Self.publicFailure(error, task: task)
            if generation == current && !failure.keepsSession { forget() }
            throw failure
        }
    }

    private func exchange(_ body: [String: Any], task: URLSessionWebSocketTask) async throws -> RemoteReply {
        let data = try JSONSerialization.data(withJSONObject: body)
        guard data.count <= RemoteWire.maximumBytes, let text = String(data: data, encoding: .utf8) else { throw RemoteFailure.invalidResponse }
        let response = try await withTaskCancellationHandler {
          try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await task.send(.string(text))
                switch try await task.receive() {
                case .data(let data): return data
                case .string(let text): return Data(text.utf8)
                @unknown default: throw RemoteFailure.invalidResponse
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(15))
                task.cancel(with: .goingAway, reason: nil)
                throw RemoteFailure.timeout
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw RemoteFailure.disconnected }
            return first
          }
        } onCancel: {
            task.cancel(with: .goingAway, reason: nil)
        }
        return try RemoteWire.decode(response)
    }

    /// Foundation errors can include URLs. Never expose raw diagnostics to UI/logs — but the
    /// close code is a small integer the host chose, and it is the only way to tell "the Mac is
    /// restarting, come back" (1012) from "this session is over" (1000/1001/1008).
    private static func publicFailure(_ error: Error, task: URLSessionWebSocketTask?) -> RemoteFailure {
        if let failure = error as? RemoteFailure { return failure }
        // 1012 Service Restart is not in Foundation's enum, so compare the raw code. That is the
        // one the Mac now uses for a preserving teardown, and it deliberately arrives without a
        // session.closed frame — treating it as terminal would discard a session the host kept.
        switch task?.closeCode.rawValue {
        case .some(RemoteWire.serviceRestartCloseCode),
             .some(URLSessionWebSocketTask.CloseCode.abnormalClosure.rawValue),
             .some(URLSessionWebSocketTask.CloseCode.internalServerError.rawValue):
            return .resumable
        default:
            return .disconnected
        }
    }
}
