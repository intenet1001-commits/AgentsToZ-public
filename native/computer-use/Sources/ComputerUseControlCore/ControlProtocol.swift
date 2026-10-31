import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// The XPC contract between the AgentsToZ main app (the only peer AgentsToZ Control accepts, by code-signing
/// requirement) and AgentsToZ Control. One JSON object per request and per reply, bounded both ways, through the one
/// method `request(_:reply:)`. CONTRACT.md next to this package lists every shape with examples. Nothing here starts
/// a process, takes a path, an executable or a requirement string from the peer, or stores a token: trust comes from
/// the verified connection, the main app's process generation and the person's approval in Control's own window.
public enum ControlContract {
    public static let version = 1
    /// The answers to open-grant/observe/press/set-value keep the lab worker's protocol 2 shape (src/computerUseHost.ts).
    public static let workerProtocol = 2
    /// The engine operations this Control answers, listed as `operations` in `status` and `open-grant`. A Control built
    /// before capture/click sends no list, so the main app refuses those two up front (`control-update-required`) and
    /// keeps observe/press/set-value, instead of failing them as requests it cannot explain (src/computerUseNative.ts).
    public static let engineOperations = ["capture", "click", "observe", "press", "receipt", "set-value"]
    public static let machService = "com.intenet.agentstozbycs.control.xpc"
    public static let agentLabel = "com.intenet.agentstozbycs.control.agent"
    public static let agentPlistName = "com.intenet.agentstozbycs.control.agent.plist"
}

public enum ControlLimits {
    public static let pendingApprovals = 8
    /// How long a request waits for the person (2026-10-31: 120 s → 10 min — 120 s often ran out before the person
    /// reached Control, and the expired request then had to be asked again). The grant it opens is unchanged.
    public static let approvalMs: Int64 = 600_000
    public static let skewMs: Int64 = 5_000
    public static let grantMs: Int64 = 600_000
    public static let grants = 8
    public static let receiptsPerGrant = 64
    /// v2 (whole Mac / one app) lasts until the person switches computer use off, the main app or Control restarts,
    /// or the AI's connection ends. This 30-day horizon only bounds the opened grant's integer expiry; it is never
    /// shown as a countdown. The window grant (`grantMs`, 600 s) is unchanged.
    public static let scopeGrantMs: Int64 = 2_592_000_000
    /// v2: the newest receipts kept in full for `receipt`. Older request IDs stay spent and are never dispatched again.
    public static let scopeReceiptsKept = 256
    /// v2: actions one approval can take (the memory bound of its spent request IDs); then a new approval is needed.
    public static let scopeActionsPerGrant = 100_000
    public static let observationMs: Int64 = 15_000
    /// How long a decided request (approved, consumed, denied, cancelled, expired) can still be read.
    public static let decidedRetentionMs: Int64 = 120_000
    /// The main app's bridge caps both at the same values (src-tauri computer_use_bridge.rs: 16,384 / 524,288).
    public static let requestBytes = 16_384
    public static let responseBytes = 512_000
    public static let labelCharacters = 100
    public static let valueBytes = 4_000
    public static let elementBytes = 160
    public static let snapshotBytes = 200
}

/// An absent subrole in the SDK's observation is not evidence that an input is non-secure: the SDK may omit it.
/// Hide text inputs until the observer provides a verified non-secure subrole rather than expose their values.
public enum ControlTextObservationPolicy {
    public static func allows(isTextField: Bool, role: String?, subrole: String?, settable: Bool) -> Bool {
        guard role != "AXSecureTextField", subrole != "AXSecureTextField" else { return false }
        // These AX roles have well-defined non-text values; being settable alone must not hide a checkbox.
        let knownNonText = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXLink"].contains(role ?? "")
        if knownNonText && !isTextField { return true }
        let isTextLike = isTextField || role == "AXTextField" || role == "AXTextArea" || settable
        guard isTextLike else { return true }
        guard let subrole, !subrole.isEmpty else { return false }
        return true
    }
}

/// A filtered view is incomplete as well as an SDK traversal that exhausted a budget or failed to read a node.
public enum ControlObservationCompleteness {
    public static func truncated(sdkTruncated: Bool, detected: Int, returned: Int) -> Bool {
        sdkTruncated || returned < detected
    }
}

