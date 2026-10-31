import XCTest
import AppKit
import CoreGraphics
import ComputerUseApproval
import ComputerUseControlCore
@testable import ComputerUseEngine

final class ScopedOSGuardTests: XCTestCase {
    /// After a typed password the system's secure field may still hold Secure Event Input: approval waits a bounded
    /// time for it to clear instead of refusing at once, and gives up (so the live check refuses) when it does not.
    @MainActor func testSecureInputWaitEndsWhenReleasedAndStopsAtItsLimit() async {
        var held = 3, pauses: [Int] = []
        let released = await ScopedOSGuard.waitWhile({ held > 0 }, limitMs: 3_000) { pauses.append($0); held -= 1 }
        XCTAssertTrue(released); XCTAssertEqual(pauses, [100, 100, 100])
        pauses = []
        let stuck = await ScopedOSGuard.waitWhile({ true }, limitMs: 300) { pauses.append($0) }
        XCTAssertFalse(stuck); XCTAssertEqual(pauses.count, 3)
        let free = await ScopedOSGuard.waitWhile({ false }, limitMs: 3_000) { _ in XCTFail("no pause when nothing is held") }
        XCTAssertTrue(free)
    }
    func testHumanActivityDiagnosticsPreserveIdleBoundaryAndRejectUnknownAges() throws {
        for idle in [-1.0, 0, 1.499999, Double.nan, Double.infinity, -Double.infinity] {
            XCTAssertThrowsError(try ScopedOSGuard.requireIdleInputAge(idle)) { error in
                XCTAssertEqual(error as? ControlError, .refuse("human-active-idle"))
            }
        }
        XCTAssertNoThrow(try ScopedOSGuard.requireIdleInputAge(1.5))
        XCTAssertNoThrow(try ScopedOSGuard.requireIdleInputAge(60))
    }
    func testCounterDiagnosticStillRefusesEveryChangedPhysicalVector() throws {
        let before = "10,11,12,13"
        XCTAssertNoThrow(try ScopedOSGuard.requireSamePhysicalCounters(before, observed: before))
        for after in ["11,11,12,13", "10,12,12,13", "10,11,13,13", "10,11,12,14"] {
            XCTAssertThrowsError(try ScopedOSGuard.requireSamePhysicalCounters(after, observed: before)) { error in
                XCTAssertEqual(error as? ControlError, .refuse("human-active-events"))
            }
        }
    }
    func testGuardSampleCountersNameTheGuardsOwnVectorInOrder() {
        let named: [String: CGEventType] = ["keyDown": .keyDown, "keyUp": .keyUp, "flagsChanged": .flagsChanged,
            "mouseMoved": .mouseMoved, "leftMouseDown": .leftMouseDown, "leftMouseUp": .leftMouseUp,
            "rightMouseDown": .rightMouseDown, "rightMouseUp": .rightMouseUp, "otherMouseDown": .otherMouseDown,
            "otherMouseUp": .otherMouseUp, "leftMouseDragged": .leftMouseDragged, "rightMouseDragged": .rightMouseDragged,
            "otherMouseDragged": .otherMouseDragged, "scrollWheel": .scrollWheel]
        XCTAssertEqual(ScopedGuardSample.counterNames.compactMap { named[$0] }, ScopedOSGuard.physicalEventTypes)
        XCTAssertEqual(Set(ScopedGuardSample.counterNames).count, ScopedOSGuard.physicalEventTypes.count)
    }
    func testObservedCounterVectorIsReadOnlyFromTheExactEvidenceShape() {
        let values = (1...14).map(String.init)
        XCTAssertEqual(ScopedOSGuard.physicalCounters(evidence: values.joined(separator: ",")), (1...14).map(UInt32.init))
        let joined = values.joined(separator: ","), rest = values.dropFirst().joined(separator: ",")
        let malformed: [String] = [values.dropLast().joined(separator: ","), joined + ",15", joined + ",", "1,,2",
                                   "-1," + rest, "x," + rest, "", "435:123:" + joined]
        for evidence in malformed {
            XCTAssertNil(ScopedOSGuard.physicalCounters(evidence: evidence), evidence)
        }
    }
    func testUnlockRequiresExplicitFalseAndExactCurrentLoggedInConsoleUser() {
        func check(_ locked: Any?, _ console: Any?, _ loggedIn: Any?, _ uid: Any?) -> Bool {
            ScopedOSGuard.unlocked(rootLocked: locked, onConsole: console, loginDone: loggedIn, sessionUID: uid, currentUID: 501)
        }
        XCTAssertTrue(check(false, true, true, NSNumber(value: 501)))
        XCTAssertFalse(check(nil, true, true, NSNumber(value: 501)), "missing lock evidence is unknown")
        XCTAssertFalse(check(NSNumber(value: 0), true, true, NSNumber(value: 501)), "integer zero is not explicit CFBoolean false")
        XCTAssertFalse(check(true, true, true, NSNumber(value: 501)))
        XCTAssertFalse(check(false, nil, true, NSNumber(value: 501)))
        XCTAssertFalse(check(false, true, false, NSNumber(value: 501)))
        XCTAssertFalse(check(false, true, true, NSNumber(value: 502)))
        XCTAssertFalse(check(false, true, true, NSNumber(value: 501.0)))
        XCTAssertFalse(check(false, true, true, NSNumber(value: true)))
    }
    func testSecureAndAmbiguousFocusAreNotSafe() {
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXSecureTextField", subrole: nil))
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertTrue(ScopedOSGuard.safeFocus(role: "AXTextField", subrole: nil))
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXTextArea", subrole: "AXUnknown"))
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXWebArea", subrole: nil))
        XCTAssertTrue(ScopedOSGuard.safeFocus(role: "AXWebArea", subrole: nil, forText: false))
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXWindow", subrole: nil))
        XCTAssertTrue(ScopedOSGuard.safeFocus(role: "AXTextField", subrole: "AXSearchField"))
        XCTAssertFalse(ScopedOSGuard.safeFocus(role: "AXButton", subrole: nil))
        XCTAssertTrue(ScopedOSGuard.safeFocus(role: "AXButton", subrole: nil, forText: false))
        XCTAssertTrue(ScopedOSGuard.safeFocus(role: "AXWindow", subrole: nil, forText: false))
    }
    @MainActor func testPointTargetAtNegativeCoordinatesRejectsProtectedOrUnknownOverlay() throws {
        let editor = ScopeApplicationIdentity(bundleId: "com.example.editor", teamId: "ABCDEFGHIJ",
            codeHash: String(repeating: "a", count: 40), pid: 10, processStart: "1000")
        let protected = ScopeApplicationIdentity(bundleId: "com.apple.SecurityAgent", teamId: "ABCDEFGHIJ",
            codeHash: String(repeating: "b", count: 40), pid: 20, processStart: "2000")
        let display = ScopedOSDisplay(nativeID: 1, frame: CGRect(x: -100, y: -100, width: 100, height: 100), scale: 2, rotation: 0)
        let below = ScopedOSWindow(id: 1, pid: 10, frame: CGRect(x: -100, y: -100, width: 80, height: 80), alpha: 1)
        let overlay = ScopedOSWindow(id: 2, pid: 20, frame: CGRect(x: -90, y: -90, width: 20, height: 20), alpha: 1)
        func resolve(_ pid: Int32) throws -> ScopeApplicationIdentity {
            if pid == 10 { return editor }; if pid == 20 { return protected }
            throw ControlError.refuse("scope-app-unverifiable")
        }
        func target(_ x: Double, _ y: Double, hit: Int32, _ windows: [ScopedOSWindow]) throws -> ScopeApplicationIdentity {
            try ScopedOSGuard.pointTarget(at: CGPoint(x: x, y: y), hitPID: hit, windows: windows, displays: [display],
                                          systemOverlay: { _, _ in false }, resolve: resolve)
        }
        XCTAssertEqual(try target(-50, -50, hit: 10, [overlay, below]), editor)
        XCTAssertThrowsError(try target(-80, -80, hit: 20, [overlay, below]), "a protected window under the point")
        XCTAssertThrowsError(try target(-80, -80, hit: 10, [overlay, below]), "the hit-test and the window in front disagree")
        XCTAssertThrowsError(try target(0, 0, hit: 10, [overlay, below]), "no window under the point")
        XCTAssertThrowsError(try target(-50, -50, hit: 0, [overlay, below]), "no hit-test result")
        let unknown = ScopedOSWindow(id: 3, pid: 30, frame: below.frame, alpha: 1)
        XCTAssertThrowsError(try target(-50, -50, hit: 30, [unknown, below]), "an unverifiable owner")
        XCTAssertThrowsError(try target(-50, -50, hit: 10, [unknown, below]), "an unknown window in front of the hit-test target")
    }

