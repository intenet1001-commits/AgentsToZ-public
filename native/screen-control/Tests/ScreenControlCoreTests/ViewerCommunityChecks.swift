#if !CORE_CHECKS
import Foundation
import XCTest
import Darwin
@testable import ScreenControlCore

final class ViewerCommunityChecks: XCTestCase {
    private let time = Date(timeIntervalSince1970: 1_700_000_000)
    private var document: [String: Any] {
        ["schemaVersion": 1, "generatedAt": 1_700_000_000_000, "expiresAt": 1_700_000_090_000,
         "inside": true, "devices": [["ref": "0123456789abcdef", "name": "아젠투지 1호", "lastSeenAt": NSNull()]]]
    }
    private func decode(_ value: [String: Any], now: Date? = nil) throws -> ViewerCommunityDirectory {
        try .decode(JSONSerialization.data(withJSONObject: value), now: now ?? time)
    }
    func testOnlyFreshStrictDiscoveryIsShown() throws {
        let parsed = try decode(document)
        XCTAssertTrue(parsed.inside); XCTAssertEqual(parsed.devices.first?.name, "아젠투지 1호")
        XCTAssertThrowsError(try decode(document, now: time.addingTimeInterval(91)))
        XCTAssertThrowsError(try decode(document, now: time.addingTimeInterval(-6)))
        for field in ["address", "grant", "hostPublicKey", "command"] {
            var doc = document; doc[field] = "untrusted"
            XCTAssertThrowsError(try decode(doc))
        }
        var outside = document; outside["inside"] = false
        XCTAssertThrowsError(try decode(outside))
        outside["devices"] = []
        XCTAssertFalse(try decode(outside).inside)
    }
    func testAmbiguousOrOversizedRowsAreRejected() throws {
        let row = (document["devices"] as! [[String: Any]])[0]
        for rows in [[row, row], Array(repeating: row, count: 65),
                     [["ref": "0123456789abcdef", "name": "Mac\u{202e}1", "lastSeenAt": NSNull()]],
                     [["ref": "0123456789abcdef", "name": "Mac", "lastSeenAt": true]]] {
            var doc = document; doc["devices"] = rows
            XCTAssertThrowsError(try decode(doc))
        }
        XCTAssertThrowsError(try ViewerCommunityDirectory.decode(Data(repeating: 0, count: 32_769), now: time))
        var doc = document; doc["schemaVersion"] = true
        XCTAssertThrowsError(try decode(doc))
    }
    func testReaderRejectsLinksSharedFilesPipesAndOversizedFiles() throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "viewer-catalog-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appending(path: "catalog.json"), link = root.appending(path: "link.json")
        try JSONSerialization.data(withJSONObject: document).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertEqual(try ViewerCommunityDirectory.read(at: file, now: time).devices.count, 1)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try ViewerCommunityDirectory.read(at: link, now: time))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
        XCTAssertThrowsError(try ViewerCommunityDirectory.read(at: file, now: time))
        let pipe = root.appending(path: "pipe")
        XCTAssertEqual(mkfifo(pipe.path, 0o600), 0)
        XCTAssertThrowsError(try ViewerCommunityDirectory.read(at: pipe, now: time))
        try Data(repeating: 0, count: 32_769).write(to: file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        XCTAssertThrowsError(try ViewerCommunityDirectory.read(at: file, now: time))
    }
}
#endif
