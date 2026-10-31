import AppKit
import ApplicationServices
import Carbon
import ComputerUseApproval
import ComputerUseControlCore
import Foundation
import PeekabooAutomationKit
import PeekabooFoundation
import Security

/// The exact-window Accessibility engine, shared by AgentsToZ Control (in its own process, production) and the
/// lab worker (a child process, labs and tests only). It reads and acts on one exact window through AX actions only:
/// no foreground activation, clipboard, keyboard synthesis or global pointer API.
public enum ComputerUseEngine {
    /// A person who used any input device this recently keeps priority over a background action.
    public static let humanIdleSeconds = 1.5
    /// Seconds since the last real input from any HID device (keys, pointer, buttons, scroll, trackpad).
    /// Read-only: needs no permission and creates no event. AX actions themselves produce no HID input.
    public static func secondsSinceHumanInput() -> Double {
        guard let any = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
    }
    public static var accessibilityTrusted: Bool { AXIsProcessTrusted() }
    public static var secureInput: Bool { IsSecureEventInputEnabled() }

    /// The signing team and code hash of a running process, from its own signature.
    static func signature(_ pid: Int32) throws -> (team: String, hash: String) {
        var code: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
              let code else { throw ControlError("identity-unavailable") }
        guard SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess else {
            throw ControlError("identity-unavailable")
        }
        var info: CFDictionary?
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let info = info as? [String: Any], let hash = info[kSecCodeInfoUnique as String] as? Data else {
            throw ControlError("identity-unavailable")
        }
        return (info[kSecCodeInfoTeamIdentifier as String] as? String ?? "", hash.map { String(format: "%02x", $0) }.joined())
    }
    /// The exact identity of one on-screen window of a running app, resolved here and never taken from a request.
    @MainActor public static func identity(pid: Int32, window: UInt32) throws -> ApprovalTarget {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              let bundle = app.bundleIdentifier else { throw ControlError("target-unavailable") }
        guard !RefusedTargets.refuses(bundle: bundle) else { throw ControlError("target-refused") }
        guard let start = SystemIdentityResolver.processStartIdentity(pid),
              let w = SystemIdentityResolver.windowIdentity(window), w.ownerProcessIdentifier == pid,
              w.layer == 0, w.isOnScreen, w.bounds.width > 0, w.bounds.height > 0 else {
            throw ControlError("target-unavailable")
        }
        let (team, hash) = try signature(pid)
        guard !RefusedTargets.teams.contains(team) else { throw ControlError("target-refused") }
        return ApprovalTarget(bundleId: bundle, teamId: team, codeHash: hash, pid: pid, processStart: String(start), windowId: window)
    }
    /// What the person sees in Control's review window: the app's own name and the window title, read here.
    @MainActor public static func describe(_ target: ApprovalTarget) -> (app: String, window: String)? {
        guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated,
              let w = SystemIdentityResolver.windowIdentity(target.windowId), w.ownerProcessIdentifier == target.pid else { return nil }
        return (String((app.localizedName ?? target.bundleId).prefix(100)), String(w.title.prefix(200)))
    }
    /// Every window of every regular app, for a person's picker only; never an agent tool.
    @MainActor public static func catalog(limit: Int = 100) -> [[String: Any]] {
        var windows: [[String: Any]] = []
        appScan: for app in NSWorkspace.shared.runningApplications.filter({ $0.activationPolicy == .regular }).prefix(limit) {
            for w in SystemIdentityResolver.windowIdentities(ownerProcessIdentifier: app.processIdentifier).prefix(limit) {
                if let t = try? identity(pid: app.processIdentifier, window: w.windowID) {
                    var entry = ControlResponse.target(t)
                    entry["title"] = String(w.title.prefix(200)); entry["appName"] = String((app.localizedName ?? "").prefix(100))
                    windows.append(entry)
                    if windows.count >= limit { break appScan }
                }
            }
        }
        return windows
    }
}

/// One exact window bound for reading and AX actions. A fail-closed backend, not a virtual desktop: some AX actions
/// bring their own app forward; that is detected and stops the session, and focus is never restored.
@MainActor
public final class TargetSession {
    public let target: ApprovalTarget
    /// Reported in every answer so the host never shows a stopped session as alive.
    public private(set) var halted = false
    lazy var tree = ExactAXTree(driver: NativeAXDriver(pid: target.pid, windowID: target.windowId))
    var expiry: Task<Void, Never>?
    var snapshot: String?
    var observedAt = Date.distantPast
    var capturedFrame: CGRect?

    public init(target: ApprovalTarget) { self.target = target }