    /// The window list read on a 3440x1440 Mac (2026-10-28), front to back: WindowServer decorations, Control Center
    /// items, the Dock's display-sized layer-20 sheet, AgentsToZ's always-on-top layer-5 「아젠투지 호출」 panel, a
    /// layer-3 ChatGPT window, then ordinary apps, including System Settings and the AgentsToZ main window. Before the
    /// accessibility cross-check, the first window under every point was the Dock: app scope refused everything and
    /// whole Mac checked the Dock instead of the window the click would reach.
    private struct RealShapedDesktop {
        let display = ScopedOSDisplay(nativeID: 1, frame: CGRect(x: 0, y: 0, width: 3440, height: 1440), scale: 1, rotation: 0)
        static func app(_ bundle: String, _ pid: Int32) -> ScopeApplicationIdentity {
            ScopeApplicationIdentity(bundleId: bundle, teamId: "", codeHash: String(repeating: "c", count: 40), pid: pid, processStart: "\(pid)00")
        }
        let identities: [Int32: ScopeApplicationIdentity] = [
            10: app("com.example.editor", 10), 20: app("com.intenet.agentstozbycs", 20), 30: app("com.stablyai.orca", 30),
            40: app("com.apple.systempreferences", 40), 50: app("com.apple.dock", 50), 60: app("com.openai.codex", 60),
            77: app("com.apple.WindowServer", 77), 88: app("com.apple.controlcenter", 88),
            91: app("com.apple.UserNotificationCenter", 91), 92: app("com.apple.coreservices.uiagent", 92),
            93: app("com.apple.LocalAuthentication.UIAgent", 93)]
        let decorations = [
            ScopedOSWindow(id: 1, pid: 77, frame: CGRect(x: 3257, y: 1, width: 28, height: 28), alpha: 1,
                           layer: Int(CGWindowLevelForKey(.cursorWindow)), title: "StatusIndicator"),
            ScopedOSWindow(id: 2, pid: 88, frame: CGRect(x: 3280, y: 0, width: 160, height: 30), alpha: 1, layer: 25, title: "Clock"),
            ScopedOSWindow(id: 3, pid: 77, frame: CGRect(x: 0, y: 0, width: 3440, height: 30), alpha: 1,
                           layer: Int(CGWindowLevelForKey(.mainMenuWindow)), title: "Menubar")]
        let dock = ScopedOSWindow(id: 4, pid: 50, frame: CGRect(x: 0, y: 0, width: 3440, height: 1440), alpha: 1,
                                  layer: Int(CGWindowLevelForKey(.dockWindow)), title: "Dock")
        let voicePanel = ScopedOSWindow(id: 5, pid: 20, frame: CGRect(x: 3022, y: 799, width: 420, height: 919), alpha: 1, layer: 5, title: "아젠투지 호출")
        let apps = [
            ScopedOSWindow(id: 6, pid: 60, frame: CGRect(x: 2556, y: -81, width: 1138, height: 2789), alpha: 1, layer: 3, title: "ChatGPT"),
            ScopedOSWindow(id: 7, pid: 30, frame: CGRect(x: 2231, y: 213, width: 1115, height: 903), alpha: 1, title: "Orca"),
            ScopedOSWindow(id: 8, pid: 40, frame: CGRect(x: 1739, y: 789, width: 723, height: 651), alpha: 1, title: "Accessibility"),
            ScopedOSWindow(id: 9, pid: 20, frame: CGRect(x: 453, y: 295, width: 1000, height: 1050), alpha: 1, title: "AgentsToZ_byCS"),
            ScopedOSWindow(id: 10, pid: 10, frame: CGRect(x: 38, y: 454, width: 1280, height: 900), alpha: 1, title: "Editor")]
        func windows(voicePanel shown: Bool = true) -> [ScopedOSWindow] { decorations + [dock] + (shown ? [voicePanel] : []) + apps }
        func resolve(_ pid: Int32) throws -> ScopeApplicationIdentity {
            guard let identity = identities[pid] else { throw ControlError.refuse("scope-app-unverifiable") }; return identity
        }
        /// The production predicate also requires an Apple-signed com.apple.dock owner; here only pid 50 is verified.
        func target(_ x: Double, _ y: Double, hit: Int32, windows: [ScopedOSWindow]? = nil, dockVerified: Bool = true) throws -> ScopeApplicationIdentity {
            try ScopedOSGuard.pointTarget(at: CGPoint(x: x, y: y), hitPID: hit, windows: windows ?? self.windows(), displays: [display],
                systemOverlay: { window, displays in dockVerified && window.pid == 50 && ScopedOSGuard.dockSheet(window, displays: displays) },
                resolve: resolve)
        }
        func refusal(_ body: () throws -> ScopeApplicationIdentity) -> String? {
            do { _ = try body(); return nil } catch let error as ControlError { return error.code } catch { return "\(error)" }
        }
    }

