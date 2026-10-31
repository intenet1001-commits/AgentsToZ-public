import AppKit
import ApplicationServices
import ComputerUseApproval
import ComputerUseControlCore
import CoreGraphics
import Foundation
import IOKit
import Security

/// Active CG display in global points. IDs are native observations, never supplied as untrusted capture targets.
public struct ScopedOSDisplay: Equatable, Sendable {
    public let nativeID: UInt32
    public let frame: CGRect
    public let scale: Double
    public let rotation: Double
    public init(nativeID: UInt32, frame: CGRect, scale: Double, rotation: Double) {
        self.nativeID = nativeID; self.frame = frame; self.scale = scale; self.rotation = rotation
    }
}

struct ScopedOSWindow: Equatable {
    let id: UInt32
    let pid: Int32
    let frame: CGRect
    let alpha: Double
    let layer: Int
    let title: String?
    init(id: UInt32, pid: Int32, frame: CGRect, alpha: Double, layer: Int = 0, title: String? = nil) {
        self.id = id; self.pid = pid; self.frame = frame; self.alpha = alpha; self.layer = layer; self.title = title
    }
}

/// Window numbers of Control's own control bar, registered by AgentsToZControl when it shows the bar (ScopedOSGuard.ownStatusWindow).
@MainActor public enum ScopedOwnStatusWindows { public static var ids: Set<UInt32> = [] }

