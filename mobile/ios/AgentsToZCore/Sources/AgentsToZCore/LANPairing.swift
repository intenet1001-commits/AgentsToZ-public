import Foundation

public enum RemoteFailure: Error, LocalizedError, Sendable {
    case invalidQR, internetNotReady, invalidResponse, disconnected, busy, denied, timeout
    /// The host answered and said no. Distinct from a dead socket: the connection is fine and the
    /// caller usually should not tear it down. Carries the host's own code so the UI can retry a
    /// RATE_LIMITED and explain a SESSION_DISCONNECTED instead of blaming the network.
    case hostRefused(code: String, message: String?)
    /// The host ended this session on purpose (revoked, expired, remote control turned off).
    case sessionEnded(reason: String?)
    /// The socket dropped in a way the host says is resumable — a restart, or an abrupt close.
    case resumable
    public var errorDescription: String? {
        switch self {
        case .invalidQR: "Mac 앱의 같은 Wi-Fi 연결 QR을 확인해 주세요."
        case .internetNotReady: "인터넷 연결 QR은 아직 지원하지 않습니다. Mac 앱에서 같은 Wi-Fi 연결 QR을 열어 주세요."
        case .invalidResponse: "Mac 응답을 확인하지 못했습니다. 연결을 다시 확인해 주세요."
        case .disconnected: "Mac과 연결이 끊겼습니다. Mac에서 새 QR을 만들어 연결해 주세요."
        case .busy: "진행 중인 요청이 끝난 뒤 다시 시도해 주세요."
        case .denied: "이 프로젝트에서 허용되지 않은 동작입니다."
        case .timeout: "응답을 확인하지 못했습니다. 작업이 실행됐을 수 있으니 Mac 상태를 확인해 주세요."
        case .hostRefused(let code, let message):
            message ?? Self.refusalText(code)
        case .sessionEnded(let reason):
            reason ?? "Mac에서 이 연결을 종료했습니다. 새 QR로 다시 연결해 주세요."
        case .resumable: "Mac 연결이 잠시 끊겼습니다. 다시 연결하는 중입니다."
        }
    }
}

extension RemoteFailure {
    /// Only for codes the host may send without a message. Anything unknown stays generic rather
    /// than inventing an explanation for a code this build does not know.
    static func refusalText(_ code: String) -> String {
        switch code {
        case "RATE_LIMITED": "요청이 너무 빠릅니다. 잠시 뒤 다시 시도해 주세요."
        case "SESSION_DISCONNECTED": "요청 도중 연결이 끊겨 실행하지 않았습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."
        case "SESSION_LIMIT": "이 Mac에 연결된 기기가 너무 많습니다. Mac에서 쓰지 않는 연결을 해제해 주세요."
        case "PAIRING_EXPIRED", "INVALID_PAIRING": "QR이 만료되었거나 이미 사용되었습니다. Mac에서 새 QR을 만들어 주세요."
        case "SESSION_EXPIRED": "연결 시간이 만료되었습니다. Mac에서 새 QR을 만들어 주세요."
        default: "Mac이 이 요청을 처리하지 않았습니다."
        }
    }
    /// Whether the stored token is worthless now. Only the host saying it does not know this
    /// session ends it; a sleeping Mac or absent Wi-Fi must keep it so the next try can work.
    public var endsStoredSession: Bool {
        switch self {
        case .hostRefused(let code, _): ["SESSION_EXPIRED", "INVALID_SESSION_TOKEN", "INVALID_PAIRING", "PAIRING_EXPIRED"].contains(code)
        case .sessionEnded: true
        default: false
        }
    }
    /// Whether the same session can keep being used after this failure.
    public var keepsSession: Bool {
        switch self {
        case .hostRefused(let code, _): !["SESSION_EXPIRED", "INVALID_SESSION_TOKEN", "SESSION_LIMIT"].contains(code)
        case .busy, .denied: true
        default: false
        }
    }
}

/// A scanned value is untrusted. Never fetch it, log it, or persist its token.
public struct LANPairing: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let origin: String
    let token: String
    public var description: String { "LANPairing(\(origin), token: redacted)" }
    public var debugDescription: String { description }
    public var webSocketURL: URL { URL(string: origin.replacingOccurrences(of: "http://", with: "ws://") + "/remote/ws")! }

    public init(scanned: String) throws {
        guard scanned.utf8.count <= 4096, scanned == scanned.trimmingCharacters(in: .whitespacesAndNewlines),
              !scanned.contains(where: { $0.isWhitespace }), !scanned.contains("\\"),
              let parts = URLComponents(string: scanned) else { throw RemoteFailure.invalidQR }
        // Existing HTTPS portal QR is a different authentication protocol.
        if parts.scheme == "https" { throw RemoteFailure.internetNotReady }
        guard parts.scheme == "http", parts.user == nil, parts.password == nil,
              parts.percentEncodedPath == "/remote/", parts.percentEncodedQuery == nil,
              let host = parts.host, Self.privateIPv4(host),
              let port = parts.port, (1024...65535).contains(port),
              let fragment = parts.percentEncodedFragment, fragment.hasPrefix("pair="),
              Self.validToken(String(fragment.dropFirst(5))) else { throw RemoteFailure.invalidQR }
        origin = "http://\(host):\(port)"
        token = String(fragment.dropFirst(5))
        // Reject URL-parser normalization, alternate IP spellings and hidden delimiters.
        guard scanned == origin + "/remote/#pair=" + token else { throw RemoteFailure.invalidQR }
    }

    static func validToken(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
    static func privateIPv4(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let numbers = parts.compactMap { part -> Int? in
            guard let n = Int(part), (0...255).contains(n), String(n) == part else { return nil }; return n
        }
        guard numbers.count == 4 else { return false }
        return numbers[0] == 10 || numbers[0] == 172 && (16...31).contains(numbers[1]) || numbers[0] == 192 && numbers[1] == 168
    }
}