    struct HumanState: Equatable {
        enum Focus: Equatable { case element(AXUIElement), absent, unavailable }
        let frontmost: Int32?
        let focusedWindow: Focus
        let focusedElement: Focus
        let cursor: CGPoint
        var verifiable: Bool { frontmost != nil && focusedWindow != .unavailable && focusedElement != .unavailable }
    }
    func humanState() -> HumanState {
        let app = NSWorkspace.shared.frontmostApplication
        func identity(_ attr: CFString) -> HumanState.Focus {
            guard let pid = app?.processIdentifier else { return .unavailable }
            let application = AXUIElementCreateApplication(pid)
            guard AXUIElementSetMessagingTimeout(application, 0.15) == .success else { return .unavailable }
            var value: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(application, attr, &value)
            if result == .noValue || result == .attributeUnsupported { return .absent }
            guard result == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return .unavailable }
            return .element(value as! AXUIElement)
        }
        return HumanState(frontmost: app?.processIdentifier, focusedWindow: identity(kAXFocusedWindowAttribute as CFString),
                          focusedElement: identity(kAXFocusedUIElementAttribute as CFString), cursor: NSEvent.mouseLocation)
    }
    /// The target is still the exact process generation and window, and this process may act.
    public func validate() throws {
        guard !halted else { throw ControlError("worker-halted") }
        guard try ComputerUseEngine.identity(pid: target.pid, window: target.windowId) == target else { throw ControlError("target-changed") }
        guard ComputerUseEngine.accessibilityTrusted, !ComputerUseEngine.secureInput else { throw ControlError("permission-or-secure-input") }
    }
    public func observe() async throws -> [String: Any] {
        // A new observation always replaces the last one, also when it fails.
        snapshot = nil; capturedFrame = nil; tree.clear(); expiry?.cancel()
        try validate()
        let before = humanState()
        guard before.verifiable else { throw ControlError("human-state-unavailable") }
        let id = "ax_snapshot_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let result = try tree.observe()
        do { try validate() } catch { tree.clear(); throw error }
        // Reading moves nothing. A person who moved or switched focus meanwhile voids this observation only.
        guard humanState() == before else { tree.clear(); throw ControlError("observation-discarded") }
        snapshot = id; observedAt = Date()
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self, self.snapshot == id else { return }
            self.snapshot = nil; self.capturedFrame = nil; self.tree.clear()
        }
        return ["snapshotId": id, "elements": result.elements, "truncated": result.truncated]
    }
    /// One AX press or text value on an element of the last observation. Refusals before dispatch are
    /// `notDispatched`; from the action on, any failure is uncertain and is never retried.
    public func perform(_ operation: String, snapshotId: String, element key: String, value: String?, coordinate: (Double, Double)? = nil) async throws -> [String: Any] {
        guard snapshotId == snapshot, Date().timeIntervalSince(observedAt) <= 15 else {
            throw ControlError.refuse("stale-observation")
        }
        // One observation, one attempt: consumed before any other check, so a refusal never leaves it reusable.
        snapshot = nil; expiry?.cancel()
        let expectedFrame = capturedFrame; capturedFrame = nil
        defer { tree.clear() }
        do { try validate() } catch {
            let code = (error as? ControlError)?.code ?? ""
            throw ControlError.refuse(["worker-halted", "permission-or-secure-input"].contains(code) ? code : "target-changed")
        }
        // Whoever is at the Mac keeps priority: an AX action can bring its own app forward and take the
        // person's next keystroke or click. Hold until they pause instead of racing them.
        let idle = ComputerUseEngine.secondsSinceHumanInput()
        guard idle >= ComputerUseEngine.humanIdleSeconds else {
            throw ControlError.refuse("human-active", retryAfterMs: Int(((ComputerUseEngine.humanIdleSeconds - max(0, idle)) * 1000).rounded(.up)))
        }
        let before = humanState()
        guard before.verifiable else { throw ControlError.refuse("human-state-unavailable") }
        guard before.frontmost != target.pid else { throw ControlError.refuse("human-using-target-app") }
        let outcome = try tree.perform(operation, element: key, value: value, coordinate: coordinate) {
            try self.validate()
            if coordinate != nil {
                let driver = NativeAXDriver(pid: self.target.pid, windowID: self.target.windowId)
                guard let expectedFrame, let window = try? driver.window(), driver.frame(of: window) == expectedFrame else {
                    throw ControlError.refuse("target-changed")
                }
            }
            guard ComputerUseEngine.secondsSinceHumanInput() >= ComputerUseEngine.humanIdleSeconds,
                  self.humanState() == before else { throw ControlError.refuse("human-active", retryAfterMs: 1500) }
        }
        try validate()
        let preserved = humanState() == before
        if !preserved { halted = true }
        return ["outcome": outcome, "humanStatePreserved": preserved]
    }
    /// A coordinate only selects an observed object. The mutation is AXPress on that same object,
    /// never a synthesized mouse event; the hit test is repeated just before dispatch.
    public func click(snapshotId: String, x: Double, y: Double) async throws -> [String: Any] {
        guard snapshotId == snapshot, Date().timeIntervalSince(observedAt) <= 15 else {
            throw ControlError.refuse("stale-observation")
        }
        let driver = NativeAXDriver(pid: target.pid, windowID: target.windowId)
        guard let capturedFrame, let window = try? driver.window(), driver.frame(of: window) == capturedFrame else {
            snapshot = nil; self.capturedFrame = nil; expiry?.cancel(); tree.clear()
            throw ControlError.refuse("target-changed")
        }
        let key: String
        do { key = try tree.coordinateElement(x: x, y: y) }
        catch {
            // Selecting sent nothing: whatever failed, this is a refusal, never an outcome-unknown that stops the grant.
            snapshot = nil; self.capturedFrame = nil; expiry?.cancel(); tree.clear()
            let failure = error as? ControlError
            throw ControlError.refuse(failure?.code ?? "coordinate-unavailable", retryAfterMs: failure?.retryAfterMs)
        }
        return try await perform("press", snapshotId: snapshotId, element: key, value: nil, coordinate: (x, y))
    }
    public func stop() { halted = true; snapshot = nil; capturedFrame = nil; expiry?.cancel(); tree.clear() }
}
