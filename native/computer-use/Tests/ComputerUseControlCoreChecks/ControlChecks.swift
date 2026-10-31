import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

// AgentsToZ Control core checks: the XPC contract, approval and grant lifetimes, owner/session fences, receipts and
// the per-process change order. Runs two ways: `swift test`, and `scripts/check-computer-use-control.ts`
// (swiftc -D CORE_CHECKS), which needs neither XCTest nor the Peekaboo checkout.

struct CheckFailure: Error, CustomStringConvertible { let description: String }

func check(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) throws {
    if !condition { throw CheckFailure(description: "line \(line): \(message())") }
}
func expectCode(_ code: String, notDispatched: Bool? = nil, line: Int = #line, _ body: () throws -> Void) throws {
    do { try body() } catch let error as ControlError {
        try check(error.code == code, "expected \(code), got \(error.code)", line: line)
        if let notDispatched { try check(error.notDispatched == notDispatched, "\(code): notDispatched \(error.notDispatched)", line: line) }
        return
    }
    throw CheckFailure(description: "line \(line): expected \(code), nothing was thrown")
}

/// A fixed clock, deterministic IDs and main-app process generations that a check can end.
final class Fixture {
    var time: Int64 = 1_793_000_000_000
    var counter = 0
    var dead: Set<ControlOwner> = []
    lazy var state = ControlState(now: { [unowned self] in self.time },
                                  newId: { [unowned self] in self.counter += 1; return String(format: "%032x", self.counter) },
                                  ownerAlive: { [unowned self] in !self.dead.contains($0) })
    let main = ControlOwner(pid: 500, start: 1_000)
    let target = ApprovalTarget(bundleId: "com.example.editor", teamId: "ABCDEFGHIJ", codeHash: String(repeating: "ab", count: 20),
                                pid: 100, processStart: "9007199254740995", windowId: 321)
    let caller = ControlCaller(sessionId: "workroom_session_a", lane: "leader", generation: String(repeating: "cd", count: 16))
    func approvalId(_ n: Int) -> String { String(format: "%064x", n) }
    func signed(_ id: String, target: ApprovalTarget? = nil, caller: ControlCaller? = nil, expiresAt: Int64? = nil) -> SignedApproval {
        let entry = state.approvals[id]
        let payload = ApprovalPayload(approvalId: id, target: target ?? entry?.target ?? self.target,
                                      caller: (caller ?? entry?.caller ?? self.caller).approvalCaller,
                                      issuedAt: time, expiresAt: expiresAt ?? entry?.expiresAt ?? time + ControlLimits.approvalMs)
        return SignedApproval(payload: payload, signature: Data([0x30, 0x44]), publicKey: Data([4] + Array(repeating: 1, count: 64)))
    }
    func submit(_ n: Int, target: ApprovalTarget? = nil, caller: ControlCaller? = nil, owner: ControlOwner? = nil) throws {
        try state.submit(approvalId: approvalId(n), target: target ?? self.target, caller: caller ?? self.caller, label: "Edit draft",
                         expiresAt: time + ControlLimits.approvalMs, owner: owner ?? main)
    }
    /// Request, approve (the person) and open: a working grant.
    func grant(_ n: Int, target: ApprovalTarget? = nil, caller: ControlCaller? = nil, owner: ControlOwner? = nil) throws -> GrantEntry {
        try submit(n, target: target, caller: caller, owner: owner)
        try state.approve(approvalId(n), signed: signed(approvalId(n)))
        return try state.openGrant(approvalId(n), caller: caller ?? self.caller, target: target ?? self.target, owner: owner ?? main)
    }
    func observe(_ g: GrantEntry, snapshot: String = "ps1_exact") throws {
        let revision = try state.beginObservation(g.id)
        try state.finishObservation(g.id, snapshotId: snapshot, revision: revision)
    }
}

struct ControlChecks {
    let fixturePath: String

    func testReviewPresentationRequiresEveryOSSignal() throws {
        // All combinations exercise the conservative contract, including cases such as an existing AX window
        // in another Space, or an on-screen window whose app never became frontmost.
        for mask in 0..<128 {
            let evidence = ReviewPresentationEvidence(
                visible: mask & 1 != 0, activeSpace: mask & 2 != 0, keyWindow: mask & 4 != 0,
                partiallyUnobscured: mask & 8 != 0, applicationActive: mask & 16 != 0,
                applicationFrontmost: mask & 32 != 0, onPointerScreen: mask & 64 != 0
            )
            try check(evidence.confirmed == (mask == 127), "review foreground evidence \(mask)")
        }
    }

    /// Regression (live v1584): with two displays the review window could pass every signal on the display the person
    /// was not looking at. It is moved to the pointer's display, and a window elsewhere is never confirmed.
    func testReviewOpensOnTheDisplayThePersonClicked() throws {
        func require<T>(_ value: T?, _ message: String) throws -> T {
            guard let value else { throw CheckFailure(description: message) }
            return value
        }
        let main = ReviewScreen(frame: ReviewRect(x: 0, y: 0, width: 1440, height: 900), visible: ReviewRect(x: 0, y: 0, width: 1440, height: 875))
        let second = ReviewScreen(frame: ReviewRect(x: 1440, y: -200, width: 1920, height: 1080),
                                  visible: ReviewRect(x: 1440, y: -200, width: 1920, height: 1055))
        let screens = [main, second]
        func on(_ window: ReviewRect, _ x: Double, _ y: Double, _ list: [ReviewScreen] = screens) -> Bool {
            ReviewPlacement.onPointerScreen(window, screens: list, pointerX: x, pointerY: y)
        }
        func place(_ window: ReviewRect, _ x: Double, _ y: Double) -> ReviewRect? {
            ReviewPlacement.frame(for: window, screens: screens, pointerX: x, pointerY: y)
        }
        let centredOnMain = ReviewRect(x: 490, y: 270, width: 460, height: 360)
        try check(ReviewPlacement.screen(atX: 2000, y: 300, in: screens) == second && ReviewPlacement.screen(atX: 100, y: 100, in: screens) == main
                  && ReviewPlacement.screen(atX: 1440, y: 899, in: screens) == main, "the pointer names its display, edges included")
        try check(!on(centredOnMain, 2000, 300), "a window centred on the main display is not on the display the person clicked")
        let moved = try require(place(centredOnMain, 2000, 300), "moved to the clicked display")
        try check(moved == ReviewRect(x: 2170, y: 148, width: 460, height: 360), "centred in the clicked display's visible frame: \(moved)")
        try check(on(moved, 2000, 300) && place(moved, 2000, 300) == nil, "then it is on that display and keeps its place")
        try check(place(ReviewRect(x: -1000, y: -1000, width: 3440, height: 2900), 100, 100) == nil,
                  "a window centred on the clicked display stays, whatever its size")
        let large = try require(place(ReviewRect(x: 0, y: 0, width: 4000, height: 3000), 2000, 300), "a large window moves")
        try check(large == second.visible, "never larger than the clicked display's visible frame: \(large)")
        try check(ReviewPlacement.screen(atX: -50, y: -50, in: screens) == nil && !on(moved, -50, -50) && place(moved, -50, -50) == nil,
                  "no display under the pointer: nothing moves and nothing is confirmed")
        try check(!on(moved, 2000, 300, []), "no displays read is never confirmation")
        let elsewhere = ReviewPresentationEvidence(visible: true, activeSpace: true, keyWindow: true, partiallyUnobscured: true,
            applicationActive: true, applicationFrontmost: true, onPointerScreen: on(centredOnMain, 2000, 300))
        try check(ReviewPresentationDecision.assess(elsewhere, ownerAlive: true, frontmost: 2, ownerPID: 1, controlPID: 2) == .wait,
                  "a key, frontmost window on another display is never reported visible")
    }

