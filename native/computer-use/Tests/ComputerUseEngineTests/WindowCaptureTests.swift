import XCTest
import CoreGraphics
import ComputerUseApproval
import ComputerUseControlCore
@testable import ComputerUseEngine

/// One window list and one image, with a hook at each of the two awaits ScreenCaptureKit adds to a capture.
@MainActor
private final class FakeWindows: WindowCaptureSource {
    struct Window { let id: UInt32; let pid: Int32?; let frame: CGRect }
    var list: [Window]
    var duringWindows: (() -> Void)?
    var duringImage: (() -> Void)?
    /// Suspends `windows()` until `release()`: the capture is really parked at that await while the test acts.
    var parked: CheckedContinuation<Void, Never>?
    var parkWindows = false
    var arrived: (() -> Void)?
    var imageCalls: [(width: Int, height: Int)] = []
    init(list: [Window]) { self.list = list }
    func windows() async throws -> [Window] {
        if parkWindows { await withCheckedContinuation { parked = $0; arrived?() } }
        duringWindows?()
        return list
    }
    func describe(_ window: Window) -> (windowId: UInt32, pid: Int32?, frame: CGRect) { (window.id, window.pid, window.frame) }
    func image(of window: Window, width: Int, height: Int) async throws -> CGImage {
        imageCalls.append((width, height))
        duringImage?()
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()!
    }
}

@MainActor
private final class Outcome {
    var payload: [String: Any]?
    var frame: CGRect?
    var error: Error?
}

/// The bound session as `TargetSession.capture` reads it: its real `stop()` (the person's 중단, revocation, expiry),
/// its own snapshot and age, the person's input state and the exact AX frame.
@MainActor
private final class Harness {
    let session = TargetSession(target: ApprovalTarget(bundleId: "com.example.editor", teamId: "ABCDEFGHIJ",
                                                       codeHash: String(repeating: "ab", count: 20), pid: 100,
                                                       processStart: "9007199254740995", windowId: 321))
    var human = TargetSession.HumanState(frontmost: 42, focusedWindow: .absent, focusedElement: .absent, cursor: .zero)
    var axFrames: [CGRect?]
    /// AX reads of the target window. None may follow a stop that landed during the window list.
    var frameReads = 0
    let source: FakeWindows
    init(frame: CGRect, list: [FakeWindows.Window]? = nil) {
        axFrames = [frame]
        source = FakeWindows(list: list ?? [.init(id: 321, pid: 100, frame: frame)])
        session.snapshot = "ax_snapshot_1"; session.observedAt = Date()
    }
    var checks: WindowCaptureChecks {
        WindowCaptureChecks(
            validate: { [session] in if session.halted { throw ControlError("worker-halted") } },
            observationCurrent: { [session] in session.snapshot == "ax_snapshot_1" && Date().timeIntervalSince(session.observedAt) <= 15 },
            humanState: { self.human },
            windowFrame: { self.frameReads += 1; return self.axFrames.count > 1 ? self.axFrames.removeFirst() : self.axFrames[0] })
    }
    func run() async -> Outcome {
        let outcome = Outcome()
        do {
            let captured = try await captureWindow(windowId: 321, pid: 100, checks: checks, source: source)
            outcome.payload = captured.payload; outcome.frame = captured.frame
        } catch { outcome.error = error }
        return outcome
    }
}

@MainActor private func code(_ outcome: Outcome) -> String? { (outcome.error as? ControlError)?.code }
/// The payload keeps the window size as the CGFloat ScreenCaptureKit reported; JSON encoding makes it a number.
private func number(_ value: Any?) -> Double? {
    if let value = value as? CGFloat { return Double(value) }
    return (value as? NSNumber)?.doubleValue
}

final class WindowCaptureTests: XCTestCase {
    private let frame = CGRect(x: 100, y: 50, width: 2560, height: 1600)

    @MainActor func testThePersonsStopWhileTheWindowListIsResolvingYieldsNoImage() async {
        let h = Harness(frame: frame)
        h.source.duringWindows = { h.session.stop() }
        let outcome = await h.run()
        XCTAssertNil(outcome.payload); XCTAssertEqual(code(outcome), "worker-halted")
        XCTAssertTrue(h.source.imageCalls.isEmpty); XCTAssertEqual(h.frameReads, 0, "refused right after the window list")
    }

