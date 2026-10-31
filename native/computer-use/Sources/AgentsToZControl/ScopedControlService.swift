import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import ComputerUseEngine
import Foundation
import LocalAuthentication
import Observation
import OSLog

@MainActor enum ScopedControlShared { static let service = ScopedControlService() }
enum ScopedControlLog {
    static let approval = Logger(subsystem: "com.intenet.agentstozbycs.control", category: "scope-approval")
    static let bar = Logger(subsystem: "com.intenet.agentstozbycs.control", category: "control-bar")
}

/// Scoped requests are separate from window grants. This class cannot approve from an XPC call: only the native
/// review panel calls approve, which always requires the person's device-owner authentication and enclave signature.
@MainActor @Observable
final class ScopedControlService {
    @ObservationIgnored let state = ScopeControlState(now: nowMs)
    @ObservationIgnored private var session: ScopedNativeSession?
    @ObservationIgnored private let authentication = ApprovalAuthentication()
    private(set) var pending: [ScopedApprovalEntry] = []
    private(set) var grant: ScopedGrantEntry?
    private(set) var approving: String?
    private(set) var problem: String?
    /// The last action that reached the target, for the control bar only (never sent anywhere).
    private(set) var lastAction: (operation: String, at: Date)?
    /// The person's standing allowance (상시 허용), read from its Secure Enclave key; nil when off.
    private(set) var standing: StandingAllowance?
    @ObservationIgnored private var standingKey: SecKey?
    private(set) var enablingStanding = false
    static let standingKeyTag = Data("com.intenet.agentstozbycs.control.standing-key.v1".utf8)

    init() { loadStanding() }
    private func loadStanding() {
        guard let found = try? ComputerUseApproval.standingKey(tag: Self.standingKeyTag), let allowance = StandingAllowance.parse(found.label) else {
            standing = nil; standingKey = nil; return
        }
        standing = allowance; standingKey = found.key
    }

    func refresh() {
        state.prune()
        if let id = authentication.approvalId {
            authentication.cancelUnlessPending(state.approvals[id]?.state == .pending, now: nowMs())
        }
        if state.grant == nil || state.grant?.halted == true { session?.stop(); session = nil }
        pending = state.pending; grant = state.grant
    }

    /// A v2 request reaches this only after strict channel/shape decoding on the signed main-app XPC connection.
    /// No XPC operation can invoke the native approval UI's `approve` method.
    func handle(_ request: ScopeControlRequest, owner: ControlOwner) async -> Data {
        defer { refresh() }
        guard ProcessGeneration.alive(owner) else { state.end(owner: owner); session?.stop(); session = nil; return ControlResponse.failure(.refuse("owner-unavailable")) }
        do { return try await run(request, owner: owner) }
        catch let error as ControlError { return ControlResponse.failure(error, halted: state.grant?.halted ?? false) }
        catch { return ControlResponse.failure(ControlError("native-operation-unconfirmed", notDispatched: true), halted: state.grant?.halted ?? false) }
    }

