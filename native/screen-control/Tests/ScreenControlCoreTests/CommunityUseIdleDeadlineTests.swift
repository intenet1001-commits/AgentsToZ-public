#if !CORE_CHECKS
import Foundation
import XCTest
import ScreenControlCore

final class CommunityUseIdleDeadlineTests: XCTestCase {
    private let wall = Date(timeIntervalSince1970: 1_800_000_000)
    func testStartCannotGainTimeFromClockSkewOrNetworkDelay() {
        let dispatch = ContinuousClock.now, received = dispatch.advanced(by: .seconds(20))
        let deadline = CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: Int64(wall.addingTimeInterval(3_630).timeIntervalSince1970 * 1_000),
            wallNow: wall, tickNow: received, humanTick: dispatch)
        XCTAssertEqual(dispatch.duration(to: deadline), .seconds(3_600))
        XCTAssertEqual(received.duration(to: deadline), .seconds(3_580))
    }
    func testCoalescedActivityKeepsTheOriginalEventTimeAfterReceipt() throws {
        let called = ContinuousClock.now, observed = try XCTUnwrap(CommunityUseIdleDeadline.observedTick(observedAt: wall.addingTimeInterval(-30), wallNow: wall, tickNow: called))
        XCTAssertEqual(observed.duration(to: called), .seconds(30))
        let received = called.advanced(by: .seconds(10))
        let deadline = CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: Int64(wall.addingTimeInterval(3_600).timeIntervalSince1970 * 1_000),
            wallNow: wall.addingTimeInterval(10), tickNow: received, humanTick: observed)
        XCTAssertEqual(observed.duration(to: deadline), .seconds(3_600))
        XCTAssertEqual(received.duration(to: deadline), .seconds(3_560))
    }
    func testEarlierIssuerDeadlineWinsAndOldOrFutureActivityIsRejected() {
        let tick = ContinuousClock.now
        let deadline = CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: Int64(wall.addingTimeInterval(15).timeIntervalSince1970 * 1_000),
            wallNow: wall, tickNow: tick, humanTick: tick)
        XCTAssertEqual(tick.duration(to: deadline), .seconds(15))
        XCTAssertNil(CommunityUseIdleDeadline.observedTick(observedAt: wall.addingTimeInterval(0.001), wallNow: wall, tickNow: tick))
        XCTAssertNil(CommunityUseIdleDeadline.observedTick(observedAt: wall.addingTimeInterval(-55.001), wallNow: wall, tickNow: tick))
        XCTAssertNotNil(CommunityUseIdleDeadline.observedTick(observedAt: wall.addingTimeInterval(-55), wallNow: wall, tickNow: tick))
        XCTAssertEqual(CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: 0, wallNow: wall, tickNow: tick, humanTick: tick), tick)
    }
    func testCapturedEventTickSurvivesWallClockReversalDuringNetworking() throws {
        let callback = ContinuousClock.now
        let event = try XCTUnwrap(CommunityUseIdleDeadline.observedTick(observedAt: wall.addingTimeInterval(-30), wallNow: wall, tickNow: callback))
        let received = callback.advanced(by: .seconds(10))
        let deadline = CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: Int64(wall.addingTimeInterval(3_570).timeIntervalSince1970 * 1_000),
            wallNow: wall.addingTimeInterval(-20), tickNow: received, humanTick: event)
        XCTAssertEqual(event.duration(to: deadline), .seconds(3_600))
        XCTAssertEqual(received.duration(to: deadline), .seconds(3_560))
    }
}
#endif
