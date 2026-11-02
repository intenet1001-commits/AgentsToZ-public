#if os(macOS)
import Foundation
import ScreenControlCore
@testable import ScreenHost
import XCTest

// What the screen host records (docs/design/mac-to-mac-2026-11-01 7.3 「controller-log」 SR-30, 6.7 SR-34): the last 64
// controller events, saved best effort so a log that cannot be written never stops a defence; and the remote-input hint
// the main app's sidecar reads before an AI's input, written at most every two seconds and removed when the session ends.
final class ControllerLogTests: XCTestCase {
    private func entry(_ index: Int, _ event: ControllerLogEntry.Event = .connected) -> ControllerLogEntry {
        ControllerLogEntry(at: Date(timeIntervalSince1970: 1_793_000_000 + Double(index)), controllerID: String(repeating: "a", count: 64),
                           name: "Mac \(index)", event: event, reason: event == .ended ? "idle" : nil, route: .nearby)
    }

    /// The stored log's events, or nil when it could not be read or decoded.
    private func storedEvents(_ items: HostTestItems) -> [ControllerLogEntry.Event]? {
        guard case .log(let log) = ScreenStore(items: items).storedControllerLog() else { return nil }
        return log.entries.map(\.event)
    }

    // MARK: Ring

    func testKeepsTheNewestSixtyFour() throws {
        var log = ControllerLog()
        for index in 0..<70 { log.append(entry(index)) }
        XCTAssertEqual(log.entries.count, ControllerLog.capacity)
        XCTAssertEqual(ControllerLog.capacity, 64)
        XCTAssertEqual(log.entries.first?.name, "Mac 6")
        XCTAssertEqual(log.entries.last?.name, "Mac 69")
        XCTAssertEqual(ControllerLog.decode(try log.encoded()), log)
        XCTAssertEqual(ControllerLog(entries: (0..<100).map { entry($0) }).entries.count, 64)
    }

