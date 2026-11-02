import Foundation
#if canImport(ScreenControlCore)
import ScreenControlCore
#endif

// The floating session bar on the Mac being watched (docs/design/mac-to-mac-2026-11-01/DESIGN.md 「부록 A」): who is
// looking at or controlling this Mac, for how long, and the person's four verbs. It is pure and imports Foundation
// alone, so the offscreen render check (scripts/check-screen-control.ts) compiles it with ScreenSessionBarView and
// nothing else. ScreenSessionBar in the app reads the service once a second, builds a `ScreenSessionBarState`
// (ScreenSessionInputHold.swift maps the service into it) and draws what `ScreenSessionBarText.present` returns.

/// The kind of device a session comes from, read from the model it registered with: "iPhone16,2", "iPad14,1", or a
/// Mac's "Mac14,2", "MacBookPro18,3", "iMac21,1". A Mac controller is explicitly displayed as a Mac even when its
/// model is unavailable (DESIGN 부록 A).
public enum ScreenDeviceKind: String, CaseIterable, Sendable {
    case iPhone, iPad, mac, other

    public init(model: String) {
        let model = model.lowercased()
        if model.hasPrefix("ipad") { self = .iPad }
        else if model.hasPrefix("iphone") || model.hasPrefix("ipod") { self = .iPhone }
        // Mac…, MacBook…, Macmini…, MacPro…, iMac…, and a virtual Mac.
        else if model.hasPrefix("mac") || model.hasPrefix("imac") || model.hasPrefix("virtualmac") { self = .mac }
        else { self = .other }
    }

    public var label: String {
        switch self {
        case .iPhone: "iPhone"
        case .iPad: "iPad"
        case .mac: "Mac"
        case .other: "기기"
        }
    }

    /// The SF Symbol drawn before the device's name.
    public var symbol: String {
        switch self {
        case .iPhone: "iphone"
        case .iPad: "ipad"
        case .mac: "desktopcomputer"
        case .other: "display"
        }
    }
}

/// Where a control session's remote input stands.
public enum ScreenSessionInput: Equatable, Sendable {
    /// Remote input reaches this Mac.
    case flowing
    /// 「직접 하기」: paused from the bar until a person at this Mac hands it back; also a session that began while this Mac
    /// still held its input from an earlier 「직접 하기」 or 「보기만」 (ScreenMacHold).
    case heldAtMac
    /// The person at this Mac is using its own mouse or keyboard, so remote input waits (local input wins).
    case localActivity
    /// Secure Event Input is on (a password field), so remote input waits.
    case secureInput
}

/// Why a session only shows the picture.
public enum ScreenSessionViewReason: Equatable, Sendable {
    /// It began that way: the device or controller may only view, or this Mac could not watch its own input.
    case session
    /// 「보기만」 was pressed during this session. The next session, from any device, starts with remote input held at
    /// this Mac until a person here hands it back (ScreenMacHold).
    case lowered
    /// This Mac stopped being able to watch its own input mid-session, so remote input stays off until it reconnects.
    case protectionLost
}

public enum ScreenSessionAccess: Equatable, Sendable {
    case control(ScreenSessionInput)
    case view(ScreenSessionViewReason)
}

/// The next session limit: an idle limit restarts with each input from the other side; a maximum does not.
public struct ScreenSessionLimit: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case idle, maximum }
    public var kind: Kind
    /// Seconds until it ends the session.
    public var remaining: TimeInterval
    public init(kind: Kind, remaining: TimeInterval) { self.kind = kind; self.remaining = remaining }
}

/// What the bar knows about the current session.
public struct ScreenSessionBarState: Equatable, Sendable {
    public var kind: ScreenDeviceKind
    public var name: String
    public var access: ScreenSessionAccess
    /// Seconds since the session began.
    public var elapsed: TimeInterval
    /// Nil until the stream runs.
    public var limit: ScreenSessionLimit?
    /// The key that ends the session at this Mac (EndSessionHotKey).
    public var hotKey: String

    public init(kind: ScreenDeviceKind, name: String, access: ScreenSessionAccess, elapsed: TimeInterval,
                limit: ScreenSessionLimit?, hotKey: String) {
        self.kind = kind; self.name = name; self.access = access; self.elapsed = elapsed; self.limit = limit
        self.hotKey = hotKey
    }
}

/// The bar's buttons. 「끊기」, 「보기만」 and 「직접 하기」 take something away from the other side, so any click may press
/// them, the other side's own included (they see the bar in the picture). 「다시 넘기기」 gives input back, so only a
/// person's click at this Mac counts (SR-29, `ScreenSessionBarClick`).
public enum ScreenSessionBarAction: String, CaseIterable, Sendable {
    case takeOver, handBack, viewOnly, end

    public var needsPersonAtMac: Bool { self == .handBack }

