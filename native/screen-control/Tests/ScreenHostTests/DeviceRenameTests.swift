#if os(macOS)
import CryptoKit
import Foundation
import os
import ScreenControlCore
@testable import ScreenHost
import XCTest

private final class MemoryItems: ScreenStoreItems {
    let items = OSAllocatedUnfairLock(initialState: [String: Data]())
    func read(_ account: String) throws -> Data? { items.withLock { $0[account] } }
    func write(_ account: String, _ data: Data) throws { items.withLock { $0[account] = data } }
}

/// The person's own name for a registered device: shown at this Mac only, under the same rule as a registered name.
final class DeviceRenameTests: XCTestCase {
    private func device(named name: String = "iPad") throws -> RegisteredDevice {
        let record = try RegistrationRecord(macFingerprint: Data(repeating: 7, count: 32), codeID: Data(repeating: 9, count: RegistrationCode.idSize),
                                            devicePublicKey: P256.Signing.PrivateKey().publicKey, deviceName: name, deviceModel: "iPad16,2")
        return RegisteredDevice(record: record, attestationKeyID: Data(repeating: 1, count: 32))
    }

    func testTypedNameIsTidiedAndCheckedLikeARegisteredName() throws {
        let iPad = try device()
        XCTAssertEqual(iPad.alias(from: "  거실   아이패드 "), .name("거실 아이패드"))
        XCTAssertEqual(iPad.alias(from: "   "), .clear)
        XCTAssertEqual(iPad.alias(from: " iPad "), .clear, "the registered name itself is no rename")
        XCTAssertEqual(iPad.alias(from: String(repeating: "가", count: 33)), .invalid)
        XCTAssertEqual(iPad.alias(from: "a\u{202E}b"), .invalid, "a bidi override would disguise the name")
        XCTAssertEqual(iPad.alias(from: "a\u{0007}b"), .invalid)
    }

    func testRenameIsStoredAndOlderStoresReadAsUnnamed() throws {
        let memory = MemoryItems(), store = ScreenStore(items: memory)
        var iPad = try device()
        try store.save([iPad])
        XCTAssertFalse(String(decoding: try XCTUnwrap(memory.items.withLock { $0["devices"] }), as: UTF8.self).contains("alias"))
        XCTAssertNil(try store.devices().first?.alias)
        XCTAssertEqual(try store.devices().first?.displayName, "iPad")

        iPad.alias = "거실 아이패드"
        try store.save([iPad])
        let read = try XCTUnwrap(try store.devices().first)
        XCTAssertEqual(read.displayName, "거실 아이패드")
        XCTAssertEqual(read.name, "iPad", "the registered name stays the record's")
        XCTAssertEqual(read.id, iPad.id)
    }
}
#endif