    private func run(_ request: ScopeControlRequest, owner: ControlOwner) async throws -> Data {
        let body = request.body
        switch request.operation {
        case "scope-status":
            let screenRecording = CGPreflightScreenCaptureAccess()
            // This process keeps its launch-time answer: watch for the person's switch and start again when it is on.
            if !screenRecording { ControlShared.service.watchScreenRecording() }
            return ControlResponse.success(["scopeProtocolVersion": 2,
                "operations": Array(ScopeControlRequest.agentOperations.union(ScopeControlRequest.managementOperations)).sorted(),
                "accessibility": ComputerUseEngine.accessibilityTrusted,
                "screenRecording": screenRecording, "secureInput": ComputerUseEngine.secureInput,
                // Who holds the open grant (the control bar): the host shows it and waits instead of halting.
                "control": state.grant.map { $0.halted ? "halted" : $0.person ? "person" : "agent" } as Any? ?? NSNull(),
                "standing": standing?.json as Any? ?? NSNull(),
                "owner": ["pid": owner.pid, "start": String(owner.start)]])
        case "scope-catalog": return ControlResponse.success(["applications": ScopedApplicationCatalog.list()])
        case "scope-request-approval":
            guard let id = body["approvalId"] as? String, let scope = request.parsedScope, let caller = request.caller,
                  let label = body["label"] as? String, let expires = (body["expiresAt"] as? NSNumber)?.int64Value else { throw ControlError.invalid }
            if case .application(let app) = scope, (try? ScopedApplicationCatalog.identity(pid: app.pid)) != app { throw ControlError.refuse("target-changed") }
            try state.submit(approvalId: id, scope: scope, caller: caller, label: label, expiresAt: expires, owner: owner)
            approveByStanding(id)
            return ControlResponse.success(["state": (state.approvals[id]?.state ?? .pending).rawValue])
        case "scope-approval-status":
            guard let id = body["approvalId"] as? String, let caller = request.caller else { throw ControlError.invalid }
            // A request the allowance could not approve yet (another grant was still open) is tried again here.
            if state.entry(id, caller: caller, owner: owner)?.state == .pending { approveByStanding(id) }
            guard let entry = state.entry(id, caller: caller, owner: owner) else { return ControlResponse.success(["state": "unknown"]) }
            var response: [String: Any] = ["state": entry.state.rawValue]
            if entry.state == .approved, let signed = entry.signed, let json = signed.json {
                response["approval"] = json; response["helperPublicKey"] = signed.publicKey.base64EncodedString()
            }
            return ControlResponse.success(response)
        case "scope-open-grant":
            guard let id = body["approvalId"] as? String, let scope = request.parsedScope, let caller = request.caller else { throw ControlError.invalid }
            try ScopedOSGuard.requireConsentEnvironment()
            if case .application(let app) = scope, try ScopedApplicationCatalog.identity(pid: app.pid) != app { throw ControlError.refuse("target-changed") }
            let bound = try state.open(id, scope: scope, caller: caller, owner: owner, legacyActive: !ControlShared.service.state.grants.isEmpty)
            lastAction = nil
            session = ScopedNativeSession(scope: scope, validateGrant: { [weak self] in
                guard let self else { throw ControlError.refuse("worker-halted") }
                // Every operation is admitted through `state.access` (which refuses a person-held grant) before it runs.
                _ = try self.state.access(bound.id, caller: caller, owner: owner, allowPerson: true)
            })
            return ControlResponse.success(["bound": true, "grant": bound.id, "expiresAt": bound.expiresAt,
                "scopeProtocolVersion": 2, "operations": Array(ScopeControlRequest.agentOperations.union(ScopeControlRequest.managementOperations)).sorted(),
                "scope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(scope)), "permissions": ComputerUseScopeApproval.permissions])
        case "scope-observe":
            guard let grant = body["grant"] as? String, let caller = request.caller else { throw ControlError.invalid }
            _ = try state.access(grant, caller: caller, owner: owner)
            guard let session else { throw ControlError.refuse("worker-halted") }
            let result = try session.observe()
            guard let snapshot = result["snapshotId"] as? String else { throw ControlError.refuse("observation-discarded") }
            try state.recordObservation(grant, caller: caller, owner: owner, snapshotId: snapshot)
            return ControlResponse.success(result)
        case "scope-capture":
            guard let grant = body["grant"] as? String, let caller = request.caller,
                  let snapshot = body["snapshotId"] as? String, let display = body["displayId"] as? String else { throw ControlError.invalid }
            _ = try state.access(grant, caller: caller, owner: owner)
            guard let session else { throw ControlError.refuse("worker-halted") }
            let result = try await session.capture(snapshotId: snapshot, displayId: display)
            _ = try state.access(grant, caller: caller, owner: owner)
            return ControlResponse.success(result)
        case "scope-click", "scope-type-text", "scope-key", "scope-scroll", "scope-drag", "scope-focus-app":
            guard let grant = body["grant"] as? String, let caller = request.caller,
                  let requestID = body["requestId"] as? String, let snapshot = body["snapshotId"] as? String else { throw ControlError.invalid }
            guard let session else { throw ControlError.refuse("worker-halted") }
            let ticket = try state.beginMutation(grant, caller: caller, owner: owner, requestId: requestID, snapshotId: snapshot)
            let outcome: MutationResult
            do { outcome = try await session.act(operation: request.operation, body: body) }
            catch let error as ControlError where error.notDispatched { outcome = .refused(error.code) }
            catch { outcome = .unknown }
            state.finishMutation(ticket, result: outcome, diagnosticReason: session.actionFailureCode,
                                 guardSamples: session.actionGuardSamples)
            if outcome == .confirmed || outcome == .dispatchedUnverified { lastAction = (request.operation, Date()) }
            guard let receipt = try state.receipt(grant, caller: caller, owner: owner, requestId: requestID) else {
                throw ControlError("native-operation-unconfirmed")
            }
            return ControlResponse.success(["receipt": receipt.json], halted: state.grant?.halted ?? true)
        case "scope-receipt":
            guard let grant = body["grant"] as? String, let caller = request.caller, let id = body["requestId"] as? String,
                  let receipt = try state.receipt(grant, caller: caller, owner: owner, requestId: id) else { throw ControlError.refuse("receipt-unknown") }
            return ControlResponse.success(["receipt": receipt.json], halted: state.grant?.halted ?? true)
        case "scope-revoke":
            guard let grant = body["grant"] as? String, let caller = request.caller else { throw ControlError.invalid }
            let revoked = try state.revoke(grant, caller: caller, owner: owner)
            if revoked { session?.stop(); session = nil }
            return ControlResponse.success(["revoked": revoked], halted: true)
        case "scope-revoke-session":
            guard let sessionID = body["sessionId"] as? String else { throw ControlError.invalid }
            end(owner: owner, sessionId: sessionID); return ControlResponse.success(["revoked": true])
        case "scope-disconnect-owner":
            end(owner: owner); return ControlResponse.success(["revoked": true])
        case "scope-standing-off":
            disableStanding(); return ControlResponse.success(["standing": NSNull()])
        default: throw ControlError.invalid
        }
    }
    func end(owner: ControlOwner, sessionId: String? = nil) {
        let grantMatches = state.grant.map { $0.owner == owner && (sessionId == nil || $0.caller.sessionId == sessionId) } ?? false
        state.end(owner: owner, sessionId: sessionId)
        if grantMatches { session?.stop(); session = nil }
        refresh()
    }
    func matches(_ entry: ScopedApprovalEntry) -> Bool {
        guard ProcessGeneration.alive(entry.owner) else { return false }
        if case .application(let app) = entry.scope { return (try? ScopedApplicationCatalog.identity(pid: app.pid)) == app }
        return true
    }
    func title(_ entry: ScopedApprovalEntry) -> String {
        switch entry.scope {
        case .desktop: return "이 Mac의 전체 화면"
        case .application(let app):
            guard matches(entry) else { return app.bundleId }
            return NSRunningApplication(processIdentifier: app.pid)?.localizedName ?? app.bundleId
        }
    }
    func approve(_ id: String) async {
        problem = nil
        guard approving == nil, let entry = state.approvals[id], entry.state == .pending else { return }
        guard matches(entry) else { problem = "요청한 앱이 바뀌었거나 종료됐습니다. 다시 요청하세요."; return }
        guard ControlShared.service.state.grants.isEmpty, state.grant == nil else {
            problem = "이미 다른 창이나 범위를 제어 중입니다. 먼저 중단하세요."; return
        }
        do { try ScopedOSGuard.requireConsentEnvironment() }
        catch { problem = "화면 기록·손쉬운 사용 권한과 잠금 상태를 확인하세요."; return }
        let context = LAContext()
        guard authentication.begin(id, expiresAt: entry.expiresAt, cancel: { context.invalidate() }) else { return }
        approving = id
        defer { if approving == id { approving = nil }; authentication.complete(id, now: nowMs()); refresh() }
        let authenticated = await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "컴퓨터 유즈를 끌 때까지 이 범위의 화면 읽기와 마우스·키보드 제어를 승인합니다") { okay, _ in
                continuation.resume(returning: okay)
            }
        }
        guard authentication.complete(id, now: nowMs()) else {
            problem = "인증하는 동안 요청이 끝났습니다. 현재 대기 중인 요청을 다시 확인하세요."; return
        }
        guard authenticated else { problem = "승인하지 않았습니다. 아무것도 허용되지 않았습니다."; return }
        // A typed password's secure field can still hold Secure Event Input when evaluatePolicy returns.
        let released = await ScopedOSGuard.awaitSecureInputRelease()
        guard let current = state.entry(id, caller: entry.caller, owner: entry.owner), current.state == .pending,
              current.scope == entry.scope, matches(current) else {
            ScopedControlLog.approval.notice("scope approval refused after authentication: request-ended")
            problem = "인증하는 동안 요청이 끝났거나 대상이 바뀌었습니다."; return
        }
        do {
            try ScopedOSGuard.requireConsentEnvironment()
            let key = try ComputerUseApproval.approvalKey(tag: ControlService.approvalKeyTag, authenticationContext: context)
            let payload = ScopeApprovalPayload(approvalId: id, scope: current.scope,
                caller: ScopeApprovalCaller(sessionId: current.caller.sessionId, lane: current.caller.lane, generation: current.caller.generation),
                owner: ScopeApprovalOwner(pid: current.owner.pid, start: String(current.owner.start)),
                issuedAt: nowMs(), expiresAt: current.expiresAt)
            let signed = ScopedSignedApproval(payload: payload, signature: try ComputerUseScopeApproval.sign(payload, with: key),
                                              publicKey: try ComputerUseApproval.publicPoint(of: key))
            // Recheck OS and target after key access too; approval can expire or the owner can end during auth.
            try ScopedOSGuard.requireConsentEnvironment()
            guard matches(current) else { throw ControlError.refuse("target-changed") }
            try state.approve(id, signed: signed, legacyActive: !ControlShared.service.state.grants.isEmpty)
            ScopedControlLog.approval.notice("scope approval signed")
        } catch {
            // Codes only: no caller, label or scope reaches the log, so a remote `log show` can say why it failed.
            let code = (error as? ControlError)?.code ?? "approval-signing-failed", secureInput = ComputerUseEngine.secureInput
            ScopedControlLog.approval.notice("scope approval refused after authentication: \(code, privacy: .public) secureInput=\(secureInput, privacy: .public) released=\(released, privacy: .public)")
            problem = ControlConsentText.scopeApprovalRefused(code: code, secureInput: secureInput)
        }
    }
    func deny(_ id: String) { state.deny(id); refresh() }

