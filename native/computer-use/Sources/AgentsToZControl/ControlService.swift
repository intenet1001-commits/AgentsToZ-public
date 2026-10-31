import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import ComputerUseEngine
import Foundation
import LocalAuthentication
import Observation
import ServiceManagement

/// Milliseconds since 1970: the unit of every expiry in the contract and the signed approval.
func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded(.down)) }

@MainActor enum ControlShared {
    static let service = ControlService()
}

/// What the review window shows for a waiting request, resolved by Control itself (never taken from the request).
struct ReviewInfo: Equatable {
    let appName: String
    let windowTitle: String
    /// The window is still the exact process generation, window and signature the request named.
    let matches: Bool
}

/// AgentsToZ Control's one service: the XPC requests of the main app and the person's decisions meet here, on the
/// main actor. The core state (ControlState) decides admission; the engine reads and acts in this process, which alone
/// holds the Accessibility permission. Shown state is published for the menu and windows; reading it touches no
/// keychain and asks for no permission.
@MainActor @Observable
final class ControlService {
    @ObservationIgnored let state = ControlState(now: nowMs)
    @ObservationIgnored private var sessions: [String: TargetSession] = [:]
    private(set) var pending: [ApprovalEntry] = []
    private(set) var grants: [GrantEntry] = []
    private(set) var reviews: [String: ReviewInfo] = [:]
    private(set) var accessibility = false
    /// Read when the settings window shows or after the person's request button, never on the 1 s tick. macOS keeps
    /// this answer per process, so a grant made after launch shows only once Control starts again.
    private(set) var screenRecording = false
    private(set) var listening = false
    private(set) var problem: String?
    private(set) var approving: String?
    @ObservationIgnored private let authentication = ApprovalAuthentication()
    /// Tag of the Secure Enclave approval key, created on the person's first approval only.
    static let approvalKeyTag = Data("com.intenet.agentstozbycs.control.approval-key.v1".utf8)

    func startedListening() { listening = true }

    /// Cheap: expiry, gone owners, ended sessions. Runs after every request and on the 1 s tick.
    func refresh() {
        state.prune()
        if let id = authentication.approvalId {
            authentication.cancelUnlessPending(state.approvals[id]?.state == .pending, now: nowMs())
        }
        for (id, session) in sessions {
            guard let grant = state.grants[id] else { session.stop(); sessions[id] = nil; continue }
            if grant.halted { session.stop() }
        }
        pending = state.pending
        grants = state.active
        accessibility = ComputerUseEngine.accessibilityTrusted
    }
    func readScreenRecording() { screenRecording = CGPreflightScreenCaptureAccess() }
    /// Set once a fresh process sees Screen Recording allowed while this one still reads its launch-time answer; the
    /// delegate then starts Control again as soon as nothing is pending or granted.
    private(set) var restartForScreenRecording = false
    @ObservationIgnored private var screenRecordingWatchUntil: Int64 = 0
    @ObservationIgnored private var screenRecordingAfterAccessibility = false
    @ObservationIgnored private var probing = false
    @ObservationIgnored private var lastProbe: Int64 = 0

