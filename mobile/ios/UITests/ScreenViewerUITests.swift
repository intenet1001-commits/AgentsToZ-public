import Foundation
import XCTest

/// J2-SCREEN-SIM (emulator e2e, 「Core + 표면만」): the gesture probe's `--screen-viewer` mode against the fixture
/// Screen host that `check-ui.py --screen-gestures` starts on this Mac's loopback (synthetic capture, input recorded and
/// never injected). Compiled only into that disposable gesture project, and only meaningful in an owned simulator: on a
/// device each test skips.
///
/// check-ui.py hands the host's pins file over as AGENTSTOZ_SCREEN_FIXTURE_PINS (owner-only, in the host's scratch); the
/// test passes the port, the Mac key and one signing key to the probe's launch environment. After the probe's
/// text-and-Return reaches the host, check-ui.py ends the session from the Mac (`end`, recorded as scripted), and the
/// probe must show the Mac's reason. Each test attaches what the phone saw (`screen-viewer-phone-*`) so check-ui.py can
/// compare it with the host's input-events.jsonl.
@MainActor final class ScreenViewerUITests: XCTestCase {
    /// The phone's input in order: tap (move, left press), two-finger tap (move, right press), press-and-drag (move,
    /// left down, at least one move, left up), then the text with Return. Each move carries the exact x,y it sent; the
    /// judge compares them with the host's records and checks where the tap and the drag landed.
    static let expectedSent = #"^M\([^ (),]+,[^ (),]+\) L\+ L- M\([^ (),]+,[^ (),]+\) R\+ R- M\([^ (),]+,[^ (),]+\) L\+( M\([^ (),]+,[^ (),]+\))+ L- T:hello$"#
    /// Every picture reached a display layer that never failed (no flush, no keyframe asked for to recover).
    static let expectedRender = "failures=0 keyframes=0 status=rendering"