/// `notDispatched`: nothing reached the target app, so the host records `refused` instead of `unknown`.
public struct ControlError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let notDispatched: Bool
    public let retryAfterMs: Int?
    public init(_ code: String, notDispatched: Bool = false, retryAfterMs: Int? = nil) {
        self.code = code; self.notDispatched = notDispatched; self.retryAfterMs = retryAfterMs
    }
    public static func refuse(_ code: String, retryAfterMs: Int? = nil) -> ControlError {
        ControlError(code, notDispatched: true, retryAfterMs: retryAfterMs)
    }
    /// A request the helper could not read or that names nothing it holds: never dispatched.
    public static let invalid = ControlError("invalid-request", notDispatched: true)
    public var description: String { code }
}

/// The Workroom session and lane a request comes from, and `generation`: the caller credential the host issued for
/// it (src/computerUseCaller.ts). A reused session ID with a new credential is another generation and matches nothing
/// of the earlier one.
public struct ControlCaller: Codable, Equatable, Hashable, Sendable {
    public let sessionId: String
    public let lane: String
    public let generation: String
    public init(sessionId: String, lane: String, generation: String) {
        self.sessionId = sessionId; self.lane = lane; self.generation = generation
    }
    public var approvalCaller: ApprovalCaller { ApprovalCaller(sessionId: sessionId, lane: lane) }
}

/// Never a target, whatever a person approves: AgentsToZ itself and every sibling app (by name and by signing team),
/// agent apps, the shells agents run in and system security surfaces. Mirrors src/computerUseProtocol.ts; only bundle
/// IDs read from apps installed on the reference Mac are listed. It also refuses everything the v2 scope protects
/// (ScopedProtectedTargets); Tests/ControlContract/protected-targets.json holds both lists.
public enum RefusedTargets {
    public static let bundles: Set<String> = [
        "com.intenet.agentstozbycs",
        "com.openai.codex", "com.openai.atlas", "com.anthropic.claudefordesktop", "com.nousresearch.hermes",
        "com.google.antigravity", "com.stablyai.orca", "com.cmuxterm.app", "com.googlecode.iterm2", "com.apple.Terminal",
        "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords", "com.apple.loginwindow",
        "com.apple.SecurityAgent", "com.apple.SecurityAgentHelper.arm64", "com.apple.SecurityAgentHelper.x86_64",
        "com.apple.authorizationhost", "com.apple.WindowServer", "com.apple.UserNotificationCenter",
        "com.apple.coreservices.uiagent", "com.apple.LocalAuthentication.UIAgent", "com.apple.LocalAuthenticationRemoteService",
        "com.apple.CertificateAssistant", "com.apple.EscrowSecurityAlert", "com.apple.security.Keychain-Circle-Notification"]
    public static let prefixes = ["com.intenet.agentstozbycs.", "com.apple.SecurityAgent"]
    public static let teams: Set<String> = ["DA8QKAQ2C9"]
    public static func refuses(bundle: String) -> Bool {
        let id = bundle.lowercased()
        return bundles.contains { $0.lowercased() == id } || prefixes.contains { id.hasPrefix($0.lowercased()) }
    }
    public static func refuses(_ target: ApprovalTarget) -> Bool { refuses(bundle: target.bundleId) || teams.contains(target.teamId) }
}

/// Who a request is routed for inside the main app. `agent`: the sidecar's agent path, which the main app's bridge
/// forces for everything arriving over the sidecar's private channel. `management`: a person using the main app's own
/// UI. The helper cannot tell the two apart by signature (both come from the verified main app), so it keeps the
/// powers apart instead: only the agent path reaches the engine (open-grant/observe/capture/click/press/set-value/receipt),
/// only management reads the window catalog and the approval list, and what both share only asks, reads or ends.
public enum ControlChannel: String, Sendable { case agent, management }

