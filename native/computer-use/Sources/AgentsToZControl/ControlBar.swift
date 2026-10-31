import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import ComputerUseEngine
import Security

/// A floating bar shown while a v2 grant is open: who holds the Mac (the AI or the person) and the person's one verb,
/// 「직접 하기」 or 「AI에게 넘기기」, plus 「중단」. It is a borderless panel that never becomes key or main, so no key
/// reaches it and Control never becomes frontmost from it. The engine exempts only this window from its overlay
/// guard (ScopedOSGuard.ownStatusWindow); a point on it is still Control's and the capture filter leaves it out.
/// Its look (a dark glass capsule) is ControlBarView; this type owns the panel, the words and the actions.
@MainActor
final class ControlBar: NSObject {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
    static let size = ControlBarView.size
    private var panel: Panel?
    private let view = ControlBarView(frame: NSRect(origin: .zero, size: ControlBarView.size))
    private var notice: (title: String, text: String, until: Date)?
    private let service: ScopedControlService

    init(service: ScopedControlService) { self.service = service }

    /// Once a second from Control's tick, and right after the person's own click.
    func update() {
        guard let grant = service.grant, !grant.halted else { hide(); return }
        let panel = self.panel ?? make()
        let owner: ControlBarOwner = grant.person ? .person : .agent
        var title = ControlBarText.title(owner)
        let detail: String
        let showsNotice: Bool
        if let notice, notice.until > Date() { title = notice.title; detail = notice.text; showsNotice = true }
        else {
            notice = nil
            showsNotice = false
            let seconds = service.lastAction.map { max(0, Int(Date().timeIntervalSince($0.at))) }
            detail = ControlBarText.detail(owner, scope: scopeName(grant.scope),
                                           lastOperation: service.lastAction?.operation, secondsAgo: seconds)
        }
        view.show(tone: owner == .agent ? .agent : .person, title: title, detail: detail,
                  notice: showsNotice, primary: ControlBarText.primary(owner))
        if panel.level != .statusBar { panel.level = .statusBar }
        if !panel.isVisible { appear(panel) }
        // Every tick, not only when hidden: another app's window at the same level ordered later covers it otherwise.
        panel.orderFrontRegardless()
        ScopedOwnStatusWindows.ids = panel.windowNumber > 0 ? [UInt32(panel.windowNumber)] : []
    }

    private func hide() {
        panel?.orderOut(nil)
        ScopedOwnStatusWindows.ids = []
    }

    private func scopeName(_ scope: ScopeApprovalScope) -> String {
        switch scope {
        case .desktop: return "전체 Mac"
        case .application(let app): return NSRunningApplication(processIdentifier: app.pid)?.localizedName ?? app.bundleId
        }
    }

    private func make() -> Panel {
        let panel = Panel(contentRect: NSRect(origin: .zero, size: Self.size),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        // Above other apps' floating panels: on 1호 (2026-10-31) ChatGPT's 1138×2009 window at the floating level (3)
        // sat in front of this bar for a whole grant, so the person never saw 「직접 하기」.
        // `isFloatingPanel = true` resets the level to floating, so the level comes after it (1637 on 1호 shipped the bar
        // at layer 3 that way, still behind ChatGPT).
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.backgroundColor = .clear
        panel.isOpaque = false
        // The shadow follows the capsule's own alpha; it is computed again once the glass has drawn (appear).
        panel.hasShadow = true
        panel.appearance = NSAppearance(named: .darkAqua)

        view.primary.target = self
        view.primary.action = #selector(primaryPressed)
        view.stop.target = self
        view.stop.action = #selector(stopPressed)
        view.stop.label = ControlBarText.stop
        panel.contentView = view
        panel.setAccessibilityLabel("AgentsToZ Control 제어 막대")
        self.panel = panel
        return panel
    }

    /// Bottom centre of the menu bar screen, above the Dock, fading in. The person may drag it; it then stays where they
    /// put it until the grant ends.
    private func appear(_ panel: NSPanel) {
        guard let screen = NSScreen.screens.first else { return }
        let visible = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: visible.midX - Self.size.width / 2, y: visible.minY + 18))
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

    @objc private func primaryPressed() {
        // One line per press, so a report that the bar did nothing can be told apart from a click that never reached it.
        ScopedControlLog.bar.notice("control bar: primary pressed owner=\(self.service.grant.map { $0.halted ? "halted" : $0.person ? "person" : "agent" } ?? "none", privacy: .public)")
        guard let grant = service.grant, !grant.halted else { update(); return }
        if !grant.person { service.handToPerson(); update(); return }
        let refusal = Self.handBackRefusal(NSApp.currentEvent, bar: panel)
        if !service.handToAgent(click: refusal), refusal != nil {
            notice = (ControlBarText.handBackRefusedTitle, ControlBarText.handBackRefused, Date().addingTimeInterval(4))
        }
        update()
    }
    @objc private func stopPressed() { service.stop(); update() }

    /// What the bar can read about the click that ran the button (ControlBarClick decides).
    static func handBackRefusal(_ event: NSEvent?, bar: NSWindow?) -> String? {
        guard let event, let bar, let cg = event.cgEvent else { return "not-a-bar-click" }
        let source = cg.getIntegerValueField(.eventSourceUnixProcessID)
        let poster = source > 0 && source <= Int64(Int32.max) ? poster(pid: pid_t(source)) : nil
        // Calibration for real devices (hardware, remote desktop): the posting process and its signing name only.
        ScopedControlLog.bar.notice("control bar: hand-back click source=\(source, privacy: .public) poster=\(poster?.identifier ?? "-", privacy: .public) apple=\(poster?.apple ?? false, privacy: .public)")
        return ControlBarClick.handBackRefusal(
            isMouseUp: event.type == .leftMouseUp, inBar: event.window === bar,
            ageSeconds: ProcessInfo.processInfo.systemUptime - event.timestamp,
            sourcePid: source, userData: cg.getIntegerValueField(.eventSourceUserData),
            ownPid: Int64(ProcessInfo.processInfo.processIdentifier), syntheticTag: ScopedSyntheticEvents.tag,
            poster: poster)
    }

    /// The posting process's signing identity, strictly validated; nil when it cannot be read or proven.
    static func poster(pid: pid_t) -> ControlBarPoster? {
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
        return ControlBarPoster(identifier: identifier, team: fields[kSecCodeInfoTeamIdentifier as String] as? String, apple: apple)
    }
}
