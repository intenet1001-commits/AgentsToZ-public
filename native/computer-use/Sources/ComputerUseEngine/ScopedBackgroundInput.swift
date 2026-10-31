import ApplicationServices
import ComputerUseControlCore
import CoreGraphics
import Foundation

/// Background input: the agent works on an app without the person's pointer or keyboard focus, so a person and an agent
/// on the same Mac do not collide (as Codex's computer use does; who holds the Mac is the control bar's, not this file's).
/// Accessibility actions and values go straight to the element; key events go to the target process's own queue. Neither
/// moves the pointer, raises a window or changes the frontmost app, so the person's activity is not a reason to stop and
/// background input does not consult the HID idle clock or physical-event counters (what it does to them is not assumed).
/// Every result is unverified until a later observation shows its effect.

/// Key events delivered to one process, never to the session or HID event stream.
@MainActor
struct ScopedProcessEventSink: ScopedEventSink {
    let pid: pid_t
    private let postEvent: (CGEvent, pid_t) -> Void
    init(pid: pid_t, postEvent: @escaping (CGEvent, pid_t) -> Void = { event, pid in event.postToPid(pid) }) {
        self.pid = pid; self.postEvent = postEvent
    }
    func post(_ event: CGEvent) { postEvent(event, pid) }
}

@MainActor
enum ScopedAccessibilityInput {
    /// Roles that are never pressed from the background: a click there is a pointer's job or a protected surface's.
    static let windowRoles: Set<String> = ["AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]

    /// What a left click at `point` does in the background, or nil when only a real pointer can do it.
    enum Click { case press(AXUIElement), focus(AXUIElement) }

    private static func prepared(_ element: AXUIElement) -> Bool { AXUIElementSetMessagingTimeout(element, 0.15) == .success }
    private static func string(_ name: String, of element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value,
              CFGetTypeID(value) == CFStringGetTypeID() else { return nil }
        return (value as! String)
    }
    private static func element(_ name: String, of element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success, let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private static func owner(_ element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }
    private static func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
    }
    private static func settable(_ name: String, _ element: AXUIElement) -> Bool {
        var value = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
    }
    private static func secure(role: String?, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField" || subrole?.hasPrefix("AXSecure") == true
    }

    /// The element of `pid` under `point` (global points), and how to act on it without a pointer: press the nearest
    /// pressable element (itself or up to four ancestors, never past its window), or give focus to a nonsecure text
    /// field. The element's window must be an ordinary window of the same process — a sheet, dialog, alert or modal
    /// window, an unreadable role or a secure field leaves the click to the pointer path and its stricter guards.
    static func click(at point: CGPoint, pid: pid_t) -> Click? {
        let app = AXUIElementCreateApplication(pid)
        guard point.x.isFinite, point.y.isFinite, prepared(app) else { return nil }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(point.x), Float(point.y), &hit) == .success, let hit,
              prepared(hit), owner(hit) == pid, let window = element(kAXWindowAttribute, of: hit), prepared(window),
              owner(window) == pid, ordinaryWindow(window) else { return nil }
        var current = hit
        for _ in 0..<5 {
            guard owner(current) == pid, let role = string(kAXRoleAttribute, of: current) else { return nil }
            let subrole = string(kAXSubroleAttribute, of: current)
            if secure(role: role, subrole: subrole) || windowRoles.contains(role) || role == "AXWindow" || role == "AXApplication" { return nil }
            if textRoles.contains(role) { return settable(kAXFocusedAttribute, current) ? .focus(current) : nil }
            if actions(current).contains(kAXPressAction) { return .press(current) }
            guard let parent = element(kAXParentAttribute, of: current), prepared(parent) else { return nil }
            current = parent
        }
        return nil
    }

    static func ordinaryWindow(_ window: AXUIElement) -> Bool {
        guard string(kAXRoleAttribute, of: window) == "AXWindow" else { return false }
        if let subrole = string(kAXSubroleAttribute, of: window), windowRoles.contains(subrole) || subrole == "AXSystemDialog" { return false }
        var modal: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(window, kAXModalAttribute as CFString, &modal)
        if result == .attributeUnsupported || result == .noValue { return true }
        guard result == .success, let modal, CFGetTypeID(modal) == CFBooleanGetTypeID() else { return false }
        return !CFBooleanGetValue((modal as! CFBoolean))
    }

    /// An Accessibility call that timed out may still have been carried out by the app: that is unknown, not refused.
    static func outcome(_ error: AXError) -> MutationResult {
        switch error {
        case .success: return .dispatchedUnverified
        case .cannotComplete: return .unknown
        default: return .refused("background-action-failed")
        }
    }
    static func perform(_ click: Click) -> MutationResult {
        switch click {
        case .press(let element): return outcome(AXUIElementPerformAction(element, kAXPressAction as CFString))
        case .focus(let element): return outcome(AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue))
        }
    }

    /// Insert at the caret (replacing a selection) as typing does. Nil when the field does not take inserted text this
    /// way — nothing was sent, and the caller posts key events to the process instead. Never reads the field's value.
    static func insert(_ text: String, into element: AXUIElement) -> MutationResult? {
        guard prepared(element), settable(kAXSelectedTextAttribute, element) else { return nil }
        return outcome(AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString))
    }
}
