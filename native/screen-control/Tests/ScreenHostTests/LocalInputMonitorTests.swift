#if os(macOS)
import CoreGraphics
import Foundation
@testable import ScreenHost
import XCTest

final class LocalInputMonitorTests: XCTestCase {
    func testOwnTagsDoNotMaskSimultaneousPhysicalInputOrReleaseIt() {
        let now = ContinuousClock.now
        var ledger = LocalInputLedger()
        ledger.record(.mouseMoved, marker: LocalInputMonitor.injectionMarker, at: now)
        XCTAssertNil(ledger.lastEvent)
        ledger.record(.mouseMoved, at: now)
        XCTAssertEqual(ledger.lastEvent, now)
        ledger.record(.leftMouseDown, at: now)
        ledger.record(.leftMouseUp, marker: LocalInputMonitor.injectionMarker, at: now)
        XCTAssertEqual(ledger.buttons, [0], "remote cleanup never releases the person's physical hold in the ledger")
        ledger.record(.leftMouseUp, at: now + .seconds(30))
        XCTAssertTrue(ledger.buttons.isEmpty)
        XCTAssertEqual(ledger.lastEvent, now + .seconds(30))
    }

    func testSecureInputGapRequiresFreshSessionAndExtendedKeyCodesRemainObserved() {
        let now = ContinuousClock.now
        var ledger = LocalInputLedger()
        ledger.record(.keyDown, code: 160, at: now)
        XCTAssertTrue(ledger.available)
        XCTAssertEqual(ledger.keys, [160])
        ledger.record(.keyUp, code: 160, at: now)
        XCTAssertTrue(ledger.keys.isEmpty)
        ledger.secureInputChanged(true, at: now)
        XCTAssertTrue(ledger.wasSecureInput)
        ledger.secureInputChanged(false, at: now + .seconds(30))
        XCTAssertFalse(ledger.available, "unobserved secure key releases cannot be guessed")
        ledger.record(.mouseMoved, at: now + .seconds(40))
        XCTAssertFalse(ledger.available)
    }

    func testPhysicalModifiersAndMonitorLossAreRetainedWithoutText() {
        let now = ContinuousClock.now
        var ledger = LocalInputLedger()
        ledger.record(.keyDown, code: 0, at: now)
        ledger.record(.keyUp, code: 0, marker: LocalInputMonitor.injectionMarker, at: now)
        XCTAssertEqual(ledger.keys, [0])
        ledger.record(.keyUp, code: 0, at: now)
        ledger.record(.flagsChanged, code: 56, flags: CGEventFlags.maskShift.rawValue, at: now)
        ledger.record(.flagsChanged, code: 60, flags: CGEventFlags.maskShift.rawValue, at: now)
        ledger.record(.flagsChanged, code: 56, flags: CGEventFlags.maskShift.rawValue, at: now)
        XCTAssertFalse(ledger.keys.isEmpty)
        ledger.record(.flagsChanged, code: 60, at: now)
        XCTAssertTrue(ledger.keys.isEmpty)
        ledger.record(.tapDisabledByTimeout, at: now)
        XCTAssertFalse(ledger.available)
        ledger.record(.mouseMoved, at: now + .seconds(10))
        XCTAssertFalse(ledger.available, "a later event cannot silently restore a disabled monitor")
    }
}
#endif
