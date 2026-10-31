import Foundation

/// Who holds the Mac while a v2 grant is open, as the on-screen control bar shows it (AgentsToZControl/ControlBar.swift).
public enum ControlBarOwner: Equatable, Sendable { case agent, person }

/// The verified signing identity of the process that posted an event (Security framework, strict validation).
public struct ControlBarPoster: Equatable, Sendable {
    public let identifier: String
    public let team: String?
    public let apple: Bool
    public init(identifier: String, team: String?, apple: Bool) { self.identifier = identifier; self.team = team; self.apple = apple }
}

/// 「AI에게 넘기기」 accepts a person's click only. Pure: the bar passes in what it read from the event.
/// Hardware input carries no posting process. A person working through a remote desktop reaches the Mac through that
/// tool's signed agent, so those identities are accepted by name. Every other poster — an AI app, a script, a test
/// tool, this process — is refused. `syntheticTag` is the engine's own forgeable marker: it can only refuse.
/// 「직접 하기」 and 「중단」 take nothing from the person and need no such check.
public enum ControlBarClick {
    public static let appleRemoteDesktop: Set<String> = ["com.apple.screensharing.agent", "com.apple.screensharing.daemon",
                                                         "com.apple.AppleVNCServer", "com.apple.RemoteDesktopAgent"]
    /// Team ID → identifiers (Jump Desktop Connect, read with codesign on 1호 2026-10-31).
    public static let teamRemoteDesktop: [String: Set<String>] = ["2HCKV38EEC": ["com.p5sys.jump.connect"]]
    /// Older than this, or not this bar's own window, and the event is not the click that ran the button's action.
    public static let freshSeconds = 1.0

    /// nil accepts; otherwise a short code for the log.
    public static func handBackRefusal(isMouseUp: Bool, inBar: Bool, ageSeconds: Double, sourcePid: Int64, userData: Int64,
                                       ownPid: Int64, syntheticTag: Int64, poster: ControlBarPoster?) -> String? {
        guard isMouseUp, inBar else { return "not-a-bar-click" }
        guard ageSeconds >= 0, ageSeconds <= freshSeconds else { return "stale-event" }
        guard userData != syntheticTag else { return "engine-event" }
        if sourcePid == 0 { return nil }
        guard sourcePid != ownPid else { return "own-event" }
        guard let poster else { return "poster-unverified" }
        if poster.apple { return appleRemoteDesktop.contains(poster.identifier) ? nil : "poster-not-remote-desktop" }
        guard let team = poster.team, teamRemoteDesktop[team]?.contains(poster.identifier) == true else { return "poster-not-remote-desktop" }
        return nil
    }
}

public enum ControlBarText {
    public static func title(_ owner: ControlBarOwner) -> String { owner == .agent ? "AI가 사용 중" : "직접 사용 중" }
    public static func primary(_ owner: ControlBarOwner) -> String { owner == .agent ? "직접 하기" : "AI에게 넘기기" }
    public static let stop = "중단"
    /// A refused hand-back, as the bar's two lines (each fits the bar without truncation).
    public static let handBackRefusedTitle = "사람의 클릭으로 확인되지 않았습니다"
    public static let handBackRefused = "넘기지 않았습니다 · 이 Mac에서 직접 눌러 주세요"
    public static func action(_ operation: String) -> String {
        switch operation {
        case "scope-click": return "클릭"
        case "scope-type-text": return "입력"
        case "scope-key": return "키"
        case "scope-scroll": return "스크롤"
        case "scope-drag": return "끌기"
        case "scope-focus-app": return "앱 전환"
        default: return "동작"
        }
    }
    public static func ago(_ seconds: Int) -> String {
        seconds < 5 ? "방금" : seconds < 60 ? "\(seconds)초 전" : "\(seconds / 60)분 전"
    }
    public static func detail(_ owner: ControlBarOwner, scope: String, lastOperation: String?, secondsAgo: Int?) -> String {
        guard owner == .agent else { return "AI는 기다립니다 · 넘기면 화면을 새로 보고 이어갑니다" }
        guard let lastOperation, let secondsAgo else { return "\(scope) · 화면을 보는 중" }
        return "\(scope) · 마지막 동작: \(action(lastOperation)) · \(ago(secondsAgo))"
    }
}
