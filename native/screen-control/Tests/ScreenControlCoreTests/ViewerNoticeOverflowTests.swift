#if !CORE_CHECKS
import Foundation
import XCTest
@testable import ScreenControlCore

/// In-memory frames and software identities only: no listener, screen, input, keychain or TCC.
final class ViewerNoticeOverflowTests: XCTestCase {
    private func pair(controller: Bool = true) async throws -> (ScreenViewer, SecureConnection) {
        let fixture = PeerFixture(), device = controller ? fixture.controller() : fixture.phone()
        let (reply, pending) = try await fixture.mac.respond(to: device.hello, accepting: [.phone, .controller])
        let (finish, viewerChannel) = try await device.finish(macHello: reply, signer: controller ? fixture.controllerSigner : fixture.phoneSigner)
        let macChannel = try await pending.confirm(finish)
        let (viewerEnd, macEnd) = framePipe()
        return (ScreenViewer(connection: SecureConnection(framed: viewerEnd, channel: viewerChannel)),
                SecureConnection(framed: macEnd, channel: macChannel))
    }

    func testAuthenticatedHoldAndHandBackArriveInOrder() async throws {
        let (viewer, mac) = try await pair(), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        defer { hearing.cancel(); watching.cancel(); mac.close() }
        try await mac.send(.inputHeldAtMac(true))
        try await mac.send(.inputHeldAtMac(false))
        try await waitUntil { notices.all.count == 2 }
        XCTAssertEqual(notices.all, [.inputHeldAtMac(true), .inputHeldAtMac(false)])
        await viewer.close()
    }

    func testOverflowOnEitherHoldTransitionClosesInsteadOfLosingState() async throws {
        for held in [true, false] {
            let (viewer, mac) = try await pair()
            let watching = Task { for try await _ in viewer.pictures() {} }
            // No notice consumer: all 64 slots fill before this state change arrives.
            for _ in 0..<64 { try await mac.send(.macLocked) }
            try await mac.send(.inputHeldAtMac(held))
            do {
                try await within(3) { try await watching.value }
                XCTFail("overflow must close the session")
            } catch let error as ScreenViewerNoticeError {
                XCTAssertEqual(error, .overflow)
            }
            // Closing the encrypted connection also closes the peer's frame stream.
            let peerEnd = try await nextFrameOrEnd(mac.framed)
            XCTAssertNil(peerEnd)
            await viewer.close(); mac.close()
        }
    }

    func testOverflowClosesTheHostPumpAndReleasesHeldInput() async throws {
        let (viewer, mac) = try await pair(), injected = Collector<InputEvent>()
        let receiver = InputReceiver(inject: { injected.add($0) })
        let pump = VideoPump(connection: mac, input: receiver, encoderFactory: EncoderShop().factory)
        let running = Task { try await pump.run(features: SessionFeatures(grant: .control)) }
        let watching = Task { for try await _ in viewer.pictures() {} }
        let down = InputEvent.key(code: 12, isDown: true, modifiers: [])
        let up = InputEvent.key(code: 12, isDown: false, modifiers: [])
        viewer.input(down)
        try await waitUntil { injected.all.contains(down) }
        // The pump's initial session-limits notice plus these notices overfills the unconsumed buffer.
        for _ in 0..<65 { try? await mac.send(.macLocked) }
        do { try await within(3) { try await watching.value }; XCTFail("overflow must close") }
        catch let error as ScreenViewerNoticeError { XCTAssertEqual(error, .overflow) }
        _ = try? await within(3) { try await running.value }
        try await waitUntil { injected.all.contains(up) }
        await viewer.close(); mac.close()
    }

    func testCancelledNoticeConsumerClosesOnTheNextAuthenticatedNotice() async throws {
        let (viewer, mac) = try await pair(), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await mac.send(.inputHeldAtMac(true))
        try await waitUntil { notices.all == [.inputHeldAtMac(true)] }
        hearing.cancel(); await hearing.value
        try await mac.send(.inputHeldAtMac(false))
        do {
            try await within(3) { try await watching.value }
            XCTFail("a terminated notice consumer must close the session")
        } catch let error as ScreenViewerNoticeError {
            XCTAssertEqual(error, .consumerEnded)
        }
        let peerEnd = try await nextFrameOrEnd(mac.framed)
        XCTAssertNil(peerEnd)
        await viewer.close(); mac.close()
    }

    func testV4GoldenAndNormalNoticeOrderingRemainUnchanged() async throws {
        try await ScreenControlChecks().testPhoneStaysOnVersionFourByteForByte()
        let (viewer, mac) = try await pair(controller: false), notices = Collector<ScreenNotice>()
        XCTAssertEqual(viewer.protocolVersion, 4)
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        defer { hearing.cancel(); watching.cancel(); mac.close() }
        try await mac.send(.remoteInputPaused)
        try await mac.send(.remoteInputResumed)
        try await waitUntil { notices.all.count == 2 }
        XCTAssertEqual(notices.all, [.remoteInputPaused, .remoteInputResumed])
        await viewer.close()
    }

    func testV4RetainsItsExistingBoundedOverflowBehavior() async throws {
        let (viewer, mac) = try await pair(controller: false)
        let watching = Task { for try await _ in viewer.pictures() {} }
        for _ in 0..<64 { try await mac.send(.macLocked) }
        try await mac.send(.macUnlocked)
        try await mac.send(.close, Data())
        try await within(3) { try await watching.value }
        var notices: [ScreenNotice] = []
        for await notice in viewer.notices { notices.append(notice) }
        XCTAssertEqual(notices.count, 64)
        XCTAssertTrue(notices.allSatisfy { $0 == .macLocked })
        await viewer.close(); mac.close()
    }

    func testUnauthenticatedBytesNeverProduceAHoldNotice() async throws {
        let (viewer, mac) = try await pair(), notices = Collector<ScreenNotice>()
        let hearing = Task { for await notice in viewer.notices { notices.add(notice) } }
        let watching = Task { for try await _ in viewer.pictures() {} }
        try await mac.framed.send(Data(repeating: 0x19, count: 40))
        do { try await within(3) { try await watching.value }; XCTFail("forged record accepted") } catch {}
        XCTAssertFalse(notices.all.contains(.inputHeldAtMac(true)))
        hearing.cancel(); await viewer.close(); mac.close()
    }
}

#endif