    @MainActor
    func testABadRowIsDroppedAloneAndAnUnknownFormatStartsAgain() throws {
        let log = ControllerLog(entries: [entry(1), entry(2, .ended)])
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: try log.encoded()) as? [String: Any])
        var rows = try XCTUnwrap(document["entries"] as? [[String: Any]])
        var unknownEvent = rows[0]; unknownEvent["event"] = "screenshot"
        rows.insert(unknownEvent, at: 1)
        rows.append(["at": "yesterday"])
        document["entries"] = rows
        let decoded = try XCTUnwrap(ControllerLog.decode(try JSONSerialization.data(withJSONObject: document)))
        XCTAssertEqual(decoded.entries, log.entries)

        document["format"] = 2
        XCTAssertNil(ControllerLog.decode(try JSONSerialization.data(withJSONObject: document)))

        let items = HostTestItems()
        XCTAssertEqual(ScreenStore(items: items).storedControllerLog(), .log(ControllerLog()), "none stored is an empty log")
        try items.write(ScreenStore.controllerLogAccount, try JSONSerialization.data(withJSONObject: document))
        XCTAssertEqual(ScreenStore(items: items).storedControllerLog(), .undecodable, "a format this build does not know")
        try items.write(ScreenStore.controllerLogAccount, Data("{".utf8))
        XCTAssertEqual(ScreenStore(items: items).storedControllerLog(), .undecodable)
        items.failReads([ScreenStore.controllerLogAccount])
        XCTAssertEqual(ScreenStore(items: items).storedControllerLog(), .readFailed, "a keychain that did not answer is not damage")
        items.failReads([])

        // A damaged log starts again and is saved over.
        let book = ControllerLogBook(store: ScreenStore(items: items))
        XCTAssertFalse(book.unread)
        XCTAssertTrue(book.log.entries.isEmpty)
        XCTAssertTrue(book.record(.paired, id: "aa", name: "Mac"))
        XCTAssertEqual(storedEvents(items), [.paired])
    }

    func testRecordsOnlyFixedWords() {
        XCTAssertEqual(ControllerLogEntry.reason(nil), "left")
        XCTAssertEqual(ControllerLogEntry.reason(.takenOver), "takenOver")
        XCTAssertEqual(ControllerLogEntry.reason(.captureUnavailable), "captureUnavailable")
        XCTAssertEqual(ControllerLogEntry.route(of: .connector), .connector)
        XCTAssertEqual(ControllerLogEntry.route(of: .connectorDevice(Data(repeating: 1, count: 32), known: true)), .connector)
        XCTAssertEqual(ControllerLogEntry.route(of: PeerKey(host: "192.168.0.20")!), .nearby)
        XCTAssertEqual(Set(ControllerLogEntry.Event.allCases.map(\.rawValue)),
                       ["paired", "grantChanged", "removed", "connected", "ended", "refused", "unenrolled"])
    }

    @MainActor
    func testABookThatCannotSaveKeepsTheEntry() {
        let items = HostTestItems()
        items.fail([ScreenStore.controllerLogAccount])
        let book = ControllerLogBook(store: ScreenStore(items: items))
        XCTAssertFalse(book.record(.removed, id: "aa", name: "Mac"))
        XCTAssertTrue(book.unsaved)
        XCTAssertEqual(book.log.entries.map(\.event), [.removed])
        items.fail([])
        XCTAssertTrue(book.record(.paired, id: "bb", name: "Mac"))
        XCTAssertFalse(book.unsaved)
        XCTAssertEqual(storedEvents(items), [.removed, .paired])
    }

    @MainActor
    func testABookThatCannotReadNeverWipesTheStoredHistory() throws {
        let items = HostTestItems()
        try ScreenStore(items: items).saveControllerLog(ControllerLog(entries: (0..<64).map { entry($0) }))
        items.failReads([ScreenStore.controllerLogAccount])
        let book = ControllerLogBook(store: ScreenStore(items: items))
        XCTAssertTrue(book.unread)
        XCTAssertTrue(book.log.entries.isEmpty)
        XCTAssertFalse(book.record(.removed, id: "aa", name: "Mac"), "never saved over what could not be read")
        XCTAssertTrue(book.unsaved)
        XCTAssertTrue(book.unread)
        XCTAssertEqual(book.log.entries.map(\.event), [.removed], "kept in memory meanwhile")
        items.failReads([])
        XCTAssertEqual(storedEvents(items)?.count, 64, "the stored history is untouched")

        // The next entry reads it again: the stored entries come first, the ring is saved.
        XCTAssertTrue(book.record(.paired, id: "bb", name: "Mac"))
        XCTAssertFalse(book.unread)
        XCTAssertFalse(book.unsaved)
        guard case .log(let merged) = ScreenStore(items: items).storedControllerLog() else { return XCTFail("the merged log is stored") }
        XCTAssertEqual(merged.entries.count, ControllerLog.capacity)
        XCTAssertEqual(merged.entries.first?.name, "Mac 2", "the oldest two give way")
        XCTAssertEqual(merged.entries.suffix(2).map(\.event), [.removed, .paired])
        XCTAssertEqual(book.log.entries.map(\.name), merged.entries.map(\.name))
    }

    @MainActor
    func testTheMenuKnowsWhileTheHistoryCannotBeRead() async throws {
        let rig = try HostRig()
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer)])
        try rig.store.saveControllerLog(ControllerLog(entries: [entry(1, .paired)]))
        rig.items.failReads([ScreenStore.controllerLogAccount])
        let service = rig.makeService()
        XCTAssertTrue(service.controllerHistoryUnread)
        XCTAssertTrue(service.controllerHistory.isEmpty)
        rig.items.failReads([])
        service.removeController(peer.id)
        XCTAssertFalse(service.controllerHistoryUnread)
        XCTAssertFalse(service.controllerHistoryUnsaved)
        XCTAssertEqual(service.controllerHistory.map(\.event), [.paired, .removed])
    }

    @MainActor
    func testALogThatCannotBeSavedNeverStopsARemoval() async throws {
        let rig = try HostRig()
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer)])
        rig.items.fail([ScreenStore.controllerLogAccount])
        let service = rig.makeService()
        rig.openPushGate(service)

        let connection = try await rig.connect(service, peer, as: .controller)
        let awaited1 = await read(connection, until: isStarted)
        XCTAssertNotNil(awaited1)
        XCTAssertTrue(service.controllerHistoryUnsaved)
        service.removeController(peer.id)
        let revoked = await ending(of: connection)
        XCTAssertEqual(revoked, .reason(.revoked))
        XCTAssertTrue(try rig.store.controllers().controllers.isEmpty)
        XCTAssertEqual(service.controllerHistory.map(\.event), [.connected, .removed, .ended])
        XCTAssertEqual(service.controllerHistory.last?.reason, "revoked")
        XCTAssertEqual(service.controllerHistory.first?.route, .nearby)
    }

    // MARK: remote-input.json (6.7)

    func testRemoteInputIsWrittenAtMostEveryTwoSecondsAndRemovedAtTheEnd() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "remote-input-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "remote-input.json")
        let clock = TestClock()
        let marker = RemoteInputMarker(url: url, session: .controller, now: { clock.now })
        func stored() throws -> RemoteInputRecord? {
            marker.settle()
            guard let data = FileManager.default.contents(atPath: url.path) else { return nil }
            return try JSONDecoder().decode(RemoteInputRecord.self, from: data)
        }
        let start = Int64(clock.now.timeIntervalSince1970 * 1000)

        marker.note()
        XCTAssertEqual(try stored(), RemoteInputRecord(lastInputAt: start, session: .controller))
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
        clock.advance(1.5)
        marker.note()
        XCTAssertEqual(try stored()?.lastInputAt, start, "not again within two seconds")
        clock.advance(0.6)
        marker.note()
        XCTAssertEqual(try stored()?.lastInputAt, start + 2100)

        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(FileManager.default.contents(atPath: url.path))) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["format", "lastInputAt", "session"])
        XCTAssertEqual(json["format"] as? Int, 1)
        XCTAssertEqual(json["session"] as? String, "controller")

        marker.remove()
        XCTAssertNil(try stored())
        clock.advance(10)
        marker.note()
        XCTAssertNil(try stored(), "nothing after the session ended")
        XCTAssertEqual(RemoteInputRecord(.phone, at: Date(timeIntervalSince1970: 2)).session, .phone)
    }

    /// A session replaced or taken over ends while the next one starts: whatever the old one asked for lands before the
    /// next one's first write, so it never removes the record of a person typing now (SR-34).
    func testAnEndedSessionNeverRemovesTheNextOnesRecord() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "remote-input-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "remote-input.json")
        let old = RemoteInputMarker(url: url, session: .controller)
        let next = RemoteInputMarker(url: url, session: .phone)
        // Hold the shared queue so every write and removal below waits, in the order it was asked for.
        let hold = DispatchSemaphore(value: 0)
        RemoteInputMarker.queue.async { hold.wait() }
        old.note()
        old.remove()
        next.note()
        old.note()
        old.remove()
        hold.signal()
        next.settle()
        let data = try XCTUnwrap(FileManager.default.contents(atPath: url.path), "the new session's record stays")
        XCTAssertEqual(try JSONDecoder().decode(RemoteInputRecord.self, from: data).session, .phone)
        next.remove()
        next.settle()
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    @MainActor
    func testSessionInputMarksTheFileAndTheEndRemovesIt() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true)
        let peer = HostTestSigner()
        try rig.seed(controllers: [try rig.controller(peer, grant: .control)])
        let service = rig.makeService()
        rig.openPushGate(service)

        let connection = try await rig.connect(service, peer, as: .controller)
        let awaited2 = await read(connection, until: isStarted)
        XCTAssertNotNil(awaited2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.remoteInputURL.path), "nothing before input")
        try await connection.send(.input, InputCodec.encode(.pointerMove(x: 0.1, y: 0.2)))
        let written = await eventually { FileManager.default.fileExists(atPath: rig.remoteInputURL.path) }
        XCTAssertTrue(written)
        let record = try JSONDecoder().decode(RemoteInputRecord.self, from: try XCTUnwrap(FileManager.default.contents(atPath: rig.remoteInputURL.path)))
        XCTAssertEqual(record.session, .controller)
        service.disconnect()
        _ = await ending(of: connection)
        let removed = await eventually { !FileManager.default.fileExists(atPath: rig.remoteInputURL.path) }
        XCTAssertTrue(removed)
    }
}
#endif
