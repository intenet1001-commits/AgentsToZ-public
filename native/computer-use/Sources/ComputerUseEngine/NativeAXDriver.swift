import ApplicationServices
import ComputerUseControlCore
import Foundation

// Same exact-window primitive as the pinned SDK; no title/position matching fallback.
@_silgen_name("_AXUIElementGetWindow")
private func exactAXWindowID(_ element: AXUIElement, _ id: inout CGWindowID) -> AXError

@MainActor
struct NativeAXDriver: ExactAXDriver {
    let pid: Int32
    let windowID: UInt32
    private func prepare(_ element: AXUIElement) -> Bool { AXUIElementSetMessagingTimeout(element, 0.15) == .success }
    private func owner(_ element: AXUIElement) -> Int32? {
        guard prepare(element) else { return nil }
        var value: pid_t = 0
        return AXUIElementGetPid(element, &value) == .success ? value : nil
    }
    private func id(_ element: AXUIElement) -> UInt32? {
        var value: CGWindowID = 0
        return exactAXWindowID(element, &value) == .success && value > 0 ? value : nil
    }
    func window() throws -> AXUIElement {
        let application = AXUIElementCreateApplication(pid)
        guard prepare(application) else { throw ControlError("window-not-exact") }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(application, kAXWindowsAttribute as CFString, &count) == .success,
              count > 0, count <= 100 else { throw ControlError("window-not-exact") }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(application, kAXWindowsAttribute as CFString, 0, count, &values) == .success,
              let windows = values as? [AXUIElement] else { throw ControlError("window-not-exact") }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.75
        var matches: [AXUIElement] = []
        for candidate in windows {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw ControlError("window-not-exact") }
            if owner(candidate) == pid && id(candidate) == windowID { matches.append(candidate) }
        }
        guard matches.count == 1 else { throw ControlError("window-not-exact") }
        return matches[0]
    }
    func belongs(_ element: AXUIElement, to window: AXUIElement) -> Bool {
        guard owner(element) == pid, owner(window) == pid, id(window) == windowID else { return false }
        if CFEqual(element, window) { return true }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        return CFEqual(value, window)
    }
    func string(_ name: String, of element: AXUIElement) -> ExactAXString {
        guard prepare(element) else { return .failed }
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if result == .attributeUnsupported || result == .noValue { return .absent }
        guard result == .success, let value else { return .failed }
        if CFGetTypeID(value) == CFStringGetTypeID() { return .value(value as! String) }
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return .value((value as! Bool) ? "true" : "false") }
        if CFGetTypeID(value) == CFNumberGetTypeID() { return .value((value as! NSNumber).stringValue) }
        return .failed
    }
    func enabled(_ element: AXUIElement) -> Bool {
        guard prepare(element) else { return false }
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXEnabledAttribute as CFString, &value) == .success
            && value.map { CFGetTypeID($0) == CFBooleanGetTypeID() && ($0 as! Bool) } == true
    }
    func settable(_ element: AXUIElement) -> Bool {
        guard prepare(element) else { return false }
        var value = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &value) == .success && value.boolValue
    }
    func children(_ element: AXUIElement, limit: Int) -> (elements: [AXUIElement], truncated: Bool) {
        guard prepare(element) else { return ([], true) }
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        if status == .attributeUnsupported || status == .noValue { return ([], false) }
        guard status == .success, count >= 0 else { return ([], true) }
        if count == 0 { return ([], false) }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, limit), &values) == .success,
              let children = values as? [AXUIElement] else { return ([], true) }
        return (children, count > limit)
    }
    func allowsActions(in window: AXUIElement) -> Bool {
        guard belongs(window, to: window), prepare(window) else { return false }
        let protected = ["AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"]
        guard case let .value(role) = string(kAXRoleAttribute, of: window), !protected.contains(role) else { return false }
        let subrole = string(kAXSubroleAttribute, of: window)
        guard subrole != .failed else { return false }
        if case let .value(value) = subrole, protected.contains(value) { return false }
        // Some apps expose sheets only as window children instead of AXSheets.
        let direct = children(window, limit: 100)
        guard !direct.truncated else { return false }
        for child in direct.elements {
            guard belongs(child, to: window), case let .value(role) = string(kAXRoleAttribute, of: child),
                  !protected.contains(role) else { return false }
            let subrole = string(kAXSubroleAttribute, of: child)
            guard subrole != .failed else { return false }
            if case let .value(value) = subrole, protected.contains(value) { return false }
        }
        var count: CFIndex = 0
        let sheets = AXUIElementGetAttributeValueCount(window, "AXSheets" as CFString, &count)
        guard sheets == .attributeUnsupported || sheets == .noValue || (sheets == .success && count == 0) else { return false }
        // Never act on an authentication/permission dialog or behind a sheet. An AX error is not absence.
        switch string(kAXModalAttribute, of: window) {
        case .absent, .value("false"): return true
        default: return false
        }
    }
    func supportsPress(_ element: AXUIElement) -> Bool {
        guard prepare(element) else { return false }
        var actions: CFArray?
        return AXUIElementCopyActionNames(element, &actions) == .success && (actions as? [String])?.contains(kAXPressAction) == true
    }
    func frame(of window: AXUIElement) -> CGRect? {
        guard belongs(window, to: window) else { return nil }
        func axValue(_ name: CFString, kind: AXValueType) -> AXValue? {
            var result: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, name, &result) == .success,
                  let result, CFGetTypeID(result) == AXValueGetTypeID(),
                  AXValueGetType(result as! AXValue) == kind else { return nil }
            return (result as! AXValue)
        }
        guard let position = axValue(kAXPositionAttribute as CFString, kind: .cgPoint),
              let dimensions = axValue(kAXSizeAttribute as CFString, kind: .cgSize) else { return nil }
        var origin = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(dimensions, .cgSize, &size),
              origin.x.isFinite, origin.y.isFinite, size.width.isFinite, size.height.isFinite,
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: origin, size: size)
    }
    /// A window-relative point in macOS points, as the agent derives it from a capture
    /// (`pixel * windowWidth / width`), placed in the global AX coordinate space of that window's frame.
    /// Nil outside the window: a point on or past its right or bottom edge selects nothing.
    nonisolated static func screenPoint(x: Double, y: Double, in frame: CGRect) -> CGPoint? {
        guard x.isFinite, y.isFinite, x >= 0, y >= 0, x < frame.width, y < frame.height else { return nil }
        return CGPoint(x: frame.origin.x + x, y: frame.origin.y + y)
    }
    func hitTest(x: Double, y: Double, window: AXUIElement) -> AXUIElement? {
        guard let frame = frame(of: window), let point = Self.screenPoint(x: x, y: y, in: frame) else { return nil }
        let application = AXUIElementCreateApplication(pid)
        guard prepare(application) else { return nil }
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit) == .success,
              let hit, belongs(hit, to: window) else { return nil }
        return hit
    }
    func setValue(_ value: String, of element: AXUIElement) -> Bool {
        AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success
    }
    func press(_ element: AXUIElement) -> Bool { AXUIElementPerformAction(element, kAXPressAction as CFString) == .success }
}
