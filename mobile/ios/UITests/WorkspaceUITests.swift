import XCTest
#if targetEnvironment(simulator)
import Vision
#endif

/// Only the owned, empty simulator created by check-ui.py. Never signs in or
/// pairs a real host. Optional personal portal address comes from a local run file.
/// test20 pairs only with check-ui.py's sandboxed fixture host (lan-journey-host.ts) and is simulator-only.
@MainActor final class WorkspaceUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func test00OnboardingAcceptsKoreanInputAndRejectsUnsupportedAddress() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["startConnectionQR"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["startConnectionQR"].isHittable, "First launch must offer a usable primary action.")
        XCTAssertTrue(app.buttons["startConnectionQR"].label.contains("프로젝트·워크룸"), "The first action must name the workspace, separately from screen control registration.")
        XCTAssertTrue(app.buttons["pasteConnectLink"].isHittable, "Data-only onboarding must be visible without expanding advanced address settings.")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Do not show an unconfigured, empty portal.")
        app.buttons["showConnectionOptions"].tap()
        let field = app.textFields["connectionAddress"]
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap(); field.typeText("잘못된 연결 주소")
        XCTAssertTrue(app.buttons["reviewConnectionAddress"].isEnabled)
        app.buttons["reviewConnectionAddress"].tap()
        XCTAssertTrue(app.staticTexts["connectionNotice"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["connectionNotice"].label.contains("https://"))
        XCTAssertFalse(app.staticTexts["connectionNotice"].label.contains("같은 Wi-Fi 연결 QR"))
        XCTAssertFalse(app.buttons["reviewConnectionAddress"].isEnabled)
        XCTAssertTrue(app.buttons["scanConnectionQR"].exists)
        capture("onboarding-invalid-input")
        field.tap(); field.typeText("http://example.invalid")
        app.buttons["reviewConnectionAddress"].tap()
        XCTAssertTrue(app.staticTexts["connectionNotice"].label.contains("https://"))
        XCTAssertFalse(app.buttons["reviewConnectionAddress"].isEnabled)
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
        XCTAssertFalse(app.staticTexts["connectionNotice"].exists, "A valid reviewed address must clear the previous input error even when connection is cancelled.")
        app.terminate()
    }

    func test10PersonalWorkspaceSettingsTabsAndColdLaunch() throws {
        guard let portal = ProcessInfo.processInfo.environment["AGENTSTOZ_IOS_PORTAL_URL"], !portal.isEmpty else {
            throw XCTSkip("Personal HTTPS portal was not supplied; anonymous portal checks are separate from onboarding.")
        }
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["startConnectionQR"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["startConnectionQR"].isHittable, "First launch must offer a usable primary action.")
        XCTAssertFalse(app.webViews.firstMatch.exists, "Do not show an unconfigured, empty portal.")
        app.buttons["showConnectionOptions"].tap()
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
        // The non-destructive way back to the app's scanner (the bundled portal's mismatch message names it).
        XCTAssertTrue(app.buttons["workroomScanOtherQR"].exists)
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

    /// A synthetic v3 controller invitation must be rejected by the shipped device-registration route. No registration
    /// action is attempted: that action creates a key before checking App Attest support.
    func test30MacControllerInviteIsRejectedByDeviceRegistration() throws {
        #if targetEnvironment(simulator)
        let fields: [Data] = [Data([0, 3]), Data(repeating: 1, count: 32), Data(repeating: 2, count: 16),
            Data(repeating: 3, count: 32), Data("Fixture Mac".utf8), Data("fixture.local".utf8), Data(),
            Data([0, 0]), Data([0, 0]), Data("fixture-pair".utf8), Data("fixture-screen".utf8),
            Data(), Data(), Data(), Data([0, 1])]
        var bytes = Data()
        for field in fields {
            var count = UInt32(field.count).bigEndian
            withUnsafeBytes(of: &count) { bytes.append(contentsOf: $0) }
            bytes.append(field)
        }
        let encoded = bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let url = try XCTUnwrap(URL(string: "agentstoz-screen:" + encoded))
        let app = XCUIApplication(); app.launch(); app.open(url)
        let rejection = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Mac 컨트롤러 전용 QR은 이 화면에서 등록할 수 없습니다")).firstMatch
        XCTAssertTrue(rejection.waitForExistence(timeout: 30), "A controller invitation must reach the device registration rejection.")
        XCTAssertFalse(app.buttons["이 기기 등록"].exists)
        XCTAssertFalse(app.buttons["openScreen"].exists)
        capture("controller-invite-rejected")
        #else
        throw XCTSkip("The synthetic invitation is exercised only on an owned simulator.")
        #endif
    }

    /// J1-LAN-APP: the shipped app pairs by the same-network URL with check-ui.py's sandboxed fixture host, lists both
    /// fixture projects, starts A once (confirmed), opens the workroom (refused until the host's scripted consent),
    /// runs one command in the fake CLI and reads its output, comes back from the background over a socket that really
    /// dropped (the host restarts its listener meanwhile) without a new QR, and after an explicit disconnect the Mac
    /// refuses the consumed URL. Each step is checked against the host's own receipts through the journey folder
    /// (`NN-<phase>.json` → `NN-<phase>.ack.json`).
    func test20SameNetworkJourneyPairsProjectAndWorkroom() throws {
        #if targetEnvironment(simulator)
        guard let folder = ProcessInfo.processInfo.environment["AGENTSTOZ_LAN_JOURNEY_DIR"], !folder.isEmpty else {
            throw XCTSkip("check-ui.py did not start the same-network journey host (AGENTSTOZ_LAN_JOURNEY_DIR is not set).")
        }
        var host = LANJourneyControl(directory: URL(fileURLWithPath: folder, isDirectory: true))
        let pairingURL = try host.pairingURL()
        // A simulator local-network or other system prompt is answered only with allow-type buttons; the app's own
        // 「작업 확인」 dialog is never an interruption.
        let monitor = addUIInterruptionMonitor(withDescription: "System alert during the same-network journey") { alert in
            MainActor.assumeIsolated {
                for label in ["Allow", "허용", "OK"] where alert.buttons[label].exists {
                    alert.buttons[label].tap(); return true
                }
                return false
            }
        }
        defer { removeUIInterruptionMonitor(monitor) }

        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["startConnectionQR"].waitForExistence(timeout: 20))
        connectSameNetwork(app, url: pairingURL)
        let web = app.webViews.firstMatch
        XCTAssertTrue(app.buttons["workroomConnectionSettings"].waitForExistence(timeout: 30))
        XCTAssertTrue(web.waitForExistence(timeout: 30))

        // 1. Both fixture projects listed; A stopped.
        expectText(web, "Fixture project A", timeout: 30)
        expectText(web, "Fixture project B", timeout: 5)
        expectText(web, "중지됨", timeout: 5)
        expectText(web, "연결됨", timeout: 15)
        capture("lan-projects-listed")
        try host.expect("listed", self)

        // 2. Start A: the page asks first (native 「작업 확인」), then the Mac runs it once.
        let start = web.buttons["실행"].firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        reveal(start, in: web)
        start.tap()
        let confirm = app.alerts["작업 확인"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "Starting a project must ask first.")
        confirm.buttons["확인"].firstMatch.tap()
        // 「실행 중 · 포트 45173」: the fixture's display-only port (lan-journey-host.ts FIXTURE_DISPLAY_PORT).
        expectText(web, "실행 중", contains: true, timeout: 20)
        capture("lan-project-A-running")
        try host.expect("started", self)

        // 3. The workroom: refused until the Mac allows this device (the host's scripted consent).
        let openWorkroom = web.buttons["워크룸에서 작업"].firstMatch
        XCTAssertTrue(openWorkroom.waitForExistence(timeout: 10))
        reveal(openWorkroom, in: web)
        openWorkroom.tap()
        expectText(web, "워크룸 작업을 허용하세요", contains: true, timeout: 20)
        capture("lan-workroom-consent-required")
        try host.expect("consent-required", self)

        let refresh = web.buttons["작업 세션 새로고침"].firstMatch
        XCTAssertTrue(refresh.waitForExistence(timeout: 10))
        reveal(refresh, in: web); refresh.tap()
        turnBypassOff(web)
        let begin = web.buttons["작업 시작"].firstMatch
        XCTAssertTrue(begin.waitForExistence(timeout: 10))
        reveal(begin, in: web); begin.tap()
        dismissKeyboard(app, web)
        expectTerminalText(app, web, "REMOTEREADY", timeout: 30)

        // 4. One command through the composer.
        let line = composer(web)
        XCTAssertTrue(line.waitForExistence(timeout: 10))
        reveal(line, in: web); line.tap()
        line.typeText("hello")
        let send = web.buttons["전송"].firstMatch; reveal(send, in: web); send.tap()
        try host.expect("sent", self)
        dismissKeyboard(app, web)
        expectTerminalText(app, web, "RESULTHELLO", timeout: 30)
        capture("lan-workroom-output")
        try host.expect("output-seen", self)

        // 5. Background → foreground. A few seconds in the background never drop the socket (the app keeps its page), so
        //    while the app is away the host restarts its listener keeping its record: the socket closes with 1012 as on
        //    a Mac restart. Coming back, only the page's own session.restore can reconnect — no new QR, no new pairing.
        XCUIDevice.shared.press(.home)
        try host.expect("backgrounded", self)
        RunLoop.current.run(until: Date().addingTimeInterval(2))
        app.activate()
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        try host.expect("resumed", self)
        expectText(web, "연결됨", timeout: 30)
        XCTAssertFalse(app.buttons["startConnectionQR"].isHittable, "Resuming must not fall back to the QR screen.")
        capture("lan-resumed")

        // 6. Explicit disconnect: the app tells the Mac and forgets the connection.
        app.buttons["workroomConnectionSettings"].tap()
        XCTAssertTrue(app.buttons["workroomConnectionDone"].waitForExistence(timeout: 10))
        // The sheet opens at half height and its List renders lazily: 「이 앱의 연결 정보 지우기」 is the last row, so the
        // sheet is dragged up (expand, then scroll) until the row exists and can be tapped.
        let disconnect = app.buttons["workroomDisconnect"]
        for _ in 0..<6 {
            if disconnect.exists && disconnect.isHittable { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.86))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)))
        }
        if !(disconnect.exists && disconnect.isHittable) {
            attachDiagnostics("connection-settings")
            XCTFail("「이 앱의 연결 정보 지우기」 was not reachable in 연결 설정.")
        }
        disconnect.tap()
        let confirmForget = app.alerts["이 앱의 연결 정보를 지울까요?"]
        XCTAssertTrue(confirmForget.waitForExistence(timeout: 10))
        let forgetById = app.buttons["workroomForgetConfirm"].firstMatch
        (forgetById.exists ? forgetById : confirmForget.buttons["연결 정보 지우기"].firstMatch).tap()
        XCTAssertTrue(app.buttons["startConnectionQR"].waitForExistence(timeout: 30))
        try host.expect("disconnected", self)

        // 7. The consumed URL again: the Mac serves the page and refuses the pairing; nothing is listed and nothing runs.
        //    Only the page's own 「연결 종료」 counts — the native 「연결 상태 확인」 (workroomEnded) also shows when the
        //    page never loaded, which says nothing about the Mac. The host checks it served the page and refused the pair.
        connectSameNetwork(app, url: pairingURL)
        let ended = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "연결 종료")).firstMatch
        if !ended.waitForExistence(timeout: 30) {
            attachDiagnostics("consumed-url")
            XCTFail("The same-network page did not show 「연결 종료」 for the consumed URL.")
        }
        XCTAssertFalse(app.descendants(matching: .any)["workroomEnded"].exists, "The page must load and be refused by the Mac, not fail to load.")
        XCTAssertFalse(web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Fixture project A")).firstMatch.exists)
        capture("lan-consumed-url-refused")
        try host.expect("replayed", self)
        try host.expect("done", self)
        app.terminate()
        #else
        throw XCTSkip("The same-network journey runs only in check-ui.py's owned simulator with its sandboxed fixture host.")
        #endif
    }
}

