#if os(macOS)
import Foundation
import ScreenControlCore

// The Mac controllers' recent history at this Mac (docs/design/mac-to-mac-2026-11-01 7.3 「controller-log」, SR-30): the
// last 64 enrolments, grant changes, removals, connections, endings, refusals and self-unenrolments, for the person at
// this Mac to read. Never screen content, input or an address. A keychain item of its own beside "controllers", so it is
// kept where only AgentsToZ Screen reaches. Writing it is best effort: a log that cannot be saved never stops a
// disconnect, a removal or any other defence.

public struct ControllerLogEntry: Codable, Sendable, Equatable {
    public enum Event: String, Codable, Sendable, CaseIterable {
        case paired, grantChanged, removed, connected, ended, refused, unenrolled
    }

    /// How the session reached this Mac: directly on the local network, or through a tunnel connector on this Mac.
    public enum Route: String, Codable, Sendable {
        case nearby, connector
    }

    public let at: Date
    /// Hex of the controller's key fingerprint.
    public let controllerID: String
    /// The name this Mac showed for it then (`RegisteredController.displayName`).
    public let name: String
    public let event: Event
    /// A short fixed word: why a session ended or was refused, or the grant a change set. Never free text from the peer.
    public let reason: String?
    /// For connections, their endings and refusals; nil for what happened at this Mac alone.
    public let route: Route?

    public init(at: Date, controllerID: String, name: String, event: Event, reason: String? = nil, route: Route? = nil) {
        self.at = at
        self.controllerID = controllerID
        self.name = name
        self.event = event
        self.reason = reason
        self.route = route
    }

    /// The route a session came by: a connector's sub-bucket, or anything else the local network.
    public static func route(of peer: PeerKey) -> Route { peer.isConnector ? .connector : .nearby }

    /// The word a session ending is logged with.
    public static func reason(_ ending: SessionEndReason?) -> String {
        guard let ending else { return "left" }
        return switch ending {
        case .idle: "idle"
        case .timeLimit: "timeLimit"
        case .endedAtMac: "endedAtMac"
        case .turnedOff: "turnedOff"
        case .revoked: "revoked"
        case .replaced: "replaced"
        case .turnedOffFromDevice: "turnedOffFromDevice"
        case .takenOver: "takenOver"
        case .busy: "busy"
        case .captureUnavailable: "captureUnavailable"
        }
    }
}

/// A ring of the newest `capacity` entries, oldest first.
public struct ControllerLog: Sendable, Equatable {
    public static let capacity = 64
    static let format = 1

    public private(set) var entries: [ControllerLogEntry]

    public init(entries: [ControllerLogEntry] = []) { self.entries = Array(entries.suffix(Self.capacity)) }

    public mutating func append(_ entry: ControllerLogEntry) {
        entries.append(entry)
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    func encoded() throws -> Data { try JSONEncoder().encode(Document(format: Self.format, entries: entries)) }

    /// A stored log: a row that does not decode is dropped alone. Nil for a document this build does not know: the log is
    /// a record for the person, so it starts again instead of stopping anything.
    static func decode(_ data: Data) -> ControllerLog? {
        guard let rows = try? JSONDecoder().decode(Rows.self, from: data) else { return nil }
        return ControllerLog(entries: rows.entries)
    }

    private struct Document: Encodable {
        let format: Int
        let entries: [ControllerLogEntry]
    }

    private struct Rows: Decodable {
        var entries: [ControllerLogEntry] = []
        enum CodingKeys: String, CodingKey { case format, entries }
        init(from decoder: Decoder) throws {
            let document = try decoder.container(keyedBy: CodingKeys.self)
            guard try document.decode(Int.self, forKey: .format) == ControllerLog.format else {
                throw DecodingError.dataCorruptedError(forKey: .format, in: document, debugDescription: "unknown format")
            }
            var rows = try document.nestedUnkeyedContainer(forKey: .entries)
            while !rows.isAtEnd {
                if let entry = try? rows.decode(ControllerLogEntry.self) { entries.append(entry) }
                else { _ = try? rows.decode(Skipped.self) }
            }
        }
    }

    /// Consumes one element of any shape.
    private struct Skipped: Decodable { init(from decoder: Decoder) throws {} }
}

/// What reading the stored log gave.
enum StoredControllerLog: Equatable {
    /// The log as stored; empty when there is none.
    case log(ControllerLog)
    /// Something this build cannot decode (damaged, or a format it does not know): set aside, and the log starts again.
    case undecodable
    /// The keychain did not answer (locked, interrupted): the stored entries may be fine, so nothing overwrites them
    /// until a read goes through (DESIGN 12절 「키체인 읽기 실패」).
    case readFailed
}

extension ScreenStore {
    static let controllerLogAccount = "controller-log"

    func storedControllerLog() -> StoredControllerLog {
        let stored: Data?
        do { stored = try read(Self.controllerLogAccount) } catch { return .readFailed }
        guard let data = stored else { return .log(ControllerLog()) }
        return ControllerLog.decode(data).map(StoredControllerLog.log) ?? .undecodable
    }

    func saveControllerLog(_ log: ControllerLog) throws {
        try write(Self.controllerLogAccount, try log.encoded())
    }
}

/// The log as the service keeps it: in memory for the menu, saved after each entry. Saving may fail; the entry stays in
/// memory and nothing else waits on it. While the stored log could not be read, entries stay in memory only and each
/// one reads it again first: once a read goes through, the stored entries come first and the ring is saved, so a keychain
/// that did not answer once never wipes the history.
@MainActor
final class ControllerLogBook {
    private let store: ScreenStore
    private let now: () -> Date
    private(set) var log: ControllerLog
    /// Whether the last entry was not saved.
    private(set) var unsaved = false
    /// Whether the stored log has not been read yet: nothing is saved over it meanwhile.
    private(set) var unread = false

    init(store: ScreenStore, now: @escaping () -> Date = { Date() }) {
        self.store = store
        self.now = now
        switch store.storedControllerLog() {
        case .log(let stored): log = stored
        case .undecodable: log = ControllerLog()
        case .readFailed:
            log = ControllerLog()
            unread = true
        }
    }

    /// Adds one entry. Returns whether it was saved; nothing should depend on that but the menu's notice.
    @discardableResult
    func record(_ event: ControllerLogEntry.Event, id: String, name: String, reason: String? = nil,
                route: ControllerLogEntry.Route? = nil) -> Bool {
        log.append(ControllerLogEntry(at: now(), controllerID: id, name: name, event: event, reason: reason, route: route))
        if unread {
            switch store.storedControllerLog() {
            case .log(let stored):
                // What was stored is older than anything recorded since.
                log = ControllerLog(entries: stored.entries + log.entries)
                unread = false
            case .undecodable:
                unread = false
            case .readFailed:
                unsaved = true
                return false
            }
        }
        do {
            try store.saveControllerLog(log)
            unsaved = false
        } catch {
            unsaved = true
        }
        return !unsaved
    }
}
#endif
