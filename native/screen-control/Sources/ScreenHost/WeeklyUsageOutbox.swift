#if os(macOS)
import Darwin
import Foundation
import ScreenControlCore

/// The main AgentsToZ app's weekly allowance alerts, waiting for this app to sign and send them (docs/claude/remote-control.md
/// 「문턱 알림 푸시」). src/weeklyUsagePushHost.ts writes one small file per alert into its own app data, renamed into place
/// after its new state is saved; this app reads them while screen control is on (`ScreenPush.deliverWeeklyUsage`).
///
/// Each file is removed **before** its alert is sent, and a file that cannot be removed is not used: an alert is sent at most
/// once, and one whose send fails is lost, never repeated. The folder belongs to this user, so a file proves nothing about
/// who wrote it; `WeeklyUsageHandoff` bounds every field and `WeeklyUsageBudget` caps how many go out.
enum WeeklyUsageOutbox {
    /// `~/Library/Application Support/com.portmanager.portmanager/weekly-usage/push-outbox` (the main app's APP_DATA_DIR).
    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/com.portmanager.portmanager/weekly-usage/push-outbox")
    }

    /// At most this many files per round; the rest wait for the next (30 seconds later).
    static let perRound = 16

    /// The waiting alerts, oldest first, each file already removed. A file that is not a small regular file of this user,
    /// or that does not read as a hand-off, is removed and skipped. Temporary files (a leading dot) are left to their writer.
    static func take(from folder: URL = url) -> [WeeklyUsageHandoff] {
        var status = stat()
        guard lstat(folder.path, &status) == 0, status.st_mode & S_IFMT == S_IFDIR, status.st_uid == getuid(),
              let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        var taken: [WeeklyUsageHandoff] = []
        for name in names.filter({ !$0.hasPrefix(".") && $0.hasSuffix(".json") && $0.utf8.count <= 96 }).sorted().prefix(perRound) {
            let path = folder.appending(path: name).path
            let data = read(path)
            guard unlink(path) == 0 else { continue }
            if let data, let handoff = WeeklyUsageHandoff.decode(data) { taken.append(handoff) }
        }
        return taken
    }

    /// The bytes of a regular file this user owns, no larger than a hand-off; nil for anything else (links are not followed).
    private static func read(_ path: String) -> Data? {
        let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var status = stat()
        guard fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG, status.st_uid == getuid(),
              status.st_size <= off_t(WeeklyUsageHandoff.maxBytes) else { return nil }
        var buffer = [UInt8](repeating: 0, count: WeeklyUsageHandoff.maxBytes + 1)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        guard count >= 0, count <= WeeklyUsageHandoff.maxBytes else { return nil }
        return Data(buffer.prefix(count))
    }
}
#endif
