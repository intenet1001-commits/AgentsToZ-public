import Foundation

/// When the Mac screen viewer may keep its session and when it must end it (DESIGN 「screen-control」, SR-12), and
/// which connection attempt still owns the work after an `await`.
///
/// History this encodes, kept separate on purpose:
/// - The build the user has installed (TestFlight 1327, git `1361fcdc`) dismissed the viewer whenever the scene was
///   not active, with **no** exception for Face ID's own sheet. That old code explains the reported symptom on its
///   own: Face ID appeared and the viewer returned to the list (user report: iPhone and iPad).
/// - The current source already tolerated `inactive` while Face ID was on screen, so the symptom is not claimed to
///   reproduce on this HEAD.
/// - What this type adds is further hardening: the Face ID reply and the return to the active phase arrive in either
///   order, and a scene can come back later than any fixed wait, so the decision is a tested state machine with one
///   bounded wait instead of a remembered phase read after a timer.
///
/// No SwiftUI, no UIKit and no clock of its own, so every order can be checked:
/// - leaving the foreground for real (`background`) ends the session at once, Face ID on screen or not;
/// - `inactive` while Face ID is on screen is tolerated, and so is the short `inactive` right after its reply;
/// - that tolerance is bounded: a scene that stays inactive past the grace (the app switcher left open) ends the
///   session, **including** when the last Face ID was a cancelled 「화면 제어 끄기」 on a live session;
/// - a cancelled or failed *connection* approval, which leaves no session at all, keeps the view so the person can
///   read why, and starts nothing;
/// - once the view is gone, or the session has ended, every later event — a late Face ID reply, a late grace
///   deadline, a late phase change, a late connection — decides nothing and can never start another session.
///
/// The host feeds events and performs the returned effect; it never decides by itself.
public struct ScreenViewerLifecycle: Equatable, Sendable {
    /// The scene phases this decision needs, named here so the core does not depend on SwiftUI.
    public enum Phase: Equatable, Sendable { case active, inactive, background }

    /// What Face ID answered. A person who cancelled, or a failure, is not by itself a reason to end for leaving.
    public enum AuthOutcome: Equatable, Sendable { case approved, cancelled, failed }

    /// Why Face ID was asked for. The viewer asks twice for different things, and a cancellation means something
    /// different each time: no session yet, or a session that is still running.
    public enum AuthPurpose: Equatable, Sendable {
        /// The one approval that lets this phone connect at all.
        case connection
        /// An approval inside a live session, such as 「화면 제어 끄기」.
        case sessionControl
    }

    public enum EndReason: Equatable, Sendable {
        /// The phone left the foreground (SR-12), including during Face ID.
        case leftForeground
        /// The scene never came back after Face ID within the grace: the app switcher stayed open.
        case stayedInactive
        /// The view itself went away (dismissed, replaced, or its task cancelled).
        case viewDismissed
    }

    /// What the host must do. `armGrace` carries the token the host returns with `graceExpired`, so a deadline left
    /// over from an earlier wait — or from before a new Face ID — decides nothing.
    public enum Effect: Equatable, Sendable {
        case none
        case endNow(EndReason)
        case armGrace(token: UInt64)
    }

    /// How long the scene may stay inactive before the session ends. Long enough for the system sheet to hand the
    /// scene back on a loaded device, short enough that a phone put away does not keep the Mac's screen running.
    public static let graceSeconds: Double = 3

    private var phase: Phase
    /// The scene has been active at least once since this view appeared: only then may a session start. Appearing
    /// while the scene is merely inactive (a sheet still dismissing, a notification shade) must not raise Face ID or
    /// connect behind it, and must not wait forever either.
    private var admitted = false
    /// The host has taken its one start. A view whose scene flickers must not connect twice.
    private var started = false
    private var authenticating = false
    private var purpose: AuthPurpose?
    /// What the last finished Face ID answered, and what it was for.
    private var lastOutcome: AuthOutcome?
    private var lastPurpose: AuthPurpose?
    /// True once the Mac's session is actually running: a cancelled approval then cannot mean 「there is no session」.
    private var sessionLive = false
    private var graceToken: UInt64?
    private var nextToken: UInt64 = 1
    private var ended = false
    private var gone = false
    private var appearedAlready = false

