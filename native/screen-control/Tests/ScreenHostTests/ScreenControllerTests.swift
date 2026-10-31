#if os(macOS)
import CryptoKit
import Foundation
import os
import ScreenControlCore
@testable import ScreenHost
import XCTest

/// The store's items in memory, so these tests never reach the person's keychain.
private final class MemoryItems: ScreenStoreItems {
    let items = OSAllocatedUnfairLock(initialState: [String: Data]())
    func read(_ account: String) throws -> Data? { items.withLock { $0[account] } }
    func write(_ account: String, _ data: Data) throws { items.withLock { $0[account] = data } }
}

/// Mac controllers (docs/design/mac-to-mac-2026-10-29/DESIGN.md 「저장과 권한」): kept where an older build never looks,
/// off until the person turns them on, allowed to control only what the person granted, and only for so long.
final class ScreenControllerTests: XCTestCase {
    private func record(_ key: P256.Signing.PublicKey = P256.Signing.PrivateKey().publicKey,
                        name: String = "1호 MacBook Pro") throws -> RegistrationRecord {
        try RegistrationRecord(macFingerprint: Data(repeating: 7, count: 32), codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                               devicePublicKey: key, deviceName: name, deviceModel: "Mac16,7")
    }

    private func controller(_ grant: ScreenControllerGrant = .view, at date: Date = Date(timeIntervalSince1970: 1_793_000_000)) throws -> RegisteredController {
        RegisteredController(record: try record(), grant: grant, brokerAttestationKeyID: Data(repeating: 3, count: 32), at: date)
    }

    func testOlderDeviceReaderNeverSeesControllers() throws {
        let memory = MemoryItems(), store = ScreenStore(items: memory)
        let phone = RegisteredDevice(record: try record(name: "iPhone"), attestationKeyID: Data(repeating: 1, count: 32))
        try store.save([phone])
        let devices = memory.items.withLock { $0["devices"] }
        try store.saveControllers(ScreenControllers(allowMacControllers: true, controllers: [try controller(.control)]))

        // An older build reads only these accounts; the controllers item is none of them and leaves "devices" as it was.
        XCTAssertEqual(Set(memory.items.withLock { Array($0.keys) }), ["devices", "controllers"])
        XCTAssertEqual(memory.items.withLock { $0["devices"] }, devices)
        XCTAssertEqual(try store.devices(), [phone])
        // Even a misdirected read by the device reader fails closed instead of taking a controller for a phone.
        let stored = try XCTUnwrap(memory.items.withLock { $0["controllers"] })
        XCTAssertThrowsError(try JSONDecoder().decode([RegisteredDevice].self, from: stored))
        XCTAssertThrowsError(try ScreenStore(items: { let m = MemoryItems(); try? m.write("devices", stored); return m }()).devices())

        // Saving the phones again never touches the controllers.
        try store.save([])
        XCTAssertEqual(memory.items.withLock { $0["controllers"] }, stored)
        XCTAssertEqual(try store.controllers().controllers.count, 1)
    }

    func testMacControllersAreOffUntilTurnedOn() throws {
        let store = ScreenStore(items: MemoryItems())
        XCTAssertEqual(try store.controllers(), ScreenControllers())
        XCTAssertFalse(try store.controllers().allowMacControllers)

        let approved = try controller(.control)
        let fingerprint = ScreenControlIdentity.fingerprint(of: try P256.Signing.PublicKey(x963Representation: approved.publicKey))
        var controllers = ScreenControllers(controllers: [approved])
        XCTAssertTrue(controllers.keyEntries.isEmpty, "switch off: no controller key reaches a key exchange")
        XCTAssertNil(controllers.grant(for: fingerprint))
        controllers.allowMacControllers = true
        try store.saveControllers(controllers)
        let loaded = try store.controllers()
        XCTAssertEqual(loaded, controllers)
        XCTAssertEqual(loaded.keyEntries.map(\.id), [fingerprint])
        XCTAssertEqual(loaded.grant(for: fingerprint), .control)
        XCTAssertNil(loaded.grant(for: Data(repeating: 0, count: 32)))
    }