/// One request. Decoding is strict: exact keys per operation, closed character sets, integers only, bounded sizes.
public enum ControlRequest: Equatable, Sendable {
    case status
    /// Every window of every regular app, for a person's picker in the main app UI; never on the agent path.
    case catalog
    /// The approval requests of this main app process, for its UI; never on the agent path. No signatures.
    case approvals
    /// Only an explicit main-window human action may bring the native review window forward.
    case showReview
    /// Creates a waiting request in Control's menu. It never activates, focuses or approves anything.
    case requestApproval(approvalId: String, target: ApprovalTarget, caller: ControlCaller, label: String, expiresAt: Int64)
    case approvalStatus(approvalId: String, caller: ControlCaller)
    /// A person withdraws a waiting or approved-but-unopened request from the main app UI.
    case cancelApproval(approvalId: String)
    /// Turns one approved, unexpired approval of this caller and exact target into a native grant. One use.
    case openGrant(approvalId: String, caller: ControlCaller, target: ApprovalTarget)
    case observe(grant: String, caller: ControlCaller)
    case capture(grant: String, caller: ControlCaller, snapshotId: String)
    case click(grant: String, caller: ControlCaller, requestId: String, snapshotId: String, x: Double, y: Double)
    case press(grant: String, caller: ControlCaller, requestId: String, snapshotId: String, element: String)
    case setValue(grant: String, caller: ControlCaller, requestId: String, snapshotId: String, element: String, value: String)
    case receipt(grant: String, caller: ControlCaller, requestId: String)
    case revoke(grant: String, caller: ControlCaller)
    case revokeSession(sessionId: String)
    /// Revocation only: the main app's sidecar channel ended while the main process lives on. Ends every request and
    /// grant of the requesting main process generation, which comes from the verified connection, never the body.
    case disconnectOwner

    public var operation: String {
        switch self {
        case .status: "status"
        case .catalog: "catalog"
        case .approvals: "approvals"
        case .showReview: "show-review"
        case .requestApproval: "request-approval"
        case .approvalStatus: "approval-status"
        case .cancelApproval: "cancel-approval"
        case .openGrant: "open-grant"
        case .observe: "observe"
        case .capture: "capture"
        case .click: "click"
        case .press: "press"
        case .setValue: "set-value"
        case .receipt: "receipt"
        case .revoke: "revoke"
        case .revokeSession: "revoke-session"
        case .disconnectOwner: "disconnect-owner"
        }
    }

    /// The exact keys each operation takes besides `v`/`channel`/`op`. One shape per operation on every channel.
    static let shapes: [String: Set<String>] = [
        "status": [], "catalog": [], "approvals": [], "show-review": [], "disconnect-owner": [],
        "request-approval": ["approvalId", "target", "caller", "label", "expiresAt"],
        "approval-status": ["approvalId", "caller"],
        "cancel-approval": ["approvalId"],
        "open-grant": ["approvalId", "caller", "target"],
        "observe": ["grant", "caller"],
        "capture": ["grant", "caller", "snapshotId"],
        "click": ["grant", "caller", "requestId", "snapshotId", "x", "y"],
        "press": ["grant", "caller", "requestId", "snapshotId", "element"],
        "set-value": ["grant", "caller", "requestId", "snapshotId", "element", "value"],
        "receipt": ["grant", "caller", "requestId"],
        "revoke": ["grant", "caller"],
        "revoke-session": ["sessionId"]]
    /// The closed operation set of each channel.
    public static let agentOperations: Set<String> = ["status", "request-approval", "approval-status", "open-grant", "observe",
        "press", "set-value", "capture", "click", "receipt", "revoke", "revoke-session", "disconnect-owner"]
    public static let managementOperations: Set<String> = ["status", "catalog", "approvals", "show-review", "request-approval", "approval-status",
        "cancel-approval", "revoke", "revoke-session", "disconnect-owner"]
    public static func operations(_ channel: ControlChannel) -> Set<String> { channel == .agent ? agentOperations : managementOperations }

    public static func decode(_ data: Data) throws -> (channel: ControlChannel, request: ControlRequest) {
        guard data.count <= ControlLimits.requestBytes,
              let object = try? JSONSerialization.jsonObject(with: data), let body = object as? [String: Any],
              let v = integer(body["v"]), v == Int64(ControlContract.version),
              let channelName = body["channel"] as? String, let channel = ControlChannel(rawValue: channelName),
              let op = body["op"] as? String, operations(channel).contains(op), let allowed = shapes[op],
              Set(body.keys) == allowed.union(["v", "channel", "op"]) else { throw ControlError.invalid }
        return (channel, try decode(op, body))
    }