    /// The settings window opens only from the person's own action: the main app's 「권한 켜기」, the menu, Finder.
    /// Asking macOS there lists Control in Privacy & Security, so the person only turns the switch on; turning it on
    /// stays in System Settings. Screen Recording follows once Accessibility is on, so two prompts never stack.
    func requestMissingPermissions() {
        refresh(); readScreenRecording()
        if !accessibility {
            requestAccessibility(); openPrivacyPane("Privacy_Accessibility")
            screenRecordingAfterAccessibility = !screenRecording
        } else if !screenRecording { askScreenRecording() }
    }
    /// The settings window's buttons. Each shows macOS's own prompt (the first time) and lists this app.
    func requestAccessibility() {
        // The literal key of kAXTrustedCheckOptionPrompt: that global is not concurrency-safe under Swift 6.
        accessibility = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    }
    func requestScreenRecording() { screenRecording = CGRequestScreenCaptureAccess(); if !screenRecording { watchScreenRecording() } }
    private func askScreenRecording() {
        requestScreenRecording()
        if !screenRecording { openPrivacyPane("Privacy_ScreenCapture") }
    }
    private func openPrivacyPane(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
    }
    /// A status read or request that finds Screen Recording off watches for 10 minutes for the person's switch.
    func watchScreenRecording() { screenRecordingWatchUntil = nowMs() + 10 * 60_000 }
    /// Once a second. Accessibility is answered live; Screen Recording is checked in a fresh process every 2 s while
    /// watched, because this process keeps the answer it read at launch.
    func watchPermissions() {
        if screenRecordingAfterAccessibility, accessibility { screenRecordingAfterAccessibility = false; askScreenRecording() }
        let now = nowMs()
        guard !restartForScreenRecording, now < screenRecordingWatchUntil, !probing, now - lastProbe >= 2_000 else { return }
        if CGPreflightScreenCaptureAccess() { screenRecording = true; screenRecordingWatchUntil = 0; return }
        probing = true; lastProbe = now
        Task {
            let allowed = await ScreenRecordingProbe.allowedInFreshProcess()
            probing = false
            if allowed { screenRecordingWatchUntil = 0; restartForScreenRecording = true }
        }
    }
    /// Resolves what each waiting request names, only while the person looks at the review window.
    func refreshReviews() {
        var next: [String: ReviewInfo] = [:]
        for entry in pending {
            let described = ComputerUseEngine.describe(entry.target)
            let current = try? ComputerUseEngine.identity(pid: entry.target.pid, window: entry.target.windowId)
            next[entry.approvalId] = ReviewInfo(appName: described?.app ?? entry.target.bundleId,
                                                windowTitle: described?.window ?? "", matches: current == entry.target)
        }
        if next != reviews { reviews = next }
    }

    // MARK: XPC

    func handle(_ data: Data, owner: ControlOwner) async -> Data {
        defer { refresh() }
        if let scoped = try? ScopeControlRequest.decode(data) {
            return await ScopedControlShared.service.handle(scoped, owner: owner)
        }
        let request: ControlRequest
        do { request = try ControlRequest.decode(data).request } catch { return ControlResponse.failure(.invalid) }
        let mutation = ["press", "set-value", "click"].contains(request.operation)
        guard ProcessGeneration.alive(owner) else {
            state.prune()
            return ControlResponse.failure(.refuse("owner-unavailable"))
        }
        do {
            return try await run(request, owner: owner)
        } catch let error as ControlError {
            // Only press/set-value/click can have reached an app; every other failure dispatched nothing.
            let reported = mutation ? error : ControlError(error.code, notDispatched: true, retryAfterMs: error.retryAfterMs)
            return ControlResponse.failure(reported, halted: halted(request))
        } catch {
            // Never echo raw AX errors, text, paths or observation data.
            return ControlResponse.failure(ControlError("native-operation-unconfirmed", notDispatched: !mutation), halted: halted(request))
        }
    }

    /// For requests naming a grant: whether the main app must treat it as stopped (gone, or stopped by anyone).
    private func halted(_ request: ControlRequest) -> Bool {
        let id: String? = switch request {
        case .observe(let g, _), .capture(let g, _, _), .click(let g, _, _, _, _, _), .press(let g, _, _, _, _), .setValue(let g, _, _, _, _, _), .receipt(let g, _, _), .revoke(let g, _): g
        default: nil
        }
        guard let id else { return false }
        return state.grants[id]?.halted ?? true
    }
    private func sync(_ id: String, _ session: TargetSession) { if session.halted { state.halt(id, reason: "worker-halted") } }
    private func stop(sessionsOf ids: [String]) { for id in ids { sessions[id]?.stop(); sessions[id] = nil } }