    @MainActor func testARevocationThatLandsWhileTheCaptureIsParkedYieldsNoImage() async {
        let h = Harness(frame: frame)
        h.source.parkWindows = true
        var reached: CheckedContinuation<Void, Never>?
        h.source.arrived = { reached?.resume(); reached = nil }
        let capture = Task { await h.run() }
        if h.source.parked == nil { await withCheckedContinuation { reached = $0 } }
        // The capture is suspended inside ScreenCaptureKit's window list; the person stops the grant now.
        h.session.stop()
        h.source.parked?.resume()
        let outcome = await capture.value
        XCTAssertNil(outcome.payload); XCTAssertEqual(code(outcome), "worker-halted")
        XCTAssertTrue(h.source.imageCalls.isEmpty); XCTAssertEqual(h.frameReads, 0); XCTAssertNil(h.session.capturedFrame)
    }

    @MainActor func testARevocationWhileThePixelsAreProducedDiscardsThem() async {
        let h = Harness(frame: frame)
        h.source.duringImage = { h.session.stop() }
        let outcome = await h.run()
        XCTAssertNil(outcome.payload); XCTAssertNil(outcome.frame); XCTAssertEqual(code(outcome), "worker-halted")
        XCTAssertEqual(h.source.imageCalls.count, 1); XCTAssertEqual(h.frameReads, 2, "refused right after the pixels returned")
    }

    @MainActor func testAHumanTakeoverAtEitherAwaitDiscardsTheObservation() async {
        for during in ["windows", "image"] {
            let h = Harness(frame: frame)
            let takeover = { h.human = TargetSession.HumanState(frontmost: 7, focusedWindow: .absent, focusedElement: .absent, cursor: .zero) }
            if during == "windows" { h.source.duringWindows = takeover } else { h.source.duringImage = takeover }
            let outcome = await h.run()
            XCTAssertNil(outcome.payload, during); XCTAssertEqual(code(outcome), "observation-discarded", during)
            XCTAssertEqual((outcome.error as? ControlError)?.notDispatched, true, during)
            XCTAssertEqual(h.source.imageCalls.count, during == "windows" ? 0 : 1, during)
            XCTAssertEqual(h.frameReads, during == "windows" ? 0 : 3, during)
        }
    }

    @MainActor func testAReplacedOrAgedObservationAndAnUnverifiablePersonGetNoImage() async {
        var h = Harness(frame: frame)
        h.source.duringWindows = { h.session.snapshot = "ax_snapshot_2" }
        var outcome = await h.run()
        XCTAssertEqual(code(outcome), "observation-discarded"); XCTAssertTrue(h.source.imageCalls.isEmpty); XCTAssertEqual(h.frameReads, 0)

        h = Harness(frame: frame)
        h.source.duringImage = { h.session.observedAt = Date(timeIntervalSinceNow: -16) }
        outcome = await h.run()
        XCTAssertEqual(code(outcome), "observation-discarded"); XCTAssertNil(outcome.payload)

        h = Harness(frame: frame)
        h.human = TargetSession.HumanState(frontmost: nil, focusedWindow: .absent, focusedElement: .absent, cursor: .zero)
        outcome = await h.run()
        XCTAssertEqual(code(outcome), "human-state-unavailable"); XCTAssertTrue(h.source.imageCalls.isEmpty)
    }

    @MainActor func testOnlyTheExactWindowWithAnUnchangedFrameIsCaptured() async {
        let other = CGRect(x: 0, y: 0, width: 800, height: 600)
        let cases: [([FakeWindows.Window], CGRect)] = [
            ([], frame),
            ([.init(id: 321, pid: 100, frame: frame), .init(id: 321, pid: 100, frame: frame)], frame),
            ([.init(id: 321, pid: 101, frame: frame)], frame),
            ([.init(id: 321, pid: 100, frame: frame)], other)]
        for (list, ax) in cases {
            let h = Harness(frame: ax, list: list)
            let outcome = await h.run()
            XCTAssertEqual(code(outcome), "window-not-exact"); XCTAssertTrue(h.source.imageCalls.isEmpty)
        }
        // Moved between the window list and the pixel request: refused before any pixels.
        let h = Harness(frame: frame)
        h.axFrames = [frame, frame.offsetBy(dx: 10, dy: 0)]
        let outcome = await h.run()
        XCTAssertEqual(code(outcome), "observation-discarded"); XCTAssertTrue(h.source.imageCalls.isEmpty)
    }

