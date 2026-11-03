#if !CORE_CHECKS
import CoreMedia
import CryptoKit
import Foundation
import XCTest
import os
@testable import ScreenControlCore

/// The sleeper deliberately returns after cancellation to exercise a late, already-scheduled timeout.
private final class FirstFrameSoftwareClock: Sendable {
    private struct State { var waiter: CheckedContinuation<Void,Never>?, budget: Duration?, fired = false, returned = false }
    private let state = OSAllocatedUnfairLock(initialState: State())
    var waiting: Bool { state.withLock { $0.waiter != nil } }
    var returned: Bool { state.withLock { $0.returned } }
    var budget: Duration? { state.withLock { $0.budget } }
    func sleep(_ duration: Duration) async {
        await withCheckedContinuation { continuation in
            let resume = state.withLock { value in
                value.budget = duration
                if value.fired { return true }; value.waiter = continuation; return false
            }
            if resume { continuation.resume() }
        }
        state.withLock { $0.returned = true }
    }
    func fire() {
        let continuation = state.withLock { value in
            value.fired = true; let waiter = value.waiter; value.waiter = nil; return waiter
        }
        continuation?.resume()
    }
}

/// Pure RAM keys, encrypted in-memory frame pipes and synthetic video; no sockets, OS permissions or biometrics.
final class ViewerFirstFrameDeadlineTests: XCTestCase {
    private func pair(version: UInt16 = 6) -> (ScreenViewer, SecureConnection) {
        let (viewerEnd, macEnd) = framePipe()
        let toMac = SymmetricKey(data: Data(repeating: 0x31, count: 32)), toViewer = SymmetricKey(data: Data(repeating: 0x72, count: 32))
        return (ScreenViewer(connection: SecureConnection(framed: viewerEnd, channel: SecureChannel(role: .device, sendKey: toMac, receiveKey: toViewer, version: version))),
                SecureConnection(framed: macEnd, channel: SecureChannel(role: .mac, sendKey: toViewer, receiveKey: toMac, version: version)))
    }
    private func keyframe() throws -> VideoFrame {
        let encoded = Collector<VideoFrame>()
        let encoder = try VideoEncoder(.init(width: 64, height: 64)) { if case .success(let frame) = $0 { encoded.add(frame) } }
        encoder.encode(try patternFrame(width: 64, height: 64, bar: 0), at: .zero); encoder.flush()
        return try XCTUnwrap(encoded.all.first)
    }
    func testSilentFirstFrameTimesOutForCommonSixAndLegacyFourDespiteAuthenticatedNotices() async throws {
        for version: UInt16 in [4,6] {
            let (viewer, mac) = pair(version: version), clock = FirstFrameSoftwareClock(), notices = Collector<ScreenNotice>()
            let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
            let watching = Task { for try await _ in viewer.pictures(firstFrameTimeout: .seconds(20), sleep: { await clock.sleep($0) }) {} }
            try await waitUntil { clock.waiting }
            XCTAssertEqual(clock.budget, .seconds(20))
            try await mac.send(.remoteInputPaused); try await waitUntil { notices.all.count == 1 }
            clock.fire()
            do { try await within(2) { try await watching.value }; XCTFail("a silent first frame must expire") }
            catch let error as TransportError { XCTAssertEqual(error, .timedOut) }
            let peerEnd = try await nextFrameOrEnd(mac.framed); XCTAssertNil(peerEnd)
            hearing.cancel(); await viewer.close(); mac.close()
        }
    }
    func testFirstValidPictureDisarmsEvenALateCancelledTimeout() async throws {
        let (viewer, mac) = pair(), clock = FirstFrameSoftwareClock(), pictures = Collector<ScreenPicture>(), frame = try keyframe()
        let watching = Task { for try await picture in viewer.pictures(firstFrameTimeout: .seconds(20), sleep: { await clock.sleep($0) }) { pictures.add(picture) } }
        try await waitUntil { clock.waiting }
        try await mac.send(.video, frame.encoded()); try await waitUntil { pictures.all.count == 1 }
        clock.fire(); try await waitUntil { clock.returned }
        try await mac.send(.video, frame.encoded()); try await waitUntil { pictures.all.count == 2 }
        await viewer.close(); _ = await watching.result; mac.close()
    }
    func testDeltaWithoutAKeyframeDoesNotExtendTheOriginalDeadline() async throws {
        let (viewer, mac) = pair(), clock = FirstFrameSoftwareClock()
        let delta = try VideoFrame(isKeyframe: false, timestamp: 1, parameterSets: [], data: Data([0,0,0,3,0x41,0x88,0x84]))
        let watching = Task { for try await _ in viewer.pictures(firstFrameTimeout: .seconds(20), sleep: { await clock.sleep($0) }) {} }
        try await waitUntil { clock.waiting }; try await mac.send(.video, delta.encoded())
        let request = try await within(2) { try await mac.receive() }
        XCTAssertEqual(try ControlMessage(decoding: request.payload, version: 6), .requestKeyframe)
        clock.fire()
        do { try await within(2) { try await watching.value }; XCTFail("delta traffic is not a first picture") }
        catch let error as TransportError { XCTAssertEqual(error, .timedOut) }
        await viewer.close(); mac.close()
    }
    func testEmptyOrMalformedVideoFailsWithATypedErrorBeforeCompletingTheFirstPicture() async throws {
        for payload in [Data(),Data([1,0,0,0,0,0,0,0,0,0])] {
            let (viewer, mac) = pair(), clock = FirstFrameSoftwareClock(), pictures = Collector<ScreenPicture>()
            let watching = Task { for try await picture in viewer.pictures(firstFrameTimeout: .seconds(20), sleep: { await clock.sleep($0) }) { pictures.add(picture) } }
            try await waitUntil { clock.waiting }; try await mac.send(.video, payload)
            do { try await within(2) { try await watching.value }; XCTFail("malformed video is never a usable first sample") }
            catch let error as VideoError { XCTAssertEqual(error, .malformed) }
            XCTAssertTrue(pictures.all.isEmpty); clock.fire(); await viewer.close(); mac.close()
        }
    }
    func testClosedAttemptLateTimeoutCannotCloseAReplacementConnection() async throws {
        let (old, oldMac) = pair(), oldClock = FirstFrameSoftwareClock()
        let abandoned = Task { for try await _ in old.pictures(firstFrameTimeout: .seconds(20), sleep: { await oldClock.sleep($0) }) {} }
        try await waitUntil { oldClock.waiting }; await old.close(); _ = await abandoned.result
        let (replacement, newMac) = pair(), newClock = FirstFrameSoftwareClock(), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in replacement.notices { notices.add(notice) } }
        let watching = Task { for try await _ in replacement.pictures(firstFrameTimeout: .seconds(20), sleep: { await newClock.sleep($0) }) {} }
        try await waitUntil { newClock.waiting }; oldClock.fire(); try await waitUntil { oldClock.returned }
        try await newMac.send(.remoteInputPaused); try await waitUntil { notices.all == [.remoteInputPaused] }
        await replacement.close(); _ = await watching.result; newClock.fire()
        hearing.cancel(); oldMac.close(); newMac.close()
    }
}
#endif