#if targetEnvironment(simulator)
extension WorkspaceUITests {
    /// Onboarding → 「연결 주소」 → the same-network warning → 「같은 네트워크에서 연결」. Never the paste button.
    fileprivate func connectSameNetwork(_ app: XCUIApplication, url: String) {
        let field = app.textFields["connectionAddress"]
        // 「포털 주소 · 다른 연결 방법」 is a toggle that keeps its state when the app returns to onboarding: after a
        // disconnect it can already be open with the field scrolled out of the lazy list, so the first tap may close it.
        // Opening it scrolls to the field.
        for _ in 0..<2 {
            if field.exists && field.isHittable { break }
            app.buttons["showConnectionOptions"].firstMatch.tap()
            if field.waitForExistence(timeout: 4) && field.isHittable { break }
        }
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        // A URL kept from the first connection is longer than the field: a tap can leave the caret mid-text, so the
        // field is tapped at its right edge and cleared until it is empty.
        for _ in 0..<4 {
            guard let current = field.value as? String, !current.isEmpty, current != field.placeholderValue else { break }
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        let left = (field.value as? String) ?? ""
        XCTAssertTrue(left.isEmpty || left == field.placeholderValue, "The connection address field could not be cleared.")
        field.typeText(url)
        app.buttons["reviewConnectionAddress"].tap()
        let warning = app.alerts.firstMatch
        XCTAssertTrue(warning.waitForExistence(timeout: 10))
        XCTAssertTrue(warning.staticTexts["같은 네트워크용 QR입니다"].exists)
        warning.buttons["같은 네트워크에서 연결"].firstMatch.tap()
    }

    fileprivate func expectText(_ web: XCUIElement, _ text: String, contains: Bool = false, timeout: TimeInterval) {
        let predicate = contains ? NSPredicate(format: "label CONTAINS %@", text) : NSPredicate(format: "label == %@", text)
        let element = web.descendants(matching: .any).matching(predicate).firstMatch
        if !element.waitForExistence(timeout: timeout) {
            attachDiagnostics("missing-\(text.prefix(20))")
            XCTFail("The same-network page did not show 「\(text)」 within \(Int(timeout)) s.")
        }
    }

    /// 「실행 옵션」 → untick 「Bypass 권한」: the fixture session must run with the CLI's own permission settings.
    fileprivate func turnBypassOff(_ web: XCUIElement) {
        let off = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Bypass OFF")).firstMatch
        if off.exists { return }
        let summary = web.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "실행 옵션 · Bypass ON")).firstMatch
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        reveal(summary, in: web); summary.tap()
        let toggle = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Bypass 권한")).firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        reveal(toggle, in: web); toggle.tap()
        if !off.waitForExistence(timeout: 5) {
            attachDiagnostics("bypass-toggle")
            XCTFail("「Bypass 권한」 did not turn off.")
        }
    }

    fileprivate func dismissKeyboard(_ app: XCUIApplication, _ web: XCUIElement) {
        guard app.keyboards.firstMatch.exists else { return }
        for label in ["Done", "완료"] where app.buttons[label].exists && app.buttons[label].isHittable {
            app.buttons[label].tap(); return
        }
        let heading = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "워크룸")).element(boundBy: 0)
        if heading.exists && heading.isHittable { heading.tap() }
    }

    /// xterm paints only while on screen and its rows are hidden from accessibility, so the terminal is read from
    /// screenshots (Vision). The page is scrolled until 「세션 종료」 (above the terminal) and the command line
    /// (below it) are both on screen.
    fileprivate func expectTerminalText(_ app: XCUIApplication, _ web: XCUIElement, _ needle: String, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        var last = ""
        while Date() < deadline {
            revealTerminal(web)
            last = Self.normalizedOCR(XCUIScreen.main.screenshot())
            if last.contains(needle) { return }
            RunLoop.current.run(until: Date().addingTimeInterval(0.7))
        }
        attachDiagnostics("terminal-\(needle)")
        let text = XCTAttachment(string: last); text.name = "terminal-ocr-\(needle)"; text.lifetime = .keepAlways; add(text)
        XCTFail("The workroom terminal on the phone did not show \(needle) within \(Int(timeout)) s.")
    }

    /// The command line under the terminal. xterm.js keeps its own helper textarea (「Terminal input」) ahead of it in the
    /// tree; typing there goes to the CLI keystroke by keystroke without the composer's Enter, so it is never the target.
    fileprivate func composer(_ web: XCUIElement) -> XCUIElement {
        web.textViews.matching(NSPredicate(format: "placeholderValue CONTAINS %@", "Enter 전송")).firstMatch
    }

    /// Project cards sit below the OPS panel and the filters: they are in the tree but not on screen until scrolled.
    fileprivate func reveal(_ element: XCUIElement, in web: XCUIElement) {
        for _ in 0..<8 {
            if element.isHittable { return }
            let top = web.frame.minY + 8, bottom = web.frame.maxY - 8
            let step = web.frame.height * 0.4
            let delta = element.frame.maxY > bottom ? -min(element.frame.maxY - bottom + 48, step) : min(top - element.frame.minY + 48, step)
            let from = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: delta)))
        }
        if !element.isHittable {
            attachDiagnostics("unreachable-\(element.label.prefix(20))")
            XCTFail("「\(element.label)」 could not be scrolled on screen.")
        }
    }

    fileprivate func revealTerminal(_ web: XCUIElement) {
        let close = web.buttons["세션 종료"].firstMatch
        let line = composer(web)
        for _ in 0..<6 {
            guard close.exists, line.exists else { return }
            let top = web.frame.minY + 8, bottom = web.frame.maxY - 8
            let closeY = close.frame.minY, lineY = line.frame.maxY
            if closeY >= top && lineY <= bottom { return }
            let step = web.frame.height * 0.3
            // Content below the viewport moves up (drag up); content above moves down (drag down).
            let delta = lineY > bottom ? -min(lineY - bottom + 24, step) : min(top - closeY + 24, step)
            let from = web.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            from.press(forDuration: 0.05, thenDragTo: from.withOffset(CGVector(dx: 0, dy: delta)))
        }
    }

    /// Upper-case letters and digits only, with the confusions a 12 px monospace terminal invites for the two strings
    /// the journey looks for (1/I/| → L, 0 → O).
    static func normalizedOCR(_ screenshot: XCUIScreenshot) -> String {
        guard let image = screenshot.image.cgImage else { return "" }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n").uppercased()
        var normalized = ""
        for character in text {
            let mapped: Character
            switch character {
            case "1", "I", "|": mapped = "L"
            case "0": mapped = "O"
            default: mapped = character
            }
            if mapped.isASCII && (mapped.isLetter || mapped.isNumber) { normalized.append(mapped) }
        }
        return normalized
    }

    /// The tree and the screen at a failure. The pairing URL in the address field is redacted.
    fileprivate func attachDiagnostics(_ name: String) {
        capture("failure-\(name)")
        let tree = XCUIApplication().debugDescription.replacingOccurrences(of: #"#pair=[A-Za-z0-9_-]+"#, with: "#pair=<redacted>", options: .regularExpression)
        let attachment = XCTAttachment(string: tree); attachment.name = "tree-\(name)"; attachment.lifetime = .keepAlways; add(attachment)
    }
}

