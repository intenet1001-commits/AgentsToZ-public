import Foundation

/// Local progress only: never a claim that an unauthenticated peer is the registered Mac.
/// Shared by the phone and Mac viewer; contains no endpoint, key or transport error description.
public enum ScreenConnectionPhase: Equatable, Sendable {
    case approval, nearby, privateNetwork, relay, community, authenticatingMac, firstFrame, displaying

    public var progressMessage: String {
        switch self {
        case .approval: "기기 인증을 기다리는 중…"
        case .nearby: "근거리에서 Mac을 찾는 중…"
        case .privateNetwork: "Cloudflare 사설망으로 Mac에 연결하는 중…"
        case .relay: "자체 중계로 Mac에 연결하는 중…"
        case .community: "커뮤니티 인터넷 경로로 Mac을 인증하는 중…"
        case .authenticatingMac: "통신 경로 연결됨 · 등록한 Mac을 인증하는 중…"
        case .firstFrame: "Mac 인증 완료 · 첫 화면을 기다리는 중…"
        case .displaying: "Mac 화면 연결됨"
        }
    }

    /// An opening timeout, an unanswered handshake and a lost video stream need different remedies.
    /// Protocol/authentication errors keep their existing, more specific messages at the call site.
    public func transportFailure(_ error: Error) -> String? {
        guard error is TransportError, self != .approval else { return nil }
        switch self {
        case .privateNetwork:
            return "Cloudflare 사설망에서 Mac까지 연결하지 못했습니다. 이 기기의 One Agent 연결, 저장한 Mac 주소와 터널 경로를 확인하세요. Mac 인증은 아직 시작하지 않았습니다. 5G에서는 같은 Wi‑Fi가 필요하지 않습니다."
        case .relay:
            return "자체 중계 통신 경로를 열지 못했습니다. 중계 서버와 Mac의 인터넷 연결을 확인하세요. Mac 인증은 아직 시작하지 않았습니다."
        case .community:
            return "커뮤니티 인터넷 연결을 마치지 못했습니다. 상대 Mac의 Screen 켜짐·알림 연결·공통 등록 권한을 확인하세요. 별도의 사설망 IP나 One Agent는 필요하지 않습니다."
        case .nearby:
            return "근거리에서 Mac까지 연결하지 못했습니다. Mac의 AgentsToZ Screen과 가까운 네트워크 연결을 확인하세요. 밖에서는 사설망 · Cloudflare 경로를 선택하세요."
        case .authenticatingMac:
            return "통신 경로는 열렸지만 등록한 Mac의 인증을 마치지 못했습니다. Mac의 AgentsToZ Screen 실행 상태와 기기 등록을 확인하세요. 지문인식 실패를 뜻하는 오류는 아닙니다."
        case .firstFrame:
            return "Mac 인증은 완료됐지만 첫 화면을 받기 전에 연결이 끊겼습니다. Mac의 화면 기록 권한과 AgentsToZ Screen 상태를 확인하세요."
        case .displaying:
            return "Mac 화면을 받던 중 연결이 끊겼습니다. 사용하던 네트워크와 Mac의 AgentsToZ Screen 상태를 확인하세요."
        case .approval: return nil
        }
    }
}
