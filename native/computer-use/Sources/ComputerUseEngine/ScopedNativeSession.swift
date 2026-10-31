import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import CoreGraphics
import Foundation

/// One admitted scoped grant. All mutation outcomes remain unverified until a later observation confirms effect.
/// The service must supply a grant/owner/caller validator and record an unknown receipt before calling `act`.
@MainActor
public final class ScopedNativeSession {
    private struct Snapshot {
        let id: String
        let at: Date
        let displays: [ScopedDisplayGeometry]
        let applications: [String: ScopeApplicationIdentity]
        let foreground: ScopeApplicationIdentity?
        let physical: String
    }
    private let scope: ScopeApprovalScope
    private let validateGrant: () throws -> Void
    private var snapshot: Snapshot?
    private var capturedDisplay: String?
    private var busy = false
    private var stopped = false
    public private(set) var actionFailureCode: String?
    /// Bounded idle-age and counter readings around the last action's events (ScopedGuardProbe); diagnostic only.
    public private(set) var actionGuardSamples: ScopedGuardSamples?

    public init(scope: ScopeApprovalScope, validateGrant: @escaping () throws -> Void) {
        self.scope = scope; self.validateGrant = validateGrant
    }
    public func stop() { stopped = true; snapshot = nil; capturedDisplay = nil }
    private func validate() throws {
        guard !stopped else { throw ControlError.refuse("worker-halted") }
        try validateGrant()
        if case .application(let app) = scope {
            guard try ScopedApplicationCatalog.identity(pid: app.pid) == app else { throw ControlError.refuse("target-changed") }
        }
    }
    private func checkAction(_ check: () throws -> Void) throws {
        do { try check() }
        catch let error as ControlError { actionFailureCode = error.code; throw error }
        catch { actionFailureCode = "native-guard-unavailable"; throw error }
    }
    private func current(_ id: String) throws -> Snapshot {
        try validate()
        guard let snapshot, snapshot.id == id, Date().timeIntervalSince(snapshot.at) >= 0,
              Date().timeIntervalSince(snapshot.at) <= Double(ControlLimits.observationMs) / 1000 else {
            throw ControlError.refuse("stale-observation")
        }
        return snapshot
    }
    private func layout(_ existing: [ScopedDisplayGeometry]) throws -> [ScopedDisplayGeometry] {
        let system = try ScopedOSGuard.displayLayout()
        guard system.count == existing.count else { throw ControlError.refuse("display-changed") }
        return try system.map { item in
            guard let previous = existing.first(where: { $0.nativeID == item.nativeID }) else { throw ControlError.refuse("display-changed") }
            return ScopedDisplayGeometry(id: previous.id, nativeID: item.nativeID, frame: item.frame, scale: item.scale, rotation: item.rotation)
        }
    }
    private func requireCurrentLayout(_ snap: Snapshot) throws {
        guard try layout(snap.displays) == snap.displays else { throw ControlError.refuse("display-changed") }
    }
    private func scopeAllows(_ identity: ScopeApplicationIdentity) -> Bool { Self.allows(identity, in: scope) }
    /// Whole Mac admits any unprotected app; an app scope admits exactly the approved running process.
    nonisolated static func allows(_ identity: ScopeApplicationIdentity, in scope: ScopeApprovalScope) -> Bool {
        if ScopedProtectedTargets.refuses(bundleId: identity.bundleId) { return false }
        if case .application(let selected) = scope { return identity == selected }
        return true
    }

