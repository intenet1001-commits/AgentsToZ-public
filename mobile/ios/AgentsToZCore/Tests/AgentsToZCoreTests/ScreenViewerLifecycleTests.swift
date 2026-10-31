import Foundation
#if !CORE_CHECKS
@testable import AgentsToZCore
#endif

/// The viewer's Face ID / scene-phase decision and its connection gate (`ScreenViewerLifecycle.swift`).
///
/// Two different builds are kept apart here, because only one of them explains what the user saw:
/// - The build installed on the user's devices (TestFlight 1327, git `1361fcdc`) dismissed the viewer whenever the
///   scene was not active, with no exception for Face ID's own sheet. `testInstalledBuildDismissedOnAnyInactiveScene`
///   replays that logic: it dismisses as soon as the Face ID sheet appears. The user's report — Face ID appeared and
///   the viewer returned to the list, on an iPhone and on an iPad — is explained by that code, and this file claims
///   no measurement of its own on any device model.
/// - The current source already tolerated `inactive` while Face ID was on screen, so the reported symptom is not
///   claimed to reproduce on this HEAD. What it still had was a fixed one-second check against a remembered phase
///   (`testSourceBeforeThisChangeStillRacedItsFixedWait`), which is the race this state machine replaces.
///
/// Everything below is a real state transition, not a string assertion.
struct ScreenViewerLifecycleChecks {
    func runAll() throws {
        try testInstalledBuildDismissedOnAnyInactiveScene()
        try testSourceBeforeThisChangeStillRacedItsFixedWait()
        try testReplyBeforeSceneReturnsKeepsTheSession()
        try testSceneReturnsBeforeReplyKeepsTheSession()
        try testBackgroundDuringAuthenticationEndsAtOnce()
        try testBackgroundAfterAuthenticationEndsAtOnce()
        try testAppearingInTheBackgroundStartsNothing()
        try testAppearingInactiveWaitsForTheSceneBeforeStarting()
        try testAppearingInactiveThatNeverReturnsEndsWithinTheGrace()
        try testTheHostsWaitTakesExactlyOneStart()
        try testASceneThatSlipsAwayBeforeTheFirstClaimDoesNotStart()
        try testLateKeyframeRenderIsRefusedAfterTheSessionEnded()
        try testCancelledConnectionApprovalKeepsTheNoticeAndStartsNothing()
        try testLockoutRecoveryDoesNotReviveAFailedConnection()
        try testCancelledTurnOffDoesNotStrandALiveSession()
        try testANewFaceIDDropsTheEarlierWait()
        try testSceneThatStaysInactiveEndsWithinTheGrace()
        try testInactiveWhileRunningIsBoundedNotImmediate()
        try testDisappearEndsOnceAndIsNeverRevived()
        try testLateRepliesAndStaleDeadlinesDecideNothing()
        try testLateConnectionIsClosedInsteadOfInstalled()
        try testGateKeepsOnlyTheNewestAttempt()
    }

    // MARK: the two builds, replayed

    /// TestFlight 1327 / git `1361fcdc`: `if scenePhase != .active { end(); dismiss() }` with no Face ID exception.
    func testInstalledBuildDismissedOnAnyInactiveScene() throws {
        var installed = InstalledBuildDecision()
        installed.authenticating = true
        // Face ID's own sheet makes the scene inactive — and that build dismissed right there.
        installed.scene(.inactive)
        try checkTrue(installed.dismissed)
    }

    /// The source before this change tolerated that sheet, but then read a remembered phase one second after the
    /// Face ID reply, so a reply that arrived before the scene was handed back still ended the session.
    func testSourceBeforeThisChangeStillRacedItsFixedWait() throws {
        var previous = PreviousSourceDecision()
        previous.authenticating = true
        previous.scene(.inactive)
        try checkTrue(!previous.dismissed)
        previous.authenticating = false
        previous.fixedWaitElapsed()
        try checkTrue(previous.dismissed)
        // The same decision also dismissed whenever the active phase simply arrived after that fixed wait.
        var slow = PreviousSourceDecision()
        slow.authenticating = true
        slow.scene(.inactive)
        slow.authenticating = false
        slow.fixedWaitElapsed()
        try checkTrue(slow.dismissed)
    }