    @MainActor func testRealShapedDesktopResolvesTheWindowBeneathTheDockSheetInBothScopes() throws {
        let desk = RealShapedDesktop()
        let orca = desk.identities[30]!, editor = desk.identities[10]!
        // App scope (Orca approved): a click on Orca, left of ChatGPT's floating window, reaches Orca through the Dock
        // sheet; nothing else is admitted.
        let onOrca = try desk.target(2500, 400, hit: 30)
        XCTAssertEqual(onOrca, orca)
        XCTAssertTrue(ScopedNativeSession.allows(onOrca, in: .application(orca)))
        XCTAssertTrue(ScopedNativeSession.allows(onOrca, in: .desktop))
        XCTAssertEqual(try desk.target(200, 800, hit: 10), editor)
        XCTAssertFalse(ScopedNativeSession.allows(try desk.target(200, 800, hit: 10), in: .application(orca)), "another app in app scope")
        XCTAssertTrue(ScopedNativeSession.allows(try desk.target(200, 800, hit: 10), in: .desktop))
        // Whole Mac: a background protected window under the point is the real target and is refused, not the Dock.
        XCTAssertEqual(desk.refusal { try desk.target(1800, 1200, hit: 40) }, "protected-target", "System Settings under the Dock sheet")
        XCTAssertEqual(desk.refusal { try desk.target(600, 700, hit: 20) }, "protected-target", "the AgentsToZ main window")
        // The always-on-top 「아젠투지 호출」 panel in front of Orca is what a click there reaches.
        XCTAssertEqual(desk.refusal { try desk.target(3100, 900, hit: 20) }, "protected-target")
        XCTAssertEqual(desk.refusal { try desk.target(3100, 900, hit: 30) }, "target-unavailable", "the panel covers Orca there")
        XCTAssertEqual(try desk.target(3100, 900, hit: 60, windows: desk.windows(voicePanel: false)), desk.identities[60]!)
    }

