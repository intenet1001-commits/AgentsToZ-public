#if os(macOS)
import Foundation
import LocalAuthentication
import Network
import os
import ScreenControlCore

// Reaching a target from this Mac (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.4): the person's biometric approval of
// the target's own key first, then `ScreenTargetConnector` over the real network. Nothing here starts on its own: the
// list's 「연결」 runs it, after `HumanActions` judged the click.
enum ViewerConnection {
    /// Touch ID, or Apple Watch when the key allows it (D-6), for this target's key; never the account password. The
    /// approval signs one transcript and is spent (SR-26).
    static func approve(_ target: ViewerTarget) async throws -> any TranscriptSigner {
        try await FaceIDApprovedSigner.approve(dataRepresentation: target.controllerKeyBlob,
                                               reason: "‘\(target.displayName)’에 연결합니다",
                                               authentication: .biometricsOnly)
    }

    static func connect(_ target: ViewerTarget,
                        progress: @escaping @Sendable (ScreenConnectionPhase) async -> Void = { _ in }) async throws -> ScreenTargetConnector.Connected {
        try await ScreenTargetConnector.connect(target, approve: { try await approve(target) }, progress: progress)
    }

    /// The wording for a failed connection. The nearby `pv` hint is read only after a nearby path opened and went
    /// unanswered, for the message; it never decides anything.
    static func message(for error: Error, target: ViewerTarget) async -> String {
        if let error = error as? ScreenTargetConnectError {
            var hint = ScreenNearbyVersionHint.unknown
            if case .refused(.nearby(let name), .unanswered) = error { hint = await NearbyVersionLookup.hint(serviceName: name) }
            return ScreenTargetText.connectFailure(error, nearbyHint: hint)
        }
        if let error = error as? LAError {
            switch error.code {
            case .userCancel, .appCancel, .systemCancel: return "생체 인증을 취소해 연결하지 않았습니다"
            case .biometryNotAvailable, .biometryNotEnrolled, .biometryNotPaired: return ScreenTargetText.biometryUnavailable
            case .biometryLockout: return "Touch ID가 잠겼습니다. 시스템 설정에서 잠금을 푼 뒤 다시 연결하세요"
            default: break
            }
        }
        return "생체 인증을 마치지 못해 연결하지 않았습니다. 지문 등록이 바뀌었다면 B 앞에서 다시 등록하세요"
    }
}

/// Reads the `pv` entry of one nearby advertisement (DESIGN 7.7), for wording only. Browsing sends nothing to B.
enum NearbyVersionLookup {
    static func hint(serviceName: String, within timeout: Duration = .milliseconds(1500)) async -> ScreenNearbyVersionHint {
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: ScreenNearby.serviceType, domain: nil), using: .tcp)
        let settled = OSAllocatedUnfairLock(initialState: false)
        return await withCheckedContinuation { (continuation: CheckedContinuation<ScreenNearbyVersionHint, Never>) in
            @Sendable func finish(_ hint: ScreenNearbyVersionHint) {
                guard settled.withLock({ done in defer { done = true }; return !done }) else { return }
                browser.cancel()
                continuation.resume(returning: hint)
            }
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    guard case .service(let name, _, _, _) = result.endpoint, name == serviceName else { continue }
                    if case .bonjour(let record) = result.metadata { finish(ScreenNearbyVersionHint.from(txt: record.dictionary)) }
                }
            }
            browser.stateUpdateHandler = { state in
                if case .failed = state { finish(.unknown) }
            }
            browser.start(queue: .global(qos: .userInitiated))
            Task {
                try? await Task.sleep(for: timeout)
                finish(.unknown)
            }
        }
    }
}
#endif
