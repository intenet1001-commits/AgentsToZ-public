#if os(macOS)
import Foundation
import os
import ScreenControlCore

/// The session bar's hold on one session's remote input (DESIGN 「부록 A」). It sits between the local input monitor
/// and the session's InputReceiver, so the bar needs no new path into the stream: 「직접 하기」 reads to the receiver as
/// the person at this Mac holding its input (`.localActivity`), 「보기만」 as input protection gone for the rest of the
/// session (`.monitorUnavailable`). The receiver then refuses remote input before injecting anything, lets go of what
/// the other side held, and tells it with the messages it already knows (remoteInputPaused and inputAvailability), so
/// the phone protocol is unchanged. 「다시 넘기기」 lifts only the pause; nothing lifts 「보기만」 before the session ends.
/// A hold lives as long as its session; what outlasts the session is `ScreenMacHold`, which gives each new session its
/// hold.
public final class ScreenSessionInputHold: Sendable {
    public enum Mode: Equatable, Sendable {
        case remote, paused, viewOnly
    }

    private struct State {
        var mode = Mode.remote
        var input: InputReceiver?
    }
    private let state: OSAllocatedUnfairLock<State>

    /// `.paused` for a session that begins while a person at this Mac still holds its input (`ScreenMacHold.begin`).
    public init(mode: Mode = .remote) { state = OSAllocatedUnfairLock(initialState: State(mode: mode)) }

    public var mode: Mode { state.withLock { $0.mode } }

    /// 「직접 하기」. Never undoes 「보기만」.
    public func pause() { state.withLock { if $0.mode == .remote { $0.mode = .paused } } }

    /// 「보기만」, for the rest of this session.
    public func lowerToView() { state.withLock { $0.mode = .viewOnly } }

    /// 「다시 넘기기」: false unless it was paused. The caller has already checked the click (ScreenSessionBarClick).
    @discardableResult
    public func resume() -> Bool {
        state.withLock {
            guard $0.mode == .paused else { return false }
            $0.mode = .remote
            return true
        }
    }

    /// What the session's receiver reads as this Mac's own input. Called under the receiver's lock, on any thread.
    public func apply(_ physical: PhysicalInputSnapshot) -> PhysicalInputSnapshot {
        var shown = physical
        switch mode {
        case .remote: break
        case .paused: shown.held = true; shown.heldAtMac = true
        case .viewOnly: shown.available = false
        }
        return shown
    }

    /// The session's receiver, once its stream runs, so the bar can say why remote input waits.
    func attach(_ input: InputReceiver?) { state.withLock { $0.input = input } }

    /// Nil before the stream runs and for a session without input. Read outside this hold's lock: the receiver takes
    /// its own lock and calls `apply` under it.
    public var availability: ScreenInputAvailability? { state.withLock { $0.input }?.availability }
}

/// 「직접 하기」 and 「보기만」 outlast the session they were pressed in. The other side can reconnect without anyone at this
/// Mac (a registered phone needs only Face ID on itself), and another registered device can connect after it; had either
/// begun with input flowing, the person here would have handed input back without the hardware click 「다시 넘기기」
/// asks for (SR-29). So after either press every new session, from any device, starts `.paused` (the bar shows
/// 「원격 입력 멈춤」 with 「다시 넘기기」) until a person at this Mac hands input back with a hardware click.
/// 「보기만」 still lowers only its own session to view (부록 A); what carries over is the pause, which the next session's
/// own 「다시 넘기기」 lifts. Only this Mac clears it: an accepted 「다시 넘기기」, or turning screen control on again, which
/// takes Touch ID or the password here (`reset`). It is kept in memory only, so quitting the app clears it as well: the
/// app starts off, and turning on asks at this Mac. Nothing a remote device sends reaches it. ScreenService keeps one
/// for the Mac and takes every session's hold from `begin()`; a Mac controller session must take the same one.
public struct ScreenMacHold: Equatable, Sendable {
    /// A person at this Mac took remote input back and has not handed it back.
    public private(set) var held = false

    public init() {}

    /// The hold a new session starts with.
    public func begin() -> ScreenSessionInputHold { ScreenSessionInputHold(mode: held ? .paused : .remote) }

    /// 「직접 하기」 on the current session's hold.
    public mutating func pause(_ hold: ScreenSessionInputHold) {
        hold.pause()
        held = true
    }

    /// 「보기만」: the current session only shows the picture, and the next one starts paused.
    public mutating func lowerToView(_ hold: ScreenSessionInputHold) {
        hold.lowerToView()
        held = true
    }

    /// 「다시 넘기기」, its click already accepted (ScreenSessionBarClick): false unless the session was paused.
    @discardableResult
    public mutating func resume(_ hold: ScreenSessionInputHold) -> Bool {
        guard hold.resume() else { return false }
        held = false
        return true
    }

    /// Screen control was turned on again at this Mac, after Touch ID or the password.
    public mutating func reset() { held = false }
}

extension ScreenSessionAccess {
    /// The bar's reading of a session: `canControl` as the service records it, the bar's hold, and the receiver's
    /// latest reason for pausing remote input.
    public static func of(canControl: Bool, hold: ScreenSessionInputHold.Mode?, availability: ScreenInputAvailability?) -> ScreenSessionAccess {
        if hold == .viewOnly { return .view(.lowered) }
        guard canControl else { return .view(.session) }
        switch availability {
        case .monitorUnavailable?, .permissionsRequired?: return .view(.protectionLost)
        default: break
        }
        if hold == .paused { return .control(.heldAtMac) }
        switch availability {
        case .secureInput?: return .control(.secureInput)
        case .localActivity?: return .control(.localActivity)
        default: return .control(.flowing)
        }
    }
}

extension ScreenSessionLimit {
    /// The pump's next deadline as the bar shows it.
    public init(deadline: (at: ContinuousClock.Instant, reason: SessionEndReason), now: ContinuousClock.Instant) {
        let left = deadline.at - now
        self.init(kind: deadline.reason == .timeLimit ? .maximum : .idle,
                  remaining: max(0, Double(left.components.seconds) + Double(left.components.attoseconds) / 1e18))
    }
}

extension LocalInputMonitor {
    /// The marker every event this app injects for the other side carries. The bar refuses a 「다시 넘기기」 click with
    /// it: that click came from the other side, not a person at this Mac.
    public static var injectedEventMarker: Int64 { injectionMarker }
}
#endif