    /// Under the standing allowance Control approves a waiting desktop request itself, with the standing key: the person
    /// allowed it once, in this window. Never an application scope, never while another window or scope is controlled,
    /// never outside the same consent environment (permissions, unlocked, no secure input) a person's approval needs.
    /// A request it cannot approve yet stays pending; its next status read tries again.
    private func approveByStanding(_ id: String) {
        guard let key = standingKey, standing != nil, let entry = state.approvals[id], entry.state == .pending,
              StandingAllowance.covers(entry.scope), ControlShared.service.state.grants.isEmpty, state.grant == nil,
              ProcessGeneration.alive(entry.owner) else { return }
        do {
            try ScopedOSGuard.requireConsentEnvironment()
            let now = nowMs()
            let payload = ScopeApprovalPayload(approvalId: id, scope: entry.scope,
                caller: ScopeApprovalCaller(sessionId: entry.caller.sessionId, lane: entry.caller.lane, generation: entry.caller.generation),
                owner: ScopeApprovalOwner(pid: entry.owner.pid, start: String(entry.owner.start)), issuedAt: now, expiresAt: entry.expiresAt)
            let signed = ScopedSignedApproval(payload: payload, signature: try ComputerUseScopeApproval.sign(payload, with: key),
                                              publicKey: try ComputerUseApproval.publicPoint(of: key))
            try state.approve(id, signed: signed, legacyActive: !ControlShared.service.state.grants.isEmpty)
            ScopedControlLog.approval.notice("scope approval by the standing allowance")
        } catch {
            let code = (error as? ControlError)?.code ?? "standing-signing-failed"
            ScopedControlLog.approval.notice("standing allowance did not approve: \(code, privacy: .public)")
        }
    }
    /// 「항상 허용」: the person turns the standing allowance on with Touch ID or the login password, in Control's own
    /// window or menu. `approving` is the waiting request they pressed it on, approved with the same authentication.
    func enableStanding(approving id: String? = nil) async {
        problem = nil
        guard !enablingStanding, approving == nil else { return }
        enablingStanding = true
        defer { enablingStanding = false; refresh() }
        let context = LAContext()
        let authenticated = await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac의 화면 읽기와 마우스·키보드 제어를 하도록 상시 허용합니다") { okay, _ in
                continuation.resume(returning: okay)
            }
        }
        guard authenticated else { problem = "상시 허용을 켜지 않았습니다. 아무것도 바뀌지 않았습니다."; return }
        do {
            try ComputerUseApproval.deleteStandingKey(tag: Self.standingKeyTag)
            let allowance = StandingAllowance(since: nowMs())
            standingKey = try ComputerUseApproval.makeStandingKey(tag: Self.standingKeyTag, label: allowance.label)
            standing = allowance
            ScopedControlLog.approval.notice("standing allowance turned on")
        } catch {
            standing = nil; standingKey = nil
            problem = "상시 허용 키를 만들지 못했습니다. 승인할 때마다 Touch ID로 승인하세요."; return
        }
        guard let id else { return }
        // A typed password's secure field can still hold Secure Event Input when evaluatePolicy returns.
        _ = await ScopedOSGuard.awaitSecureInputRelease()
        approveByStanding(id)
    }
    /// Turning it off ends what it allowed: the open grant halts and nothing is approved without the person again.
    func disableStanding() {
        let had = standing != nil || standingKey != nil
        standing = nil; standingKey = nil
        do { try ComputerUseApproval.deleteStandingKey(tag: Self.standingKeyTag) }
        catch { ScopedControlLog.approval.notice("standing allowance key was not deleted") }
        if had { ScopedControlLog.approval.notice("standing allowance turned off"); state.stop(); session?.stop() }
        refresh()
    }
    /// 「직접 하기」 on the control bar: the person holds the Mac; the agent's next operation is refused, nothing halts.
    func handToPerson() {
        if state.handToPerson() { ScopedControlLog.bar.notice("control bar: the person took control") }
        refresh()
    }
    /// 「AI에게 넘기기」 on the control bar. `click` is the bar's reading of the event that ran the button.
    func handToAgent(click refusal: String?) -> Bool {
        defer { refresh() }
        if let refusal {
            ScopedControlLog.bar.notice("control bar: hand-back refused: \(refusal, privacy: .public)"); return false
        }
        do { try state.handToAgent() } catch {
            let code = (error as? ControlError)?.code ?? "hand-back-failed"
            ScopedControlLog.bar.notice("control bar: hand-back refused: \(code, privacy: .public)"); return false
        }
        ScopedControlLog.bar.notice("control bar: handed back to the agent"); return true
    }
    /// The person's 「중단」 (bar, menu, review window): the grant halts and the standing allowance ends with it, so the AI
    /// cannot open a new grant by itself right after being stopped.
    func stop() { state.stop(); session?.stop(); if standing != nil || standingKey != nil { disableStanding() } else { refresh() } }
    func dismissProblem() { problem = nil }
}