    @MainActor func testRealShapedDesktopFailsClosedOnDisagreementOrAmbiguity() throws {
        let desk = RealShapedDesktop()
        XCTAssertEqual(desk.refusal { try desk.target(1800, 1200, hit: 30) }, "target-unavailable", "hit-test names a covered app")
        XCTAssertEqual(desk.refusal { try desk.target(1800, 1200, hit: 0) }, "target-unavailable", "no hit-test result")
        // The hit-test names the Dock while an app lies beneath: a tile cannot be told from a pass-through.
        XCTAssertEqual(desk.refusal { try desk.target(700, 1300, hit: 50) }, "target-unavailable")
        // Nothing but the Dock sheet at the point: the Dock itself, which only whole Mac admits.
        let dock = try desk.target(100, 100, hit: 50)
        XCTAssertEqual(dock, desk.identities[50]!)
        XCTAssertTrue(ScopedNativeSession.allows(dock, in: .desktop))
        XCTAssertFalse(ScopedNativeSession.allows(dock, in: .application(desk.identities[30]!)))
        XCTAssertEqual(desk.refusal { try desk.target(100, 100, hit: 10) }, "target-unavailable", "no window of the named app there")
        // ChatGPT's layer-3 window (alpha 1) covers the right quarter of the display, yet the hit-test passes through it
        // to Orca (measured 2026-10-29 at (2580,432)). The pixels there are ChatGPT's, not the receiver's, so a click
        // under it is refused rather than looked through; it is resolved only when ChatGPT itself takes the click.
        XCTAssertEqual(desk.refusal { try desk.target(2600, 400, hit: 30) }, "target-unavailable", "Orca beneath ChatGPT's floating window")
        XCTAssertEqual(try desk.target(2600, 400, hit: 60), desk.identities[60]!)
        // An unverified sheet of the same shape is never looked through.
        XCTAssertEqual(desk.refusal { try desk.target(2500, 400, hit: 30, dockVerified: false) }, "target-unavailable")
        // The menu bar belongs to the compositor; a click there is never resolved to the app named by the hit-test.
        XCTAssertEqual(desk.refusal { try desk.target(500, 10, hit: 30) }, "target-unavailable")
        XCTAssertEqual(desk.refusal { try desk.target(500, 10, hit: 77) }, "protected-target")
        // An unknown owner in front of the target refuses.
        let stranger = ScopedOSWindow(id: 11, pid: 99, frame: CGRect(x: 2400, y: 300, width: 300, height: 300), alpha: 1)
        var windows = desk.windows(); windows.insert(stranger, at: 4)
        XCTAssertEqual(desk.refusal { try desk.target(2500, 400, hit: 30, windows: windows) }, "target-unavailable")
        XCTAssertEqual(desk.refusal { try desk.target(2500, 400, hit: 99, windows: windows) }, "scope-app-unverifiable")
    }