    func testViewerStreamsFixtureMacAndSendsGestures() throws {
        #if targetEnvironment(simulator)
        let app = try launchViewer(role: "device")
        let state = app.staticTexts["screenViewerState"]
        XCTAssertTrue(waitFor(state, timeout: 20) { $0.hasPrefix("connected") }, "state: \(state.label)")
        XCTAssertTrue(state.label.contains("path=loopback"), state.label)
        let frames = app.staticTexts["screenViewerFrames"]
        XCTAssertTrue(waitFor(frames, timeout: 30) { Self.number(after: "frames=", in: $0) >= 30 }, "frames: \(frames.label)")
        let input = app.staticTexts["screenViewerInput"]
        XCTAssertTrue(waitFor(input, timeout: 10) { $0 == "input=ready" }, "input: \(input.label)")

        let surface = app.otherElements["screenViewerSurface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        let delivery = app.staticTexts["gestureDelivery"]
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(waitFor(delivery, timeout: 5) { $0 == "left=1 right=0" }, "tap: \(delivery.label)")
        // The right click waits for the two-finger double tap (zoom reset) to fail.
        surface.tap(withNumberOfTaps: 1, numberOfTouches: 2)
        XCTAssertTrue(waitFor(delivery, timeout: 5) { $0 == "left=1 right=1" }, "two-finger tap: \(delivery.label)")
        // Inside the picture: a 16:9 Mac picture fills only the middle band of a portrait phone (y ≈ 0.37…0.63).
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.45))
            .press(forDuration: 0.6, thenDragTo: surface.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.56)))
        XCTAssertTrue(waitFor(delivery, timeout: 5) { $0 == "left=2 right=1" }, "press-and-drag: \(delivery.label)")

        let field = app.textFields["screenViewerTextField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("hello\n")
        let text = app.staticTexts["screenViewerTextResult"]
        XCTAssertTrue(waitFor(text, timeout: 10) { $0 == "text=1:posted" }, "text-and-Return: \(text.label)")
        let sent = app.staticTexts["screenViewerSent"].label
        XCTAssertNotNil(sent.range(of: Self.expectedSent, options: .regularExpression), "sent: \(sent)")
        let render = app.staticTexts["screenViewerRender"]
        XCTAssertEqual(render.label, Self.expectedRender, "render: \(render.label)")

        // The fixture lowers this phone to view-only after text. Acknowledge only after the phone observes it, so the
        // host cannot close the session before the version-4 availability notice arrives.
        XCTAssertTrue(waitFor(input, timeout: 20) { $0 == "input=monitorUnavailable" }, "view-only input: \(input.label)")
        let pins = try XCTUnwrap(ProcessInfo.processInfo.environment["AGENTSTOZ_SCREEN_FIXTURE_PINS"])
        let acknowledgement = URL(fileURLWithPath: pins).deletingLastPathComponent().appendingPathComponent("bar-view-observed")
        try Data("observed".utf8).write(to: acknowledgement, options: .atomic)

        // check-ui.py ends the session at the Mac after this acknowledgement.
        XCTAssertTrue(waitFor(state, timeout: 30) { $0.hasPrefix("ended=") }, "state: \(state.label)")
        XCTAssertEqual(state.label, "ended=endedAtMac")
        attach(app, name: "screen-viewer-phone-device")
        #else
        throw XCTSkip("The screen viewer probe runs only in an owned simulator (check-ui.py --screen-gestures).")
        #endif
    }

    func testImpostorKeyIsRefusedByTheMac() throws {
        #if targetEnvironment(simulator)
        let app = try launchViewer(role: "impostor")
        let state = app.staticTexts["screenViewerState"]
        XCTAssertTrue(waitFor(state, timeout: 20) { $0.hasPrefix("impostor=") && $0 != "impostor=connecting" }, "state: \(state.label)")
        XCTAssertEqual(state.label, "impostor=refused")
        XCTAssertEqual(app.staticTexts["screenViewerFrames"].label, "frames=0")
        attach(app, name: "screen-viewer-phone-impostor")
        #else
        throw XCTSkip("The screen viewer probe runs only in an owned simulator (check-ui.py --screen-gestures).")
        #endif
    }

    #if targetEnvironment(simulator)
    /// Launches the probe in viewer mode with the fixture's port, Mac key and the key for `role`. A missing pins file
    /// fails the test: check-ui.py compiles this file only when it also starts the fixture host.
    private func launchViewer(role: String) throws -> XCUIApplication {
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["AGENTSTOZ_SCREEN_FIXTURE_PINS"], "no fixture pins file")
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let pins = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let port = try XCTUnwrap(pins["port"] as? Int)
        XCTAssertFalse([3001, 52741, 4723].contains(port), "the fixture port is a reserved port")
        let key = try XCTUnwrap(pins[role == "device" ? "devicePrivateKey" : "impostorPrivateKey"] as? String)
        let app = XCUIApplication()
        app.launchArguments = ["--screen-viewer"]
        app.launchEnvironment = [
            "SCREEN_FIXTURE_PORT": String(port),
            "SCREEN_FIXTURE_MAC_PUBLIC_KEY": try XCTUnwrap(pins["macPublicKey"] as? String),
            "SCREEN_FIXTURE_MAC_FINGERPRINT": try XCTUnwrap(pins["macFingerprint"] as? String),
            "SCREEN_FIXTURE_SIGNING_KEY": key,
            "SCREEN_FIXTURE_ROLE": role,
        ]
        app.launch()
        return app
    }

    /// Polls the element's label until `condition` holds or `timeout` passes.
    private func waitFor(_ element: XCUIElement, timeout: TimeInterval, _ condition: (String) -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if element.exists, condition(element.label) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        } while Date() < deadline
        return element.exists && condition(element.label)
    }

    static func number(after prefix: String, in label: String) -> Int {
        guard label.hasPrefix(prefix) else { return -1 }
        return Int(label.dropFirst(prefix.count)) ?? -1
    }

    /// What the phone saw, for check-ui.py to compare with the host's records. No key material.
    private func attach(_ app: XCUIApplication, name: String) {
        var seen: [String: String] = [:]
        for identifier in ["screenViewerState", "screenViewerFrames", "screenViewerRender", "screenViewerInput",
                           "gestureDelivery", "screenViewerTextResult", "screenViewerSent"] {
            seen[identifier] = app.staticTexts[identifier].label
        }
        let data = (try? JSONSerialization.data(withJSONObject: seen, options: [.sortedKeys])) ?? Data("{}".utf8)
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    #endif
}
