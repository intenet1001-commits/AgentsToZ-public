import XCTest

@MainActor final class ScreenGestureUITests: XCTestCase {
    func testKeyboardPanelSpaceButtonsRouteTheRequestedAction() {
        let app = XCUIApplication(); app.launchArguments = ["--space-controls"]; app.launch()
        let result = app.staticTexts["spaceBarResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        app.buttons["screenKeyboardSpacePrevious"].tap()
        XCTAssertEqual(result.label, "navigation=1")
        for number in 1...3 {
            app.buttons["screenKeyboardSpace\(number)"].tap()
            XCTAssertEqual(result.label, "desktop=\(number) sequence=true")
        }
        app.buttons["screenKeyboardSpaceNext"].tap()
        XCTAssertEqual(result.label, "navigation=2")
        app.buttons["disableSpaceBar"].tap()
        XCTAssertFalse(app.buttons["screenKeyboardSpace1"].isEnabled)
        XCTAssertFalse(app.buttons["screenKeyboardSpaceNext"].isEnabled)
    }

    func testReturnAndKeypadEnterMapToMacKeys() {
        let app = XCUIApplication(); app.launchArguments = ["--keyboard-enter-codes"]; app.launch()
        let result = app.staticTexts["keyboardEnterCodes"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertEqual(result.label, "36,76,36,none")
    }

    func testReturnCommitsMarkedCompositionAndSubmitsOnce() {
        let app = XCUIApplication(); app.launchArguments = ["--compose-return"]; app.launch()
        let result = app.staticTexts["composeReturnResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertEqual(result.label, "marked=true handled=true composing=1 text=ㅎ committed=2 sends=false,true locked=true")
    }

    func testTextReturnDraftIsRetainedUntilMatchingPostedReceipt() {
        let app = XCUIApplication(); app.launchArguments = ["--return-draft"]; app.launch()
        let result = app.staticTexts["returnDraftResult"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        XCTAssertEqual(result.label, "blocked=false unknown=false stale=false edited=false posted=true retry=false,true disconnected=false")
    }

    func testTrackpadDiscardsPausedInputAndUsesResynchronizedMacPointer() {
        let app = XCUIApplication(); app.launchArguments = ["--trackpad-resync"]; app.launch()
        let surface = app.otherElements["gestureProbeSurface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        let point = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        point.tap()
        XCTAssertEqual(app.staticTexts["gestureDelivery"].label, "left=1 right=0 x=13107 y=52428")
        app.buttons["probePause"].tap()
        point.tap()
        point.press(forDuration: 0.2, thenDragTo: surface.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.7)))
        XCTAssertEqual(app.staticTexts["gestureDelivery"].label, "left=1 right=0 x=13107 y=52428", "paused taps and motion never reach the input callback")
        app.buttons["probeResume"].tap()
        point.tap()
        XCTAssertEqual(app.staticTexts["gestureDelivery"].label, "left=2 right=0 x=52428 y=13107", "next click uses the Mac's new pointer, not queued touch motion")
    }

    func testFingerTapProducesLeftClick() {
        let app = XCUIApplication()
        app.launch()
        let surface = app.otherElements["gestureProbeSurface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let delivered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "left=1 right=0"), object: app.staticTexts["gestureDelivery"])
        _ = XCTWaiter.wait(for: [delivered], timeout: 3)
        XCTAssertEqual(app.staticTexts["gestureDelivery"].label, "left=1 right=0")
    }

    func testTwoFingerTapProducesRightClick() {
        let app = XCUIApplication()
        app.launch()
        let surface = app.otherElements["gestureProbeSurface"]
        XCTAssertTrue(surface.waitForExistence(timeout: 5))
        surface.tap(withNumberOfTaps: 1, numberOfTouches: 2)
        // The right-click recognizer waits for the two-finger double tap (zoom reset) to fail.
        let delivered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", "left=0 right=1"), object: app.staticTexts["gestureDelivery"])
        _ = XCTWaiter.wait(for: [delivered], timeout: 3)
        XCTAssertEqual(app.staticTexts["gestureDelivery"].label, "left=0 right=1")
    }
}
