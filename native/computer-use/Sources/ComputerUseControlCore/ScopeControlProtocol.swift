import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// Version 2 is a separate capability: accepting this envelope never grants authority or starts an operation.
/// Callers must still perform authenticated approval, binding, fencing and all native action checks.
public struct ScopeControlRequest {
    public let channel: ControlChannel
    public let operation: String
    public let body: [String: Any]

    static let shapes: [String: Set<String>] = [
        "scope-status": [], "scope-catalog": [], "scope-disconnect-owner": [],
        "scope-request-approval": ["approvalId", "scope", "caller", "label", "expiresAt"],
        "scope-approval-status": ["approvalId", "caller"],
        "scope-open-grant": ["approvalId", "scope", "caller"],
        "scope-observe": ["grant", "caller"],
        "scope-capture": ["grant", "caller", "snapshotId", "displayId"],
        "scope-click": ["grant", "caller", "requestId", "snapshotId", "displayId", "x", "y", "button", "clickCount"],
        "scope-type-text": ["grant", "caller", "requestId", "snapshotId", "text"],
        "scope-key": ["grant", "caller", "requestId", "snapshotId", "key", "modifiers"],
        "scope-scroll": ["grant", "caller", "requestId", "snapshotId", "displayId", "x", "y", "deltaX", "deltaY"],
        "scope-drag": ["grant", "caller", "requestId", "snapshotId", "displayId", "x", "y", "endX", "endY"],
        "scope-focus-app": ["grant", "caller", "requestId", "snapshotId", "applicationId"],
        "scope-receipt": ["grant", "caller", "requestId"],
        "scope-revoke": ["grant", "caller"], "scope-revoke-session": ["sessionId"], "scope-standing-off": []]
    public static let agentOperations: Set<String> = ["scope-status", "scope-request-approval", "scope-approval-status",
        "scope-open-grant", "scope-observe", "scope-capture", "scope-click", "scope-type-text", "scope-key", "scope-scroll",
        "scope-drag", "scope-focus-app", "scope-receipt", "scope-revoke", "scope-revoke-session", "scope-disconnect-owner",
        // The main app's 「끄기」 (sent over the sidecar's link): ends the standing allowance. Nothing turns it on but
        // Control's own window.
        "scope-standing-off"]
    public static let managementOperations: Set<String> = ["scope-status", "scope-catalog", "scope-request-approval",
        "scope-approval-status", "scope-revoke", "scope-revoke-session", "scope-disconnect-owner"]

    /// These accessors are used only after strict decode; callers still bind every value to the authenticated owner.
    public var caller: ControlCaller? { ControlRequest.caller(body["caller"]) }
    public var parsedScope: ScopeApprovalScope? { Self.scope(body["scope"]) }

    public static func scope(_ value: Any?) -> ScopeApprovalScope? {
        guard let object = value as? [String: Any], let kind = object["kind"] as? String else { return nil }
        if kind == "desktop", Set(object.keys) == ["kind"] { return .desktop }
        guard kind == "application", Set(object.keys) == ["kind", "application"],
              let a = object["application"] as? [String: Any],
              Set(a.keys) == ["bundleId", "teamId", "codeHash", "pid", "processStart"],
              let bundle = a["bundleId"] as? String, let team = a["teamId"] as? String,
              let hash = a["codeHash"] as? String, let start = a["processStart"] as? String,
              let pid = ControlRequest.integer(a["pid"]), pid > 0, pid <= Int64(Int32.max) else { return nil }
        let application = ScopeApplicationIdentity(bundleId: bundle, teamId: team, codeHash: hash, pid: Int32(pid), processStart: start)
        return ComputerUseScopeApproval.validApplication(application) ? .application(application) : nil
    }

    public static func decode(_ data: Data) throws -> ScopeControlRequest {
        guard data.count <= ControlLimits.requestBytes, let object = try? JSONSerialization.jsonObject(with: data),
              let body = object as? [String: Any], ControlRequest.integer(body["v"]) == 2,
              let channelName = body["channel"] as? String, let channel = ControlChannel(rawValue: channelName),
              let op = body["op"] as? String, let shape = shapes[op],
              (channel == .agent ? agentOperations : managementOperations).contains(op),
              Set(body.keys) == shape.union(["v", "channel", "op"]) else { throw ControlError.invalid }
        if shape.contains("approvalId"), ControlRequest.approvalId(body["approvalId"]) == nil { throw ControlError.invalid }
        if shape.contains("scope"), scope(body["scope"]) == nil { throw ControlError.invalid }
        if shape.contains("caller"), ControlRequest.caller(body["caller"]) == nil { throw ControlError.invalid }
        if shape.contains("label"), ControlRequest.label(body["label"]) == nil { throw ControlError.invalid }
        if shape.contains("expiresAt"), !(ControlRequest.integer(body["expiresAt"]).map { $0 > 0 } ?? false) { throw ControlError.invalid }
        if shape.contains("grant"), ControlRequest.grantId(body["grant"]) == nil { throw ControlError.invalid }
        if shape.contains("requestId"), ControlRequest.requestId(body["requestId"]) == nil { throw ControlError.invalid }
        for key in ["snapshotId", "displayId", "applicationId"] where shape.contains(key) {
            guard ControlRequest.token(body[key], ControlLimits.snapshotBytes) != nil else { throw ControlError.invalid }
        }
        if shape.contains("sessionId") {
            guard let session = body["sessionId"] as? String,
                  ComputerUseApproval.validCaller(ApprovalCaller(sessionId: session, lane: "x")) else { throw ControlError.invalid }
        }
        for key in ["x", "y", "endX", "endY"] where shape.contains(key) {
            guard ControlRequest.coordinate(body[key]) != nil else { throw ControlError.invalid }
        }
        for key in ["deltaX", "deltaY"] where shape.contains(key) {
            guard let value = ControlRequest.integer(body[key]), (-1200...1200).contains(value) else { throw ControlError.invalid }
        }
        if shape.contains("text") {
            guard let value = body["text"] as? String, !value.isEmpty, !value.utf8.contains(0),
                  value.utf8.count <= ControlLimits.valueBytes else { throw ControlError.invalid }
        }
        if op == "scope-click" {
            guard let button = body["button"] as? String, ["left", "right"].contains(button),
                  let count = ControlRequest.integer(body["clickCount"]), [1, 2].contains(count) else { throw ControlError.invalid }
        }
        if op == "scope-key" {
            guard let key = body["key"] as? String, validKey(key), let modifiers = body["modifiers"] as? [String],
                  modifiers.count <= 4, Set(modifiers).count == modifiers.count,
                  modifiers.allSatisfy({ ["cmd", "ctrl", "alt", "shift"].contains($0) }) else { throw ControlError.invalid }
        }
        return ScopeControlRequest(channel: channel, operation: op, body: body)
    }

    private static func validKey(_ key: String) -> Bool {
        if key.utf8.count == 1, let b = key.utf8.first, (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) { return true }
        return ["Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                "Home", "End", "PageUp", "PageDown"].contains(key)
    }
}