    func testOnlyAnExactDisplaySizedDockLevelSheetQualifiesForLookingThrough() {
        let desk = RealShapedDesktop()
        XCTAssertTrue(ScopedOSGuard.dockSheet(desk.dock, displays: [desk.display]))
        func sheet(_ frame: CGRect, layer: Int = Int(CGWindowLevelForKey(.dockWindow)), title: String? = "Dock") -> ScopedOSWindow {
            ScopedOSWindow(id: 4, pid: 50, frame: frame, alpha: 1, layer: layer, title: title)
        }
        XCTAssertFalse(ScopedOSGuard.dockSheet(sheet(desk.dock.frame, title: nil), displays: [desk.display]), "a window name is required")
        XCTAssertFalse(ScopedOSGuard.dockSheet(sheet(desk.dock.frame, title: "Other"), displays: [desk.display]))
        XCTAssertFalse(ScopedOSGuard.dockSheet(sheet(desk.dock.frame, layer: 0), displays: [desk.display]))
        XCTAssertFalse(ScopedOSGuard.dockSheet(sheet(desk.dock.frame, layer: 25), displays: [desk.display]))
        XCTAssertFalse(ScopedOSGuard.dockSheet(sheet(CGRect(x: 0, y: 1340, width: 3440, height: 100)), displays: [desk.display]),
                       "a tile-sized Dock window is a real target, not a pass-through sheet")
        XCTAssertFalse(ScopedOSGuard.dockSheet(desk.dock, displays: []))
        let second = ScopedOSDisplay(nativeID: 2, frame: CGRect(x: -1920, y: 0, width: 1920, height: 1080), scale: 2, rotation: 0)
        XCTAssertTrue(ScopedOSGuard.dockSheet(sheet(second.frame), displays: [desk.display, second]))
    }

