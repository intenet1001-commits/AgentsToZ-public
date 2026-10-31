#if os(macOS)
import Foundation

/// What the main AgentsToZ app shows in its work-mode panel (DESIGN 「덮개 닫힘」): whether this helper is on or being
/// viewed, how many devices can still connect, and which permission it still needs. One small owner-only file with no
/// device names, addresses or keys. The main app only displays it; nothing reads it to decide anything about security.
public struct ScreenStatus: Codable, Equatable, Sendable {
    /// `waiting`: on, but not listening, because this Mac is not on an approved network (결정 4). No network name or
    /// address is written: the panel only says to approve it in AgentsToZ Screen.
    public enum Power: String, Codable, Sendable { case off, starting, on, waiting }
    public enum LoginItem: String, Codable, Sendable { case on, off, approval }

    public var version = 1
    public var pid: Int32
    public var power: Power
    public var viewing: Bool
    /// Registrations that can still connect: expired ones are refused by the key exchange.
    public var devices: Int
    /// Screen recording is allowed.
    public var capture: Bool
    /// Posting events and observing local takeover are both allowed, which controlling needs.
    public var control: Bool
    public var loginItem: LoginItem
    /// Milliseconds since 1970, when this was written.
    public var updatedAt: Int64

    public init(pid: Int32, power: Power, viewing: Bool, devices: Int, capture: Bool, control: Bool, loginItem: LoginItem,
                updatedAt: Int64) {
        self.pid = pid
        self.power = power
        self.viewing = viewing
        self.devices = devices
        self.capture = capture
        self.control = control
        self.loginItem = loginItem
        self.updatedAt = updatedAt
    }

    /// Equal apart from when it was written: an unchanged status is not written again.
    public func sameState(as other: ScreenStatus?) -> Bool {
        guard var other else { return false }
        other.updatedAt = updatedAt
        return other == self
    }
}

public enum ScreenStatusFile {
    /// `~/Library/Application Support/AgentsToZ Screen/status.json`. The main app reads the same path
    /// (src-tauri/src/screen_helper.rs).
    public static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/AgentsToZ Screen/status.json")
    }

    /// Replaces the file in one rename, so a reader never sees half of it. Owner-only (0600 in a 0700 folder).
    public static func write(_ status: ScreenStatus, to url: URL = url) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = folder.appending(path: ".status-\(UUID().uuidString).json")
        guard FileManager.default.createFile(atPath: temporary.path, contents: try JSONEncoder().encode(status),
                                             attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        guard rename(temporary.path, url.path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(at: temporary)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
    }

    /// On quit: the main app then shows the helper as not running. Only a file this process wrote: a second copy that
    /// is still running keeps what it wrote.
    public static func remove(at url: URL = url, pid: Int32 = getpid()) {
        guard let data = try? Data(contentsOf: url), data.count <= 4096,
              let status = try? JSONDecoder().decode(ScreenStatus.self, from: data), status.pid == pid else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
#endif