    func testReviewPollingStopsWhenTheUserChangesApps() throws {
        let visible = ReviewPresentationEvidence(visible: true, activeSpace: true, keyWindow: true,
            partiallyUnobscured: true, applicationActive: true, applicationFrontmost: true, onPointerScreen: true)
        let waiting = ReviewPresentationEvidence(visible: true, activeSpace: false, keyWindow: false,
            partiallyUnobscured: false, applicationActive: false, applicationFrontmost: false, onPointerScreen: true)
        try check(ReviewPresentationDecision.assess(visible, ownerAlive: true, frontmost: 2, ownerPID: 1, controlPID: 2) == .confirmed,
                  "verified foreground is confirmed")
        try check(ReviewPresentationDecision.assess(waiting, ownerAlive: true, frontmost: 1, ownerPID: 1, controlPID: 2) == .wait,
                  "a pending OS activation may settle")
        try check(ReviewPresentationDecision.assess(waiting, ownerAlive: true, frontmost: nil, ownerPID: 1, controlPID: 2) == .wait,
                  "unknown foreground is never confirmation")
        try check(ReviewPresentationDecision.assess(visible, ownerAlive: true, frontmost: nil, ownerPID: 1, controlPID: 2) == .wait,
                  "inconsistent or missing foreground evidence is never confirmation")
        try check(ReviewPresentationDecision.assess(visible, ownerAlive: true, frontmost: 3, ownerPID: 1, controlPID: 2) == .abort,
                  "a switch to an unrelated application aborts even if other evidence is stale")
        try check(ReviewPresentationDecision.assess(visible, ownerAlive: false, frontmost: 2, ownerPID: 1, controlPID: 2) == .abort,
                  "a terminated or replaced owner never confirms")
    }

    func testReviewPresentationConfirmsItsWireEvidence() throws {
        let reply = try JSONSerialization.jsonObject(with: ControlResponse.confirmedReviewPresentation()) as! [String: Any]
        try check(reply["success"] as? Bool == true && reply["opened"] as? Bool == true,
                  "confirmed review is a successful open")
        try check(reply["visibilityConfirmed"] as? Bool == true, "caller can distinguish older unchecked helpers")
    }

