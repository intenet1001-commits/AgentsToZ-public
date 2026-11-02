#if !CORE_CHECKS
import Foundation
import XCTest
@testable import ScreenControlCore

final class CommunityRelayTransportChecks: XCTestCase {
    func testEightMiBFrameFragmentsBelowJSONLimitAndReassemblesWithoutChangingBytes() throws {
        let payload = Data((0..<CommunityRelayFragment.maximumFrame).map { UInt8(truncatingIfNeeded: $0) })
        var receiver = CommunityRelayAssembly(); let channel = UUID()
        let count = (payload.count + CommunityRelayFragment.chunkSize - 1) / CommunityRelayFragment.chunkSize
        var result: Data?
        for index in 0..<count {
            let start = index * CommunityRelayFragment.chunkSize, end = min(payload.count, start + CommunityRelayFragment.chunkSize)
            let part = CommunityRelayFragment(channel: channel, sequence: 0, index: index, count: count, total: payload.count,
                                             payload: Data(payload[start..<end]), closed: false)
            let encoded = try part.encode()
            let wrapped = try JSONSerialization.data(withJSONObject: ["type": "data", "to": UUID().uuidString.lowercased(),
                "id": UUID().uuidString.lowercased(), "ciphertext": ScreenCommunityRequest.base64(encoded)])
            XCTAssertLessThan(wrapped.count, 262_144)
            result = try receiver.append(CommunityRelayFragment.decode(encoded), maxFrame: CommunityRelayFragment.maximumFrame)
            if index < count - 1 { XCTAssertNil(result) }
        }
        XCTAssertEqual(result, payload); XCTAssertEqual(receiver.bufferedBytes, 0)
    }
    func testInterleavedDuplicateAndReorderedFragmentsCannotChangeStreamOrder() throws {
        let channel = UUID(), total = CommunityRelayFragment.chunkSize + 4
        let first = CommunityRelayFragment(channel: channel, sequence: 0, index: 0, count: 2, total: total,
                                          payload: Data(repeating: 1, count: CommunityRelayFragment.chunkSize), closed: false)
        let last = CommunityRelayFragment(channel: channel, sequence: 0, index: 1, count: 2, total: total,
                                         payload: Data(repeating: 2, count: 4), closed: false)
        var wrongOrder = CommunityRelayAssembly(); XCTAssertThrowsError(try wrongOrder.append(last, maxFrame: total))
        var duplicate = CommunityRelayAssembly(); XCTAssertNil(try duplicate.append(first, maxFrame: total))
        XCTAssertThrowsError(try duplicate.append(first, maxFrame: total))
        var receiver = CommunityRelayAssembly(); XCTAssertNil(try receiver.append(first, maxFrame: total))
        XCTAssertNotNil(try receiver.append(last, maxFrame: total))
        XCTAssertThrowsError(try receiver.append(first, maxFrame: total), "completed frame counters cannot be replayed")
    }
    func testPreauthCapPartialTimeoutAndMalformedFragmentRejectBeforeUnboundedAllocation() throws {
        let channel = UUID(), now = ContinuousClock.now, total = CommunityRelayFragment.chunkSize + 1
        let first = CommunityRelayFragment(channel: channel, sequence: 0, index: 0, count: 2, total: total,
                                          payload: Data(repeating: 1, count: CommunityRelayFragment.chunkSize), closed: false)
        var capped = CommunityRelayAssembly(); XCTAssertThrowsError(try capped.append(first, maxFrame: 16 * 1024))
        XCTAssertEqual(capped.bufferedBytes, 0)
        var expired = CommunityRelayAssembly(); XCTAssertNil(try expired.append(first, maxFrame: total, now: now))
        let last = CommunityRelayFragment(channel: channel, sequence: 0, index: 1, count: 2, total: total, payload: Data([2]), closed: false)
        XCTAssertThrowsError(try expired.append(last, maxFrame: total, now: now.advanced(by: .seconds(10))))
        XCTAssertThrowsError(try CommunityRelayFragment.decode(Data(repeating: 0, count: 33)))
        var encoded = try first.encode(); encoded[0] = 2; XCTAssertThrowsError(try CommunityRelayFragment.decode(encoded))
        let oversize = CommunityRelayFragment(channel: channel, sequence: 0, index: 0, count: 1,
            total: CommunityRelayFragment.maximumFrame + 1, payload: Data([1]), closed: false)
        XCTAssertThrowsError(try oversize.encode())
    }
    func testChannelIdentifierAndCloseRecordRoundTripExactly() throws {
        let id = UUID(), close = CommunityRelayFragment(channel: id, sequence: 0, index: 0, count: 0, total: 0, payload: Data(), closed: true)
        let decoded = try CommunityRelayFragment.decode(close.encode())
        XCTAssertEqual(decoded.channel, id); XCTAssertTrue(decoded.closed); XCTAssertEqual(decoded.payload.count, 0)
        var receiver = CommunityRelayAssembly(); XCTAssertThrowsError(try receiver.append(decoded, maxFrame: 1024))
    }
}
#endif