/// Conservative OS evidence for a local control session. IOConsoleLocked is an XNU implementation key, not a public
/// SDK lock contract. An absent/wrong value is unknown and never means unlocked; a separate live check is required at
/// every observation/capture/input boundary. Fast User Switching and screen sharing still require real-device checks.
public enum ScopedOSGuard {
    static func boolean(_ value: Any?) -> Bool? {
        guard let value, CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return nil }
        return CFBooleanGetValue(((value as CFTypeRef) as! CFBoolean))
    }
    static func unlocked(rootLocked: Any?, onConsole: Any?, loginDone: Any?, sessionUID: Any?, currentUID: uid_t) -> Bool {
        guard boolean(rootLocked) == false, boolean(onConsole) == true, boolean(loginDone) == true,
              let uid = sessionUID as? NSNumber, CFGetTypeID(uid) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(uid as CFNumber), uid.int64Value >= 0,
              uid.uint64Value == UInt64(currentUID) else { return false }
        return true
    }
    public static func screenUnlocked() -> Bool {
        // IOConsoleLocked is a property of the registry root, not the IOService plane root.
        let root = IORegistryGetRootEntry(kIOMainPortDefault)
        guard root != IO_OBJECT_NULL else { return false }
        defer { IOObjectRelease(root) }
        guard let locked = IORegistryEntryCreateCFProperty(root, "IOConsoleLocked" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
              let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return unlocked(rootLocked: locked, onConsole: session[kCGSessionOnConsoleKey as String],
                        loginDone: session[kCGSessionLoginDoneKey as String], sessionUID: session[kCGSessionUserIDKey as String],
                        currentUID: getuid())
    }
    /// Authentication happens after a person's click; unlike input checks this does not require idle time.
    @MainActor public static func requireConsentEnvironment() throws {
        guard ComputerUseEngine.accessibilityTrusted, CGPreflightScreenCaptureAccess() else { throw ControlError.refuse("permission-unavailable") }
        guard screenUnlocked(), !ComputerUseEngine.secureInput else { throw ControlError.refuse("secure-state-unavailable") }
    }
    /// A password typed into the system's authentication sheet keeps Secure Event Input on for a moment after
    /// `evaluatePolicy` returns, so checking at once refused a consent the person had just given (1호, 2026-10-31:
    /// password over remote access, no Touch ID). Wait a bounded time for it to clear; the caller still runs
    /// `requireConsentEnvironment` and refuses when it has not.
    @MainActor public static func awaitSecureInputRelease(limitMs: Int = 3_000) async -> Bool {
        await waitWhile({ ComputerUseEngine.secureInput }, limitMs: limitMs) { try? await Task.sleep(nanoseconds: UInt64($0) * 1_000_000) }
    }
    /// Checks `held` before each pause and gives up after `limitMs` worth of pauses. Returns whether it was released.
    @MainActor static func waitWhile(_ held: () -> Bool, limitMs: Int, stepMs: Int = 100, pause: (Int) async -> Void) async -> Bool {
        var waited = 0
        while held() {
            guard waited < limitMs else { return false }
            await pause(stepMs); waited += stepMs
        }
        return true
    }
    @MainActor public static func requireGeneral() throws {
        try requireConsentEnvironment()
        try requireIdleInputAge(ComputerUseEngine.secondsSinceHumanInput())
    }
    // Diagnostic codes distinguish the two independent checks without identifying who produced an OS event.
    // Keep the same thresholds and exact counter equality; neither check exempts a synthetic event.
    static func requireIdleInputAge(_ idle: Double) throws {
        guard idle.isFinite, idle >= ComputerUseEngine.humanIdleSeconds else { throw ControlError.refuse("human-active-idle") }
    }
    static func requireSamePhysicalCounters(_ current: String, observed: String) throws {
        guard current == observed else { throw ControlError.refuse("human-active-events") }
    }

    /// Resolve any running app, including protected apps, from current OS signature and kernel generation. This
    /// does not authorize that app; apply ScopedProtectedTargets before exposing, capturing, focusing or acting.
    @MainActor public static func identity(pid: Int32) throws -> ScopeApplicationIdentity {
        guard pid > 0, let start = ProcessGeneration.start(pid) else {
            throw ControlError.refuse("scope-app-unverifiable")
        }
        let app = NSRunningApplication(processIdentifier: pid)
        let bundle: String
        if let app, !app.isTerminated, let identifier = app.bundleIdentifier, !identifier.isEmpty { bundle = identifier }
        else if verifiedCompositor(pid) == start { bundle = "com.apple.WindowServer" }
        else { throw ControlError.refuse("scope-app-unverifiable") }
        let signature = try ComputerUseEngine.signature(pid)
        let result = ScopeApplicationIdentity(bundleId: bundle, teamId: signature.team, codeHash: signature.hash,
                                              pid: pid, processStart: String(start))
        guard ComputerUseScopeApproval.validApplication(result), ProcessGeneration.start(pid) == start,
              app?.isTerminated != true else { throw ControlError.refuse("scope-app-unverifiable") }
        return result
    }

    /// Read-only identity, including the Control window while a newly approved grant starts.
    @MainActor public static func currentForegroundIdentity() throws -> ScopeApplicationIdentity {
        guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier else {
            throw ControlError.refuse("human-state-unavailable")
        }
        let app = try identity(pid: pid)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw ControlError.refuse("target-changed") }
        return app
    }
    @MainActor public static func foregroundIdentity() throws -> ScopeApplicationIdentity {
        let app = try currentForegroundIdentity()
        guard !ScopedProtectedTargets.refuses(bundleId: app.bundleId) else { throw ControlError.refuse("protected-foreground") }
        return app
    }

    /// Read only AX focus metadata, never values. Text roles must have an explicitly verified nonsecure subrole;
    /// unsupported or malformed focus is unknown. Reject generic containers whose focused descendant is ambiguous.
    @MainActor public static func requireSafeFocus(forText: Bool) throws {
        let front = try foregroundIdentity()
        let (focused, role, subrole) = try focusedElement(of: front.pid)
        let safe: Bool
        if containerRoles.contains(role) {
            safe = try focusedTextDescendant(of: focused, acceptNonText: !forText)
        } else { safe = safeFocus(role: role, subrole: subrole, forText: forText) }
        guard safe,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == front.pid,
              ProcessGeneration.start(front.pid).map(String.init) == front.processStart else {
            throw ControlError.refuse("focus-unverifiable")
        }
    }

    /// The focus inside `app` for background input, which does not need the app in front: the element itself when it
    /// is a verified nonsecure text field or area (text goes in through Accessibility), nil when the safe target is a
    /// focused descendant of a container or a non-text control (keys are posted to the app instead). The same role
    /// rules as `requireSafeFocus`; unsafe, ambiguous or unreadable focus refuses, as does a changed process generation.
    @MainActor public static func backgroundFocus(of app: ScopeApplicationIdentity, forText: Bool) throws -> AXUIElement? {
        guard ProcessGeneration.start(app.pid).map(String.init) == app.processStart else { throw ControlError.refuse("target-changed") }
        let (focused, role, subrole) = try focusedElement(of: app.pid)
        let safe = containerRoles.contains(role) ? try focusedTextDescendant(of: focused, acceptNonText: !forText)
                                                 : safeFocus(role: role, subrole: subrole, forText: forText)
        guard safe, ProcessGeneration.start(app.pid).map(String.init) == app.processStart else {
            throw ControlError.refuse("focus-unverifiable")
        }
        return ["AXTextField", "AXTextArea"].contains(role) ? focused : nil
    }

    static let containerRoles: Set<String> = ["AXWebArea", "AXGroup", "AXScrollArea", "AXWindow"]
    /// The application's own focused element (not the system-wide one), with its role and nonsecure-checkable subrole.
    @MainActor static func focusedElement(of pid: Int32) throws -> (AXUIElement, String, String?) {
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(app, 0.15) == .success else { throw ControlError.refuse("focus-unverifiable") }
        var focusedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
              let focusedValue, CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
            throw ControlError.refuse("focus-unverifiable")
        }
        let focused = focusedValue as! AXUIElement
        var owner: pid_t = 0
        guard AXUIElementSetMessagingTimeout(focused, 0.15) == .success,
              AXUIElementGetPid(focused, &owner) == .success, owner == pid else { throw ControlError.refuse("focus-unverifiable") }
        var roleValue: CFTypeRef?, subroleValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &roleValue) == .success,
              let role = roleValue as? String, !role.isEmpty else { throw ControlError.refuse("focus-unverifiable") }
        let subroleResult = AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString, &subroleValue)
        if subroleResult == .success, !(subroleValue is String) { throw ControlError.refuse("focus-unverifiable") }
        guard subroleResult == .success || subroleResult == .noValue || subroleResult == .attributeUnsupported else {
            throw ControlError.refuse("focus-unverifiable")
        }
        return (focused, role, subroleResult == .success ? subroleValue as? String : nil)
    }

    static func safeFocus(role: String, subrole: String?, forText: Bool = true) -> Bool {
        guard role != "AXSecureTextField", subrole != "AXSecureTextField" else { return false }
        if let subrole, subrole == "AXUnknown" || subrole.hasPrefix("AXSecure") { return false }
        // A generic web/terminal focus is not by itself a secure input. Global secure-input, identity and protected
        // surfaces are checked separately; malformed focus metadata and explicit secure roles remain refused.
        let textRoles = ["AXTextField", "AXTextArea"]
        if textRoles.contains(role) { return true }
        if forText { return false }
        return ["AXWebArea", "AXGroup", "AXScrollArea", "AXWindow", "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXLink", "AXMenuItem",
                "AXMenuBarItem", "AXMenu", "AXSlider", "AXIncrementor"].contains(role)
    }

    /// Generic web/group focus does not identify the field receiving text. Traverse a small bounded AX subtree and
    /// require exactly one explicitly focused, known nonsecure text field. Never read its value or infer from labels.
    @MainActor static func focusedTextDescendant(of root: AXUIElement, acceptNonText: Bool = false) throws -> Bool {
        let deadline = ProcessInfo.processInfo.systemUptime + 0.5
        var queue: [AXUIElement] = [root], visited = Set<CFHashCode>(), count = 0, matches = 0
        while !queue.isEmpty {
            guard count < 96, ProcessInfo.processInfo.systemUptime < deadline else { throw ControlError.refuse("focus-unverifiable") }
            let element = queue.removeFirst(), hash = CFHash(element)
            guard visited.insert(hash).inserted else { throw ControlError.refuse("focus-unverifiable") }
            count += 1
            guard AXUIElementSetMessagingTimeout(element, 0.15) == .success else { throw ControlError.refuse("focus-unverifiable") }
            if count > 1 {
                var focusedValue: CFTypeRef?
                let focusedResult = AXUIElementCopyAttributeValue(element, kAXFocusedAttribute as CFString, &focusedValue)
                guard focusedResult == .success || focusedResult == .noValue || focusedResult == .attributeUnsupported else {
                    throw ControlError.refuse("focus-unverifiable")
                }
                if focusedResult == .success {
                    guard let focusedValue, CFGetTypeID(focusedValue) == CFBooleanGetTypeID() else { throw ControlError.refuse("focus-unverifiable") }
                    if CFBooleanGetValue((focusedValue as! CFBoolean)) {
                        var roleValue: CFTypeRef?, subroleValue: CFTypeRef?
                        guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue) == .success,
                              let role = roleValue as? String else { throw ControlError.refuse("focus-unverifiable") }
                        let result = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue)
                        guard result == .success || result == .noValue || result == .attributeUnsupported,
                              result != .success || subroleValue is String else { throw ControlError.refuse("focus-unverifiable") }
                        let subrole = result == .success ? subroleValue as? String : nil
                        // A focused container is not the final input target; continue looking for its descendant.
                        if ["AXWebArea", "AXGroup", "AXScrollArea", "AXWindow"].contains(role), subrole != "AXSecureTextField" {
                            // Its children are inspected below.
                        } else if safeFocus(role: role, subrole: subrole, forText: !acceptNonText) {
                            matches += 1
                        } else {
                            throw ControlError.refuse("focus-unverifiable")
                        }
                    }
                }
            }
            var childrenValue: CFTypeRef?
            let childrenResult = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenValue)
            if childrenResult == .noValue || childrenResult == .attributeUnsupported {
                if count == 1 { throw ControlError.refuse("focus-unverifiable") }
                continue
            }
            guard childrenResult == .success, let childrenValue, let children = childrenValue as? [AXUIElement],
                  queue.count + children.count <= 96 else { throw ControlError.refuse("focus-unverifiable") }
            queue.append(contentsOf: children)
        }
        return matches == 1
    }

    /// Physical-event counters only. Synthetic events from a private source still require real-device attribution
    /// testing; if the OS treats them as HID activity this safely refuses the next guard rather than guessing.
    /// `requireIdle: false` reads the counters while the person may be using the Mac (background input and observation
    /// do not share the pointer with them); pointer input still compares them and requires the idle age first.
    @MainActor public static func physicalEvidence(requireIdle: Bool = true) throws -> String {
        if requireIdle { try requireGeneral() } else { try requireConsentEnvironment() }
        let counts = physicalCounters()
        guard counts.contains(where: { $0 != 0 }) else { throw ControlError.refuse("human-state-unavailable") }
        try requireConsentEnvironment()
        return counts.map(String.init).joined(separator: ",")
    }
    // kCGAnyInputEventType is documented for elapsed time, not the counter API. Read documented individual
    // input-event counters and compare the whole vector. Synthetic-event attribution requires real-device tests.
    // Order matches ScopedGuardSample.counterNames.
    static let physicalEventTypes: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .mouseMoved, .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp, .leftMouseDragged, .rightMouseDragged,
        .otherMouseDragged, .scrollWheel]
    /// The raw counter vector, with no check. Only physicalEvidence decides; diagnostics merely compare readings.
    static func physicalCounters() -> [UInt32] {
        physicalEventTypes.map { CGEventSource.counterForEventType(.hidSystemState, eventType: $0) }
    }
    /// The counter vector inside an observation's physicalEvidence string, or nil when it is not exactly that shape.
    static func physicalCounters(evidence: String) -> [UInt32]? {
        let parts = evidence.split(separator: ",", omittingEmptySubsequences: false)
        let values = parts.compactMap { UInt32($0) }
        return values.count == physicalEventTypes.count && parts.count == values.count ? values : nil
    }
    /// The foreground process generation and the consent environment (unlocked, no secure input), with no claim about
    /// whether the person is using the Mac: observation and capture bind this across their awaits. Background input
    /// never shares the pointer or keyboard focus with the person, so their activity does not void what was seen.
    @MainActor public static func foregroundEvidence(allowProtectedForeground: Bool = false) throws -> String {
        try requireConsentEnvironment()
        let app = try currentForegroundIdentity()
        if !allowProtectedForeground && ScopedProtectedTargets.refuses(bundleId: app.bundleId) {
            throw ControlError.refuse("protected-foreground")
        }
        return "\(app.pid):\(app.processStart)"
    }
    /// Capture evidence also binds the foreground generation across awaits.
    @MainActor public static func humanEvidence(allowProtectedForeground: Bool = false) throws -> String {
        let physical = try physicalEvidence()
        let app = try currentForegroundIdentity()
        if !allowProtectedForeground && ScopedProtectedTargets.refuses(bundleId: app.bundleId) {
            throw ControlError.refuse("protected-foreground")
        }
        return "\(app.pid):\(app.processStart):" + physical
    }

    /// Snapshot all active physical display IDs and their geometry. A missing, duplicate or malformed screen fails.
    @MainActor public static func displayLayout() throws -> [ScopedOSDisplay] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0, count <= 32 else {
            throw ControlError.refuse("display-unavailable")
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count)), actual: UInt32 = 0
        guard CGGetActiveDisplayList(count, &ids, &actual) == .success, actual == count,
              Set(ids).count == ids.count, !ids.contains(0) else { throw ControlError.refuse("display-unavailable") }
        return try ids.sorted().map { id in
            let frame = CGDisplayBounds(id), pixels = CGDisplayPixelsWide(id), heightPixels = CGDisplayPixelsHigh(id), rotation = CGDisplayRotation(id)
            guard frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite,
                  frame.width > 0, frame.height > 0, pixels > 0, heightPixels > 0, rotation.isFinite else {
                throw ControlError.refuse("display-unavailable")
            }
            let scale = Double(pixels) / Double(frame.width)
            let heightScale = Double(heightPixels) / Double(frame.height)
            guard scale.isFinite, scale > 0, heightScale.isFinite,
                  abs(scale - heightScale) <= max(scale, heightScale) * 0.05 else { throw ControlError.refuse("display-unavailable") }
            return ScopedOSDisplay(nativeID: id, frame: frame, scale: scale, rotation: rotation)
        }
    }

    /// CGWindowList is ordered front to back. Any visible window whose bounds/owner cannot be proven aborts rather
    /// than being skipped: doing otherwise could click through an opaque security or password overlay.
    @MainActor static func visibleWindows() throws -> [ScopedOSWindow] {
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            throw ControlError.refuse("window-list-unavailable")
        }
        var result: [ScopedOSWindow] = []
        for row in rows {
            guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id > 0,
                  let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0,
                  let layer = (row[kCGWindowLayer as String] as? NSNumber)?.intValue,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
                  let alpha = (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue,
                  alpha.isFinite, alpha >= 0, alpha <= 1,
                  frame.origin.x.isFinite, frame.origin.y.isFinite, frame.width.isFinite, frame.height.isFinite,
                  frame.width >= 0, frame.height >= 0 else { throw ControlError.refuse("window-list-unavailable") }
            if alpha == 0 || frame.width == 0 || frame.height == 0 { continue }
            result.append(ScopedOSWindow(id: id, pid: pid, frame: frame, alpha: alpha, layer: layer,
                                         title: row[kCGWindowName as String] as? String))
        }
        return result
    }

    /// The input target at `point`. `hitPID` is the process the window server's accessibility hit-test says receives
    /// input there; the front-to-back window list must agree. The first window under the point is not the target by
    /// itself: the Dock keeps a display-sized layer-20 sheet in front of every app that passes events through outside
    /// its tiles. Only such a verified sheet (`systemOverlay`) is looked through, and only when the hit-test names
    /// another process. When it names the sheet's owner while any other window lies beneath, a tile cannot be told
    /// from a pass-through, so it refuses. Any other disagreement, an unverifiable owner or a protected target refuses.
    static func pointTarget(at point: CGPoint, hitPID: Int32, windows: [ScopedOSWindow], displays: [ScopedOSDisplay],
                            systemOverlay: (ScopedOSWindow, [ScopedOSDisplay]) -> Bool,
                            resolve: (Int32) throws -> ScopeApplicationIdentity) throws -> ScopeApplicationIdentity {
        guard point.x.isFinite, point.y.isFinite, hitPID > 0 else { throw ControlError.refuse("target-unavailable") }
        var overlayOwners = Set<Int32>(), beneath: ScopedOSWindow?
        for window in windows where window.frame.contains(point) {
            if systemOverlay(window, displays) { overlayOwners.insert(window.pid); continue }
            beneath = window; break
        }
        if let beneath { guard beneath.pid == hitPID else { throw ControlError.refuse("target-unavailable") } }
        else { guard overlayOwners.contains(hitPID) else { throw ControlError.refuse("target-unavailable") } }
        let target = try resolve(hitPID)
        guard target.pid == hitPID, !ScopedProtectedTargets.refuses(bundleId: target.bundleId) else {
            throw ControlError.refuse("protected-target")
        }
        return target
    }

    /// The Dock's transparent full-display sheet, by shape only: Dock window level, the exact frame of one active
    /// display and the observed title. The real caller also requires an Apple-signed com.apple.dock owner.
    static func dockSheet(_ window: ScopedOSWindow, displays: [ScopedOSDisplay]) -> Bool {
        guard window.title == "Dock", window.layer == Int(CGWindowLevelForKey(.dockWindow)) else { return false }
        return displays.contains { display in
            abs(window.frame.minX - display.frame.minX) <= 1 && abs(window.frame.minY - display.frame.minY) <= 1 &&
                abs(window.frame.width - display.frame.width) <= 1 && abs(window.frame.height - display.frame.height) <= 1
        }
    }

    /// The process the window server routes input at `point` to, from the system-wide accessibility hit-test. A timeout
    /// set on the system-wide element is this process's global AX timeout; it is bounded so an unresponsive app refuses
    /// quickly and is reset to the default before returning. Elements given their own timeout elsewhere keep it.
    @MainActor static func accessibilityHitPID(at point: CGPoint) throws -> Int32 {
        guard point.x.isFinite, point.y.isFinite else { throw ControlError.refuse("target-unavailable") }
        let system = AXUIElementCreateSystemWide()
        guard AXUIElementSetMessagingTimeout(system, 0.25) == .success else { throw ControlError.refuse("target-unavailable") }
        defer { _ = AXUIElementSetMessagingTimeout(system, 0) }
        var element: AXUIElement?, pid: pid_t = 0
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success, let element,
              AXUIElementGetPid(element, &pid) == .success, pid > 0 else { throw ControlError.refuse("target-unavailable") }
        return pid
    }

    /// Resolve and re-check the input target at `point` (see `pointTarget`). The hit-test, the windows under the point,
    /// the display layout and every process generation involved must be unchanged across the check.
    /// `requireIdle: false` is for a check after this action's own event (its idle age is the action's, not the person's)
    /// and for background input, which does not move the pointer.
    @MainActor public static func pointTargetIdentity(at point: CGPoint, requireIdle: Bool = true) throws -> ScopeApplicationIdentity {
        if requireIdle { try requireGeneral() } else { try requireConsentEnvironment() }
        let displays = try displayLayout()
        guard displays.filter({ $0.frame.contains(point) }).count == 1 else { throw ControlError.refuse("coordinate-unavailable") }
        let windows = try visibleWindows()
        let hit = try accessibilityHitPID(at: point)
        var overlays: [Int32: UInt64] = [:], pointers: [Int32: UInt64] = [:]
        let result = try pointTarget(at: point, hitPID: hit, windows: windows, displays: displays, systemOverlay: { window, displays in
            // Input passes through the pointer's own window to the window beneath it, which must be the hit-test owner.
            if pointerWindow(window), let start = verifiedCompositor(window.pid) { pointers[window.pid] = start; return true }
            guard dockSheet(window, displays: displays), let start = verifiedApple(window.pid, identifier: "com.apple.dock") else { return false }
            overlays[window.pid] = start; return true
        }, resolve: { try identity(pid: $0) })
        try requireConsentEnvironment()
        guard try displayLayout() == displays else { throw ControlError.refuse("display-changed") }
        guard windows.filter({ $0.frame.contains(point) }) == (try visibleWindows()).filter({ $0.frame.contains(point) }),
              try accessibilityHitPID(at: point) == hit,
              ProcessGeneration.start(result.pid).map(String.init) == result.processStart,
              overlays.allSatisfy({ verifiedApple($0.key, identifier: "com.apple.dock") == $0.value }),
              pointers.allSatisfy({ verifiedCompositor($0.key) == $0.value }) else {
            throw ControlError.refuse("target-changed")
        }
        return result
    }

    /// Known ordinary Control windows can remain behind another app; the capture filter excludes them and point
    /// operations independently check the actual topmost target. System authentication surfaces and protected
    /// higher-level overlays other than AgentsToZ's own always-on-top window still block; unknown owners fail closed.
    /// Only three tightly bounded observed compositor decorations are exempt from global overlay refusal. They are
    /// never an input target. A title or layer alone is not an identity: the real caller also verifies Apple signing.
    static func compositorDecoration(_ window: ScopedOSWindow, displays: [ScopedOSDisplay]) -> Bool {
        let menuLayer = Int(CGWindowLevelForKey(.mainMenuWindow)), cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
        for display in displays where display.frame.intersects(window.frame) {
            if pointerWindow(window) { return true }
            if window.title == "Menubar", window.layer == menuLayer,
               abs(window.frame.minX - display.frame.minX) <= 2, abs(window.frame.minY - display.frame.minY) <= 2,
               abs(window.frame.width - display.frame.width) <= 2, window.frame.height > 0, window.frame.height <= 80 { return true }
            if window.title == "StatusIndicator", window.layer == cursorLayer,
               window.frame.width > 0, window.frame.width <= 64, window.frame.height > 0, window.frame.height <= 64,
               abs(window.frame.minY - display.frame.minY) <= 5 { return true }
        }
        return false
    }
    /// The mouse pointer, when the compositor draws it as its own window (measured 2026-10-31 on macOS 26.7: WindowServer
    /// window 4, 「Cursor」, cursor level, 28×40 at the pointer, while a screen capture was running). It follows the
    /// pointer anywhere, so the frame is bounded by size only (an enlarged accessibility pointer stays under 256 pt).
    /// Unexempted, it refused every v2 capture and action as `protected-overlay`, and a point under it as another owner.
    static func pointerWindow(_ window: ScopedOSWindow) -> Bool {
        window.title == "Cursor" && window.layer == Int(CGWindowLevelForKey(.cursorWindow)) &&
            window.frame.width > 0 && window.frame.width <= 256 && window.frame.height > 0 && window.frame.height <= 256
    }
    static func verifiedCompositor(_ pid: Int32) -> UInt64? { verifiedApple(pid, identifier: "com.apple.WindowServer") }
    /// The process generation of an Apple-anchored process with exactly this signing identifier, or nil.
    static func verifiedApple(_ pid: Int32, identifier: String) -> UInt64? {
        guard pid > 0, identifier.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." }),
              let start = ProcessGeneration.start(pid) else { return nil }
        var code: SecCode?, requirement: SecRequirement?
        let attrs = [kSecGuestAttributePid: pid] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attrs, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString("anchor apple and identifier \"\(identifier)\"" as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess,
              ProcessGeneration.start(pid) == start else { return nil }
        return start
    }
    public static func isVerifiedCompositor(_ identity: ScopeApplicationIdentity) -> Bool {
        identity.bundleId == "com.apple.WindowServer" && verifiedCompositor(identity.pid).map(String.init) == identity.processStart
    }
    /// AgentsToZ's always-on-top 「아젠투지 호출」 window is an ordinary activating window kept in front, so it gets the
    /// rule its sibling windows already get: the capture filter excludes it, a point on it resolves to AgentsToZ and is
    /// refused, and it can take keys only while AgentsToZ is frontmost, which is protected-foreground. Refusing everything
    /// while it was visible anywhere protected nothing more. Only the main app's exact bundle at always-on-top levels
    /// qualifies: tao sets level 5 (its `kCGFloatingWindowLevelKey` key used as a level; measured on that window
    /// 2026-10-28), and 3 is the real floating level should tao correct it. Control and every other protected app keep
    /// blocking above layer 0; security surfaces block at any layer. A nonactivating panel takes keys without its app
    /// being frontmost; an AgentsToZ window made that way must not get this exemption.
    static let ownAlwaysOnTopLayers: Set<Int> = [Int(CGWindowLevelForKey(.floatingWindow)), 5]
    static func ownAlwaysOnTop(_ window: ScopedOSWindow, owner: ScopeApplicationIdentity) -> Bool {
        owner.bundleId.lowercased() == "com.intenet.agentstozbycs" && ownAlwaysOnTopLayers.contains(window.layer)
    }
    /// Control's own control bar (AgentsToZControl/ControlBar.swift) shows who holds the Mac while a grant is open, so it is
    /// up during every capture and action. It is a borderless panel that can never become key or main — no key the AI
    /// sends can reach it — and a point on it still resolves to Control and is refused (protected-target); the capture
    /// filter excludes Control as before. Only the window numbers this process registered for the bar, owned by this
    /// process, at the status-bar level the bar uses, are exempt. Every other Control window keeps blocking above layer 0.
    /// The bar moved up to the status level after another app's floating window covered it on 1호 (2026-10-31); the floating
    /// level stays accepted because 1637 shipped the bar there by mistake and every action was then refused as an overlay.
    static let ownStatusLayers: Set<Int> = [Int(CGWindowLevelForKey(.statusWindow)), Int(CGWindowLevelForKey(.floatingWindow))]
    static func ownStatusWindow(_ window: ScopedOSWindow, ownPid: Int32, ids: Set<UInt32>) -> Bool {
        window.pid == ownPid && ids.contains(window.id) && ownStatusLayers.contains(window.layer)
    }
    @MainActor static func noProtectedOverlays(windows: [ScopedOSWindow], displays: [ScopedOSDisplay],
                                               resolve: (Int32) throws -> ScopeApplicationIdentity,
                                               compositor: (ScopedOSWindow, [ScopedOSDisplay]) -> Bool = { _, _ in false },
                                               ownStatus: Set<UInt32>? = nil) throws -> [Int32: ScopeApplicationIdentity] {
        var identities: [Int32: ScopeApplicationIdentity] = [:]
        let statusIds = ownStatus ?? ScopedOwnStatusWindows.ids, ownPid = ProcessInfo.processInfo.processIdentifier
        for window in windows where displays.contains(where: { $0.frame.intersects(window.frame) }) {
            if compositor(window, displays) { continue }
            if ownStatusWindow(window, ownPid: ownPid, ids: statusIds) { continue }
            let app: ScopeApplicationIdentity
            if let known = identities[window.pid] { app = known }
            else { app = try resolve(window.pid); identities[window.pid] = app }
            // Authentication, consent and security prompts block at any layer (ScopedProtectedTargets.securitySurfaces).
            guard app.pid == window.pid, !ScopedProtectedTargets.blocksWhileVisible(bundleId: app.bundleId),
                  !(window.layer > 0 && ScopedProtectedTargets.refuses(bundleId: app.bundleId) && !ownAlwaysOnTop(window, owner: app)) else {
                throw ControlError.refuse("protected-overlay")
            }
        }
        return identities
    }
    @MainActor public static func requireNoProtectedOverlays(allowOwnForeground: Bool = false) throws {
        try requireConsentEnvironment()
        let foreground = try currentForegroundIdentity()
        let own = foreground.bundleId.lowercased() == "com.intenet.agentstozbycs" ||
            foreground.bundleId.lowercased().hasPrefix("com.intenet.agentstozbycs.")
        guard !ScopedProtectedTargets.refuses(bundleId: foreground.bundleId) || (allowOwnForeground && own) else {
            throw ControlError.refuse("protected-foreground")
        }
        let displays = try displayLayout(), windows = try visibleWindows()
        var compositors: [Int32: UInt64] = [:]
        let identities = try noProtectedOverlays(windows: windows, displays: displays, resolve: { try identity(pid: $0) }, compositor: { window, displays in
            guard compositorDecoration(window, displays: displays), let start = verifiedCompositor(window.pid) else { return false }
            compositors[window.pid] = start; return true
        })
        try requireConsentEnvironment()
        guard try displayLayout() == displays else { throw ControlError.refuse("display-changed") }
        guard try visibleWindows() == windows,
              identities.values.allSatisfy({ ProcessGeneration.start($0.pid).map(String.init) == $0.processStart }),
              compositors.allSatisfy({ verifiedCompositor($0.key) == $0.value }) else {
            throw ControlError.refuse("target-changed")
        }
    }
}