    @MainActor func testRealShapedOverlaysAndSecurityPromptsAbortCaptureAndInput() throws {
        let desk = RealShapedDesktop()
        let extra: [Int32: ScopeApplicationIdentity] = [
            94: RealShapedDesktop.app("com.intenet.agentstozbycs.control", 94), 95: RealShapedDesktop.app("com.apple.loginwindow", 95)]
        let compositor: (ScopedOSWindow, [ScopedOSDisplay]) -> Bool = { $0.pid == 77 && ScopedOSGuard.compositorDecoration($0, displays: $1) }
        func overlays(_ windows: [ScopedOSWindow]) -> String? {
            do { _ = try ScopedOSGuard.noProtectedOverlays(windows: windows, displays: [desk.display], resolve: { try extra[$0] ?? desk.resolve($0) },
                                                           compositor: compositor); return nil }
            catch let error as ControlError { return error.code } catch { return "\(error)" }
        }
        // The capture filter excludes the 「아젠투지 호출」 window and a point on it is refused (the target tests above), so
        // it no longer refuses everything: the person can keep talking to AgentsToZ while AI works in another app.
        XCTAssertNil(overlays(desk.windows()), "AgentsToZ's own always-on-top window is not an overlay")
        XCTAssertNil(overlays(desk.windows(voicePanel: false)), "Dock, Control Center and the compositor menu bar are not overlays")
        func floating(_ pid: Int32, layer: Int) -> [ScopedOSWindow] {
            desk.windows(voicePanel: false) + [ScopedOSWindow(id: 120, pid: pid, frame: CGRect(x: 1400, y: 500, width: 420, height: 200), alpha: 1, layer: layer)]
        }
        XCTAssertNil(overlays(floating(20, layer: Int(CGWindowLevelForKey(.floatingWindow)))), "the real floating level, should tao correct its level")
        for layer in [Int(CGWindowLevelForKey(.modalPanelWindow)), Int(CGWindowLevelForKey(.popUpMenuWindow))] {
            XCTAssertEqual(overlays(floating(20, layer: layer)), "protected-overlay", "AgentsToZ above layer 0 but not always-on-top: \(layer)")
        }
        for (pid, owner) in [(94, "Control"), (40, "System Settings"), (77, "a compositor window that is no known decoration")] {
            XCTAssertEqual(overlays(floating(Int32(pid), layer: 5)), "protected-overlay", "\(owner) at the always-on-top level")
        }
        // 「Force Quit Applications」 (loginwindow, layer 8) was on screen on this Mac on 2026-10-30.
        for (pid, title) in [(91, "UserNotificationCenter"), (92, "Gatekeeper"), (93, "Touch ID"), (95, "Force Quit Applications")] {
            let prompt = ScopedOSWindow(id: UInt32(100 + pid), pid: Int32(pid), frame: CGRect(x: 1400, y: 500, width: 500, height: 300), alpha: 1, title: title)
            XCTAssertEqual(overlays(desk.windows() + [prompt]), "protected-overlay", "\(title) blocks even at layer 0 behind other windows")
        }
    }
    /// Control's control bar is up during every action (2026-10-31): only the window numbers Control registered for it,
    /// owned by this very process, at the status-bar level it uses, pass. Any other Control window still blocks.
    @MainActor func testOnlyControlsOwnRegisteredBarPassesTheOverlayGuard() throws {
        let desk = RealShapedDesktop(), own = ProcessInfo.processInfo.processIdentifier
        let control = RealShapedDesktop.app("com.intenet.agentstozbycs.control", own)
        let compositor: (ScopedOSWindow, [ScopedOSDisplay]) -> Bool = { $0.pid == 77 && ScopedOSGuard.compositorDecoration($0, displays: $1) }
        func overlays(_ window: ScopedOSWindow, registered: Set<UInt32>, owner: ScopeApplicationIdentity? = nil) -> String? {
            let identity = owner ?? control
            do { _ = try ScopedOSGuard.noProtectedOverlays(windows: desk.windows(voicePanel: false) + [window], displays: [desk.display],
                                                           resolve: { $0 == window.pid ? identity : try desk.resolve($0) },
                                                           compositor: compositor, ownStatus: registered); return nil }
            catch let error as ControlError { return error.code } catch { return "\(error)" }
        }
        let status = Int(CGWindowLevelForKey(.statusWindow)), floating = Int(CGWindowLevelForKey(.floatingWindow))
        XCTAssertEqual(status, Int(NSWindow.Level.statusBar.rawValue), "ControlBar.swift sets NSWindow.Level.statusBar")
        let bar = ScopedOSWindow(id: 4321, pid: own, frame: CGRect(x: 600, y: 900, width: 520, height: 44), alpha: 1, layer: status)
        XCTAssertNil(overlays(bar, registered: [4321]), "the registered bar is not an overlay")
        XCTAssertEqual(overlays(bar, registered: []), "protected-overlay", "an unregistered Control window blocks")
        XCTAssertEqual(overlays(bar, registered: [9999]), "protected-overlay", "another registered number does not cover it")
        let other = ScopedOSWindow(id: 4321, pid: 94, frame: bar.frame, alpha: 1, layer: status)
        XCTAssertEqual(overlays(other, registered: [4321], owner: RealShapedDesktop.app("com.intenet.agentstozbycs.control", 94)), "protected-overlay",
                       "the same number owned by another process blocks")
        let modal = ScopedOSWindow(id: 4321, pid: own, frame: bar.frame, alpha: 1, layer: Int(CGWindowLevelForKey(.modalPanelWindow)))
        XCTAssertEqual(overlays(modal, registered: [4321]), "protected-overlay", "the bar's number at another level blocks")
        let low = ScopedOSWindow(id: 4321, pid: own, frame: bar.frame, alpha: 1, layer: floating)
        XCTAssertNil(overlays(low, registered: [4321]), "the bar at the floating level (as 1637 shipped it) is still the bar")
        let menu = ScopedOSWindow(id: 4321, pid: own, frame: bar.frame, alpha: 1, layer: Int(CGWindowLevelForKey(.popUpMenuWindow)))
        XCTAssertEqual(overlays(menu, registered: [4321]), "protected-overlay", "the bar's number above the status level blocks")
    }