/// test20's side of the host's control folder. The host (lan-journey-host.ts serve) judges each phase against its
/// own state and answers; the test fails on any problem it reports.
private struct LANJourneyControl {
    let directory: URL
    private var sequence = 0

    init(directory: URL) { self.directory = directory }

    func pairingURL() throws -> String {
        let text = try String(contentsOf: directory.appendingPathComponent("pairing-url"), encoding: .utf8)
        let url = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard url.hasPrefix("http://"), url.contains("/remote/#pair=") else { throw LANJourneyError.badPairingFile }
        return url
    }

    @MainActor mutating func expect(_ phase: String, _ test: WorkspaceUITests, timeout: TimeInterval = 45) throws {
        sequence += 1
        let stem = (sequence < 10 ? "0" : "") + "\(sequence)-\(phase)"
        let control = directory.appendingPathComponent("control", isDirectory: true)
        try Data(#"{"phase":"\#(phase)"}"#.utf8).write(to: control.appendingPathComponent(stem + ".json"), options: .atomic)
        let ack = control.appendingPathComponent(stem + ".ack.json")
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let data = try? Data(contentsOf: ack),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let problems = (object["problems"] as? [String]) ?? []
                if object["ok"] as? Bool != true {
                    test.attachDiagnostics("host-\(phase)")
                    XCTFail("Host check for phase \(phase) failed: \(problems.joined(separator: "; "))")
                }
                return
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        test.attachDiagnostics("host-\(phase)-timeout")
        throw LANJourneyError.noAnswer(phase)
    }
}

private enum LANJourneyError: Error {
    case badPairingFile
    case noAnswer(String)
}
#endif
