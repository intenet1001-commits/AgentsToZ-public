import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

extension ScreenControlChecks {
    func testConnectionDiagnosticsDistinguishStages() async throws {
        let error = TransportError.timedOut
        let privateFailure = ScreenConnectionPhase.privateNetwork.transportFailure(error)
        let authFailure = ScreenConnectionPhase.authenticatingMac.transportFailure(error)
        let videoFailure = ScreenConnectionPhase.firstFrame.transportFailure(error)
        try check(privateFailure?.contains("Mac 인증은 아직 시작하지 않았습니다") == true, "a path timeout must not claim Mac authentication")
        try check(privateFailure?.contains("같은 Wi‑Fi가 필요하지 않습니다") == true, "a cellular private route must not ask for the same Wi-Fi")
        try check(authFailure?.contains("통신 경로는 열렸지만") == true && authFailure != privateFailure, "handshake timeout is distinct")
        try check(videoFailure?.contains("Mac 인증은 완료") == true && videoFailure != authFailure, "video failure follows authenticated Mac")
        try check(ScreenConnectionPhase.approval.transportFailure(error) == nil, "no transport diagnosis before approval")
        for phase in [ScreenConnectionPhase.nearby, .privateNetwork, .relay, .authenticatingMac, .firstFrame, .displaying] {
            try check(phase.transportFailure(HandshakeError.badSignature) == nil, "identity errors must keep their specific diagnosis")
            try check(phase.transportFailure(CancellationError()) == nil, "cancellation is not a transport failure")
            try check(phase.transportFailure(.failed("secret-host-key-token") as TransportError)?.contains("secret-host-key-token") == false,
                      "raw transport details must not enter the UI")
        }
    }
}