    private static func decode(_ op: String, _ body: [String: Any]) throws -> ControlRequest {
        switch op {
        case "status": return .status
        case "catalog": return .catalog
        case "approvals": return .approvals
        case "show-review": return .showReview
        case "disconnect-owner": return .disconnectOwner
        case "request-approval":
            guard let id = approvalId(body["approvalId"]), let target = target(body["target"]),
                  let caller = caller(body["caller"]), let label = label(body["label"]),
                  let expires = integer(body["expiresAt"]), expires > 0 else { throw ControlError.invalid }
            return .requestApproval(approvalId: id, target: target, caller: caller, label: label, expiresAt: expires)
        case "approval-status":
            guard let id = approvalId(body["approvalId"]), let caller = caller(body["caller"]) else { throw ControlError.invalid }
            return .approvalStatus(approvalId: id, caller: caller)
        case "cancel-approval":
            guard let id = approvalId(body["approvalId"]) else { throw ControlError.invalid }
            return .cancelApproval(approvalId: id)
        case "open-grant":
            guard let id = approvalId(body["approvalId"]), let caller = caller(body["caller"]),
                  let target = target(body["target"]) else { throw ControlError.invalid }
            return .openGrant(approvalId: id, caller: caller, target: target)
        case "revoke-session":
            guard let session = body["sessionId"] as? String,
                  ComputerUseApproval.validCaller(ApprovalCaller(sessionId: session, lane: "x")) else { throw ControlError.invalid }
            return .revokeSession(sessionId: session)
        default:
            guard let grant = grantId(body["grant"]), let caller = caller(body["caller"]) else { throw ControlError.invalid }
            switch op {
            case "observe": return .observe(grant: grant, caller: caller)
            case "capture":
                guard let snapshot = token(body["snapshotId"], ControlLimits.snapshotBytes) else { throw ControlError.invalid }
                return .capture(grant: grant, caller: caller, snapshotId: snapshot)
            case "click":
                guard let request = requestId(body["requestId"]), let snapshot = token(body["snapshotId"], ControlLimits.snapshotBytes),
                      let x = coordinate(body["x"]), let y = coordinate(body["y"]) else { throw ControlError.invalid }
                return .click(grant: grant, caller: caller, requestId: request, snapshotId: snapshot, x: x, y: y)
            case "revoke": return .revoke(grant: grant, caller: caller)
            case "receipt":
                guard let request = requestId(body["requestId"]) else { throw ControlError.invalid }
                return .receipt(grant: grant, caller: caller, requestId: request)
            case "press", "set-value":
                guard let request = requestId(body["requestId"]), let snapshot = token(body["snapshotId"], ControlLimits.snapshotBytes),
                      let element = token(body["element"], ControlLimits.elementBytes) else { throw ControlError.invalid }
                if op == "press" { return .press(grant: grant, caller: caller, requestId: request, snapshotId: snapshot, element: element) }
                guard let value = body["value"] as? String, value.utf8.count <= ControlLimits.valueBytes else { throw ControlError.invalid }
                return .setValue(grant: grant, caller: caller, requestId: request, snapshotId: snapshot, element: element, value: value)
            default: throw ControlError.invalid
            }
        }
    }