    /// `phase` is the phase the host reports at `appeared`; a lifecycle that has not appeared yet decides nothing.
    public init(phase: Phase = .active) { self.phase = phase }

    /// Whether a start may be taken **right now**: the view has appeared, the scene has been active at least once
    /// *and* is active at this moment, nothing has started yet, and the session has neither ended nor gone away.
    /// The latch alone is not enough — a scene that slips away again between the active event and the host's next
    /// pass must not raise Face ID behind it.
    public var allowsSessionStart: Bool {
        appearedAlready && admitted && phase == .active && !started && !ended && !gone
    }

    /// Whether the host's session work may still touch the model. False once the view is gone or the session ended.
    public var allowsSessionWork: Bool { appearedAlready && !ended && !gone }

    /// The view has appeared and read its phase at least once.
    public var hasAppeared: Bool { appearedAlready }

    /// The scene has been active since this view appeared, so a session may be started.
    public var isAdmitted: Bool { admitted }

    /// A start has been taken; `claimSessionStart` will never hand out another one.
    public var hasStarted: Bool { started }

    /// True once this lifecycle has ended the session; the host shows its own message and stops.
    public var hasEnded: Bool { ended }

    /// A bounded wait for the scene is in flight.
    public var isWaitingForScene: Bool { graceToken != nil }

    /// What a host asked for when it wanted to start: whether it may, and what to do either way.
    public struct Start: Equatable, Sendable {
        /// True exactly once, and only while the scene is active at that moment — the latch is not enough.
        public let starts: Bool
        public let effect: Effect
    }

    /// The host's single entry point for starting the session, with the phase it actually reads at that moment.
    ///
    /// It appears (once), admits a start only while the scene is active, and hands out at most one start ever, so a
    /// refused attempt cannot connect behind a scene that is not on screen and a later one cannot connect twice.
    public mutating func claimSessionStart(phase: Phase) -> Start {
        let effect = appeared(phase: phase)
        guard allowsSessionStart else { return Start(starts: false, effect: effect) }
        started = true
        return Start(starts: true, effect: effect)
    }

    /// The view appeared with the phase it actually reads, never an assumed one. Appearing in the background is not a
    /// session: it ends at once. Appearing while inactive admits nothing and waits, bounded, for the active phase.
    /// A lifecycle that already ended or went away is **not** revived by appearing again.
    @discardableResult
    public mutating func appeared(phase: Phase) -> Effect {
        guard !ended, !gone else { return .none }
        let first = !appearedAlready
        appearedAlready = true
        self.phase = phase
        switch phase {
        case .background:
            return end(.leftForeground)
        case .active:
            admitted = true
            return first ? .none : clearGrace()
        case .inactive:
            // Not on screen: nothing starts behind it, and this wait is what ends a scene that never comes back.
            // One wait at a time — a host that asks again every pass must not keep pushing the deadline away.
            _ = first
            return isWaitingForScene || started ? .none : armGrace()
        }
    }

    /// The Mac's session is running. Until then a cancelled approval means there is nothing to keep alive.
    public mutating func sessionConnected() {
        guard !ended, !gone else { return }
        sessionLive = true
    }

    /// Face ID is being asked for, and for what. Its own sheet makes the scene inactive; that alone is not leaving.
    /// Any wait armed before this approval is dropped, so an older inactive deadline cannot end the session while a
    /// new Face ID is on screen.
    public mutating func authenticationStarted(for purpose: AuthPurpose = .connection) -> Effect {
        guard !ended, !gone, appearedAlready else { return .none }
        authenticating = true
        self.purpose = purpose
        graceToken = nil
        // Already in the background when the prompt is raised: leaving wins over the prompt.
        if phase == .background { return end(.leftForeground) }
        return .none
    }

