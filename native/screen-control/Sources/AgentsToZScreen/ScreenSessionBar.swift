#if os(macOS)
import AppKit
import os
import ScreenControlCore
import ScreenHost
import Security

/// The floating session bar (docs/design/mac-to-mac-2026-11-01/DESIGN.md 「부록 A」): while a device or another Mac
/// watches or controls this Mac, a bar like the Control bar says who, whether it only watches or controls, for how
/// long and until when, when this Mac's own input has paused remote input, and the end-session key; and gives the
/// person 「끊기」, 「보기만」, 「직접 하기」 and 「다시 넘기기」. It shows for any session and finds the device's kind in the
/// session's peer class and registered model. Phone and Mac sessions both take their hold from the service's
/// `ScreenMacHold` (DESIGN 부록 A).
///
/// A borderless panel that never becomes key or main: no key reaches it and AgentsToZ Screen never comes to the front
/// from it. It stays in the picture the other side sees (no `sharingType` change, and capture leaves out only the
/// viewer app), so the person there can press 「끊기」 or 「보기만」 on it too. Its look is ScreenSessionBarView; its words
/// and buttons are ScreenSessionBarText; this type owns the panel, the clock and the actions.
@MainActor
final class ScreenSessionBar: NSObject, NSWindowDelegate {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }

    static let shared = ScreenSessionBar(service: ScreenShared.service)
    static let size = ScreenSessionBarView.size
    private static let originKey = "ScreenSessionBarOrigin"
    private static let log = Logger(subsystem: "com.intenet.agentstozbycs.screen", category: "session-bar")

    private let service: ScreenService
    private var panel: Panel?
    private let view = ScreenSessionBarView(frame: NSRect(origin: .zero, size: ScreenSessionBarView.size))
    private var notice: (notice: ScreenSessionBarNotice, until: Date)?
    private var tick: Timer?
    /// Set while the bar moves itself, so only the person's drag is remembered.
    private var placing = false

    init(service: ScreenService) { self.service = service }

    /// Once, when the app starts: from then on the bar follows the session by itself.
    func start() { follow() }

    /// Shows and ticks while a session exists, hides otherwise; called again whenever the session changes.
    private func follow() {
        let connected = withObservationTracking { service.session != nil } onChange: {
            Task { @MainActor [weak self] in self?.follow() }
        }
        if connected, tick == nil {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.update() } }
            // Common modes: it keeps ticking while the menu bar menu is open.
            RunLoop.main.add(timer, forMode: .common)
            tick = timer
        } else if !connected {
            tick?.invalidate()
            tick = nil
            notice = nil
        }
        update()
    }

    /// Once a second while a session exists, and right after each press.
    func update() {
        guard let session = service.session else { return hide() }
        let panel = self.panel ?? make()
        let hold = service.sessionInput
        let access = ScreenSessionAccess.of(canControl: session.canControl, hold: hold?.mode, availability: hold?.availability)
        let state = ScreenSessionBarState(
            kind: session.peerClass == .controller ? .mac : ScreenDeviceKind(model: session.deviceModel), name: session.deviceName, access: access,
            elapsed: Date().timeIntervalSince(session.since),
            limit: service.sessionDeadline.map { ScreenSessionLimit(deadline: $0, now: .now) }, hotKey: EndSessionHotKey.label)
        if let current = notice, current.until <= Date() { notice = nil }
        view.show(ScreenSessionBarText.present(state, notice: notice?.notice))
        // `isFloatingPanel` resets the level, and other apps' panels at the same level ordered later cover it: both are
        // put right every tick, as the Control bar does (docs/claude/computer-use.md 「제어 막대」).
        if panel.level != .statusBar { panel.level = .statusBar }
        if !panel.isVisible { appear(panel) }
        panel.orderFrontRegardless()
    }

    private func hide() {
        panel?.orderOut(nil)
    }

    private func make() -> Panel {
        let panel = Panel(contentRect: NSRect(origin: .zero, size: Self.size),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // The level comes after `isFloatingPanel`, which sets it back to floating.
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.delegate = self
        for pill in view.pills.values {
            pill.target = self
            pill.action = #selector(pressed(_:))
            pill.refusedAccessibilityPress = { [weak self] in self?.refuse(.notABarClick, how: "accessibility press") }
        }
        panel.contentView = view
        panel.setAccessibilityLabel("AgentsToZ Screen 세션 막대")
        self.panel = panel
        return panel
    }

    /// Where the person last left it if that is still on a screen, else bottom centre above the Dock, fading in.
    private func appear(_ panel: NSPanel) {
        let saved = UserDefaults.standard.string(forKey: Self.originKey).map(NSPointFromString)
        guard let origin = ScreenSessionBarPlacement.origin(saved: saved, size: Self.size,
                                                            visibleFrames: NSScreen.screens.map(\.visibleFrame)) else { return }
        placing = true
        panel.setFrameOrigin(origin)
        placing = false
        panel.alphaValue = 0
        panel.orderFrontRegardless()
        panel.invalidateShadow()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
            panel.animator().alphaValue = 1
        } completionHandler: { [weak panel] in
            MainActor.assumeIsolated { panel?.invalidateShadow() }
        }
    }

    /// The person dragged it: it opens there next time while that spot is on a screen.
    func windowDidMove(_ notification: Notification) {
        guard !placing, let panel else { return }
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: Self.originKey)
    }

    @objc private func pressed(_ sender: ScreenSessionBarView.PillButton) {
        guard let action = sender.barAction else { return }
        // One line per press, so a report that the bar did nothing can be told apart from a click that never reached it.
        Self.log.notice("session bar: \(action.rawValue, privacy: .public) pressed")
        switch action {
        case .end: service.disconnect()
        case .viewOnly: service.lowerSessionToView()
        case .takeOver: service.pauseRemoteInput()
        case .handBack:
            let refusal = Self.handBackRefusal(NSApp.currentEvent, bar: panel, pill: sender)
            if !service.resumeRemoteInput(refusal: refusal), let refusal {
                notice = (.handBackRefused(refusal), Date().addingTimeInterval(4))
            }
        }
        update()
    }

    /// An accessibility press on 「다시 넘기기」, refused by the pill before any action ran: the bar says why.
    private func refuse(_ refusal: ScreenSessionBarClick.Refusal, how: String) {
        Self.log.notice("session bar: hand-back refused \(how, privacy: .public)")
        notice = (.handBackRefused(refusal), Date().addingTimeInterval(4))
        update()
    }

    /// What the bar can read about the click that ran 「다시 넘기기」 (ScreenSessionBarClick decides): the event, and
    /// whether the pill tracked that click itself with the mouse-up inside it.
    static func handBackRefusal(_ event: NSEvent?, bar: NSWindow?, pill: ScreenSessionBarView.PillButton) -> ScreenSessionBarClick.Refusal? {
        guard let event, let bar, let cg = event.cgEvent else { return .notABarClick }
        let source = cg.getIntegerValueField(.eventSourceUnixProcessID)
        let own = Int64(ProcessInfo.processInfo.processIdentifier)
        let poster = source > 0 && source != own && source <= Int64(Int32.max) ? poster(pid: pid_t(source)) : nil
        // `clickCount` raises on an event that is not a mouse event, so it and the location are read for a mouse-up only.
        let mouseUp = event.type == .leftMouseUp
        let inControl = mouseUp && pill.tracksOwnMouseDown && pill.window === bar &&
            pill.bounds.contains(pill.convert(event.locationInWindow, from: nil))
        let refusal = ScreenSessionBarClick.handBackRefusal(
            isMouseUp: mouseUp, inBar: event.window === bar, inControl: inControl, clickCount: mouseUp ? event.clickCount : 0,
            ageSeconds: ProcessInfo.processInfo.systemUptime - event.timestamp,
            sourcePid: source, userData: cg.getIntegerValueField(.eventSourceUserData),
            ownPid: own, injectionMarker: LocalInputMonitor.injectedEventMarker, poster: poster,
            keyboardType: cg.getIntegerValueField(.keyboardEventKeyboardType), sourceState: cg.getIntegerValueField(.eventSourceStateID))
        // Calibration on real devices (hardware, remote desktop): the posting process and its signing name only.
        log.notice("session bar: hand-back source=\(source, privacy: .public) poster=\(poster?.identifier ?? "-", privacy: .public) inControl=\(inControl, privacy: .public) refusal=\(refusal?.rawValue ?? "none", privacy: .public)")
        return refusal
    }

    /// The posting process's signing identity, strictly validated; nil when it cannot be read or proven. Only chooses
    /// what a refusal says: every posting process is refused.
    static func poster(pid: pid_t) -> ScreenSessionBarPoster? {
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let fields = info as? [String: Any], let identifier = fields[kSecCodeInfoIdentifier as String] as? String else { return nil }
        var requirement: SecRequirement?
        let apple = SecRequirementCreateWithString("anchor apple" as CFString, [], &requirement) == errSecSuccess && requirement != nil &&
            SecCodeCheckValidity(code, [], requirement) == errSecSuccess
        return ScreenSessionBarPoster(identifier: identifier, team: fields[kSecCodeInfoTeamIdentifier as String] as? String, apple: apple)
    }
}
#endif