    public var label: String {
        switch self {
        case .takeOver: "직접 하기"
        case .handBack: "다시 넘기기"
        case .viewOnly: "보기만"
        case .end: "끊기"
        }
    }
}

/// How the status light and rim read: someone else moving this Mac, someone only watching, the person here holding
/// it, or something to look at.
public enum ScreenSessionBarTone: Equatable, Sendable { case controlling, watching, holding, warning }

/// A short message that replaces the bar's words for a few seconds.
public enum ScreenSessionBarNotice: Equatable, Sendable {
    case handBackRefused(ScreenSessionBarClick.Refusal)
}

/// One drawn state of the bar.
public struct ScreenSessionBarPresentation: Equatable, Sendable {
    public var tone: ScreenSessionBarTone
    public var symbol: String
    public var title: String
    public var detail: String
    /// The second line is a warning (amber).
    public var notice: Bool
    public var actions: [ScreenSessionBarAction]
    public var hotKey: String
}

public enum ScreenSessionBarText {
    public static let localActivity = "이 Mac에서 조작 중 — 원격 입력 멈춤"
    public static let secureInput = "보안 입력 중 — 원격 입력 멈춤"
    public static let heldAtMac = "직접 하는 중 · 다시 넘기기는 이 Mac에서만"
    public static let lowered = "보기만으로 바꿈"
    public static let protectionLost = "입력 보호가 멈춰 보기만 · 다시 연결하면 조작"
    public static let refusedTitle = "사람의 클릭으로 확인되지 않았습니다"
    public static let refused = "넘기지 않았습니다 · 이 Mac 앞에서 직접 눌러 주세요"
    public static let remoteDesktopTitle = "이 Mac 앞에서 눌러야 합니다"
    public static let remoteDesktop = "원격 데스크톱으로는 다시 넘길 수 없습니다"
    public static let repeatedClickTitle = "다시 넘기지 않았습니다"
    public static let repeatedClick = "두 번 누름은 받지 않습니다 · 한 번만 눌러 주세요"

    /// 「iPhone ‘민수 폰’」, without repeating the kind when the name already says it (「‘민수의 iPhone’」).
    public static func device(_ kind: ScreenDeviceKind, _ name: String) -> String {
        name.localizedCaseInsensitiveContains(kind.label) ? "‘\(name)’" : "\(kind.label) ‘\(name)’"
    }

    /// 「방금 연결」, 「12분째」, 「1시간 5분째」.
    public static func elapsed(_ seconds: TimeInterval) -> String {
        let whole = max(0, Int(seconds))
        guard whole >= 60 else { return "방금 연결" }
        return "\(duration(minutes: whole / 60))째"
    }

    /// 「입력이 없으면 48분 뒤 끝남」 for an idle limit, 「7시간 12분 뒤 끝남」 for a maximum. Minutes round up, so the bar
    /// never says less time than there is; the last minute counts down in seconds.
    public static func limit(_ limit: ScreenSessionLimit) -> String {
        let seconds = max(0, limit.remaining)
        let left = seconds < 60 ? "\(Int(seconds.rounded(.up)))초" : duration(minutes: Int((seconds / 60).rounded(.up)))
        return limit.kind == .idle ? "입력이 없으면 \(left) 뒤 끝남" : "\(left) 뒤 끝남"
    }

    private static func duration(minutes: Int) -> String {
        guard minutes >= 60 else { return "\(minutes)분" }
        let hours = minutes / 60, rest = minutes % 60
        return rest == 0 ? "\(hours)시간" : "\(hours)시간 \(rest)분"
    }

    /// The bar for `state`, with `notice` over its words while it lasts.
    public static func present(_ state: ScreenSessionBarState, notice: ScreenSessionBarNotice? = nil) -> ScreenSessionBarPresentation {
        let who = device(state.kind, state.name)
        let time = [elapsed(state.elapsed), state.limit.map(limit)].compactMap { $0 }.joined(separator: " · ")
        let tone: ScreenSessionBarTone
        let title: String
        var detail: String
        var warning = false
        let actions: [ScreenSessionBarAction]
        switch state.access {
        case .control(let input):
            title = "\(who) · \(input == .heldAtMac ? "원격 입력 멈춤" : "조작 중")"
            actions = [input == .heldAtMac ? .handBack : .takeOver, .viewOnly, .end]
            switch input {
            case .flowing: tone = .controlling; detail = time
            case .heldAtMac: tone = .holding; detail = "\(heldAtMac) · \(elapsed(state.elapsed))"
            case .localActivity: tone = .holding; detail = "\(localActivity) · \(elapsed(state.elapsed))"; warning = true
            case .secureInput: tone = .warning; detail = "\(secureInput) · \(elapsed(state.elapsed))"; warning = true
            }
        case .view(let reason):
            title = "\(who) · 보는 중"
            actions = [.end]
            switch reason {
            case .session: tone = .watching; detail = time
            case .lowered: tone = .watching; detail = "\(lowered) · \(time)"
            case .protectionLost: tone = .warning; detail = protectionLost; warning = true
            }
        }
        var shown = ScreenSessionBarPresentation(tone: tone, symbol: state.kind.symbol, title: title, detail: detail,
                                                 notice: warning, actions: actions, hotKey: state.hotKey)
        if case .handBackRefused(let refusal)? = notice {
            switch refusal {
            case .remoteDesktop: (shown.title, shown.detail) = (remoteDesktopTitle, remoteDesktop)
            case .repeatedClick: (shown.title, shown.detail) = (repeatedClickTitle, repeatedClick)
            default: (shown.title, shown.detail) = (refusedTitle, refused)
            }
            shown.notice = true
        }
        return shown
    }
}