    func testGrantsRoundTripAndDamagedRowsAreDiscardedAlone() throws {
        let view = try controller(.view), control = try controller(.control)
        let data = try ScreenStore.encodeControllers(ScreenControllers(allowMacControllers: true, controllers: [view, control]))
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var rows = try XCTUnwrap(document["controllers"] as? [[String: Any]])
        XCTAssertEqual(document["format"] as? Int, 1)
        XCTAssertEqual(rows.map { $0["grant"] as? String }, ["view", "control"])

        var unknownGrant = rows[1]; unknownGrant["grant"] = "admin"
        var wrongID = rows[0]; wrongID["id"] = String(repeating: "0", count: 64)
        rows += [unknownGrant, wrongID]
        document["controllers"] = rows + [NSNull(), 42]
        let loaded = try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document))
        XCTAssertEqual(loaded.controllers.controllers, [view, control])
        XCTAssertEqual(loaded.discardedCount, 4)
    }

    func testUnknownControllersDocumentFailsClosed() throws {
        let data = try ScreenStore.encodeControllers(ScreenControllers(allowMacControllers: true, controllers: [try controller()]))
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        document["format"] = 2
        XCTAssertThrowsError(try ScreenStore.decodeControllers(JSONSerialization.data(withJSONObject: document)))
        for text in ["[]", "{}", "[", #"{"format":1,"controllers":[]}"#] {
            XCTAssertThrowsError(try ScreenStore.decodeControllers(Data(text.utf8)), text)
        }
        let device = try JSONEncoder().encode([RegisteredDevice(record: try record(), attestationKeyID: Data())])
        XCTAssertThrowsError(try ScreenStore.decodeControllers(device), "a phone list is never read as controllers")
    }

    func testControlNeedsTheGrantAndTheLocalInputMonitor() {
        XCTAssertTrue(ScreenControllerPolicy.canControl(inputMonitorAvailable: true, grant: .control))
        XCTAssertFalse(ScreenControllerPolicy.canControl(inputMonitorAvailable: false, grant: .control))
        XCTAssertFalse(ScreenControllerPolicy.canControl(inputMonitorAvailable: true, grant: .view))
        XCTAssertFalse(ScreenControllerPolicy.canControl(inputMonitorAvailable: false, grant: .view))
    }

    func testControllerSessionsAreBoundedAndPhonesAreNot() {
        let start = ContinuousClock.now, minute = Duration.seconds(60)
        // View-only: whatever counts as activity, the session ends 60 minutes after it began.
        var view = SessionTimer(limits: ScreenControllerPolicy.sessionLimits(canControl: false), started: start)
        view.noteInput(at: start + minute * 59)
        XCTAssertEqual(view.deadline.at, start + minute * 60)
        XCTAssertEqual(view.deadline.reason, .timeLimit)

        // Control: 60 minutes without input as for a phone, and never past 8 hours however busy.
        let controlLimits = ScreenControllerPolicy.sessionLimits(canControl: true)
        var control = SessionTimer(limits: controlLimits, started: start)
        XCTAssertEqual(control.deadline.at, start + minute * 60)
        XCTAssertEqual(control.deadline.reason, .idle)
        control.noteInput(at: start + minute * 30)
        XCTAssertEqual(control.deadline.at, start + minute * 90)
        control.noteInput(at: start + minute * (8 * 60 - 1))
        XCTAssertEqual(control.deadline.at, start + minute * (8 * 60))
        XCTAssertEqual(control.deadline.reason, .timeLimit)
        XCTAssertEqual(controlLimits.idle, SessionLimits.standard.idle)

        // Phones keep the user's rule: an hour without input, no wall-clock limit.
        XCTAssertNil(SessionLimits.standard.maximum)
        XCTAssertEqual(SessionLimits.standard.idle, minute * 60)
    }

    func testCaptureLeavesOutOnlyTheViewer() {
        let apps = ["com.apple.finder", "com.intenet.agentstozbycs.viewer", "COM.INTENET.AGENTSTOZBYCS.VIEWER",
                    "com.intenet.agentstozbycs.viewer.helper", "com.intenet.agentstozbycs.viewerx",
                    "com.intenet.agentstozbycs.screen", "com.intenet.agentstozbycs", "", nil]
        XCTAssertEqual(CaptureExclusion.excluded(apps) { $0 }, ["com.intenet.agentstozbycs.viewer", "COM.INTENET.AGENTSTOZBYCS.VIEWER",
                                                                "com.intenet.agentstozbycs.viewer.helper"])
        XCTAssertFalse(CaptureExclusion.excludes(bundleIdentifier: nil))
        XCTAssertEqual(CaptureExclusion.viewerBundleIdentifier, "com.intenet.agentstozbycs.viewer")
    }
}
#endif