    public func observe() throws -> [String: Any] {
        guard !busy else { throw ControlError.refuse("process-busy") }
        busy = true; defer { busy = false }
        snapshot = nil; capturedDisplay = nil
        // Seeing the screen does not need the person to be idle: background input never shares the pointer with them.
        // The counters are kept so that pointer input can still tell that the person moved since this observation.
        try validate(); try ScopedOSGuard.requireConsentEnvironment()
        let seen = try ScopedOSGuard.foregroundEvidence(allowProtectedForeground: true)
        let physical = try ScopedOSGuard.physicalEvidence(requireIdle: false)
        let systemDisplays = try ScopedOSGuard.displayLayout()
        let displays = systemDisplays.map { item in
            ScopedDisplayGeometry(id: "display_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased(),
                                  nativeID: item.nativeID, frame: item.frame, scale: item.scale, rotation: item.rotation)
        }
        var apps: [String: ScopeApplicationIdentity] = [:], output: [[String: Any]] = []
        for entry in ScopedApplicationCatalog.list() {
            guard let body = entry["application"] as? [String: Any], let pid = (body["pid"] as? NSNumber)?.int32Value,
                  let identity = try? ScopedApplicationCatalog.identity(pid: pid), scopeAllows(identity) else { continue }
            let id = "app_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            apps[id] = identity
            output.append(["id": id, "name": entry["name"] as? String ?? identity.bundleId, "bundleId": identity.bundleId])
        }
        if case .application(let selected) = scope, !apps.values.contains(selected) { throw ControlError.refuse("target-changed") }
        let foreground = try ScopedOSGuard.currentForegroundIdentity()
        let frontId = apps.first(where: { $0.value == foreground })?.key
        let front: [String: Any]? = frontId.map { ["applicationId": $0, "bundleId": foreground.bundleId,
                                                   "pid": foreground.pid, "processStart": foreground.processStart] }
        try validate()
        guard try ScopedOSGuard.foregroundEvidence(allowProtectedForeground: true) == seen,
              try ScopedOSGuard.displayLayout() == systemDisplays else {
            throw ControlError.refuse("observation-discarded")
        }
        let id = "scope_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        snapshot = Snapshot(id: id, at: Date(), displays: displays, applications: apps, foreground: foreground, physical: physical)
        let scopeData = try JSONEncoder().encode(scope)
        let scopeJSON = try JSONSerialization.jsonObject(with: scopeData)
        return ["snapshotId": id, "scope": scopeJSON, "applications": output,
                "displays": displays.map { ["id": $0.id, "originX": $0.frame.origin.x, "originY": $0.frame.origin.y,
                                             "width": $0.frame.width, "height": $0.frame.height,
                                             "scale": $0.scale, "rotation": $0.rotation] },
                "foreground": front as Any? ?? NSNull()]
    }

    public func capture(snapshotId: String, displayId: String) async throws -> [String: Any] {
        guard !busy else { throw ControlError.refuse("process-busy") }
        busy = true; defer { busy = false }
        let snap = try current(snapshotId)
        capturedDisplay = nil
        let checks = ScopedCaptureChecks(validateGrant: { try self.validate() },
            observationCurrent: { (try? self.current(snapshotId)) != nil }, humanEvidence: { try ScopedOSGuard.foregroundEvidence() },
            protectedOverlaysAbsent: { try ScopedOSGuard.requireNoProtectedOverlays(); return true },
            displayLayout: { try self.layout(snap.displays) }, resolveApplication: { pid, bundle in
                let identity = try ScopedOSGuard.identity(pid: pid)
                // The catalog's empty WindowServer bundle resolves only through the signed-compositor check.
                guard identity.bundleId == bundle || bundle.isEmpty && ScopedOSGuard.isVerifiedCompositor(identity) else {
                    throw ControlError.refuse("target-changed")
                }
                return identity
            }, isProtectedApplication: {
                // The verified WindowServer compositor is not an input target or an agent-visible app; the desktop
                // filter must retain it so the menu bar and background remain present. Overlay checks are separate.
                ScopedOSGuard.isVerifiedCompositor($0) ? false : ScopedProtectedTargets.refuses(bundleId: $0.bundleId)
            })
        let result = try await captureScopedDisplay(scope: scope, displayID: displayId, layout: snap.displays, checks: checks)
        _ = try current(snapshotId); try requireCurrentLayout(snap); capturedDisplay = displayId
        return result
    }

