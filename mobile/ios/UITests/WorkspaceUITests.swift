import XCTest

/// Only the owned, empty simulator created by check-ui.py. Never signs in or
/// pairs a real host. Optional personal portal address comes from a local run file.
@MainActor final class WorkspaceUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func test00OnboardingAcceptsKoreanInputAndRejectsUnsupportedAddress() {
        let app = XCUIApplication(); app.launch()
        let field = app.textFields["connectionAddress"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap(); field.typeText("잘못된 연결 주소")
        XCTAssertTrue(app.buttons["reviewConnectionAddress"].isEnabled)
        app.buttons["reviewConnectionAddress"].tap()
        XCTAssertTrue(app.staticTexts["connectionNotice"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["reviewConnectionAddress"].isEnabled)
        XCTAssertTrue(app.buttons["scanConnectionQR"].exists)
        capture("onboarding-invalid-input")
        field.tap()
        field.typeText("http://192.168.1.2:43123/remote/#pair=" + String(repeating: "a", count: 43))
        app.buttons["reviewConnectionAddress"].tap()
        let warning = app.alerts.firstMatch
        XCTAssertTrue(warning.waitForExistence(timeout: 5))
        XCTAssertTrue(warning.staticTexts["같은 네트워크용 QR입니다"].exists)
        XCTAssertTrue(warning.buttons["같은 네트워크에서 연결"].firstMatch.exists)
        capture("lan-qr-warning-before-connection")
        warning.buttons["취소"].firstMatch.tap()
        XCTAssertFalse(warning.exists)
        XCTAssertTrue(field.isHittable)
        XCTAssertFalse(app.webViews.firstMatch.exists)
        app.terminate()
    }

    func test10PersonalWorkspaceSettingsTabsAndColdLaunch() throws {
        guard let portal = ProcessInfo.processInfo.environment["AGENTSTOZ_IOS_PORTAL_URL"], !portal.isEmpty else {
            throw XCTSkip("Personal HTTPS portal was not supplied; anonymous portal checks are separate from onboarding.")
        }
        let app = XCUIApplication(); app.launch()
        let field = app.textFields["connectionAddress"]
        XCTAssertTrue(field.waitForExistence(timeout: 15)); field.tap(); field.typeText(portal)
        app.buttons["reviewConnectionAddress"].tap()
        let open = app.buttons["내 작업 공간 열기"]
        XCTAssertTrue(open.waitForExistence(timeout: 5)); open.tap()
        let settings = app.buttons["workroomConnectionSettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        let web = app.webViews.firstMatch
        let home = web.buttons["홈"]
        XCTAssertTrue(home.waitForExistence(timeout: 30))
        for label in ["프로젝트", "원격 작업", "북마크", "기록", "홈"] {
            let tab = web.buttons[label]; XCTAssertTrue(tab.isHittable); tab.tap()
        }
        settings.tap()
        XCTAssertTrue(app.buttons["workroomDisconnect"].waitForExistence(timeout: 5))
        app.buttons["workroomDisconnect"].tap()
        // SwiftUI's iOS 26 alert exposes nested buttons with the same identifier.
        let cancel = app.buttons["workroomForgetCancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 5)); cancel.tap()
        XCTAssertFalse(app.alerts.firstMatch.exists)
        app.buttons["workroomConnectionDone"].tap()
        XCTAssertTrue(home.waitForExistence(timeout: 5))
        XCTAssertTrue(home.isHittable)
        // The presenting onboarding view remains in the AX tree beneath the cover.
        XCTAssertFalse(field.isHittable)

        // WK exposes summary and its labelled child as nested AX buttons.
        let theme = web.buttons["화면 설정"].firstMatch
        XCTAssertTrue(theme.exists); theme.tap()
        // WebKit maps aria-pressed theme choices to AX switches.
        let systemTheme = web.switches["기기 설정 따름"]
        XCTAssertTrue(systemTheme.waitForExistence(timeout: 3))
        web.buttons["북마크"].tap()
        XCTAssertFalse(systemTheme.isHittable)
        XCTAssertTrue(web.staticTexts["북마크"].firstMatch.exists)
        home.tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(home.waitForExistence(timeout: 5)); XCTAssertTrue(home.isHittable)
        capture("workspace-landscape")
        XCUIDevice.shared.orientation = .portrait
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(home.waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        let restoredHome = app.webViews.firstMatch.buttons["홈"]
        XCTAssertTrue(restoredHome.waitForExistence(timeout: 30))
        XCTAssertTrue(restoredHome.isHittable)
        XCTAssertFalse(app.textFields["connectionAddress"].isHittable)
        capture("workspace-cold-launch")
    }
}