    @MainActor func testProtectedOrUnverifiableVisibleWindowsAbortCapture() throws {
        let display = ScopedOSDisplay(nativeID: 1, frame: CGRect(x: -100, y: -100, width: 100, height: 100), scale: 2, rotation: 0)
        let editor = ScopeApplicationIdentity(bundleId: "com.example.editor", teamId: "ABCDEFGHIJ",
            codeHash: String(repeating: "a", count: 40), pid: 10, processStart: "1000")
        let protected = ScopeApplicationIdentity(bundleId: "com.intenet.agentstozbycs.control", teamId: "ABCDEFGHIJ",
            codeHash: String(repeating: "b", count: 40), pid: 20, processStart: "2000")
        let safeWindow = ScopedOSWindow(id: 1, pid: 10, frame: display.frame, alpha: 1)
        let protectedWindow = ScopedOSWindow(id: 2, pid: 20, frame: CGRect(x: -10, y: -10, width: 5, height: 5), alpha: 1)
        func resolve(_ pid: Int32) throws -> ScopeApplicationIdentity {
            if pid == 10 { return editor }; if pid == 20 { return protected }
            throw ControlError.refuse("scope-app-unverifiable")
        }
        XCTAssertEqual(try ScopedOSGuard.noProtectedOverlays(windows: [safeWindow], displays: [display], resolve: resolve)[10], editor)
        XCTAssertNoThrow(try ScopedOSGuard.noProtectedOverlays(windows: [safeWindow, protectedWindow], displays: [display], resolve: resolve),
                         "an ordinary Control window behind another app is excluded by the capture filter")
        let protectedOverlay = ScopedOSWindow(id: 5, pid: 20, frame: protectedWindow.frame, alpha: 1, layer: 2)
        XCTAssertThrowsError(try ScopedOSGuard.noProtectedOverlays(windows: [safeWindow, protectedOverlay], displays: [display], resolve: resolve))
        let unknown = ScopedOSWindow(id: 3, pid: 30, frame: display.frame, alpha: 1)
        XCTAssertThrowsError(try ScopedOSGuard.noProtectedOverlays(windows: [unknown], displays: [display], resolve: resolve))
        let offDisplay = ScopedOSWindow(id: 4, pid: 20, frame: CGRect(x: 100, y: 100, width: 20, height: 20), alpha: 1)
        XCTAssertNoThrow(try ScopedOSGuard.noProtectedOverlays(windows: [offDisplay], displays: [display], resolve: resolve))
    }
    func testOnlyExactBoundedCompositorDecorationsQualifyForVerification() {
        let display = ScopedOSDisplay(nativeID: 1, frame: CGRect(x: 0, y: 0, width: 1000, height: 800), scale: 2, rotation: 0)
        let menu = ScopedOSWindow(id: 1, pid: 77, frame: CGRect(x: 0, y: 0, width: 1000, height: 30), alpha: 1,
                                  layer: Int(CGWindowLevelForKey(.mainMenuWindow)), title: "Menubar")
        let indicator = ScopedOSWindow(id: 2, pid: 77, frame: CGRect(x: 900, y: 1, width: 28, height: 28), alpha: 1,
                                       layer: Int(CGWindowLevelForKey(.cursorWindow)), title: "StatusIndicator")
        XCTAssertTrue(ScopedOSGuard.compositorDecoration(menu, displays: [display]))
        XCTAssertTrue(ScopedOSGuard.compositorDecoration(indicator, displays: [display]))
        XCTAssertFalse(ScopedOSGuard.compositorDecoration(ScopedOSWindow(id: 3, pid: 77, frame: menu.frame, alpha: 1, layer: menu.layer, title: "Other"), displays: [display]))
        XCTAssertFalse(ScopedOSGuard.compositorDecoration(ScopedOSWindow(id: 3, pid: 77, frame: CGRect(x: 0, y: 0, width: 800, height: 800), alpha: 1, layer: menu.layer, title: "Menubar"), displays: [display]))
        // The pointer drawn as a compositor window, anywhere on a display (2026-10-31: 「Cursor」, 28×40, cursor level).
        let cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
        let pointer = ScopedOSWindow(id: 4, pid: 77, frame: CGRect(x: 416, y: 698, width: 28, height: 40), alpha: 1, layer: cursorLayer, title: "Cursor")
        XCTAssertTrue(ScopedOSGuard.compositorDecoration(pointer, displays: [display]))
        XCTAssertFalse(ScopedOSGuard.compositorDecoration(pointer, displays: []), "only on a display")
        XCTAssertFalse(ScopedOSGuard.pointerWindow(ScopedOSWindow(id: 5, pid: 77, frame: CGRect(x: 0, y: 0, width: 300, height: 300), alpha: 1, layer: cursorLayer, title: "Cursor")), "not pointer-sized")
        XCTAssertFalse(ScopedOSGuard.pointerWindow(ScopedOSWindow(id: 5, pid: 77, frame: pointer.frame, alpha: 1, layer: 0, title: "Cursor")), "not at the cursor level")
        XCTAssertFalse(ScopedOSGuard.pointerWindow(ScopedOSWindow(id: 5, pid: 77, frame: pointer.frame, alpha: 1, layer: cursorLayer, title: nil)), "a window name is required")
    }