    private func run(_ request: ControlRequest, owner: ControlOwner) async throws -> Data {
        switch request {
        case .status:
            let mine = state.approvals(of: owner)
            return ControlResponse.status(accessibility: ComputerUseEngine.accessibilityTrusted, secureInput: ComputerUseEngine.secureInput,
                                          pendingApprovals: mine.filter { $0.state == .pending }.count,
                                          grants: state.grants.values.filter { $0.owner == owner }.count)
        case .showReview:
            // Opening review is an explicit main-UI action. Do not steal focus after the person changed apps.
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == owner.pid,
                  ProcessGeneration.alive(owner) else {
                throw ControlError("review-owner-not-frontmost")
            }
            guard try await ControlMain.delegate.showReviewForMainWindow(owner: owner) else {
                throw ControlError("review-visibility-unconfirmed")
            }
            return ControlResponse.confirmedReviewPresentation()
        case .catalog:
            return ControlResponse.success(["windows": ComputerUseEngine.catalog()])
        case .approvals:
            return ControlResponse.success(["approvals": state.approvals(of: owner).map { e -> [String: Any] in
                ["approvalId": e.approvalId, "state": e.state.rawValue, "label": e.label, "expiresAt": e.expiresAt,
                 "target": ControlResponse.target(e.target), "caller": ["sessionId": e.caller.sessionId, "lane": e.caller.lane]]
            }])
        case let .requestApproval(id, target, caller, label, expiresAt):
            // Shown in the menu bar only. Nothing is activated or focused: a person typing or picking elsewhere keeps it.
            try state.submit(approvalId: id, target: target, caller: caller, label: label, expiresAt: expiresAt, owner: owner)
            return ControlResponse.success(["state": ApprovalState.pending.rawValue])
        case let .approvalStatus(id, caller):
            guard let entry = state.entry(id, caller: caller, owner: owner) else { return ControlResponse.success(["state": "unknown"]) }
            var body: [String: Any] = ["state": entry.state.rawValue]
            if entry.state == .approved, let signed = entry.signed {
                body["approval"] = signed.json
                body["helperPublicKey"] = signed.publicKey.base64EncodedString()
            }
            return ControlResponse.success(body)
        case let .cancelApproval(id):
            return ControlResponse.success(["cancelled": state.cancel(id, owner: owner)])
        case let .openGrant(id, caller, target):
            // Everything is checked, the engine included, before the one-use approval is consumed.
            ScopedControlShared.service.state.prune()
            guard ScopedControlShared.service.state.grant == nil else { throw ControlError.refuse("scope-conflict") }
            try state.checkOpen(id, caller: caller, target: target, owner: owner)
            let session = TargetSession(target: target)
            try session.validate()
            let grant = try state.openGrant(id, caller: caller, target: target, owner: owner)
            sessions[grant.id] = session
            return ControlResponse.openGrant(grant.id, expiresAt: grant.expiresAt)
        case let .observe(id, caller):
            let grant = try state.access(id, caller: caller, owner: owner)
            guard let session = sessions[grant.id] else { throw ControlError("worker-halted") }
            let revision = try state.beginObservation(grant.id)
            let body: [String: Any]
            do { body = try await session.observe() } catch { sync(grant.id, session); throw error }
            sync(grant.id, session)
            // Kept only if no change reached the same process while it was read, and the grant still exists.
            try state.finishObservation(grant.id, snapshotId: body["snapshotId"] as? String ?? "", revision: revision)
            return ControlResponse.success(body, halted: state.grants[grant.id]?.halted ?? true)
        case let .capture(id, caller, snapshotId):
            let grant = try state.access(id, caller: caller, owner: owner)
            guard let session = sessions[grant.id] else { throw ControlError.refuse("worker-halted") }
            let ticket = try state.beginCapture(grant.id, snapshotId: snapshotId)
            let body: [String: Any]
            do { body = try await session.capture(snapshotId: snapshotId, screenAccessApproved: grant.screenAccessApproved) }
            catch { state.cancelCapture(ticket); sync(grant.id, session); throw error }
            sync(grant.id, session)
            try state.finishCapture(ticket)
            return ControlResponse.success(body, halted: state.grants[grant.id]?.halted ?? true)
        case let .click(id, caller, requestId, snapshotId, x, y):
            return try await mutate("click", grant: id, caller: caller, requestId: requestId, snapshotId: snapshotId,
                                    element: "", value: nil, coordinate: (x, y), owner: owner)
        case let .press(id, caller, requestId, snapshotId, element):
            return try await mutate("press", grant: id, caller: caller, requestId: requestId, snapshotId: snapshotId,
                                    element: element, value: nil, owner: owner)
        case let .setValue(id, caller, requestId, snapshotId, element, value):
            return try await mutate("set-value", grant: id, caller: caller, requestId: requestId, snapshotId: snapshotId,
                                    element: element, value: value, owner: owner)
        case let .receipt(id, caller, requestId):
            let grant = try state.access(id, caller: caller, owner: owner, allowHalted: true)
            guard let receipt = state.receipt(grant.id, requestId: requestId) else { throw ControlError("receipt-unknown") }
            return ControlResponse.success(["receipt": receipt.json], halted: grant.halted)
        case let .revoke(id, caller):
            let removed = try state.revoke(id, caller: caller, owner: owner)
            stop(sessionsOf: [id])
            return ControlResponse.success(["revoked": removed], halted: true)
        case let .revokeSession(sessionId):
            let ended = state.revokeSession(sessionId, owner: owner)
            ScopedControlShared.service.end(owner: owner, sessionId: sessionId)
            stop(sessionsOf: ended.revoked)
            return ControlResponse.success(["revoked": ended.revoked.count, "cancelled": ended.cancelled])
        case .disconnectOwner:
            let ended = state.disconnectOwner(owner)
            ScopedControlShared.service.end(owner: owner)
            stop(sessionsOf: ended.revoked)
            return ControlResponse.success(["revoked": ended.revoked.count, "cancelled": ended.cancelled])
        }
    }

