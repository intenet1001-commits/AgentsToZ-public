import Foundation

public enum ProjectAction: String, Codable, CaseIterable, Sendable {
    case start, stop, restart
    public var label: String { switch self { case .start: "시작"; case .stop: "중지"; case .restart: "재시작" } }
}

public struct RemoteProject: Decodable, Identifiable, Sendable, Equatable {
    public let controlId: String
    public let name: String
    public let alias: String?
    public let workspaceRoot: String?
    public let branch: String?
    public let port: Int?
    public let kind: String
    public let status: String
    public let actions: [String]
    public var id: String { controlId }
    public var availableActions: [ProjectAction] { ProjectAction.allCases.filter { actions.contains($0.rawValue) } }
    public var statusLabel: String { switch status { case "running": "실행 중"; case "stopped": "중지됨"; default: "상태 확인 필요" } }
    func validate() throws {
        guard LANPairing.validToken(controlId), !name.isEmpty, name.utf8.count <= 1024,
              [alias, workspaceRoot, branch].allSatisfy({ ($0?.utf8.count ?? 0) <= 1024 }),
              port == nil || (1...65535).contains(port!), ["main", "worktree"].contains(kind),
              ["running", "stopped", "unknown"].contains(status), actions.count <= 32,
              actions.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 64 }) else { throw RemoteFailure.invalidResponse }
    }
}

/// The host's machine-readable refusal. Without this every `ok:false` looked identical, so a
/// retriable RATE_LIMITED and a real disconnect produced the same tear-down.
public struct RemoteWireError: Decodable, Sendable, Equatable {
    public let code: String?
    public let message: String?
    /// The host is the Mac we verified by origin, but bound it anyway: this text reaches the UI.
    public var displayMessage: String? {
        guard let message, !message.isEmpty, message.utf8.count <= 1024 else { return nil }
        return message
    }
}

struct RemoteReply: Decodable, Sendable {
    let type: String
    let protocolVersion: String?
    let sessionToken: String?
    let hostName: String?
    let expiresAt: String?
    let idleExpiresAt: String?
    let projects: [RemoteProject]?
    let project: RemoteProject?
    let projectCount: Int?
    let nextPage: Int?
    let page: Int?
    let actionId: String?
    let ok: Bool?
    let error: RemoteWireError?
    let reason: String?
}

public struct RemoteSnapshot: Sendable {
    public let hostName: String
    public let projects: [RemoteProject]
    public let projectCount: Int
    public let nextPage: Int?
}

enum RemoteWire {
    static let version = "agentstoz-local-v7"
    static let maximumBytes = 16 * 1024
    /// Kept in step with the host: see `parseRemoteControlClientMessage` and the frames
    /// `remoteControlLanServer.ts` sends. Decoding is separate from deciding — a refusal is
    /// returned to the caller, which knows whether it is terminal for what it was doing.
    static let acceptedTypes = ["session.ready", "session.restored", "action.result", "session.closed", "error"]
    /// RFC 6455 1012 Service Restart. The Mac closes with this when it is tearing down but keeping
    /// the session; Foundation's CloseCode enum does not name it.
    static let serviceRestartCloseCode = 1012
    static func decode(_ data: Data) throws -> RemoteReply {
        guard data.count <= maximumBytes else { throw RemoteFailure.invalidResponse }
        let reply: RemoteReply
        do { reply = try JSONDecoder().decode(RemoteReply.self, from: data) }
        catch { throw RemoteFailure.invalidResponse }
        // The types the Mac actually emits. `session.ended` was in this list and does not exist
        // anywhere in the host; `session.closed`, `session.restored` and `error` were rejected as
        // malformed, so a resumed session could not be read and every host refusal was flattened
        // into "the connection died".
        guard Self.acceptedTypes.contains(reply.type) else { throw RemoteFailure.invalidResponse }
        if let projects = reply.projects {
            guard projects.count <= 500, Set(projects.map(\.id)).count == projects.count,
                  let count = reply.projectCount, (projects.count...500).contains(count),
                  reply.nextPage == nil || (1...99).contains(reply.nextPage!) else { throw RemoteFailure.invalidResponse }
            for project in projects { try project.validate() }
        }
        try reply.project?.validate()
        return reply
    }
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