    @MainActor func testThePointerWindowNeitherBlocksNorBecomesTheTarget() throws {
        let desk = RealShapedDesktop(), cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
        let pointer = ScopedOSWindow(id: 11, pid: 77, frame: CGRect(x: 197, y: 797, width: 28, height: 40), alpha: 1, layer: cursorLayer, title: "Cursor")
        let windows = [pointer] + desk.windows()
        // Measured: the compositor's 「Cursor」 window refused every capture and action until it was exempted.
        let menuAndIndicatorOnly: (ScopedOSWindow, [ScopedOSDisplay]) -> Bool = {
            $0.pid == 77 && ["Menubar", "StatusIndicator"].contains($0.title) && ScopedOSGuard.compositorDecoration($0, displays: $1)
        }
        XCTAssertThrowsError(try ScopedOSGuard.noProtectedOverlays(windows: windows, displays: [desk.display], resolve: desk.resolve,
                                                                   compositor: menuAndIndicatorOnly)) {
            XCTAssertEqual(($0 as? ControlError)?.code, "protected-overlay")
        }
        XCTAssertNoThrow(try ScopedOSGuard.noProtectedOverlays(windows: windows, displays: [desk.display], resolve: desk.resolve,
            compositor: { $0.pid == 77 && ScopedOSGuard.compositorDecoration($0, displays: $1) }))
        // A click under the pointer reaches the editor beneath it; only the verified compositor's pointer passes through.
        func target(_ hit: Int32, through: (ScopedOSWindow) -> Bool) throws -> ScopeApplicationIdentity {
            try ScopedOSGuard.pointTarget(at: CGPoint(x: 200, y: 800), hitPID: hit, windows: windows, displays: [desk.display],
                systemOverlay: { window, displays in through(window) || window.pid == 50 && ScopedOSGuard.dockSheet(window, displays: displays) },
                resolve: desk.resolve)
        }
        XCTAssertEqual(try target(10) { $0.pid == 77 && ScopedOSGuard.pointerWindow($0) }, desk.identities[10]!)
        XCTAssertEqual(desk.refusal { try target(10) { _ in false } }, "target-unavailable", "unexempted, the pointer hid the editor")
        XCTAssertEqual(desk.refusal { try target(30) { $0.pid == 77 && ScopedOSGuard.pointerWindow($0) } }, "target-unavailable",
                       "the hit-test must still name the window beneath")
    }
}