    func testContractSamples() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let valid = root["valid"] as? [String: [String: Any]], let invalid = root["invalid"] as? [[String: Any]],
              let agent = valid["agent"], let management = valid["management"] else {
            throw CheckFailure(description: "contract fixture unreadable")
        }
        try check(Set(agent.keys) == ControlRequest.agentOperations, "a sample for every agent operation")
        try check(Set(management.keys) == ControlRequest.managementOperations, "a sample for every management operation")
        for (channel, samples) in [(ControlChannel.agent, agent), (.management, management)] {
            for (op, sample) in samples {
                let decoded = try ControlRequest.decode(JSONSerialization.data(withJSONObject: sample))
                try check(decoded.channel == channel && decoded.request.operation == op, "\(channel) \(op) decoded as \(decoded.request.operation)")
            }
        }
        try check(invalid.count >= 30, "the invalid samples are present")
        for entry in invalid {
            let bytes = try JSONSerialization.data(withJSONObject: entry["request"] as Any)
            do { _ = try ControlRequest.decode(bytes); throw CheckFailure(description: "accepted: \(entry["why"] ?? "")") }
            catch let error as ControlError { try check(error.code == "invalid-request", "\(entry["why"] ?? ""): \(error.code)") }
        }
        try expectCode("invalid-request") { _ = try ControlRequest.decode(Data(repeating: 0x20, count: ControlLimits.requestBytes + 1)) }
        try expectCode("invalid-request") { _ = try ControlRequest.decode(Data("[1]".utf8)) }
        // Only the agent path reaches the engine; only management reads the catalog and the approval list.
        let engine: Set<String> = ["open-grant", "observe", "press", "set-value", "capture", "click", "receipt"]
        try check(engine.isSubset(of: ControlRequest.agentOperations) && engine.isDisjoint(with: ControlRequest.managementOperations),
                  "engine operations are agent-only")
        try check(["catalog", "approvals", "cancel-approval"].allSatisfy { !ControlRequest.agentOperations.contains($0) },
                  "catalog, approval list and withdrawal are management-only")
        try check(ControlRequest.agentOperations.intersection(ControlRequest.managementOperations)
                  == ["status", "request-approval", "approval-status", "revoke", "revoke-session", "disconnect-owner"],
                  "what both share only asks, reads or ends")
        try check(ControlLimits.requestBytes == 16_384 && ControlLimits.responseBytes <= 524_288, "inside the main bridge's frame caps")
    }

    func testScreenPermissionAndCaptureOrdering() throws {
        let f = Fixture()
        let ordinary = try f.grant(1)
        try f.observe(ordinary)
        try expectCode("screen-consent-required") { _ = try f.state.beginCapture(ordinary.id, snapshotId: "ps1_exact") }
        try f.submit(2)
        try f.state.approve(f.approvalId(2), signed: f.signed(f.approvalId(2)), screenAccessApproved: true)
        let g = try f.state.openGrant(f.approvalId(2), caller: f.caller, target: f.target, owner: f.main)
        try check(g.screenAccessApproved && !ordinary.screenAccessApproved, "screen consent belongs to one grant")
        try f.observe(g)
        let capture = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        try expectCode("process-busy") { _ = try f.state.beginMutation(ordinary.id, requestId: "request_1000", snapshotId: "ps1_exact") }
        try f.state.finishCapture(capture)
        let click = try f.state.beginMutation(g.id, requestId: "request_1001", snapshotId: "ps1_exact")
        f.state.finishMutation(click, .confirmed)
        try expectCode("duplicate-request") { _ = try f.state.beginMutation(g.id, requestId: "request_1001", snapshotId: "ps1_exact") }
        try f.observe(g)
        let revoked = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        f.state.remove(g.id)
        try expectCode("observation-discarded") { try f.state.finishCapture(revoked) }
        try check(!f.state.isBusy(revoked.process), "revoked capture releases process lane")
    }

    /// A capture that was open when the person stopped the grant, when its observation aged past 15 s, when the grant
    /// expired or when the same grant began a new observation hands no image over, and frees the process lane.
    func testCaptureEndsOnStopExpiryOrReplacedObservation() throws {
        let f = Fixture()
        func screenGrant(_ n: Int) throws -> GrantEntry {
            try f.submit(n)
            try f.state.approve(f.approvalId(n), signed: f.signed(f.approvalId(n)), screenAccessApproved: true)
            let g = try f.state.openGrant(f.approvalId(n), caller: f.caller, target: f.target, owner: f.main)
            try f.observe(g)
            return g
        }
        var g = try screenGrant(1)
        var ticket = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        f.state.halt(g.id, reason: "human-stop")
        try expectCode("observation-discarded", notDispatched: true) { try f.state.finishCapture(ticket) }
        try check(!f.state.isBusy(ticket.process), "a stopped capture releases the process lane")
        try expectCode("worker-halted", notDispatched: true) { _ = try f.state.beginCapture(g.id, snapshotId: "ps1_exact") }

        g = try screenGrant(2)
        ticket = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        try check(f.state.stopAll() == 1, "the person's stop-all reaches the capturing grant")
        try expectCode("observation-discarded", notDispatched: true) { try f.state.finishCapture(ticket) }
        try check(!f.state.isBusy(ticket.process), "stop-all releases the process lane")

        g = try screenGrant(3)
        ticket = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        f.time += ControlLimits.observationMs + 1
        try expectCode("observation-discarded", notDispatched: true) { try f.state.finishCapture(ticket) }
        try check(!f.state.isBusy(ticket.process), "an aged capture releases the process lane")

        try f.observe(g)
        ticket = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        f.time += ControlLimits.grantMs
        try expectCode("observation-discarded", notDispatched: true) { try f.state.finishCapture(ticket) }
        try check(f.state.grants[g.id] == nil && !f.state.isBusy(ticket.process), "an expired grant is gone and frees the lane")

        g = try screenGrant(4)
        ticket = try f.state.beginCapture(g.id, snapshotId: "ps1_exact")
        try expectCode("process-busy", notDispatched: true) { _ = try f.state.beginObservation(g.id) }
        try expectCode("observation-discarded", notDispatched: true) { try f.state.finishCapture(ticket) }
        try check(!f.state.isBusy(ticket.process), "a replaced observation releases the lane")
    }

    /// `status` and `open-grant` advertise capture/click with the exact reply fields of the shared samples; a Control
    /// that predates them sends no `operations`, which the main app treats as "update Control".
    func testStatusAndOpenGrantAdvertiseTheEngineOperations() throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: fixturePath))
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let replies = root["replies"] as? [String: Any],
              let status = replies["status"] as? [String: Any], let open = replies["open-grant"] as? [String: Any] else {
            throw CheckFailure(description: "reply samples unreadable")
        }
        let engine = Set(ControlContract.engineOperations)
        try check(engine.isSuperset(of: ["capture", "click"]) && engine.isSubset(of: ControlRequest.agentOperations)
                  && engine.isDisjoint(with: ControlRequest.managementOperations), "advertised operations are agent engine operations")
        for (name, sample, reply) in [("status", status, ControlResponse.status(accessibility: true, secureInput: false, pendingApprovals: 0, grants: 1)),
                                      ("open-grant", open, ControlResponse.openGrant(String(repeating: "ef", count: 16), expiresAt: 1_793_000_631_000))] {
            let body = try JSONSerialization.jsonObject(with: reply) as? [String: Any] ?? [:]
            try check(Set(body.keys) == Set(sample.keys), "\(name) reply fields \(body.keys.sorted()) match the sample \(sample.keys.sorted())")
            try check(body["operations"] as? [String] == ControlContract.engineOperations
                      && sample["operations"] as? [String] == ControlContract.engineOperations, "\(name) lists the engine operations")
            try check(body["protocolVersion"] as? Int == sample["protocolVersion"] as? Int, "\(name) protocol version")
        }
    }

    /// The Touch ID or password prompt and the active-grant row say when a grant may also read screen images.
    func testConsentTextNamesScreenImages() throws {
        try check(ControlConsentText.approvalReason(screenAccess: true).contains("화면 이미지"), "the screen-image prompt names screen images")
        try check(!ControlConsentText.approvalReason(screenAccess: false).contains("화면 이미지"), "an ordinary prompt does not")
        try check(ControlConsentText.approvalReason(screenAccess: true).contains("10분"), "both keep the ten-minute limit")
        try check(ControlConsentText.grantAccess(screenAccessApproved: true) != ControlConsentText.grantAccess(screenAccessApproved: false),
                  "an active grant shows whether it may capture")
    }

    /// A refused scope approval names its cause; the secure-input case tells the person to close the password field.
    /// Hardware clicks carry no posting process; remote desktops are accepted by verified signing name; anything else
    /// that posted the event (this process, the engine's marker, an AI or a script) is refused, as is a stale event.
    func testControlBarHandsBackOnlyAPersonsClick() throws {
        let tag: Int64 = 0x41545A53434F5045
        func decide(up: Bool = true, inBar: Bool = true, age: Double = 0.05, source: Int64 = 0, data: Int64 = 0,
                    poster: ControlBarPoster? = nil) -> String? {
            ControlBarClick.handBackRefusal(isMouseUp: up, inBar: inBar, ageSeconds: age, sourcePid: source, userData: data,
                                            ownPid: 500, syntheticTag: tag, poster: poster)
        }
        try check(decide() == nil, "a hardware click hands back")
        try check(decide(up: false) == "not-a-bar-click" && decide(inBar: false) == "not-a-bar-click", "only the bar's own mouse-up")
        try check(decide(age: 3) == "stale-event" && decide(age: -1) == "stale-event", "an old or future event is not the click")
        try check(decide(data: tag) == "engine-event", "the engine's own marker never hands back")
        try check(decide(source: 500) == "own-event", "Control's own event never hands back")
        try check(decide(source: 77) == "poster-unverified", "an unverified poster never hands back")
        try check(decide(source: 77, poster: ControlBarPoster(identifier: "com.p5sys.jump.connect", team: "2HCKV38EEC", apple: false)) == nil,
                  "Jump Desktop Connect, verified, hands back")
        try check(decide(source: 77, poster: ControlBarPoster(identifier: "com.p5sys.jump.connect", team: "XXXXXXXXXX", apple: false)) == "poster-not-remote-desktop",
                  "the same name under another team does not")
        try check(decide(source: 77, poster: ControlBarPoster(identifier: "com.apple.screensharing.agent", team: nil, apple: true)) == nil,
                  "Apple screen sharing hands back")
        try check(decide(source: 77, poster: ControlBarPoster(identifier: "com.apple.screensharing.agent", team: nil, apple: false)) == "poster-not-remote-desktop",
                  "an Apple name without Apple's anchor does not")
        for agent in ["com.openai.codex", "com.anthropic.claudefordesktop", "com.apple.Terminal", "com.intenet.agentstozbycs"] {
            try check(decide(source: 77, poster: ControlBarPoster(identifier: agent, team: "TEAM", apple: agent.hasPrefix("com.apple."))) == "poster-not-remote-desktop",
                      "\(agent) never hands back")
        }
        try check(ControlBarText.primary(.agent) == "직접 하기" && ControlBarText.primary(.person) == "AI에게 넘기기", "the bar's verbs")
        try check(ControlBarText.detail(.agent, scope: "전체 Mac", lastOperation: "scope-type-text", secondsAgo: 12) == "전체 Mac · 마지막 동작: 입력 · 12초 전",
                  "the agent's last action")
        try check(ControlBarText.detail(.agent, scope: "전체 Mac", lastOperation: nil, secondsAgo: nil) == "전체 Mac · 화면을 보는 중", "no action yet")
    }

    func testScopeApprovalRefusalNamesItsCause() throws {
        let secure = ControlConsentText.scopeApprovalRefused(code: "secure-state-unavailable", secureInput: true)
        let locked = ControlConsentText.scopeApprovalRefused(code: "secure-state-unavailable", secureInput: false)
        try check(secure.contains("보안 입력") && !locked.contains("보안 입력") && locked.contains("잠겨"), "secure input and a locked screen read differently")
        let codes = ["secure-state-unavailable", "permission-unavailable", "target-changed", "scope-conflict", "approval-unknown", "invalid-request", "some-new-code"]
        let texts = codes.map { ControlConsentText.scopeApprovalRefused(code: $0, secureInput: false) }
        try check(Set(texts).count == texts.count - 1, "each cause has its own sentence; approval-unknown and invalid-request share one")
        try check(texts.allSatisfy { $0.contains("허용되지 않았습니다") || $0.contains("다시 승인") }, "each says nothing was allowed or what to do")
        try check(texts.last?.contains("some-new-code") == true, "an unknown code is named, not hidden")
    }

    func testCaptureAndClickRequestValidation() throws {
        let caller: [String: Any] = ["sessionId": "workroom_session_a", "lane": "leader", "generation": String(repeating: "cd", count: 16)]
        var request: [String: Any] = ["v": 1, "channel": "agent", "op": "click", "grant": String(repeating: "ef", count: 16),
             "caller": caller, "requestId": "request_1000", "snapshotId": "ps1_exact", "x": 1.25, "y": 2.0]
        _ = try ControlRequest.decode(JSONSerialization.data(withJSONObject: request))
        for invalid in [true, -1, 100_001] as [Any] {
            request["x"] = invalid
            try expectCode("invalid-request") { _ = try ControlRequest.decode(JSONSerialization.data(withJSONObject: request)) }
        }
        request["x"] = 1; request["screenAccessApproved"] = true
        try expectCode("invalid-request") { _ = try ControlRequest.decode(JSONSerialization.data(withJSONObject: request)) }
        request.removeValue(forKey: "screenAccessApproved"); request["channel"] = "management"
        try expectCode("invalid-request") { _ = try ControlRequest.decode(JSONSerialization.data(withJSONObject: request)) }
    }

    func testRepliesAreBoundedAndFixedShape() throws {
        let ok = try JSONSerialization.jsonObject(with: ControlResponse.success(["success": false, "halted": true, "x": 1])) as! [String: Any]
        try check(ok["success"] as? Bool == true && ok["halted"] as? Bool == false, "a body cannot override success or halted")
        let big = ControlResponse.success(["blob": String(repeating: "a", count: ControlLimits.responseBytes)])
        let answer = try JSONSerialization.jsonObject(with: big) as! [String: Any]
        try check(answer["code"] as? String == "response-too-large" && answer["success"] as? Bool == false, "oversized replies are a fixed failure")
        let fail = try JSONSerialization.jsonObject(with: ControlResponse.failure(.refuse("human-active", retryAfterMs: 700))) as! [String: Any]
        try check(fail["notDispatched"] as? Bool == true && fail["retryAfterMs"] as? Int == 700, "refusals say nothing was sent")
    }

    func testRefusedTargets() throws {
        for bundle in ["com.intenet.agentstozbycs", "com.intenet.agentstozbycs.screen", "com.intenet.agentstozbycs.control",
                       "COM.OPENAI.CODEX", "com.apple.Terminal", "com.apple.SecurityAgentHelper.arm64", "com.nousresearch.hermes",
                       "com.apple.Passwords", "com.anthropic.claudefordesktop", "com.stablyai.orca"] {
            try check(RefusedTargets.refuses(bundle: bundle), "\(bundle) must be refused")
        }
        try check(!RefusedTargets.refuses(bundle: "com.example.editor"), "an ordinary app is allowed")
        let f = Fixture()
        let signedByUs = ApprovalTarget(bundleId: "com.example.renamed", teamId: "DA8QKAQ2C9", codeHash: f.target.codeHash,
                                        pid: 100, processStart: "1", windowId: 1)
        try check(RefusedTargets.refuses(signedByUs), "anything the AgentsToZ team signs is refused")
        try expectCode("target-refused") { try f.submit(1, target: signedByUs) }
    }

    func testUnknownTextSubroleIsNotExposed() throws {
        try check(!ControlTextObservationPolicy.allows(isTextField: true, role: "AXTextField", subrole: nil, settable: false), "SDK omitted text-field subrole")
        try check(!ControlTextObservationPolicy.allows(isTextField: false, role: "AXTextArea", subrole: nil, settable: false), "SDK omitted text-area subrole")
        try check(!ControlTextObservationPolicy.allows(isTextField: false, role: "AXUnknown", subrole: nil, settable: true), "unknown settable element")
        try check(!ControlTextObservationPolicy.allows(isTextField: true, role: "AXTextField", subrole: "", settable: true), "empty subrole")
        try check(!ControlTextObservationPolicy.allows(isTextField: true, role: "AXTextField", subrole: "AXSecureTextField", settable: true), "secure subrole")
        try check(!ControlTextObservationPolicy.allows(isTextField: false, role: "AXSecureTextField", subrole: nil, settable: false), "secure role")
        try check(ControlTextObservationPolicy.allows(isTextField: true, role: "AXTextField", subrole: "AXSearchField", settable: true), "known non-secure subrole")
        try check(ControlTextObservationPolicy.allows(isTextField: false, role: "AXButton", subrole: nil, settable: false), "ordinary button")
        for role in ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXLink"] {
            try check(ControlTextObservationPolicy.allows(isTextField: false, role: role, subrole: nil, settable: true), "non-text \(role) stays available")
            try check(!ControlTextObservationPolicy.allows(isTextField: false, role: role, subrole: "AXSecureTextField", settable: true), "secure \(role) refused")
        }
        try check(!ControlTextObservationPolicy.allows(isTextField: true, role: "AXButton", subrole: nil, settable: true), "conflicting text classification fails closed")
    }

    func testObservationCompleteness() throws {
        try check(!ControlObservationCompleteness.truncated(sdkTruncated: false, detected: 3, returned: 3), "complete detection")
        try check(ControlObservationCompleteness.truncated(sdkTruncated: true, detected: 3, returned: 3), "SDK traversal was truncated")
        try check(ControlObservationCompleteness.truncated(sdkTruncated: false, detected: 3, returned: 2), "security filter omitted elements")
    }

    func testApprovalRequestsAreBoundedAndExpire() throws {
        let f = Fixture()
        for n in 1...8 { try f.submit(n) }
        try expectCode("approval-limit") { try f.submit(9) }
        try expectCode("approval-expired") {
            try f.state.submit(approvalId: f.approvalId(10), target: f.target, caller: f.caller, label: "Edit", expiresAt: f.time + ControlLimits.approvalMs + ControlLimits.skewMs + 1, owner: f.main)
        }
        try expectCode("invalid-request") { try f.submit(1) }
        f.state.deny(f.approvalId(1))
        try check(f.state.entry(f.approvalId(1), caller: f.caller, owner: f.main)?.state == .denied, "denied")
        try check(f.state.entry(f.approvalId(2), caller: f.caller, owner: ControlOwner(pid: 500, start: 2_000)) == nil, "another owner learns nothing")
        let otherLane = ControlCaller(sessionId: f.caller.sessionId, lane: "member-2", generation: f.caller.generation)
        try check(f.state.entry(f.approvalId(2), caller: otherLane, owner: f.main) == nil, "another lane learns nothing")
        f.time += ControlLimits.approvalMs + 1
        try check(f.state.entry(f.approvalId(3), caller: f.caller, owner: f.main)?.state == .expired, "a request waits 10 min at most")
        try expectCode("approval-unknown") { try f.state.approve(f.approvalId(3), signed: f.signed(f.approvalId(3))) }
        f.time += ControlLimits.decidedRetentionMs + 1
        f.state.prune()
        try check(f.state.approvals.isEmpty, "decisions are forgotten after their retention")
    }

    func testApprovalAnswersExactlyItsRequestAndOpensOnce() throws {
        let f = Fixture()
        let id = f.approvalId(1)
        try f.submit(1)
        let other = ApprovalTarget(bundleId: f.target.bundleId, teamId: f.target.teamId, codeHash: f.target.codeHash, pid: 101,
                                   processStart: f.target.processStart, windowId: f.target.windowId)
        try expectCode("invalid-request") { try f.state.approve(id, signed: f.signed(id, target: other)) }
        try expectCode("invalid-request") {
            try f.state.approve(id, signed: f.signed(id, caller: ControlCaller(sessionId: f.caller.sessionId, lane: "member-2", generation: f.caller.generation)))
        }
        try expectCode("invalid-request") { try f.state.approve(id, signed: f.signed(id, expiresAt: f.time + 1)) }
        try expectCode("approval-unknown") { _ = try f.state.openGrant(id, caller: f.caller, target: f.target, owner: f.main) }
        try f.state.approve(id, signed: f.signed(id))
        try check(f.state.grants.isEmpty, "approving alone creates no grant")
        try check(f.state.entry(id, caller: f.caller, owner: f.main)?.signed != nil, "the signed approval is readable by its caller")
        try expectCode("approval-unknown") { try f.state.approve(id, signed: f.signed(id)) }
        let grant = try f.state.openGrant(id, caller: f.caller, target: f.target, owner: f.main)
        try check(grant.expiresAt == f.time + 600_000, "a grant lives 10 minutes from opening")
        let consumed = f.state.entry(id, caller: f.caller, owner: f.main)
        try check(consumed?.state == .consumed && consumed?.signed == nil, "the approval is used up")
        try expectCode("approval-unknown") { _ = try f.state.openGrant(id, caller: f.caller, target: f.target, owner: f.main) }
        try check(f.state.grants.count == 1, "one approval, one grant")
    }

    func testAnApprovalUnopenedForTenMinutesExpires() throws {
        let f = Fixture()
        try f.submit(1)
        try f.state.approve(f.approvalId(1), signed: f.signed(f.approvalId(1)))
        f.time += ControlLimits.approvalMs + 1
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(1), caller: f.caller, target: f.target, owner: f.main) }
        try check(f.state.entry(f.approvalId(1), caller: f.caller, owner: f.main)?.state == .expired, "expired, not consumed")
    }

    func testOpenGrantChecksOwnerCallerAndTarget() throws {
        let f = Fixture()
        let id = f.approvalId(1)
        try f.submit(1)
        try f.state.approve(id, signed: f.signed(id))
        let restarted = ControlOwner(pid: f.main.pid, start: f.main.start + 1)
        try expectCode("approval-unknown") { _ = try f.state.openGrant(id, caller: f.caller, target: f.target, owner: restarted) }
        let reborn = ControlCaller(sessionId: f.caller.sessionId, lane: f.caller.lane, generation: String(repeating: "ee", count: 16))
        try expectCode("approval-unknown") { _ = try f.state.openGrant(id, caller: reborn, target: f.target, owner: f.main) }
        let moved = ApprovalTarget(bundleId: f.target.bundleId, teamId: f.target.teamId, codeHash: f.target.codeHash, pid: 100,
                                   processStart: "9007199254740996", windowId: 321)
        try expectCode("target-changed") { _ = try f.state.openGrant(id, caller: f.caller, target: moved, owner: f.main) }
        let g = try f.state.openGrant(id, caller: f.caller, target: f.target, owner: f.main)
        try expectCode("grant-unknown") { _ = try f.state.access(g.id, caller: reborn, owner: f.main) }
        try expectCode("grant-unknown") { _ = try f.state.access(g.id, caller: f.caller, owner: restarted) }
        try check(try f.state.access(g.id, caller: f.caller, owner: f.main).id == g.id, "the exact owner and caller")
    }

    func testGrantsAreLimitedAndExpire() throws {
        let f = Fixture()
        for n in 1...8 { _ = try f.grant(n) }
        try f.submit(9)
        try expectCode("grant-limit") { try f.state.approve(f.approvalId(9), signed: f.signed(f.approvalId(9))) }
        f.time += 600_000
        try expectCode("grant-unknown") { _ = try f.state.access(String(format: "%032x", 1), caller: f.caller, owner: f.main) }
        try check(f.state.grants.isEmpty, "expired grants are removed")
    }

    func testRevocationIsIdempotentAndScoped() throws {
        let f = Fixture()
        let a = try f.grant(1)
        f.time += 300_000
        let other = ControlCaller(sessionId: "workroom_session_b", lane: "leader", generation: String(repeating: "aa", count: 16))
        let b = try f.grant(2, caller: other)
        try expectCode("grant-unknown") { _ = try f.state.revoke(b.id, caller: f.caller, owner: f.main) }
        try check(f.state.grants[b.id] != nil, "another caller cannot revoke the live grant")
        f.time += 300_000
        try check(try !f.state.revoke(a.id, caller: f.caller, owner: f.main), "already expired is a successful no-op")
        try check(try f.state.access(b.id, caller: other, owner: f.main).id == b.id, "another session remains live")
        try check(try f.state.revoke(b.id, caller: other, owner: f.main), "the exact owner can revoke once")
        try check(try !f.state.revoke(b.id, caller: other, owner: f.main), "repeated revocation is a no-op")
        let restarted = Fixture()
        try check(try !restarted.state.revoke(a.id, caller: f.caller, owner: f.main), "a restarted helper has nothing to revoke")
    }

    func testEndingTheSessionEndsItsRequestsAndGrants() throws {
        let f = Fixture()
        let opened = try f.grant(1)
        try f.submit(2)
        try f.state.approve(f.approvalId(2), signed: f.signed(f.approvalId(2)))
        try f.submit(3)
        let other = ControlCaller(sessionId: "workroom_session_b", lane: "leader", generation: String(repeating: "aa", count: 16))
        let kept = try f.grant(4, caller: other)
        let ended = f.state.revokeSession(f.caller.sessionId, owner: f.main)
        try check(ended.revoked == [opened.id] && ended.cancelled == 2, "its grant ends; its approved and waiting requests are cancelled")
        try expectCode("grant-unknown") { _ = try f.state.access(opened.id, caller: f.caller, owner: f.main) }
        // A signature that arrives after the session ended creates nothing: the request is no longer waiting.
        try expectCode("approval-unknown") { try f.state.approve(f.approvalId(3), signed: f.signed(f.approvalId(3))) }
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(2), caller: f.caller, target: f.target, owner: f.main) }
        try check(f.state.entry(f.approvalId(2), caller: f.caller, owner: f.main)?.signed == nil, "a cancelled approval keeps no signature")
        try check(f.state.grants[kept.id] != nil, "another session keeps its grant")
        // The same session ID with a new credential starts from nothing.
        let reborn = ControlCaller(sessionId: f.caller.sessionId, lane: f.caller.lane, generation: String(repeating: "ee", count: 16))
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(2), caller: reborn, target: f.target, owner: f.main) }
    }

    func testTheMainAppEndingEndsEverythingItOwned() throws {
        let f = Fixture()
        let old = try f.grant(1)
        try f.submit(2)
        try f.state.approve(f.approvalId(2), signed: f.signed(f.approvalId(2)))
        try f.submit(3)
        let next = ControlOwner(pid: 501, start: 3_000)
        let kept = try f.grant(4, owner: next)
        f.dead.insert(f.main)
        f.state.prune()
        try check(f.state.grants.keys.sorted() == [kept.id], "only the live owner's grant remains")
        try check(f.state.approvals[f.approvalId(2)]?.state == .cancelled && f.state.approvals[f.approvalId(3)]?.state == .cancelled,
                  "its approved and waiting requests are cancelled")
        // A new main process with the same PID (a restart or a reused PID) is another owner.
        let samePid = ControlOwner(pid: f.main.pid, start: f.main.start + 5)
        try expectCode("grant-unknown") { _ = try f.state.access(old.id, caller: f.caller, owner: samePid) }
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(2), caller: f.caller, target: f.target, owner: samePid) }
    }

    func testDisconnectOwnerOnlyEndsThatMainProcessGeneration() throws {
        let f = Fixture()
        let a = try f.grant(1)
        let other = ControlCaller(sessionId: "workroom_session_b", lane: "member-2", generation: String(repeating: "aa", count: 16))
        let b = try f.grant(2, caller: other)
        try f.submit(3)
        try f.state.approve(f.approvalId(3), signed: f.signed(f.approvalId(3)))
        try f.submit(4)
        let otherMain = ControlOwner(pid: 501, start: 3_000)
        let kept = try f.grant(5, owner: otherMain)
        try f.submit(6, owner: otherMain)
        // A change in flight when the channel ends still releases its process afterwards.
        try f.observe(a)
        let inFlight = try f.state.beginMutation(a.id, requestId: "request_0001", snapshotId: "ps1_exact")
        let ended = f.state.disconnectOwner(f.main)
        try check(ended.revoked == [a.id, b.id].sorted() && ended.cancelled == 2, "every session and lane of this owner ends")
        f.state.finishMutation(inFlight, .confirmed)
        try check(!f.state.isBusy(a.process), "the process is released")
        try check(f.state.grants.keys.sorted() == [kept.id], "another main process generation keeps its grant")
        try check(f.state.approvals[f.approvalId(6)]?.state == .pending, "and its waiting request")
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(3), caller: f.caller, target: f.target, owner: f.main) }
        try expectCode("approval-unknown") { try f.state.approve(f.approvalId(4), signed: f.signed(f.approvalId(4))) }
        // Revocation only: running it again ends nothing more and creates nothing.
        let again = f.state.disconnectOwner(f.main)
        try check(again.revoked.isEmpty && again.cancelled == 0 && f.state.grants.count == 1, "nothing more to end")
        // The same main process may ask again afterwards; a new request needs a new human approval.
        try f.submit(7)
        try check(f.state.approvals[f.approvalId(7)]?.state == .pending, "a new request waits for the person")
    }

    func testThePersonsMainAppUIListsAndWithdrawsOnlyItsOwnRequests() throws {
        let f = Fixture()
        try f.submit(1)
        try f.submit(2)
        try f.state.approve(f.approvalId(2), signed: f.signed(f.approvalId(2)))
        let otherMain = ControlOwner(pid: 501, start: 3_000)
        try f.submit(3, owner: otherMain)
        try check(f.state.approvals(of: f.main).map(\.approvalId) == [f.approvalId(1), f.approvalId(2)], "only this main process's requests")
        try check(!f.state.cancel(f.approvalId(3), owner: f.main), "another owner's request is not withdrawn")
        try check(f.state.cancel(f.approvalId(2), owner: f.main), "an approved, unopened request is withdrawn")
        try check(f.state.approvals[f.approvalId(2)]?.signed == nil, "its signature is dropped")
        try expectCode("approval-unknown") { _ = try f.state.openGrant(f.approvalId(2), caller: f.caller, target: f.target, owner: f.main) }
        try check(f.state.cancel(f.approvalId(1), owner: f.main) && !f.state.cancel(f.approvalId(1), owner: f.main), "withdrawn once")
        try check(f.state.approvals[f.approvalId(3)]?.state == .pending, "the other owner's request still waits")
    }

    func testProcessGenerationIsTheKernelsStartTime() throws {
        let me = getpid()
        guard let start = ProcessGeneration.start(me) else { throw CheckFailure(description: "no start time for this process") }
        try check(ProcessGeneration.start(me) == start, "stable for one process")
        try check(ProcessGeneration.alive(ControlOwner(pid: me, start: start)), "this process is alive")
        try check(!ProcessGeneration.alive(ControlOwner(pid: me, start: start &+ 1)), "another start time is another process")
        try check(ProcessGeneration.start(0) == nil && ProcessGeneration.start(-1) == nil, "no generation for invalid PIDs")
        try check(ProcessGeneration.start(Int32.max) == nil, "no generation for a PID that does not exist")
    }

    func testOneObservationOneAttemptAndNoReplay() throws {
        let f = Fixture()
        let g = try f.grant(1)
        try expectCode("stale-observation", notDispatched: true) { _ = try f.state.beginMutation(g.id, requestId: "request_0001", snapshotId: "ps1_exact") }
        try f.observe(g)
        try expectCode("stale-observation", notDispatched: true) { _ = try f.state.beginMutation(g.id, requestId: "request_0001", snapshotId: "other") }
        try expectCode("stale-observation", notDispatched: true) { _ = try f.state.beginMutation(g.id, requestId: "request_0002", snapshotId: "ps1_exact") }
        try f.observe(g)
        f.time += 15_001
        try expectCode("stale-observation") { _ = try f.state.beginMutation(g.id, requestId: "request_0003", snapshotId: "ps1_exact") }
        try f.observe(g)
        let ticket = try f.state.beginMutation(g.id, requestId: "request_0004", snapshotId: "ps1_exact")
        try check(f.state.receipt(g.id, requestId: "request_0004")?.state == .unknown, "unknown until the answer")
        try check(f.state.finishMutation(ticket, .confirmed).state == .confirmed, "confirmed")
        try f.observe(g)
        try expectCode("duplicate-request", notDispatched: true) { _ = try f.state.beginMutation(g.id, requestId: "request_0004", snapshotId: "ps1_exact") }
        try f.observe(g)
        let refused = try f.state.beginMutation(g.id, requestId: "request_0005", snapshotId: "ps1_exact")
        f.state.finishMutation(refused, .refused("human-active"))
        try check(f.state.receipt(g.id, requestId: "request_0005") == Receipt(requestId: "request_0005", state: .refused, reason: "human-active"), "refusal recorded")
        try check(!(f.state.grants[g.id]?.halted ?? true), "a refusal does not stop the grant")
        try f.observe(g)
        let lost = try f.state.beginMutation(g.id, requestId: "request_0006", snapshotId: "ps1_exact")
        f.state.finishMutation(lost, .unknown)
        try check(f.state.grants[g.id]?.haltReason == "outcome-unknown", "an unknown result stops the grant")
        try expectCode("worker-halted") { _ = try f.state.access(g.id, caller: f.caller, owner: f.main) }
        try check(try f.state.access(g.id, caller: f.caller, owner: f.main, allowHalted: true).id == g.id, "receipts stay readable")
        try expectCode("worker-halted") { _ = try f.state.beginObservation(g.id) }
    }

    func testChangesAreOrderedPerProcessAndOtherProcessesStayIndependent() throws {
        let f = Fixture()
        let sameProcessOtherWindow = ApprovalTarget(bundleId: f.target.bundleId, teamId: f.target.teamId, codeHash: f.target.codeHash,
                                                    pid: 100, processStart: f.target.processStart, windowId: 322)
        let otherProcess = ApprovalTarget(bundleId: f.target.bundleId, teamId: f.target.teamId, codeHash: f.target.codeHash,
                                          pid: 200, processStart: "201", windowId: 400)
        let a = try f.grant(1), b = try f.grant(2, target: sameProcessOtherWindow), c = try f.grant(3, target: otherProcess)
        try f.observe(a); try f.observe(b); try f.observe(c)
        let first = try f.state.beginMutation(a.id, requestId: "request_a001", snapshotId: "ps1_exact")
        // Another window of the same process: its observation is stale after this change, and the process is busy.
        try expectCode("stale-observation", notDispatched: true) { _ = try f.state.beginMutation(b.id, requestId: "request_b001", snapshotId: "ps1_exact") }
        try expectCode("process-busy", notDispatched: true) { _ = try f.state.beginObservation(b.id) }
        // Another process runs in parallel.
        let parallel = try f.state.beginMutation(c.id, requestId: "request_c001", snapshotId: "ps1_exact")
        f.state.finishMutation(parallel, .confirmed)
        f.state.finishMutation(first, .confirmed)
        // An observation that started before a change of its process is discarded, not kept.
        let revision = try f.state.beginObservation(b.id)
        try f.observe(a)
        let change = try f.state.beginMutation(a.id, requestId: "request_a002", snapshotId: "ps1_exact")
        f.state.finishMutation(change, .dispatchedUnverified)
        try expectCode("observation-discarded") { try f.state.finishObservation(b.id, snapshotId: "ps2", revision: revision) }
        try f.observe(b)
        let later = try f.state.beginMutation(b.id, requestId: "request_b002", snapshotId: "ps1_exact")
        try check(f.state.finishMutation(later, .humanTakeover).state == .humanTakeover, "takeover recorded")
        try check(f.state.grants[b.id]?.haltReason == "human-takeover", "a takeover stops that grant")
        try check(!(f.state.grants[a.id]?.halted ?? true), "and only that grant")
        // A grant that ends while its change runs still releases the process.
        try f.observe(a)
        let ending = try f.state.beginMutation(a.id, requestId: "request_a003", snapshotId: "ps1_exact")
        f.state.revokeSession(f.caller.sessionId, owner: f.main)
        f.state.finishMutation(ending, .confirmed)
        try check(!f.state.isBusy(a.process), "the process is released")
    }

    func testReceiptsAreBoundedPerGrant() throws {
        let f = Fixture()
        let g = try f.grant(1)
        for n in 0..<ControlLimits.receiptsPerGrant {
            try f.observe(g)
            f.state.finishMutation(try f.state.beginMutation(g.id, requestId: String(format: "request_%04d", n), snapshotId: "ps1_exact"), .confirmed)
        }
        try f.observe(g)
        try expectCode("receipt-limit", notDispatched: true) { _ = try f.state.beginMutation(g.id, requestId: "request_9999", snapshotId: "ps1_exact") }
    }

    func testThePersonsStopEndsEveryGrant() throws {
        let f = Fixture()
        let a = try f.grant(1), b = try f.grant(2)
        try check(f.state.stopAll() == 2, "both stopped")
        try expectCode("worker-halted") { _ = try f.state.access(a.id, caller: f.caller, owner: f.main) }
        try expectCode("worker-halted", notDispatched: true) { _ = try f.state.beginMutation(b.id, requestId: "request_0001", snapshotId: "ps1_exact") }
    }

    static var all: [(String, (ControlChecks) -> () throws -> Void)] { [
        ("scope v2 decoding is strict and channel-scoped", { _ in ScopeProtocolChecks.testStrictV2Shapes }),
        ("scope excludes security surfaces while allowing agent apps", { _ in ScopeProtocolChecks.testProtectedTargets }),
        ("the standing allowance label is exact and desktop only", { _ in ScopeProtocolChecks.testStandingAllowanceLabel }),
        ("protected targets equal the golden list shared with TypeScript", { checks in
            { try ScopeProtocolChecks.testProtectedTargetsMatchGolden(fixturePath: checks.fixturePath) } }),
        ("scope state fences legacy and records unknown before dispatch", { _ in ScopeStateChecks.testFencesAndReceipts }),
        ("completed scope transmission needs a new observation and cannot replay", { _ in ScopeStateChecks.testCompletedUnverifiedRequiresFreshObservation }),
        ("takeover diagnostics exclude private values without unhalting", { _ in ScopeStateChecks.testTakeoverDiagnosticsExcludePrivateValues }),
        ("guard readings are bounded and never change a receipt's state, reason or halt", { _ in ScopeStateChecks.testGuardSamplesAreBoundedAndOnlyExplainTheReceipt }),
        ("a refusal names its guard check beside the reason without halting or replaying", { _ in ScopeStateChecks.testRefusalNamesItsGuardCheck }),
        ("a scope grant lasts until ended: no 10 minutes or 64 actions, every spent ID stays refused", { _ in ScopeStateChecks.testGrantLastsUntilEndedAndKeepsEverySpentId }),
        ("a scope approval's actions are bounded in memory and then need a new approval", { _ in ScopeStateChecks.testActionsPerApprovalAreBounded }),
        ("the person holds a scope grant from the control bar without ending it", { _ in ScopeStateChecks.testThePersonHoldsTheGrantFromTheBarWithoutEndingIt }),
        ("the control bar hands back only a person's click", { $0.testControlBarHandsBackOnlyAPersonsClick }),
        ("scope safety refuses unverified state, overlays and changed targets", { _ in ScopedSafetyChecks.testUnknownEvidenceFailsClosed }),
        ("review presentation requires every OS signal", { $0.testReviewPresentationRequiresEveryOSSignal }),
        ("review opens on the display the person clicked and is confirmed only there", { $0.testReviewOpensOnTheDisplayThePersonClicked }),
        ("review polling stops on an unrelated foreground or replaced owner", { $0.testReviewPollingStopsWhenTheUserChangesApps }),
        ("review presentation reply carries foreground evidence", { $0.testReviewPresentationConfirmsItsWireEvidence }),
        ("screen access belongs to a grant and capture holds process order", { $0.testScreenPermissionAndCaptureOrdering }),
        ("capture and click requests reject caller consent and invalid coordinates", { $0.testCaptureAndClickRequestValidation }),
        ("a stop, expiry or replaced observation during capture hands no image over", { $0.testCaptureEndsOnStopExpiryOrReplacedObservation }),
        ("status and open-grant advertise capture/click with the sample reply fields", { $0.testStatusAndOpenGrantAdvertiseTheEngineOperations }),
        ("the approval prompt and grant rows name screen-image access", { $0.testConsentTextNamesScreenImages }),
        ("a refused scope approval names its cause", { $0.testScopeApprovalRefusalNamesItsCause }),
        ("the XPC contract samples decode, every invalid one is refused", { $0.testContractSamples }),
        ("replies are bounded and keep their fixed fields", { $0.testRepliesAreBoundedAndFixedShape }),
        ("AgentsToZ, agents, shells and security apps are never targets", { $0.testRefusedTargets }),
        ("text with missing or secure subrole is never exposed", { $0.testUnknownTextSubroleIsNotExposed }),
        ("SDK truncation and filtered observations are reported as incomplete", { $0.testObservationCompleteness }),
        ("requests: at most 8 waiting, 10 min, decided ones readable briefly by their caller", { $0.testApprovalRequestsAreBoundedAndExpire }),
        ("an approval answers exactly its request and opens one grant once", { $0.testApprovalAnswersExactlyItsRequestAndOpensOnce }),
        ("an approval not opened within 10 min expires", { $0.testAnApprovalUnopenedForTenMinutesExpires }),
        ("a request may wait 10 minutes for the person, and its countdown reads in minutes", { _ in ApprovalWindowChecks.testRequestsWaitTenMinutes }),
        ("expired authentication cancels once, unblocks a fresh request and refuses late success", { _ in ApprovalAuthenticationChecks.testExpiredAuthenticationReleasesItsWaitAndRejectsLateSuccess }),
        ("withdrawing authentication invalidates before a reentrant native completion", { _ in ApprovalAuthenticationChecks.testRevokedAuthenticationCancelsBeforeReentrantCompletion }),
        ("a late native authentication success is refused before the next expiry tick", { _ in ApprovalAuthenticationChecks.testLateSuccessBeforeTheNextTimerTickIsRefused }),
        ("open-grant needs the same main process generation, caller credential and target", { $0.testOpenGrantChecksOwnerCallerAndTarget }),
        ("at most 8 grants; expired ones are removed", { $0.testGrantsAreLimitedAndExpire }),
        ("revocation after expiry or restart is idempotent and never removes another caller grant", { $0.testRevocationIsIdempotentAndScoped }),
        ("ending a session ends its requests and grants; late signatures create nothing", { $0.testEndingTheSessionEndsItsRequestsAndGrants }),
        ("a main app quit, restart or reused PID revives nothing", { $0.testTheMainAppEndingEndsEverythingItOwned }),
        ("disconnect-owner ends only the requesting main process generation, revocation only", { $0.testDisconnectOwnerOnlyEndsThatMainProcessGeneration }),
        ("the main app UI lists and withdraws only its own requests", { $0.testThePersonsMainAppUIListsAndWithdrawsOnlyItsOwnRequests }),
        ("the main app's generation is the kernel's process start time", { $0.testProcessGenerationIsTheKernelsStartTime }),
        ("one observation, one attempt; no replay; unknown stops the grant", { $0.testOneObservationOneAttemptAndNoReplay }),
        ("changes are ordered per process; other processes stay parallel", { $0.testChangesAreOrderedPerProcessAndOtherProcessesStayIndependent }),
        ("receipts are bounded per grant", { $0.testReceiptsAreBoundedPerGrant }),
        ("the person's stop ends every grant", { $0.testThePersonsStopEndsEveryGrant }),
    ] }
}

#if CORE_CHECKS
@main struct ControlChecksMain {
    static func main() {
        guard CommandLine.arguments.count == 2 else { print("usage: checks <requests.json>"); exit(2) }
        var failed = 0
        for (name, run) in ControlChecks.all {
            do { try run(ControlChecks(fixturePath: CommandLine.arguments[1]))(); print("pass  \(name)") }
            catch { failed += 1; print("FAIL  \(name): \(error)") }
        }
        print("\(ControlChecks.all.count - failed)/\(ControlChecks.all.count) computer-use control checks passed")
        exit(failed == 0 ? 0 : 1)
    }
}
#else
import XCTest
final class ComputerUseControlCoreTests: XCTestCase {
    func testControlCore() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "ControlContract/requests.json").path
        for (name, run) in ControlChecks.all {
            do { try run(ControlChecks(fixturePath: fixture))() } catch { XCTFail("\(name): \(error)") }
        }
    }
}
#endif
