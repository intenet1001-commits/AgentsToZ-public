import CryptoKit
import Foundation
import Observation
import ScreenControlCore
import UIKit

/// A process-only signing capability shared by all community features. No LAContext or success Boolean is cached.
@MainActor @Observable final class MobileCommunityUseSession {
    enum HumanActivity: String { case touch, key, action }
    private final class SessionSigner: TranscriptSigner, @unchecked Sendable {
        private let lock = NSLock()
        private var key: P256.Signing.PrivateKey?
        private var foregroundAllowed = true
        let publicKey: P256.Signing.PublicKey
        init(key: P256.Signing.PrivateKey) { self.key = key; publicKey = key.publicKey }
        func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
            try lock.withLock { guard foregroundAllowed, let key else { throw ScreenCommunityError.service("SESSION_EXPIRED") }; return try key.signature(for: data) }
        }
        func setForeground(_ allowed: Bool) { lock.withLock { foregroundAllowed = allowed } }
        func destroy() { lock.withLock { key = nil; foregroundAllowed = false } }
    }
    private(set) var session: CommunityUseSession?
    private(set) var message = "사용 시작 때 한 번 인증합니다. 마지막 실제 조작 후 60분간 유효합니다."
    private(set) var busy = false
    @ObservationIgnored private var signer: SessionSigner?
    @ObservationIgnored private var authorization: CommunityAuthorization?
    @ObservationIgnored private var coordinator: CommunityAccessCoordinator?
    @ObservationIgnored private var monotonicDeadline: ContinuousClock.Instant?
    @ObservationIgnored private var generation: UInt64 = 0
    @ObservationIgnored private var expiry: Task<Void, Never>?
    @ObservationIgnored private var lockObservation: NSObjectProtocol?
    @ObservationIgnored private var activeObservation: NSObjectProtocol?
    @ObservationIgnored private var resumedObservation: NSObjectProtocol?
    @ObservationIgnored private var protectedDataAvailable = true
    @ObservationIgnored private var foreground = true
    /// The consumer must immediately release all pressed input and suspend new commands on invalidation/background.
    @ObservationIgnored var inputSuspended: () -> Void = {}
    @ObservationIgnored private var suspensionHandlers: [UUID: @MainActor () -> Void] = [:]
    @ObservationIgnored var authorizationProvider: (@MainActor () async throws -> CommunityAuthorization)?
    init() {
        lockObservation = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.protectedDataAvailable = false; self?.invalidate(reason: "기기가 잠겨 공통 사용 세션을 종료했습니다.") }
        }
        activeObservation = NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.foreground = false; self?.signer?.setForeground(false); self?.suspendConsumers() }
        }
        resumedObservation = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.becameActive() }
        }
    }
    var isUsable: Bool {
        guard foreground, UIApplication.shared.applicationState == .active, protectedDataAvailable, let session, signer != nil, let deadline = monotonicDeadline else { return false }
        return ContinuousClock.now < deadline && Int64(Date().timeIntervalSince1970 * 1000) < session.body.idleExpiresAt
    }
    /// Subscribers only release input and close channels. This never starts a use episode or extends idle.
    func observeSuspension(_ handler: @escaping @MainActor () -> Void) throws -> UUID {
        guard suspensionHandlers.count < 8 else { throw ScreenCommunityError.service("TOO_MANY_CONSUMERS") }
        let id = UUID(); suspensionHandlers[id] = handler; return id
    }
    func removeSuspensionObserver(_ id: UUID) { suspensionHandlers.removeValue(forKey: id) }
    private func suspendConsumers() { inputSuspended(); for handler in Array(suspensionHandlers.values) { handler() } }
    /// Only the structured client proof can reach the process-only use key; arbitrary bytes have no API here.
    func signMobileControl(_ proof: CommunityMobileControlProof) async throws -> Data {
        let epoch = generation
        guard isUsable, let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let current = try await currentSession(for: proof.context.purpose.capability)
        guard let authorization else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let context = try CommunityMobileControlContext(authority: authority, mobile: authorization, session: current,
            receiver: proof.context.receiver, purpose: proof.context.purpose)
        try proof.validate(current: context)
        guard epoch == generation, isUsable, let signer else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let signed = try await signer.signature(for: proof.bytes)
        guard epoch == generation, isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        return signed.rawRepresentation
    }
    /// Separate typed negative-control proof. No arbitrary bytes, operation key or RAM key leaves this owner.
    func signSafety(_ proof: CommunitySafetyMobileRequest) async throws -> Data {
        let epoch=generation
        guard isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let current=try await currentSession(for:.screenView)
        guard epoch==generation,isUsable,let authorization,let signer else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        try proof.validate(currentAuthorization:authorization,currentSession:current)
        let signature=try await signer.signature(for:proof.bytes)
        guard epoch==generation,isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        return signature.rawRepresentation
    }
    func becameActive() {
        foreground = UIApplication.shared.applicationState == .active; protectedDataAvailable = UIApplication.shared.isProtectedDataAvailable
        signer?.setForeground(foreground && protectedDataAvailable)
        if !protectedDataAvailable || (session != nil && !isUsable) { invalidate(reason: "공통 사용 세션이 만료되었습니다. 다시 사용을 시작하세요.") }
    }
    /// BIO can finish before UIKit reports active. Waiting preserves the key and all cancellation/lock fences.
    func waitUntilActive() async throws {
        let epoch = generation, deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while UIApplication.shared.applicationState != .active {
            guard epoch == generation, !Task.isCancelled, UIApplication.shared.isProtectedDataAvailable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
            guard ContinuousClock.now < deadline else { throw ScreenCommunityError.service("SESSION_INACTIVE") }
            try await Task.sleep(for: .milliseconds(25))
        }
        guard epoch == generation, !Task.isCancelled, UIApplication.shared.isProtectedDataAvailable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        becameActive()
        guard isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
    }
    private func args(_ values: [Any]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    func start(authorization: CommunityAuthorization, biometricBlob: Data, capabilities: [CommunityCapability], authority: ScreenCommunityAuthority) async throws {
        guard !busy else { throw ScreenCommunityError.service("BUSY") }
        guard authorization.isCurrent(), authorization.body.deviceKind == .mobile,
              Set(capabilities).isSubset(of: Set(authorization.body.capabilities)),
              UIApplication.shared.isProtectedDataAvailable else { throw ScreenCommunityError.service("NOT_AUTHORIZED") }
        invalidate(reason: "사용 시작을 준비하는 중…"); busy = true; defer { busy = false }
        let epoch = generation
        let candidate = SessionSigner(key: P256.Signing.PrivateKey()) // Never serialized or sent outside this process.
        let biometric = try await FaceIDApprovedSigner.approve(dataRepresentation: biometricBlob, reason: "등록한 Mac과 기능을 함께 사용합니다")
        guard epoch == generation, !Task.isCancelled, UIApplication.shared.isProtectedDataAvailable,
              ScreenCommunityRequest.base64(biometric.publicKey.x963Representation) == authorization.body.biometricPublicKey else { throw ScreenCommunityError.wrongCommunity }
        let transport = CommunityAccessCoordinator(authority: authority, pending: nil, save: { _ in }) // RAM-only; process exit discards session.
        let dispatchedTick = ContinuousClock.now
        let response = try await transport.request(.sessionOpen, actor: authorization.body.enrollmentId,
            argumentsJSON: args([authorization.body.communityId, ScreenCommunityRequest.base64(candidate.publicKey.x963Representation), capabilities.map(\.rawValue)]), signer: biometric, mutation: true)
        let opened = try response.session(for: authorization)
        guard epoch == generation, opened.body.sessionId == response.requestId,
              opened.body.publicKey == ScreenCommunityRequest.base64(candidate.publicKey.x963Representation), opened.body.capabilities == capabilities,
              opened.body.sequence == 0 else { throw ScreenCommunityError.wrongCommunity }
        self.authorization = authorization; signer = candidate; coordinator = transport; session = opened
        foreground = UIApplication.shared.applicationState == .active; protectedDataAvailable = true
        candidate.setForeground(foreground)
        resetDeadline(opened, humanTick: dispatchedTick); try await transport.acknowledge(response.requestId)
        message = "한 번 인증한 공통 세션 사용 중 · Mac·기능 전환 때 추가 인증 없음"
    }
    private func resetDeadline(_ next: CommunityUseSession, humanTick: ContinuousClock.Instant) {
        let candidate = CommunityUseIdleDeadline.bounded(serverIdleExpiresAt: next.body.idleExpiresAt,
            wallNow: Date(), tickNow: .now, humanTick: humanTick)
        // Only accepted human activity may move the monotonic deadline forward; status never calls this method.
        monotonicDeadline = candidate; expiry?.cancel()
        expiry = Task { [weak self] in
            try? await Task.sleep(until: candidate, clock: .continuous)
            guard !Task.isCancelled else { return }; self?.invalidate(reason: "60분 동안 조작이 없어 공통 사용 세션을 종료했습니다.")
        }
    }
    func signer(for capability: CommunityCapability) throws -> any TranscriptSigner {
        guard isUsable, let session, session.body.capabilities.contains(capability), let signer,
              session.body.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        guard let authorization else { throw ScreenCommunityError.service("NOT_AUTHORIZED") }
        return try CommunityPurposeSigner(inner: signer, authorization: authorization, session: session, capability: capability)
    }
    private func waitForCoordinator() async throws {
        let epoch = generation, deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while busy {
            guard epoch == generation, isUsable, !Task.isCancelled, ContinuousClock.now < deadline else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
            try await Task.sleep(for: .milliseconds(20))
        }
        guard epoch == generation, isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
    }
    func currentSession(for capability: CommunityCapability) async throws -> CommunityUseSession {
        try await waitForCoordinator()
        if authorization?.isCurrent(at: Date().addingTimeInterval(10)) != true {
            guard let authorizationProvider else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
            try updateAuthorization(await authorizationProvider())
        }
        guard let session, let signer, let authorization, let coordinator else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        if session.body.expiresAt <= Int64(Date().timeIntervalSince1970 * 1000) + 10_000 {
            busy = true; defer { busy = false }; let epoch = generation
            do {
                let response = try await coordinator.request(.sessionStatus, actor: authorization.body.enrollmentId,
                    argumentsJSON: args([authorization.body.communityId, session.body.sessionId]), signer: signer)
                let next = try response.session(for: authorization)
                guard epoch == generation, next.body.sessionId == session.body.sessionId, next.body.publicKey == session.body.publicKey,
                      next.body.sequence == session.body.sequence, next.body.lastHumanAt == session.body.lastHumanAt,
                      next.body.idleExpiresAt == session.body.idleExpiresAt, next.body.capabilities == session.body.capabilities else { throw ScreenCommunityError.wrongCommunity }
                self.session = next // Refresh execution lease without extending idle or monotonic deadline.
            } catch { invalidate(reason: "사용 권한 확인을 완료하지 못했습니다. 다시 사용을 시작하세요."); throw error }
        }
        guard let current = self.session, current.body.capabilities.contains(capability) else { throw ScreenCommunityError.service("NOT_AUTHORIZED") }
        return current
    }
    func updateAuthorization(_ next: CommunityAuthorization) throws {
        guard let previous = authorization else { return }
        let a = previous.body, b = next.body
        guard next.isCurrent(), a.communityId == b.communityId, a.profileId == b.profileId, a.enrollmentId == b.enrollmentId,
              a.deviceId == b.deviceId, a.deviceKind == b.deviceKind, a.hostPublicKey == b.hostPublicKey,
              a.publicKey == b.publicKey, a.biometricPublicKey == b.biometricPublicKey, a.controlKey == b.controlKey, a.agentDeviceId == b.agentDeviceId,
              a.capabilities == b.capabilities, a.revision == b.revision, a.keyEpoch == b.keyEpoch else {
            invalidate(reason: "기기 권한이 변경되어 공통 사용 세션을 종료했습니다."); throw ScreenCommunityError.wrongCommunity
        }
        authorization = next
    }
    /// Invoke only from the real touch/key/explicit action handler, with its original timestamp.
    /// Video frames, networking and agent automation have no activity entry point.
    func recordHumanActivity(_ kind: HumanActivity, observedAt: Date, observedTick: ContinuousClock.Instant) async throws {
        try await waitForCoordinator()
        let wallNow = Date(), tickNow = ContinuousClock.now
        guard !busy, isUsable, let session, let signer, let authorization, let coordinator,
              observedAt <= wallNow, wallNow.timeIntervalSince(observedAt) <= 55,
              observedTick <= tickNow, observedTick.duration(to: tickNow) <= .seconds(55),
              Int64(observedAt.timeIntervalSince1970 * 1000) > session.body.lastHumanAt else { throw ScreenCommunityError.service("INVALID_ACTIVITY") }
        busy = true; defer { busy = false }; let epoch = generation
        do {
            let reply = try await coordinator.request(.activity, actor: authorization.body.enrollmentId,
                argumentsJSON: args([authorization.body.communityId, session.body.sessionId, session.body.sequence + 1, kind.rawValue]), signer: signer,
                mutation: true, observedAt: observedAt)
            let next = try reply.session(for: authorization)
            guard epoch == generation, next.body.sessionId == session.body.sessionId, next.body.publicKey == session.body.publicKey,
                  next.body.sequence == session.body.sequence + 1, next.body.lastHumanAt >= session.body.lastHumanAt,
                  next.body.lastHumanAt <= Int64(observedAt.timeIntervalSince1970 * 1000), next.body.capabilities == session.body.capabilities else { throw ScreenCommunityError.wrongCommunity }
            self.session = next; resetDeadline(next, humanTick: observedTick); try await coordinator.acknowledge(reply.requestId)
        } catch {
            // No new-ID retry after an unknown activity outcome. Losing the RAM session is safe and explicit.
            invalidate(reason: "조작 확인이 끊겨 공통 사용 세션을 종료했습니다. 다시 사용을 시작하세요."); throw error
        }
    }
    func invalidate(reason: String = "공통 사용 세션을 종료했습니다.") {
        generation &+= 1; expiry?.cancel(); expiry = nil
        suspendConsumers(); signer?.destroy(); signer = nil; session = nil; authorization = nil; coordinator = nil; monotonicDeadline = nil; message = reason
    }
    func close() async {
        var closing: (CommunityAccessRequest, ScreenCommunityEnvelope)?
        let authority = ScreenCommunityAuthority.configured
        if let oldSession = session, let oldSigner = signer, let oldAuthorization = authorization {
            let request = try? CommunityAccessRequest(operation: .sessionClose, actor: oldAuthorization.body.enrollmentId,
                argumentsJSON: args([oldAuthorization.body.communityId, oldSession.body.sessionId]))
            if let request, let envelope = try? await request.signed(by: oldSigner) { closing = (request, envelope) }
        }
        invalidate()
        if let authority, let closing { _ = try? await CommunityAccessHTTP(authority: authority).send(closing.1, requestId: closing.0.id) }
    }
}