    /// Face ID answered. The scene may still be inactive for a moment, in either order with this reply.
    public mutating func authenticationFinished(_ outcome: AuthOutcome) -> Effect {
        guard !ended, !gone, appearedAlready else { return .none }
        authenticating = false
        lastOutcome = outcome
        lastPurpose = purpose ?? .connection
        purpose = nil
        if phase == .background { return end(.leftForeground) }
        // The scene is back already: nothing to wait for.
        if phase == .active { return clearGrace() }
        // Inactive right after the reply: wait, bounded, for the scene to come back.
        return armGrace()
    }

    /// The scene changed. Only a real background ends the session at once; `inactive` is bounded, not fatal.
    public mutating func sceneChanged(to next: Phase) -> Effect {
        guard !ended, !gone else { return .none }
        phase = next
        switch next {
        case .background:
            return end(.leftForeground)
        case .active:
            // The scene is on screen: a start that was refused at appear time becomes available here, exactly once.
            admitted = true
            return clearGrace()
        case .inactive:
            // Face ID's own sheet, or a system overlay while the session runs: tolerate it for the same bounded wait.
            return authenticating ? .none : armGrace()
        }
    }

    /// The grace deadline the host armed with this token ran out. A token from an earlier wait, or from before a new
    /// Face ID, decides nothing.
    public mutating func graceExpired(token: UInt64) -> Effect {
        guard !ended, !gone, graceToken == token else { return .none }
        graceToken = nil
        guard phase != .active else { return .none }
        // Never on screen since this view appeared: there is no session to protect and nothing to read, so the
        // bounded wait ends it instead of leaving a viewer that connected to nothing.
        if !admitted { return end(.stayedInactive) }
        // A live session that is still not on screen ends here, whatever the last Face ID answered: a cancelled
        // 「화면 제어 끄기」 must not leave the Mac's screen running behind an app switcher forever.
        if sessionLive { return end(.stayedInactive) }
        // No session: a cancelled or failed connection approval leaves a notice the person is reading.
        if lastPurpose == .connection, lastOutcome == .cancelled || lastOutcome == .failed { return .none }
        return end(.stayedInactive)
    }

    /// The view went away: dismissed by the person, replaced, or its task cancelled. Nothing may start afterwards.
    public mutating func viewDisappeared() -> Effect {
        guard !gone else { return .none }
        gone = true
        graceToken = nil
        guard !ended else { return .none }
        ended = true
        return .endNow(.viewDismissed)
    }

    private mutating func armGrace() -> Effect {
        let token = nextToken
        nextToken += 1
        graceToken = token
        return .armGrace(token: token)
    }

    private mutating func clearGrace() -> Effect {
        graceToken = nil
        return .none
    }

    private mutating func end(_ reason: EndReason) -> Effect {
        ended = true
        graceToken = nil
        sessionLive = false
        return .endNow(reason)
    }
}

/// Which connection attempt still owns the viewer's work after an `await`.
///
/// Face ID and the key exchange are both awaited, and the view can go away while either is in flight. Ending a
/// session that has no viewer yet cannot stop that work, so every attempt carries a generation: the model checks it
/// after each `await`, and a viewer that arrives for a generation nobody owns is closed instead of installed.
/// Without this, a late `connect` could hand a live Mac session to a view that is already gone.
public struct ScreenViewerSessionGate: Equatable, Sendable {
    private var generation: UInt64 = 0
    private var current: UInt64?

    public init() {}

    /// Begins an attempt and returns the generation it owns. Starting again abandons the previous attempt.
    public mutating func start() -> UInt64 {
        generation += 1
        current = generation
        return generation
    }

    /// Ends whatever is running or being set up: no attempt owns the work until the next `start()`.
    public mutating func invalidate() {
        current = nil
    }

    /// Whether this attempt may still touch the model after an `await`.
    public func owns(_ attempt: UInt64) -> Bool { current == attempt }

    /// Whether a viewer that has just finished connecting may be installed. When false the caller must close it.
    public func accepts(_ attempt: UInt64) -> Bool { owns(attempt) }

    /// The attempt that currently owns the work, if any. For checks and diagnostics.
    public var runningAttempt: UInt64? { current }
}