/// The verified signing identity of the process that posted an event (Security framework, strict validation).
public struct ScreenSessionBarPoster: Equatable, Sendable {
    public let identifier: String
    public let team: String?
    public let apple: Bool
    public init(identifier: String, team: String?, apple: Bool) { self.identifier = identifier; self.team = team; self.apple = apple }
}

/// 「다시 넘기기」 accepts a hardware click at this Mac only (SR-29), the Control bar's pid 0 rule without its remote
/// desktop exception: the event that ran the button must be a fresh mouse-up on the bar, inside the pill that tracked
/// its own mouse-down, carry no posting process, not be one this app injected for the other side, and be a single
/// click. Remote input the app injected, another program, an AI, a script, an accessibility press and a remote desktop
/// are all refused; the poster's identity only chooses what the bar says. Pure: the bar passes in what it read from the
/// event.
///
public enum ScreenSessionBarClick {
    public enum Refusal: String, Sendable, CaseIterable {
        /// Not a mouse-up on the bar inside the pill that tracked it: an accessibility press, `performClick`, a keyboard
        /// activation, another window's event.
        case notABarClick = "not-a-bar-click"
        case stale = "stale-event"
        /// Input this app injected for the other side.
        case screenInjected = "screen-injected"
        case ownProcess = "own-process"
        case remoteDesktop = "remote-desktop"
        case otherProcess = "other-process"
        /// A person's click, but not a single one: the second click of a double-click on 「직접 하기」 lands on
        /// 「다시 넘기기」, which takes the same place, and must not hand input straight back.
        case repeatedClick = "repeated-click"
    }

    public static let hardwareSourcePid = ScreenInputOrigin.hardwareSourcePid

    /// The bar adds its own tracked-button and injection-marker checks to the shared hardware rule.
    public static func handBackRefusal(isMouseUp: Bool, inBar: Bool, inControl: Bool, clickCount: Int, ageSeconds: Double,
                                       sourcePid: Int64, userData: Int64, ownPid: Int64, injectionMarker: Int64,
                                       poster: ScreenSessionBarPoster?, keyboardType: Int64 = 0, sourceState: Int64 = 0) -> Refusal? {
        guard isMouseUp, inBar, inControl else { return .notABarClick }
        guard userData != injectionMarker else { return .screenInjected }
        let identity = poster.map { ScreenInputPoster(identifier: $0.identifier, team: $0.team, apple: $0.apple) }
        let event = ScreenInputEvent(kind: .leftMouseUp, ageSeconds: ageSeconds, sourcePid: sourcePid,
                                     keyboardType: keyboardType, sourceState: sourceState, poster: identity)
        if let refusal = ScreenInputOrigin.humanClick(event, inControl: true, ownPid: ownPid, screenPid: ownPid) {
            switch refusal {
            case .noCurrentEvent, .notTheControl: return .notABarClick
            case .staleEvent: return .stale
            case .ownEvent: return .ownProcess
            case .screenInjection: return .screenInjected
            case .remoteDesktop: return .remoteDesktop
            case .synthetic, .unexpectedSourceState, .virtualDevice: return .otherProcess
            }
        }
        return clickCount == 1 ? nil : .repeatedClick
    }

}

/// Where the bar opens.
public enum ScreenSessionBarPlacement {
    public static let margin: CGFloat = 18
    /// The Control bar opens `margin` above the Dock; this one sits a bar's height above it, so both show when an AI
    /// from another Mac moves this Mac during a session (부록 A).
    public static let controlBarSlot: CGFloat = 52 + 10

    /// Where the person last left it while that spot is still wholly on a screen; otherwise bottom centre of the first
    /// (menu bar) screen, above the Dock and the Control bar's spot. Nil without a screen.
    public static func origin(saved: CGPoint?, size: CGSize, visibleFrames: [CGRect]) -> CGPoint? {
        if let saved, visibleFrames.contains(where: { $0.contains(CGRect(origin: saved, size: size)) }) { return saved }
        guard let main = visibleFrames.first else { return nil }
        return CGPoint(x: (main.midX - size.width / 2).rounded(), y: main.minY + margin + controlBarSlot)
    }
}
