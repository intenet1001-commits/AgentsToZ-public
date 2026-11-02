#if os(macOS)
import Foundation
import os
import ScreenControlCore

// Remote human input on this Mac, as a hint for the main app's sidecar (docs/design/mac-to-mac-2026-11-01 6.7, SR-34).
// While a phone or a Mac controller's input is injected here, at most once every two seconds, AgentsToZ Screen writes
//   ~/Library/Application Support/AgentsToZ Screen/remote-input.json
//   {"format":1,"lastInputAt":<milliseconds since 1970>,"session":"phone"|"controller"}
// owner-only, replaced in one rename, and removes it when the session ends. The sidecar reads it before sending an AI's
// input to Control and refuses that input while a remote person typed within the last ten seconds: the person wins.
//
// A hint the same user can write, apart from the status file so that contract stays as it is. Forging it only makes the AI
// wait (the safe side); deleting it brings back what happens without it. A view-only session injects nothing and never
// writes it, so a person watching from a phone never stops the AI.

public struct RemoteInputRecord: Codable, Equatable, Sendable {
    public enum Session: String, Codable, Sendable { case phone, controller }

    public var format = 1
    /// Milliseconds since 1970: the last remote input this Mac injected, at most `RemoteInputMarker.interval` old while
    /// input keeps coming.
    public var lastInputAt: Int64
    public var session: Session

    public init(lastInputAt: Int64, session: Session) {
        self.lastInputAt = lastInputAt
        self.session = session
    }

    public init(_ peerClass: ScreenPeerClass, at date: Date) {
        self.init(lastInputAt: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)), session: peerClass == .phone ? .phone : .controller)
    }
}

/// One session's marker. `note` is called from the input path on any thread: the write happens on a queue, so injection
/// never waits on the disk, and `remove` runs after every write already asked for.
///
/// Every marker shares one serial queue, and each asks for its write or removal while it holds its own state: a session
/// replaced or taken over removes its file before the next session's first write can land, so the old session never
/// deletes the record of a person still typing in the new one (SR-34), and no write of an ended session follows its removal.
public final class RemoteInputMarker: Sendable {
    /// `~/Library/Application Support/AgentsToZ Screen/remote-input.json`, beside the status file.
    public static var url: URL { ScreenStatusFile.url.deletingLastPathComponent().appending(path: "remote-input.json") }
    /// How often the file is written at most while input keeps coming.
    public static let interval: TimeInterval = 2

    private let url: URL
    private let session: ScreenPeerClass
    private let now: @Sendable () -> Date
    /// When the file was last written, and whether the session ended (nothing is written after that).
    private let state = OSAllocatedUnfairLock(initialState: (lastWritten: Date?.none, ended: false))
    /// One for every marker of this process: the order sessions asked in is the order the file sees.
    static let queue = DispatchQueue(label: "agentstoz.screen-control.remote-input")

    public init(url: URL = RemoteInputMarker.url, session: ScreenPeerClass, now: @escaping @Sendable () -> Date = { Date() }) {
        self.url = url
        self.session = session
        self.now = now
    }

    /// Remote input was just injected. Writes now unless the file was written less than `interval` ago.
    public func note() {
        let date = now()
        let record = RemoteInputRecord(session, at: date), url = url
        state.withLock { state in
            guard !state.ended else { return }
            if let last = state.lastWritten, date.timeIntervalSince(last) < Self.interval, date >= last { return }
            state.lastWritten = date
            // Asked for while holding the state, so it can never be queued behind this marker's removal.
            Self.queue.async { try? Self.write(record, to: url) }
        }
    }

    /// The session ended: the file goes, after any write still on its way, and nothing is written again.
    public func remove() {
        let url = url
        state.withLock { state in
            guard !state.ended else { return }
            state.ended = true
            Self.queue.async { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// Waits for the writes and removals asked for so far (checks).
    func settle() { Self.queue.sync {} }

    static func write(_ record: RemoteInputRecord, to url: URL) throws {
        let folder = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = folder.appending(path: ".remote-input-\(UUID().uuidString).json")
        guard FileManager.default.createFile(atPath: temporary.path, contents: try JSONEncoder().encode(record),
                                             attributes: [.posixPermissions: 0o600]) else { throw CocoaError(.fileWriteUnknown) }
        guard rename(temporary.path, url.path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(at: temporary)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
    }
}

/// A session's keyboard and Spaces controls, marking each one that reached this Mac as remote input.
final class MarkedDesktopControls: DesktopControlling {
    private let base: any DesktopControlling
    private let marker: RemoteInputMarker

    init(_ base: any DesktopControlling, marker: RemoteInputMarker) {
        self.base = base
        self.marker = marker
    }

    func keyboardState() async -> ScreenKeyboardState { await base.keyboardState() }

    func keyboard(_ action: ScreenKeyboardAction) async -> (ScreenKeyboardState, ScreenControlResult) {
        let answer = await base.keyboard(action)
        if answer.1 == .applied { marker.note() }
        return answer
    }

    func navigate(_ action: ScreenSpaceAction) async -> ScreenControlResult {
        let result = await base.navigate(action)
        if result == .applied { marker.note() }
        return result
    }

    func spaceChanges() async -> AsyncStream<Bool> { await base.spaceChanges() }
}
#endif
