import XCTest

/// Run only with the dedicated physical harness and the local Mac fixture. This does not mock biometric approval,
/// sign in, change enrolled biometrics, or type into a real project. The fixture's independent Mac receipt decides
/// delivery; successful XCTest taps alone do not establish remote input success.
@MainActor final class PhysicalScreenControls: XCTestCase {
    func testRealMacClickKoreanTextAndFourDirectionScroll() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let json = env["AGENTSTOZ_PHYSICAL_SCREEN_CONFIG"], let data = json.data(using: .utf8),
              let config = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let targets = config["targets"] as? [String: [Double]], let aspect = config["aspect"] as? Double,
              let macName = config["macName"] as? String else {
            throw XCTSkip("Requires the explicit USB physical-screen harness and a fresh Mac fixture.")
        }
        let app = XCUIApplication(bundleIdentifier: "com.intenet.agentstoz.mobile.testflight")
        app.activate()
        XCUIDevice.shared.orientation = .landscapeLeft
        let guide = app.navigationBars["Mac 화면 조작법"]
        if guide.exists { app.buttons["완료"].firstMatch.tap() }
        let surface = app.otherElements["screenRemoteSurface"]
        let stage = env["AGENTSTOZ_PHYSICAL_SCREEN_STAGE"]
        XCTAssertTrue(["connect", "input", "submit", "spaces"].contains(stage ?? ""), "Capture and verify the real fixture before starting a separate input stage.")
        if stage != "connect" {
            XCTAssertTrue(surface.exists, "Input stage never selects or reconnects a Mac; the host must first verify its live fixture picture.")
            XCTAssertEqual(surface.value as? String, "연결됨", "An expired session is never revived by the input stage.")
        }
        if !surface.exists {
            let screens = app.buttons["workroomScreenMacs"]
            if screens.waitForExistence(timeout: 4), screens.isHittable { screens.tap() }
            let rows = app.buttons.matching(identifier: "openScreen")
            XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
            func normalized(_ value: String) -> String { value.filter { !$0.isWhitespace } }
            let macs = rows.allElementsBoundByIndex.filter {
                $0.isHittable && normalized($0.label).contains(normalized(macName))
            }
            XCTAssertEqual(stage, "connect", "The input stage must never select or reconnect a Mac.")
            // A renewed registration is appended last. Connecting alone sends no test clicks or text. The host
            // must then inspect the fixture screenshot and its own authenticated session before the input stage.
            XCTAssertFalse(macs.isEmpty, "No registered Mac has the expected display name. Rows: \(rows.allElementsBoundByIndex.map(\.label))")
            try XCTUnwrap(macs.last).tap()
        }
        // A real person must satisfy the original biometric ACL. Never simulate, reuse a debug signer or fall back
        // to passcode connection approval. The timeout leaves time for the physical Touch ID prompt.
        let ready = NSPredicate { _, _ in guide.exists || (surface.exists && (surface.value as? String) == "연결됨") }
        expectation(for: ready, evaluatedWith: app)
        waitForExpectations(timeout: 90)
        if guide.exists { app.buttons["완료"].firstMatch.tap() }
        let connected = NSPredicate(format: "value == %@", "연결됨")
        expectation(for: connected, evaluatedWith: surface)
        waitForExpectations(timeout: 5)
        if env["AGENTSTOZ_PHYSICAL_SCREEN_STAGE"] == "connect" {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "physical-ipad-connected-fixture"; attachment.lifetime = .keepAlways
            add(attachment)
            return
        }
        if app.buttons["입력 방식: 트랙패드"].exists { app.buttons["입력 방식: 트랙패드"].tap() }
        if app.buttons["확대 원래대로"].exists { app.buttons["확대 원래대로"].tap() }
        if app.buttons["screenScrollPad"].exists, app.buttons["아래로"].exists { app.buttons["닫기"].firstMatch.tap() }
        if app.textFields["Mac에 입력할 글자"].exists { app.buttons["텍스트 입력 · 키보드"].tap() }
        func target(_ name: String) throws -> XCUICoordinate {
            let point = try XCTUnwrap(targets[name])
            let frame = surface.frame
            let width = min(frame.width, frame.height * aspect), height = min(frame.height, frame.width / aspect)
            let offset = CGVector(dx: (frame.width - width) / 2 + width * point[0],
                                  dy: (frame.height - height) / 2 + height * point[1])
            return surface.coordinate(withNormalizedOffset: .zero).withOffset(offset)
        }
        if stage == "submit" {
            // The separately verified Mac fixture supplies the receipt; no user project is used.
            try target("text").tap()
            app.buttons["텍스트 입력 · 키보드"].tap()
            let field = app.textFields["Mac에 입력할 글자"]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap()
            field.typeText("자동입력-v4")
            XCTAssertEqual(field.value as? String, "자동입력-v4")
            field.typeText("\n")
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "physical-ipad-enter-submit"; attachment.lifetime = .keepAlways
            add(attachment)
            return
        }
        if stage == "spaces" {
            app.buttons["텍스트 입력 · 키보드"].tap()
            for id in ["screenKeyboardSpace1", "screenKeyboardSpace2", "screenKeyboardSpace3",
                       "screenKeyboardSpacePrevious", "screenKeyboardSpaceNext"] {
                let button = app.buttons[id]
                XCTAssertTrue(button.waitForExistence(timeout: 5) && button.isEnabled, "Missing Space control \(id)")
                button.tap()
                Thread.sleep(forTimeInterval: 1.5) // allow the real Mac's Space transition to finish
            }
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "physical-ipad-space-controls"; attachment.lifetime = .keepAlways
            add(attachment)
            return
        }
        try target("click").tap()
        try target("text").tap()
        app.buttons["텍스트 입력 · 키보드"].tap()
        let field = app.textFields["Mac에 입력할 글자"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap(); field.typeText("한글입력 ipad-OK")
        XCTAssertEqual(field.value as? String, "한글입력 ipad-OK", "Verify native iPad text entry before sending it to the Mac.")
        app.buttons["보내기"].tap()
        app.buttons["텍스트 입력 · 키보드"].tap()
        try target("scroll").tap()
        app.buttons["screenScrollPad"].tap()
        for name in ["아래로", "아래로", "오른쪽", "오른쪽", "위로", "왼쪽"] {
            app.buttons[name].tap()
        }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "physical-ipad-screen-controls"; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
