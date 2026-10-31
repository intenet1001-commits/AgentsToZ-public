#if os(macOS)
import Foundation
import ScreenControlCore
@testable import ScreenHost
import XCTest

/// The hand-off folder the main app writes (src/weeklyUsagePushHost.ts): files are read strictly, oldest first, and each
/// one is gone before its alert could be sent, so nothing is ever sent twice. Only a temporary folder; never the real one.
final class WeeklyUsageOutboxTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "weekly-usage-outbox-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func write(_ name: String, _ text: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    private func handoff(_ provider: String, _ mark: Int, at ms: Int = 1_793_000_000_000) -> String {
        #"{"version":1,"provider":"\#(provider)","mark":\#(mark),"windowKey":"r498056","observedAt":\#(ms)}"#
    }

    func testTakesOldestFirstAndRemovesEveryFileBeforeReturning() throws {
        try write("1793000000002-codex-20-bbbbbbbb.json", handoff("codex", 20))
        try write("1793000000001-claude-30-aaaaaaaa.json", handoff("claude", 30))
        try write("1793000000003-agy-0-cccccccc.json", #"{"version":1,"provider":"agy","mark":0,"windowKey":"w2026-W44","observedAt":1,"email":"a@b.c"}"#)
        try write("1793000000004-codex-10-dddddddd.json", String(repeating: " ", count: 600))
        try write(".1793000000005-codex-10-eeeeeeee.json.tmp", handoff("codex", 10)) // still being written: left alone
        try write("notes.txt", "not a hand-off")
        let taken = WeeklyUsageOutbox.take(from: folder)
        XCTAssertEqual(taken.map(\.provider), [.claude, .codex])
        XCTAssertEqual(taken.map(\.mark), [30, 20])
        // The two good files and the two refused ones are gone; nothing can be read (and sent) a second time.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted(),
                       [".1793000000005-codex-10-eeeeeeee.json.tmp", "notes.txt"])
        XCTAssertEqual(WeeklyUsageOutbox.take(from: folder), [])
    }

    func testLinksAreNotFollowedAndAtMostARoundIsTaken() throws {
        let outside = FileManager.default.temporaryDirectory.appending(path: "weekly-usage-outside-\(UUID().uuidString).json")
        try Data(handoff("claude", 50).utf8).write(to: outside)
        defer { try? FileManager.default.removeItem(at: outside) }
        try FileManager.default.createSymbolicLink(at: folder.appending(path: "1793000000000-claude-50-ffffffff.json"), withDestinationURL: outside)
        XCTAssertEqual(WeeklyUsageOutbox.take(from: folder), [])
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path), "the link is removed, its target is not touched")

        for index in 0..<(WeeklyUsageOutbox.perRound + 3) {
            try write(String(format: "17930000%05d-codex-40-%08x.json", index, index), handoff("codex", 40))
        }
        XCTAssertEqual(WeeklyUsageOutbox.take(from: folder).count, WeeklyUsageOutbox.perRound)
        XCTAssertEqual(WeeklyUsageOutbox.take(from: folder).count, 3)
    }

    func testAMissingFolderIsNothingToSend() {
        XCTAssertEqual(WeeklyUsageOutbox.take(from: folder.appending(path: "absent")), [])
    }
}
#endif