    /// One change through the core's admission: exact observation, process order, one attempt, no replay. Everything
    /// refused before the AX action says `notDispatched`; anything after it is unknown and stops the grant.
    private func mutate(_ operation: String, grant id: String, caller: ControlCaller, requestId: String, snapshotId: String,
                        element: String, value: String?, coordinate: (Double, Double)? = nil, owner: ControlOwner) async throws -> Data {
        let grant: GrantEntry
        do { grant = try state.access(id, caller: caller, owner: owner) } catch let error as ControlError { throw ControlError.refuse(error.code) }
        guard let session = sessions[grant.id] else { throw ControlError.refuse("worker-halted") }
        let ticket = try state.beginMutation(grant.id, requestId: requestId, snapshotId: snapshotId)
        let body: [String: Any]
        do {
            if let coordinate { body = try await session.click(snapshotId: snapshotId, x: coordinate.0, y: coordinate.1) }
            else { body = try await session.perform(operation, snapshotId: snapshotId, element: element, value: value) }
        } catch let error as ControlError where error.notDispatched {
            state.finishMutation(ticket, .refused(error.code)); sync(grant.id, session); throw error
        } catch {
            // It may have reached the app: unknown, the grant stops, and nothing is retried.
            state.finishMutation(ticket, .unknown); sync(grant.id, session); throw error
        }
        let outcome = (body["outcome"] as? [String: Any])?["state"] as? String
        let result: MutationResult
        if body["humanStatePreserved"] as? Bool != true { result = .humanTakeover }
        else {
            switch outcome {
            case "confirmed_change", "confirmed_no_change": result = .confirmed
            case "refused": result = .refused("native-refused")
            case "dispatched_unverified": result = .dispatchedUnverified
            default: result = .unknown
            }
        }
        state.finishMutation(ticket, result)
        sync(grant.id, session)
        return ControlResponse.success(body, halted: state.grants[grant.id]?.halted ?? true)
    }

    // MARK: The person's decisions (this app's windows only)