    /// Integers only: JSON booleans and fractions are refused, as are values beyond 2^53.
    static func integer(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d.rounded() == d, abs(d) < 9_007_199_254_740_992 else { return nil }
        return n.int64Value
    }
    static func coordinate(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= 100_000 else { return nil }
        return n.doubleValue
    }
    static func approvalId(_ v: Any?) -> String? {
        guard let s = v as? String, ComputerUseApproval.lowerHexString(s, length: 64) else { return nil }; return s
    }
    static func grantId(_ v: Any?) -> String? {
        guard let s = v as? String, ComputerUseApproval.lowerHexString(s, length: 32) else { return nil }; return s
    }
    /// The host's request ID (src/computerUseProtocol.ts): `[A-Za-z0-9_-]{8,128}`.
    public static func requestId(_ v: Any?) -> String? {
        guard let s = v as? String, (8...128).contains(s.utf8.count),
              s.unicodeScalars.allSatisfy({ ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || $0 == "_" || $0 == "-" }) else { return nil }
        return s
    }
    /// Printable ASCII without spaces: snapshot and element identifiers the engine made.
    static func token(_ v: Any?, _ max: Int) -> String? {
        guard let s = v as? String, (1...max).contains(s.utf8.count),
              s.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7f }) else { return nil }
        return s
    }
    static func label(_ v: Any?) -> String? {
        guard let raw = v as? String else { return nil }
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard (1...ControlLimits.labelCharacters).contains(s.count),
              !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return s
    }
    static func target(_ v: Any?) -> ApprovalTarget? {
        guard let t = v as? [String: Any],
              Set(t.keys) == ["bundleId", "teamId", "codeHash", "pid", "processStart", "windowId"],
              let bundle = t["bundleId"] as? String, let team = t["teamId"] as? String, let code = t["codeHash"] as? String,
              let pid = integer(t["pid"]), pid > 0, pid <= Int64(Int32.max),
              let start = t["processStart"] as? String,
              let window = integer(t["windowId"]), window > 0, window <= Int64(UInt32.max) else { return nil }
        let target = ApprovalTarget(bundleId: bundle, teamId: team, codeHash: code, pid: Int32(pid), processStart: start, windowId: UInt32(window))
        return ComputerUseApproval.validTarget(target) ? target : nil
    }
    static func caller(_ v: Any?) -> ControlCaller? {
        guard let c = v as? [String: Any], Set(c.keys) == ["sessionId", "lane", "generation"],
              let session = c["sessionId"] as? String, let lane = c["lane"] as? String, let generation = c["generation"] as? String,
              ComputerUseApproval.validCaller(ApprovalCaller(sessionId: session, lane: lane)),
              ComputerUseApproval.lowerHexString(generation, length: 32) else { return nil }
        return ControlCaller(sessionId: session, lane: lane, generation: generation)
    }
}