    // MARK: the two orders of reply and active

    func testReplyBeforeSceneReturnsKeepsTheSession() throws {
        var life = appeared()
        try checkEqual(life.authenticationStarted(for: .connection), .none)
        try checkEqual(life.sceneChanged(to: .inactive), .none)
        guard case .armGrace(let token) = life.authenticationFinished(.approved) else { throw CheckFailure.failed("no grace") }
        try checkTrue(!life.hasEnded)
        try checkTrue(life.allowsSessionWork)
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkTrue(!life.isWaitingForScene)
        // The deadline already in flight must not end the session it no longer owns.
        try checkEqual(life.graceExpired(token: token), .none)
        try checkTrue(!life.hasEnded)
    }

    func testSceneReturnsBeforeReplyKeepsTheSession() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.sceneChanged(to: .inactive)
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkEqual(life.authenticationFinished(.approved), .none)
        try checkTrue(!life.hasEnded)
        try checkTrue(life.allowsSessionWork)
    }

    // MARK: what must still end at once

    func testBackgroundDuringAuthenticationEndsAtOnce() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.sceneChanged(to: .inactive)
        // The foreground gate is not relaxed by authentication.
        try checkEqual(life.sceneChanged(to: .background), .endNow(.leftForeground))
        try checkTrue(life.hasEnded)
        try checkTrue(!life.allowsSessionWork)
        // A Face ID reply that lands after that cannot revive or restart anything.
        try checkEqual(life.authenticationFinished(.approved), .none)
        try checkTrue(!life.allowsSessionStart)
        try checkTrue(!life.claimSessionStart(phase: .active).starts)
    }

    func testBackgroundAfterAuthenticationEndsAtOnce() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.authenticationFinished(.approved)
        life.sessionConnected()
        try checkEqual(life.sceneChanged(to: .background), .endNow(.leftForeground))
        // Raising the prompt in an already backgrounded scene is an end, not a prompt.
        var later = ScreenViewerLifecycle()
        _ = later.appeared(phase: .inactive)
        _ = later.sceneChanged(to: .background)
        try checkEqual(later.authenticationStarted(for: .connection), .none)
        try checkTrue(later.hasEnded)
    }

    func testAppearingInTheBackgroundStartsNothing() throws {
        var life = ScreenViewerLifecycle()
        // Before appearing, nothing may start.
        try checkTrue(!life.allowsSessionStart)
        try checkTrue(!life.claimSessionStart(phase: .background).starts)
        life = ScreenViewerLifecycle()
        try checkEqual(life.appeared(phase: .background), .endNow(.leftForeground))
        try checkTrue(!life.allowsSessionStart)
        // Even the first Face ID is refused, so no connection is attempted from a background scene.
        try checkEqual(life.authenticationStarted(for: .connection), .none)
    }

    /// A view that appears while the scene is only inactive — a sheet still dismissing — must not raise Face ID or
    /// connect behind it, and must start as soon as the scene is actually on screen.
    func testAppearingInactiveWaitsForTheSceneBeforeStarting() throws {
        var life = ScreenViewerLifecycle()
        let refused = life.claimSessionStart(phase: .inactive)
        try checkTrue(!refused.starts)
        try checkTrue(!life.isAdmitted && !life.hasStarted)
        // Nothing connects behind that scene, and the wait is already armed.
        guard case .armGrace = refused.effect else { throw CheckFailure.failed("no admission grace") }
        try checkTrue(life.isWaitingForScene)
        // Asking again while still inactive keeps refusing, without arming a second wait.
        try checkTrue(!life.claimSessionStart(phase: .inactive).starts)
        // The scene is on screen: the start becomes available and is taken once.
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkTrue(life.allowsSessionStart)
        let admittedStart = life.claimSessionStart(phase: .active)
        try checkTrue(admittedStart.starts)
        try checkTrue(life.hasStarted && !life.allowsSessionStart)
    }

    func testAppearingInactiveThatNeverReturnsEndsWithinTheGrace() throws {
        var life = ScreenViewerLifecycle()
        guard case .armGrace(let token) = life.claimSessionStart(phase: .inactive).effect else {
            throw CheckFailure.failed("no admission grace")
        }
        // The scene never came back: this ends rather than waiting forever with nothing on screen.
        try checkEqual(life.graceExpired(token: token), .endNow(.stayedInactive))
        try checkTrue(life.hasEnded)
        try checkTrue(!life.claimSessionStart(phase: .active).starts)
    }

    /// The host's wait, replayed: it asks on every pass and must start exactly once — never twice when the scene
    /// flickers, and never zero times just because the first pass was too early.
    func testTheHostsWaitTakesExactlyOneStart() throws {
        for phases in [[ScreenViewerLifecycle.Phase.inactive, .inactive, .active, .active, .inactive, .active],
                       [.active, .active, .inactive, .active]] {
            var life = ScreenViewerLifecycle()
            var starts = 0
            for phase in phases {
                if phase != .active, life.hasAppeared { _ = life.sceneChanged(to: phase) }
                let start = life.claimSessionStart(phase: phase)
                if start.starts { starts += 1 }
                if phase == .active, life.hasAppeared { _ = life.sceneChanged(to: .active) }
            }
            try checkEqual(starts, 1)
            try checkTrue(life.hasStarted && !life.hasEnded)
        }
    }

    /// The admission latch is not a licence: active, then inactive again before the host's first pass, must refuse,
    /// and the next active must start — exactly once.
    func testASceneThatSlipsAwayBeforeTheFirstClaimDoesNotStart() throws {
        var life = ScreenViewerLifecycle()
        try checkTrue(!life.claimSessionStart(phase: .inactive).starts)
        // The active event arrives, so a start is pending…
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkTrue(life.isAdmitted && life.allowsSessionStart)
        // …but the scene is inactive again by the time the host actually asks.
        let refused = life.claimSessionStart(phase: .inactive)
        try checkTrue(!refused.starts)
        try checkTrue(!life.hasStarted)
        try checkTrue(!life.allowsSessionStart)
        // It comes back: one start, and only one.
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkTrue(life.claimSessionStart(phase: .active).starts)
        try checkTrue(!life.claimSessionStart(phase: .active).starts)
        try checkTrue(!life.hasEnded)
    }

    /// A keyframe the Mac prepares while the view is going away: the attempt no longer owns the model, so the
    /// picture must not be rendered and the status must not be cleared.
    func testLateKeyframeRenderIsRefusedAfterTheSessionEnded() throws {
        var gate = ScreenViewerSessionGate()
        let attempt = gate.start()
        try checkTrue(gate.owns(attempt))
        // `end()` runs while `requestKeyframe()` is awaited.
        gate.invalidate()
        try checkTrue(!gate.owns(attempt))
        try checkTrue(!gate.accepts(attempt))
    }

    // MARK: cancelled Face ID, by purpose

    func testCancelledConnectionApprovalKeepsTheNoticeAndStartsNothing() throws {
        for outcome in [ScreenViewerLifecycle.AuthOutcome.cancelled, .failed] {
            var life = appeared()
            _ = life.authenticationStarted(for: .connection)
            _ = life.sceneChanged(to: .inactive)
            guard case .armGrace(let token) = life.authenticationFinished(outcome) else { throw CheckFailure.failed("no grace") }
            // No session exists and the person is reading why: the view is not torn down for the inactive scene.
            try checkEqual(life.graceExpired(token: token), .none)
            try checkTrue(!life.hasEnded)
            // Leaving still ends it.
            try checkEqual(life.sceneChanged(to: .background), .endNow(.leftForeground))
        }
    }

    func testLockoutRecoveryDoesNotReviveAFailedConnection() throws {
        var life = appeared()
        var gate = ScreenViewerSessionGate()
        try checkTrue(life.claimSessionStart(phase: .active).starts)
        let failedAttempt = gate.start()
        _ = life.authenticationStarted(for: .connection)
        _ = life.authenticationFinished(.failed)
        gate.invalidate()

        // Recovery has its own OS prompt. Even a successful passcode recovery remains a failed Mac approval;
        // no signer/context escapes recovery, no new gate attempt is started and the original start stays spent.
        _ = life.authenticationStarted(for: .connection)
        try checkEqual(life.sceneChanged(to: .inactive), .none)
        guard case .armGrace(let token) = life.authenticationFinished(.failed) else { throw CheckFailure.failed("no recovery grace") }
        try checkEqual(life.graceExpired(token: token), .none)
        _ = life.sceneChanged(to: .active)
        try checkTrue(!life.claimSessionStart(phase: .active).starts)
        try checkTrue(!gate.owns(failedAttempt) && !gate.accepts(failedAttempt))
        try checkTrue(gate.runningAttempt == nil)

        // Only closing the failed view and explicitly selecting the Mac creates a new biometric connection.
        _ = life.viewDisappeared()
        var next = appeared()
        try checkTrue(next.claimSessionStart(phase: .active).starts)
        let freshAttempt = gate.start()
        try checkTrue(freshAttempt != failedAttempt && gate.owns(freshAttempt))
    }

    /// A cancelled 「화면 제어 끄기」 happens on a *running* session, so the bounded wait must still end it.
    func testCancelledTurnOffDoesNotStrandALiveSession() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.authenticationFinished(.approved)
        life.sessionConnected()
        _ = life.authenticationStarted(for: .sessionControl)
        _ = life.sceneChanged(to: .inactive)
        guard case .armGrace(let token) = life.authenticationFinished(.cancelled) else { throw CheckFailure.failed("no grace") }
        // The Mac's screen must not keep running behind an app switcher because the person cancelled 끄기.
        try checkEqual(life.graceExpired(token: token), .endNow(.stayedInactive))
        try checkTrue(life.hasEnded)
    }

    /// A wait armed before a new Face ID must not end the session while that prompt is on screen.
    func testANewFaceIDDropsTheEarlierWait() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.authenticationFinished(.approved)
        life.sessionConnected()
        guard case .armGrace(let stale) = life.sceneChanged(to: .inactive) else { throw CheckFailure.failed("no grace") }
        // 「화면 제어 끄기」 raises a new prompt while that wait is still in flight.
        try checkEqual(life.authenticationStarted(for: .sessionControl), .none)
        try checkTrue(!life.isWaitingForScene)
        try checkEqual(life.graceExpired(token: stale), .none)
        try checkTrue(!life.hasEnded)
    }

    // MARK: the bounded wait

    func testSceneThatStaysInactiveEndsWithinTheGrace() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.sceneChanged(to: .inactive)
        guard case .armGrace(let token) = life.authenticationFinished(.approved) else { throw CheckFailure.failed("no grace") }
        try checkEqual(life.graceExpired(token: token), .endNow(.stayedInactive))
        try checkTrue(life.hasEnded)
        try checkTrue(ScreenViewerLifecycle.graceSeconds > 0 && ScreenViewerLifecycle.graceSeconds <= 5)
    }

    func testInactiveWhileRunningIsBoundedNotImmediate() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.authenticationFinished(.approved)
        life.sessionConnected()
        _ = life.sceneChanged(to: .active)
        // A banner or a system overlay mid-session: tolerated, bounded, never an instant end.
        guard case .armGrace(let token) = life.sceneChanged(to: .inactive) else { throw CheckFailure.failed("no grace") }
        try checkTrue(!life.hasEnded)
        try checkEqual(life.sceneChanged(to: .active), .none)
        try checkEqual(life.graceExpired(token: token), .none)
        // Still inactive at the deadline ends it.
        var lingering = appeared()
        _ = lingering.authenticationStarted(for: .connection)
        _ = lingering.authenticationFinished(.approved)
        lingering.sessionConnected()
        guard case .armGrace(let second) = lingering.sceneChanged(to: .inactive) else { throw CheckFailure.failed("no grace") }
        try checkEqual(lingering.graceExpired(token: second), .endNow(.stayedInactive))
    }

    // MARK: disappear and late work

    func testDisappearEndsOnceAndIsNeverRevived() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        try checkEqual(life.viewDisappeared(), .endNow(.viewDismissed))
        try checkTrue(!life.allowsSessionStart)
        // Dismissing twice must not end twice, and a cancelled task's late reply must not connect.
        try checkEqual(life.viewDisappeared(), .none)
        try checkEqual(life.authenticationFinished(.approved), .none)
        try checkEqual(life.authenticationStarted(for: .connection), .none)
        try checkEqual(life.sceneChanged(to: .active), .none)
        // A view whose task restarts cannot bring the ended session back.
        try checkEqual(life.appeared(phase: .active), .none)
        try checkTrue(!life.allowsSessionStart)
        life.sessionConnected()
        try checkTrue(!life.allowsSessionStart)
    }

    func testLateRepliesAndStaleDeadlinesDecideNothing() throws {
        var life = appeared()
        _ = life.authenticationStarted(for: .connection)
        _ = life.sceneChanged(to: .inactive)
        guard case .armGrace(let first) = life.authenticationFinished(.approved) else { throw CheckFailure.failed("no grace") }
        life.sessionConnected()
        _ = life.sceneChanged(to: .active)
        guard case .armGrace(let second) = life.sceneChanged(to: .inactive) else { throw CheckFailure.failed("no grace") }
        try checkTrue(first != second)
        // The first wait's deadline arrives after the second was armed: it owns nothing now.
        try checkEqual(life.graceExpired(token: first), .none)
        try checkTrue(!life.hasEnded)
        try checkEqual(life.graceExpired(token: second), .endNow(.stayedInactive))
        // And after the end, its own deadline cannot end a session again.
        try checkEqual(life.graceExpired(token: second), .none)
    }

    // MARK: the connection gate (the model's real late-completion guard)

    /// Face ID or the key exchange finishing after the view has gone: the attempt owns nothing, so the model must
    /// close the session it received instead of installing it.
    func testLateConnectionIsClosedInsteadOfInstalled() throws {
        var gate = ScreenViewerSessionGate()
        let attempt = gate.start()
        try checkTrue(gate.owns(attempt))
        // The view disappeared while Face ID was still on screen; `end()` abandons the attempt even with no viewer.
        gate.invalidate()
        try checkTrue(!gate.owns(attempt))
        // The approval comes back…
        try checkTrue(!gate.owns(attempt))
        // …and so does the connection: it must not be installed.
        try checkTrue(!gate.accepts(attempt))
        try checkTrue(gate.runningAttempt == nil)
    }

    func testGateKeepsOnlyTheNewestAttempt() throws {
        var gate = ScreenViewerSessionGate()
        let first = gate.start()
        let second = gate.start()
        try checkTrue(first != second)
        // Re-tapping the Mac abandons the first attempt; its late connection is refused, the new one is accepted.
        try checkTrue(!gate.owns(first))
        try checkTrue(!gate.accepts(first))
        try checkTrue(gate.owns(second))
        try checkTrue(gate.accepts(second))
        gate.invalidate()
        try checkTrue(!gate.owns(second))
        // Nothing starts by itself after an end: only an explicit new attempt owns the work again.
        let third = gate.start()
        try checkTrue(gate.owns(third) && !gate.owns(second))
    }

    // MARK: helpers

    private func appeared(phase: ScreenViewerLifecycle.Phase = .active) -> ScreenViewerLifecycle {
        var life = ScreenViewerLifecycle()
        _ = life.appeared(phase: phase)
        return life
    }
}

/// The installed build's decision (TestFlight 1327 / git `1361fcdc`): any phase that is not active dismissed the
/// viewer, with no exception for Face ID's own sheet.
private struct InstalledBuildDecision {
    var authenticating = false
    var dismissed = false
    mutating func scene(_ phase: ScreenViewerLifecycle.Phase) {
        if phase != .active { dismissed = true }
    }
}

/// The source immediately before this change: Face ID's sheet was tolerated, but a fixed one-second check then read a
/// remembered phase, so a reply that arrived before the scene returned ended the session.
private struct PreviousSourceDecision {
    var rememberedPhase = ScreenViewerLifecycle.Phase.active
    var authenticating = false
    var left = false
    var dismissed = false
    mutating func scene(_ phase: ScreenViewerLifecycle.Phase) {
        rememberedPhase = phase
        leaveUnlessActive(phase)
    }
    mutating func fixedWaitElapsed() { leaveUnlessActive(rememberedPhase) }
    private mutating func leaveUnlessActive(_ phase: ScreenViewerLifecycle.Phase) {
        guard !left, phase != .active, !(phase == .inactive && authenticating) else { return }
        left = true
        dismissed = true
    }
}