    /// Control resolves the target itself; a changed, closed or refused window can only be denied. The approval key is
    /// read or created, and the approval signed, only here, after LocalAuthentication succeeded. Cancelling the prompt
    /// signs nothing and allows nothing.
    func approve(_ approvalId: String, screenAccessApproved: Bool = false) async {
        problem = nil
        guard approving == nil, let entry = state.approvals[approvalId], entry.state == .pending else { return }
        guard ComputerUseEngine.accessibilityTrusted else {
            problem = "AgentsToZ Control에 손쉬운 사용 권한이 없어 승인해도 제어할 수 없습니다. 설정에서 권한을 확인하세요."; return
        }
        guard (try? ComputerUseEngine.identity(pid: entry.target.pid, window: entry.target.windowId)) == entry.target else {
            problem = "요청한 창이 바뀌었거나 닫혔습니다. 거부하고 다시 요청받으세요."; return
        }
        let context = LAContext()
        guard authentication.begin(approvalId, expiresAt: entry.expiresAt, cancel: { context.invalidate() }) else { return }
        approving = approvalId
        defer { if approving == approvalId { approving = nil }; authentication.complete(approvalId, now: nowMs()); refresh() }
        // The prompt names screen images whenever the person turned them on for this request.
        let reason = ControlConsentText.approvalReason(screenAccess: screenAccessApproved)
        let authenticated = await authenticate(context, reason: reason)
        guard authentication.complete(approvalId, now: nowMs()) else {
            problem = "인증하는 동안 요청이 끝났습니다. 현재 대기 중인 요청을 다시 확인하세요."; return
        }
        guard authenticated else {
            problem = "승인하지 않았습니다. 아무것도 허용되지 않았습니다."; return
        }
        // The request may have ended (session revoked, expired, main app gone) while the person authenticated.
        guard state.approvals[approvalId]?.state == .pending else {
            problem = "그사이 요청이 끝났습니다. 아무것도 허용되지 않았습니다."; return
        }
        do {
            let key = try ComputerUseApproval.approvalKey(tag: Self.approvalKeyTag, authenticationContext: context)
            let payload = ApprovalPayload(approvalId: approvalId, target: entry.target, caller: entry.caller.approvalCaller,
                                          issuedAt: nowMs(), expiresAt: entry.expiresAt)
            let signed = SignedApproval(payload: payload, signature: try ComputerUseApproval.sign(payload, with: key),
                                        publicKey: try ComputerUseApproval.publicPoint(of: key))
            try state.approve(approvalId, signed: signed, screenAccessApproved: screenAccessApproved)
        } catch let error as ControlError {
            problem = error.code == "grant-limit" ? "이미 8개 창을 제어 중입니다. 하나를 중단한 뒤 다시 승인하세요."
                : "그사이 요청이 끝났거나 바뀌었습니다. 아무것도 허용되지 않았습니다."
        } catch {
            problem = "승인 서명을 만들지 못했습니다. 아무것도 허용되지 않았습니다."
        }
    }
    private func authenticate(_ context: LAContext, reason: String) async -> Bool {
        await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in continuation.resume(returning: ok) }
        }
    }
    func deny(_ approvalId: String) { problem = nil; state.deny(approvalId); refresh() }
    func stop(_ grantId: String) { state.halt(grantId, reason: "human-stop"); sessions[grantId]?.stop(); refresh() }
    func stopAll() { state.stopAll(); for session in sessions.values { session.stop() }; ScopedControlShared.service.stop(); refresh() }
    func dismissProblem() { problem = nil }

    // MARK: Background service (the person's settings only)

    @ObservationIgnored private let agent = SMAppService.agent(plistName: ControlContract.agentPlistName)
    private(set) var agentStatus: SMAppService.Status = .notRegistered
    func readAgentStatus() { agentStatus = agent.status }
    /// Registers Control's own LaunchAgent from its own bundle. `requiresApproval` and `enabled` differ; neither is
    /// proof of the Accessibility permission or of isolation.
    func registerAgent() {
        problem = nil
        do { try agent.register() } catch { problem = "백그라운드 실행을 등록하지 못했습니다. 로그인 항목 설정을 확인하세요." }
        readAgentStatus()
    }
    /// Stops Control from starting in the background. Grants already made stay until they end; nothing is revoked
    /// silently in System Settings.
    func unregisterAgent() async {
        problem = nil
        do { try await agent.unregister() } catch { problem = "백그라운드 실행 등록을 해제하지 못했습니다." }
        readAgentStatus()
    }
}