    /// The image is the window scaled to 1280 px on its longest side, within the JPEG cap, with the window's point
    /// size beside it. A pixel the agent picks maps to `pixel * windowWidth / width`, and only a point inside the
    /// captured frame reaches the hit test, at that frame's global origin plus the point.
    @MainActor func testADownscaledImageMapsPixelsToWindowPointsInsideTheCapturedFrame() async throws {
        let h = Harness(frame: frame)
        let outcome = await h.run()
        let payload = try XCTUnwrap(outcome.payload)
        XCTAssertEqual(outcome.frame, frame)
        XCTAssertEqual(h.source.imageCalls.first?.width, 1280); XCTAssertEqual(h.source.imageCalls.first?.height, 800)
        let width = try XCTUnwrap(payload["width"] as? Int), height = try XCTUnwrap(payload["height"] as? Int)
        let windowWidth = try XCTUnwrap(number(payload["windowWidth"])), windowHeight = try XCTUnwrap(number(payload["windowHeight"]))
        XCTAssertEqual([width, height], [1280, 800]); XCTAssertEqual([windowWidth, windowHeight], [2560, 1600])
        XCTAssertEqual(payload["mediaType"] as? String, "image/jpeg")
        let jpeg = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(payload["data"] as? String)))
        XCTAssertLessThanOrEqual(jpeg.count, WindowCaptureLimits.jpegBytes); XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8])
        XCTAssertEqual(h.session.capturedFrame, nil, "only TargetSession.capture binds the frame for a later click")

        func point(_ px: Double, _ py: Double) -> CGPoint? {
            NativeAXDriver.screenPoint(x: px * windowWidth / Double(width), y: py * windowHeight / Double(height), in: frame)
        }
        XCTAssertEqual(point(640, 400), CGPoint(x: 100 + 1280, y: 50 + 800))
        XCTAssertEqual(point(0, 0), CGPoint(x: 100, y: 50))
        XCTAssertEqual(point(1279, 799), CGPoint(x: 100 + 2558, y: 50 + 1598))
        XCTAssertNil(point(1280, 10), "the right edge is outside the window")
        XCTAssertNil(point(10, 800), "the bottom edge is outside the window")
        XCTAssertNil(NativeAXDriver.screenPoint(x: -0.5, y: 1, in: frame))
        XCTAssertNil(NativeAXDriver.screenPoint(x: .nan, y: 1, in: frame))
        XCTAssertNil(NativeAXDriver.screenPoint(x: 1, y: .infinity, in: frame))
    }

    @MainActor func testASmallWindowIsNotUpscaled() async throws {
        let small = CGRect(x: 0, y: 0, width: 640.5, height: 300.25)
        let outcome = await Harness(frame: small).run()
        let payload = try XCTUnwrap(outcome.payload)
        XCTAssertEqual(payload["width"] as? Int, 640); XCTAssertEqual(payload["height"] as? Int, 300)
        XCTAssertEqual(number(payload["windowWidth"]), 640.5)
    }

    /// The engine's capture payload carries exactly the fields of the shared reply sample (besides success/halted).
    @MainActor func testThePayloadFieldsMatchTheSharedReplySample() async throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "ControlContract/requests.json")
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        let sample = try XCTUnwrap((root["replies"] as? [String: Any])?["capture"] as? [String: Any])
        let outcome = await Harness(frame: frame).run()
        let payload = try XCTUnwrap(outcome.payload)
        XCTAssertEqual(Set(payload.keys).union(["success", "halted"]), Set(sample.keys))
        XCTAssertEqual(sample["width"] as? Int, 1280); XCTAssertEqual(sample["windowWidth"] as? Int, 2560)
    }
}