    /// Coordinates must reference the same display image from the same observation. `body` has already passed strict
    /// v2 decoding. A service receipt must be created before this method is invoked.
    public func act(operation: String, body: [String: Any]) async throws -> MutationResult {
        actionFailureCode = nil; actionGuardSamples = nil
        guard !busy, let id = body["snapshotId"] as? String else { throw ControlError.refuse("process-busy") }
        busy = true; defer { busy = false; snapshot = nil; capturedDisplay = nil }
        let snap = try current(id)
        let coordinate = ["scope-click", "scope-scroll", "scope-drag"].contains(operation)
        let keyboard = ["scope-type-text", "scope-key"].contains(operation)
        let displayID = body["displayId"] as? String
        let selected = snap.displays.first(where: { $0.id == displayID })
        if coordinate, (displayID == nil || capturedDisplay != displayID || selected == nil) { return .refused("capture-required") }
        let x = (body["x"] as? NSNumber)?.doubleValue ?? 0, y = (body["y"] as? NSNumber)?.doubleValue ?? 0
        let initialPoint = selected.flatMap { ScopedEventDispatcher.point(display: $0.frame, x: x, y: y) }
        if coordinate && initialPoint == nil { return .refused("coordinate-unavailable") }
        // Pointer input shares the person's pointer: before its first event the person must be idle (1.5 s) and unchanged
        // since the observation; after it the idle age is this action's own, so the counters alone show the person.
        let guardTarget: (CGPoint, Bool) throws -> Void = { point, afterPost in
            try self.checkAction {
                let target = try ScopedOSGuard.pointTargetIdentity(at: point, requireIdle: !afterPost)
                guard self.scopeAllows(target) else { throw ControlError.refuse("target-refused") }
            }
        }
        let guardOperation: (Bool) throws -> Void = { afterPost in
            try self.checkAction {
            _ = try self.current(id); try self.requireCurrentLayout(snap)
            if afterPost { try ScopedOSGuard.requireConsentEnvironment() } else { try ScopedOSGuard.requireGeneral() }
            try ScopedOSGuard.requireSamePhysicalCounters(try ScopedOSGuard.physicalEvidence(requireIdle: false), observed: snap.physical)
            try ScopedOSGuard.requireNoProtectedOverlays(allowOwnForeground: operation == "scope-focus-app")
            if keyboard {
                try ScopedOSGuard.requireSafeFocus(forText: operation == "scope-type-text")
                let front = try ScopedOSGuard.foregroundIdentity()
                guard front == snap.foreground, self.scopeAllows(front) else { throw ControlError.refuse("target-changed") }
            }
            if operation == "scope-focus-app" {
                let front = try ScopedOSGuard.currentForegroundIdentity()
                let own = front.bundleId.lowercased() == "com.intenet.agentstozbycs" || front.bundleId.lowercased().hasPrefix("com.intenet.agentstozbycs.")
                guard front == snap.foreground, own || !ScopedProtectedTargets.refuses(bundleId: front.bundleId) else {
                    throw ControlError.refuse("target-changed")
                }
            }
            if let initialPoint, coordinate { try guardTarget(initialPoint, afterPost) }
            }
        }
        // Background input: the target's identity and scope, the observation and the consent environment, never the
        // person's activity — they may keep using the Mac. A guard failing after something was sent is unknown.
        let guardBackground: (ScopeApplicationIdentity) throws -> Void = { target in
            try self.checkAction {
                _ = try self.current(id); try self.requireCurrentLayout(snap); try ScopedOSGuard.requireConsentEnvironment()
                try ScopedOSGuard.requireNoProtectedOverlays()
                guard (try? ScopedApplicationCatalog.identity(pid: target.pid)) == target, self.scopeAllows(target) else {
                    throw ControlError.refuse("target-changed")
                }
            }
        }
        let background = { (result: MutationResult) -> MutationResult in result == .humanTakeover ? .unknown : result }
        // Keys and text go to the observed foreground app (or the approved app) without it having to stay in front.
        let keyboardTarget: () throws -> ScopeApplicationIdentity = {
            guard let target = snap.foreground, self.scopeAllows(target) else { throw ControlError.refuse("target-changed") }
            try guardBackground(target); return target
        }
        let probe = ScopedGuardProbe.live(observedEvidence: snap.physical)
        defer { actionGuardSamples = probe.samples }
        let dispatcher = ScopedEventDispatcher(sink: ScopedSessionEventSink(), probe: probe, validate: guardOperation)
        switch operation {
        case "scope-click":
            guard let display = selected, let button = body["button"] as? String, let count = (body["clickCount"] as? NSNumber)?.intValue else { return .refused("invalid-request") }
            // A single left click on a pressable control or a text field is done without the pointer. Anything else —
            // a right or double click, a spot with no such element, a dialog — uses the pointer and its guards.
            if button == "left", count == 1, let point = initialPoint {
                let action: (ScopeApplicationIdentity, ScopedAccessibilityInput.Click)?
                do {
                    let target = try ScopedOSGuard.pointTargetIdentity(at: point, requireIdle: false)
                    guard scopeAllows(target) else { actionFailureCode = "target-refused"; return .refused("guard-refused") }
                    try guardBackground(target)
                    action = ScopedAccessibilityInput.click(at: point, pid: target.pid).map { (target, $0) }
                } catch let error as ControlError { actionFailureCode = actionFailureCode ?? error.code; return .refused("guard-refused") }
                catch { actionFailureCode = "native-guard-unavailable"; return .refused("guard-refused") }
                if let (target, click) = action {
                    do { try guardBackground(target) } catch { return .refused("guard-refused") }
                    return ScopedAccessibilityInput.perform(click)
                }
            }
            return dispatcher.click(display: display.frame, x: x, y: y, right: button == "right", count: count)
        case "scope-scroll":
            guard let display = selected, let dx = (body["deltaX"] as? NSNumber)?.int32Value, let dy = (body["deltaY"] as? NSNumber)?.int32Value else { return .refused("invalid-request") }
            return dispatcher.scroll(display: display.frame, x: x, y: y, deltaX: dx, deltaY: dy)
        case "scope-drag":
            guard let display = selected, let endX = (body["endX"] as? NSNumber)?.doubleValue, let endY = (body["endY"] as? NSNumber)?.doubleValue else { return .refused("invalid-request") }
            return await dispatcher.drag(display: display.frame, x: x, y: y, endX: endX, endY: endY, validatePoint: { try guardTarget($0, true) })
        case "scope-type-text":
            guard let text = body["text"] as? String, !text.isEmpty, !text.utf8.contains(0), text.utf8.count <= ControlLimits.valueBytes else { return .refused("invalid-request") }
            let target: ScopeApplicationIdentity, field: AXUIElement?
            do { target = try keyboardTarget(); field = try ScopedOSGuard.backgroundFocus(of: target, forText: true) }
            catch let error as ControlError { actionFailureCode = actionFailureCode ?? error.code; return .refused("guard-refused") }
            catch { actionFailureCode = "native-guard-unavailable"; return .refused("guard-refused") }
            if let field {
                do { try guardBackground(target) } catch { return .refused("guard-refused") }
                if let inserted = ScopedAccessibilityInput.insert(text, into: field) { return inserted }
            }
            let keys = ScopedEventDispatcher(sink: ScopedProcessEventSink(pid: target.pid), validate: { _ in
                try guardBackground(target); _ = try ScopedOSGuard.backgroundFocus(of: target, forText: true)
            })
            return background(keys.typeText(text))
        case "scope-key":
            guard let key = body["key"] as? String, let modifiers = body["modifiers"] as? [String] else { return .refused("invalid-request") }
            let target: ScopeApplicationIdentity
            do { target = try keyboardTarget(); _ = try ScopedOSGuard.backgroundFocus(of: target, forText: false) }
            catch let error as ControlError { actionFailureCode = actionFailureCode ?? error.code; return .refused("guard-refused") }
            catch { actionFailureCode = "native-guard-unavailable"; return .refused("guard-refused") }
            let keys = ScopedEventDispatcher(sink: ScopedProcessEventSink(pid: target.pid), validate: { _ in
                try guardBackground(target); _ = try ScopedOSGuard.backgroundFocus(of: target, forText: false)
            })
            return background(keys.key(key, modifiers: modifiers))
        case "scope-focus-app":
            guard let appId = body["applicationId"] as? String, let app = snap.applications[appId], scopeAllows(app),
                  (try? ScopedApplicationCatalog.identity(pid: app.pid)) == app,
                  let running = NSRunningApplication(processIdentifier: app.pid) else { return .refused("target-changed") }
            do { try guardOperation(false) } catch { return .refused("guard-refused") }
            // On the first action after approval Control itself may be foreground. In that case yield the explicit
            // request cooperatively; never yield on behalf of another foreground application or force activation.
            if NSApp.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier {
                do { try guardOperation(false) } catch { return .refused("guard-refused") }
                guard (try? ScopedApplicationCatalog.identity(pid: app.pid)) == app else { return .refused("target-changed") }
                NSApp.yieldActivation(to: running)
            }
            // The OS may deny focus or accept without making it visible; a fresh observation confirms the effect.
            return running.activate(from: NSRunningApplication.current, options: []) ? .dispatchedUnverified : .refused("activation-refused")
        default: return .refused("invalid-request")
        }
    }
}