public enum ControlResponse {
    /// `success` and `halted` are always present; a body never overrides them.
    public static func success(_ body: [String: Any], halted: Bool = false) -> Data {
        var out = body; out["success"] = true; out["halted"] = halted
        return encode(out)
    }
    public static func failure(_ error: ControlError, halted: Bool = false) -> Data {
        var out: [String: Any] = ["success": false, "code": error.code, "notDispatched": error.notDispatched, "halted": halted]
        if let retry = error.retryAfterMs { out["retryAfterMs"] = retry }
        return encode(out)
    }
    /// Sorted keys; an answer that cannot be encoded or is too large becomes a fixed failure, never a partial reply.
    static func encode(_ object: [String: Any]) -> Data {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              data.count <= ControlLimits.responseBytes else {
            return Data(#"{"code":"response-too-large","halted":false,"notDispatched":false,"success":false}"#.utf8)
        }
        return data
    }
    public static func target(_ t: ApprovalTarget) -> [String: Any] {
        ["bundleId": t.bundleId, "teamId": t.teamId, "codeHash": t.codeHash, "pid": Int(t.pid),
         "processStart": t.processStart, "windowId": Int(t.windowId)]
    }
    /// The `status` body (Tests/ControlContract/requests.json `replies.status`).
    public static func status(accessibility: Bool, secureInput: Bool, pendingApprovals: Int, grants: Int) -> Data {
        success(["protocolVersion": ControlContract.version, "workerProtocol": ControlContract.workerProtocol,
                 "accessibility": accessibility, "secureInput": secureInput, "backgroundOnly": true,
                 "pendingApprovals": pendingApprovals, "grants": grants, "operations": ControlContract.engineOperations])
    }
    /// The `open-grant` body (`replies.open-grant`): the operations travel with each grant, so the main app decides
    /// capture/click from the Control that holds it, not from a status read that may be old.
    public static func openGrant(_ grant: String, expiresAt: Int64) -> Data {
        success(["bound": true, "grant": grant, "protocolVersion": ControlContract.workerProtocol, "expiresAt": expiresAt,
                 "operations": ControlContract.engineOperations])
    }
}

/// What the person reads in the Touch ID or login password prompt and on each active grant. Screen images are a
/// separate, default-off choice, so both say whether this grant may also read the window's pixels.
public enum ControlConsentText {
    public static func approvalReason(screenAccess: Bool) -> String {
        screenAccess ? "AgentsToZ 작업 세션이 창 하나를 최대 10분 동안 제어하고 그 창의 화면 이미지도 읽도록 허용합니다."
            : "AgentsToZ 작업 세션이 창 하나를 최대 10분 동안 제어하도록 허용합니다."
    }
    public static func grantAccess(screenAccessApproved: Bool) -> String {
        screenAccessApproved ? "화면 이미지 허용" : "화면 이미지 없음"
    }
    /// Why a scope approval was refused after the person authenticated. One generic sentence hid the cause on 1호
    /// (2026-10-31), where the request then simply expired. Each says nothing was allowed and what to do next.
    public static func scopeApprovalRefused(code: String, secureInput: Bool) -> String {
        switch code {
        case "secure-state-unavailable" where secureInput:
            return "다른 곳의 암호 입력(보안 입력)이 아직 켜져 있어 승인하지 못했습니다. 암호 입력 칸을 닫고 다시 승인하세요. 아무것도 허용되지 않았습니다."
        case "secure-state-unavailable":
            return "화면이 잠겨 있거나 이 사용자가 화면에 나와 있지 않아 승인하지 못했습니다. 아무것도 허용되지 않았습니다."
        case "permission-unavailable":
            return "화면 기록 또는 손쉬운 사용 권한이 꺼져 있어 승인하지 못했습니다. 아무것도 허용되지 않았습니다."
        case "target-changed":
            return "요청한 앱이 바뀌었거나 종료됐습니다. 다시 요청하세요. 아무것도 허용되지 않았습니다."
        case "scope-conflict":
            return "이미 다른 창이나 범위를 제어 중입니다. 먼저 중단한 뒤 다시 승인하세요."
        case "approval-unknown", "invalid-request":
            return "인증하는 동안 요청이 끝났거나 바뀌었습니다. 아무것도 허용되지 않았습니다."
        default:
            return "승인 서명을 만들지 못했습니다(\(code)). 아무것도 허용되지 않았습니다."
        }
    }
    /// The standing allowance (StandingAllowance), as the review row, the settings window and the menu describe it.
    public static let standingOffer = "「항상 허용」은 이 요청을 승인하고, 앞으로 이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 쓰게 합니다. 앱·Control을 다시 시작하거나 업데이트해도 유지되고, 끄거나 「중단」을 누르면 끝납니다."
    public static let standingOff = "꺼짐: AI가 컴퓨터 유즈를 요청할 때마다 여기서 Touch ID나 로그인 암호로 승인합니다. 켜면 이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다. 커뮤니티의 다른 Mac에서 맡긴 작업도 이 Mac의 AI가 하므로 그대로 이어집니다."
    public static func standingOn(since: Date) -> String {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "ko_KR"); formatter.dateFormat = "M월 d일 a h:mm"
        return "켜짐(\(formatter.string(from: since))부터): 이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac의 화면을 읽고 마우스·키보드를 씁니다. 화면 아래 Control 막대의 「직접 하기」로 언제든 넘겨받고, 「중단」을 누르면 상시 허용도 꺼집니다. 앱을 고르는 범위는 매번 승인합니다."
    }
}

/// The main app process a request came from: its PID and that process's start time. A restart or a reused PID is
/// another owner and revives nothing of the earlier one.
public struct ControlOwner: Hashable, Sendable {
    public let pid: Int32
    public let start: UInt64
    public init(pid: Int32, start: UInt64) { self.pid = pid; self.start = start }
}

public enum ProcessGeneration {
    /// The kernel's start time of `pid` in microseconds since 1970, or nil when no such process exists.
    public static func start(_ pid: Int32) -> UInt64? {
        guard pid > 0 else { return nil }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size == MemoryLayout<kinfo_proc>.stride,
              info.kp_proc.p_pid == pid else { return nil }
        let t = info.kp_proc.p_un.__p_starttime
        return UInt64(t.tv_sec) &* 1_000_000 &+ UInt64(t.tv_usec)
    }
    public static func owner(_ pid: Int32) -> ControlOwner? { start(pid).map { ControlOwner(pid: pid, start: $0) } }
    /// Whether that exact process is still running: same PID and same start time.
    public static func alive(_ owner: ControlOwner) -> Bool { start(owner.pid) == owner.start }
}
