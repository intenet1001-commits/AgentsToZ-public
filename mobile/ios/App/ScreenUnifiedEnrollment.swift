import CryptoKit
import Foundation
import Observation
import ScreenControlCore
import Security
import SwiftUI

private struct MobilePreparedEnrollment: Codable {
    let planId: String, communityId: String, digest: String
    let expiresAt: Int64
}
private struct MobilePendingEnrollment: Decodable { let planId: String, name: String, kind: CommunityDeviceKind, expiresAt: Int64 }
private final class MobileUnifiedStore: @unchecked Sendable {
    struct Accepted: Codable { let envelope: ScreenCommunityEnvelope; let checkedAt: Date }
    struct State: Codable {
        let operationBlob: Data
        var plan: CommunityAccessPlan?
        var prepared: MobilePreparedEnrollment?
        var accepted: Accepted?
        var approving: CommunityAccessPlan?
        var approvingCommunity: String?
        var approvalReceipt: Accepted?
        var journal: CommunityAccessJournal?
    }
    private let lock = NSLock()
    private var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.intenet.agentstoz.mobile.screen-community", kSecAttrAccount as String: "unified-enrollment-v2",
        kSecAttrSynchronizable as String: false] }
    private func bytes() throws -> Data? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }; return data
    }
    func read() throws -> State? { try lock.withLock { try bytes().map { try JSONDecoder().decode(State.self, from: $0) } } }
    func install(_ state: State) throws {
        try lock.withLock {
            guard try bytes() == nil else { throw ScreenCommunityError.service("DEVICE_KEY_EXISTS") }
            let q = query.merging([kSecValueData as String: try JSONEncoder().encode(state), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]) { $1 }
            let status = SecItemAdd(q as CFDictionary, nil)
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
    }
    func update(_ transform: (inout State) throws -> Void) throws {
        try lock.withLock {
            guard let bytes = try bytes() else { throw ScreenCommunityError.service("DEVICE_KEY_MISSING") }
            var state = try JSONDecoder().decode(State.self, from: bytes); try transform(&state)
            let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: try JSONEncoder().encode(state)] as CFDictionary)
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
    }
}

/// A fresh signed peer plus a display-only DTO using the real pre-existing biometric blob. Never saved to ScreenMacStore.
struct MobileCommunityScreenTarget: Identifiable {
    let peer: CommunityAuthorization
    let mac: SavedScreenMac
    var id: String { mac.id }
}

@MainActor @Observable final class MobileUnifiedEnrollment {
    private(set) var capabilities: [CommunityCapability] = [.screenView, .screenControl]
    private(set) var authorization: CommunityAuthorization?
    private(set) var hasEnrollmentPlan = false
    private(set) var screenTargets: [MobileCommunityScreenTarget] = []
    private(set) var review: CommunityAccessReview?
    private(set) var confirmation = CommunityEnrollmentConfirmation()
    private(set) var preparedDigest: String?
    private(set) var pending: [(id: String, name: String)] = []
    private(set) var waiting = false
    private(set) var busy = false
    private(set) var message = "사용할 기능을 함께 선택하고 관리 기기에서 한 번 승인하세요."
    let useSession = MobileCommunityUseSession()
    @ObservationIgnored private let store = MobileUnifiedStore()
    @ObservationIgnored private var coordinator: CommunityAccessCoordinator?
    @ObservationIgnored private var controlPeers: [CommunityMobileControlPurpose: (sessionID: String, peers: [CommunityAuthorization])] = [:]
    @ObservationIgnored private var actionEpoch = 0
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var boundAccount: MobileCommunityAccount?
    @ObservationIgnored private var approvalDeadline: Int64?
    @ObservationIgnored private var fallbackCertificate: ScreenCommunityCertificate?
    init() {
        do { hasEnrollmentPlan = try store.read()?.plan != nil }
        catch { hasEnrollmentPlan = true }
        useSession.authorizationProvider = { [weak self] in
            guard let self, let account = self.boundAccount else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            try await self.refresh(account: account)
            guard let authorization = self.authorization else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            return authorization
        }
    }
    var isWaitingForApproval: Bool { waiting && (approvalDeadline ?? 0) > Int64(Date().timeIntervalSince1970 * 1000) }
    static let available = CommunityCapability.allCases.filter { $0 != .receiveView && $0 != .receiveControl }
    var registrationCode: String? { guard isWaitingForApproval, let preparedDigest else { return nil }; return CommunityEnrollmentCode.formatted(digest: preparedDigest) }
    func resetConfirmation() { actionEpoch &+= 1; confirmation.reset() }
    func confirmRegistration(digest: String, confirmed: Bool) {
        guard let review, review.digest == digest else { confirmation.reset(); return }
        confirmation.setConfirmed(confirmed, for: review)
    }
    func selectAll() { resetConfirmation(); capabilities = Self.available }
    func set(_ capability: CommunityCapability, selected: Bool) {
        guard Self.available.contains(capability) else { return }
        resetConfirmation()
        var set = Set(capabilities)
        if selected { set.insert(capability); if capability == .screenControl { set.insert(.screenView) } }
        else { set.remove(capability); if capability == .screenView { set.remove(.screenControl) } }
        capabilities = Self.available.filter(set.contains)
    }
    private func args(_ values: [Any]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func transport(create: Bool) throws -> (MobileUnifiedStore.State, CommunityAccessCoordinator) {
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        var state = try store.read()
        if state == nil, create { let new = MobileUnifiedStore.State(operationBlob: try CommunityAutomaticKey.make()); try store.install(new); state = new }
        guard let state else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        _ = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
        if coordinator == nil { let store = store; coordinator = CommunityAccessCoordinator(authority: authority, pending: state.journal, save: { journal in try store.update { $0.journal = journal } }) }
        return (state, coordinator!)
    }
    private func validate(_ grant: CommunityAuthorization, plan: CommunityAccessPlan) throws {
        guard grant.body.profileId == plan.profileId, grant.body.deviceId == plan.deviceId, grant.body.deviceKind == .mobile,
              grant.body.name == plan.name, grant.body.hostPublicKey == plan.hostKey, grant.body.controlKey == plan.controlKey, grant.body.agentDeviceId == plan.agentDeviceId,
                  grant.body.publicKey == plan.operationKey, grant.body.biometricPublicKey == plan.biometricKey,
              grant.body.capabilities == plan.capabilities else { throw ScreenCommunityError.wrongCommunity }
    }
    private func install(_ reply: CommunityAccessReply, plan: CommunityAccessPlan) throws {
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let grant = try reply.authorization(authority: authority); try validate(grant, plan: plan)
        if let expected = try store.read()?.prepared?.communityId, grant.body.communityId != expected { throw ScreenCommunityError.wrongCommunity }
        try store.update { $0.accepted = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)); $0.prepared = nil }
        if authorization?.body.revision != grant.body.revision { useSession.invalidate(reason: "기기 권한이 갱신되어 사용 세션을 종료했습니다.") }
        try useSession.updateAuthorization(grant)
        authorization = grant; waiting = false; preparedDigest = nil
    }
    private func installPrepared(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, recovered: Bool = false) throws {
        guard reply.kind == "prepared" else { throw ScreenCommunityError.wrongRequest }
        let receipt = try JSONDecoder().decode(MobilePreparedEnrollment.self, from: reply.encodedValue())
        guard UUID(uuidString: receipt.planId)?.uuidString.lowercased() == receipt.planId,
              UUID(uuidString: receipt.communityId)?.uuidString.lowercased() == receipt.communityId,
              receipt.digest == (try plan.digest), (recovered || receipt.expiresAt > Int64(Date().timeIntervalSince1970 * 1000)) else { throw ScreenCommunityError.wrongCommunity }
        try store.update { $0.prepared = receipt }; waiting = true; approvalDeadline = receipt.expiresAt; preparedDigest = receipt.digest
    }
    private func recover(host: any TranscriptSigner, transport: CommunityAccessCoordinator) async throws {
        guard let journal = await transport.snapshot(), let state = try store.read(), let authority = ScreenCommunityAuthority.configured else { return }
        let reply = try await transport.recover(using: host)
        if journal.operation == "prepare", let plan = state.plan { try installPrepared(reply, plan: plan, recovered: true) }
        else if journal.operation == "approve", let plan = state.approving {
            let grant = try reply.authorization(authority: authority, now: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000))
            guard state.approvingCommunity == grant.body.communityId, grant.body.profileId == plan.profileId, grant.body.deviceId == plan.deviceId,
                  grant.body.name == plan.name, grant.body.hostPublicKey == plan.hostKey, grant.body.controlKey == plan.controlKey, grant.body.agentDeviceId == plan.agentDeviceId,
                  grant.body.publicKey == plan.operationKey, grant.body.biometricPublicKey == plan.biometricKey,
                  grant.body.capabilities == plan.capabilities, grant.body.deviceKind == plan.kind else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approvalReceipt = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)) }
        } else { throw ScreenCommunityError.wrongRequest }
        try await transport.acknowledge(journal.id); try store.update { $0.approving = nil; $0.approvingCommunity = nil }
    }
    func request(account: MobileCommunityAccount) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
            let (_, transport) = try transport(create: true)
            let host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
            try await recover(host: host, transport: transport)
            if let pending = try store.read()?.prepared, pending.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) {
                try await refresh(account: account); return
            }
            let state = try store.read()!, operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
            let biometric = try SecureEnclaveTranscriptSigner(dataRepresentation: account.viewerBlob)
            let proposedName = UIDevice.current.name, name = RegistrationInvite.isShowableName(proposedName) ? proposedName : "iPhone·iPad"
            let plan = try CommunityAccessPlan(profileId: authority.profileID, deviceId: account.deviceID, name: name, kind: .mobile,
                hostKey: host.publicKey.x963Representation, biometricKey: biometric.publicKey.x963Representation, operationKey: operation.publicKey.x963Representation, capabilities: capabilities)
            try store.update { $0.plan = plan; $0.prepared = nil }; hasEnrollmentPlan = true
            let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
            let reply = try await transport.request(.prepare, actor: nil, argumentsJSON: args([object]), signer: host, mutation: true)
            try installPrepared(reply, plan: plan); try await transport.acknowledge(reply.requestId)
            message = "선택한 기능을 한 번에 등록 요청했습니다. 기존 관리 기기에서 승인해 주세요."
        } catch { message = MobileScreenCommunity.describe(error) }
    }
    func refresh(account: MobileCommunityAccount, legacy: ScreenCommunityCertificate? = nil) async throws {
        let epoch = generation
        boundAccount = account
        if let legacy { fallbackCertificate = legacy }
        guard try store.read() != nil else { return }
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let (saved, transport) = try transport(create: false), host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
        try await recover(host: host, transport: transport)
        guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        let state = try store.read() ?? saved
        guard let plan = state.plan, plan.deviceId == account.deviceID, plan.hostKey == ScreenCommunityRequest.base64(host.publicKey.x963Representation) else { throw ScreenCommunityError.wrongCommunity }
        if let prepared = state.prepared {
            guard prepared.digest == (try plan.digest) else { throw ScreenCommunityError.wrongCommunity }
            waiting = true; approvalDeadline = prepared.expiresAt; preparedDigest = prepared.digest
            message = isWaitingForApproval ? "관리 기기에서 선택한 기능의 등록 승인을 기다리는 중입니다." : "이전 등록 요청을 확인하는 중입니다."
            do {
                let reply = try await transport.request(.status, actor: nil, argumentsJSON: args([prepared.planId]), signer: host)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                if reply.kind == "authorization" { try install(reply, plan: plan) } else { try installPrepared(reply, plan: plan) }
            } catch ScreenCommunityError.service("REQUEST_EXPIRED") {
                guard let legacy = fallbackCertificate, legacy.communityID == prepared.communityId else { throw ScreenCommunityError.service("REQUEST_EXPIRED") }
                let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
                let reply = try await transport.request(.authorization, actor: legacy.member.enrollmentID,
                    argumentsJSON: args([legacy.communityID]), signer: operation)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                let recovered = try reply.authorization(authority: authority)
                guard recovered.body.enrollmentId == legacy.member.enrollmentID else { throw ScreenCommunityError.wrongCommunity }
                try install(reply, plan: plan)
            }
        } else if let saved = state.accepted {
            let previous = try CommunityAccessReply.verify(saved.envelope, authority: authority, now: saved.checkedAt).authorization(authority: authority, now: saved.checkedAt)
            try validate(previous, plan: plan)
            let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
            let reply = try await transport.request(.authorization, actor: previous.body.enrollmentId, argumentsJSON: args([previous.body.communityId]), signer: operation)
            guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
            try install(reply, plan: plan)
        }
        if authorization != nil { message = "공통 기기 등록 완료 · 실제 기능·연결 준비 상태는 별도 확인" }
    }
    func refreshScreenTargets() async throws {
        guard let account = boundAccount, let authority = ScreenCommunityAuthority.configured,
              let own = authorization, own.isCurrent(), useSession.isUsable else { screenTargets = []; return }
        let use = try await useSession.currentSession(for: .screenView)
        let signer = try useSession.signer(for: .screenView)
        let request = try CommunityAccessRequest(operation: .directory, actor: own.body.enrollmentId,
            argumentsJSON: args([own.body.communityId, use.body.sessionId]))
        let reply = try await CommunityAccessHTTP(authority: authority).send(request.signed(by: signer), requestId: request.id)
        guard useSession.isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let peers = try reply.directory(authority: authority, communityId: own.body.communityId)
        let biometric = try SecureEnclaveTranscriptSigner(dataRepresentation: account.viewerBlob)
        guard ScreenCommunityRequest.base64(biometric.publicKey.x963Representation) == own.body.biometricPublicKey else { throw ScreenCommunityError.wrongCommunity }
        screenTargets = try peers.filter { $0.body.deviceKind == .desktop && $0.body.enrollmentId != own.body.enrollmentId && $0.body.capabilities.contains(.receiveView) }.map { peer in
            let host = try P256.Signing.PublicKey(x963Representation: ScreenCommunityRequest.decodeBase64(peer.body.hostPublicKey, max: 87))
            let fingerprint = ScreenControlIdentity.fingerprint(of: host)
            var mac = SavedScreenMac(id: fingerprint.map { String(format: "%02x", $0) }.joined(), macName: peer.body.name,
                macPublicKey: host.x963Representation, hostName: ScreenNearby.screenService(fingerprint: fingerprint), address: "", port: ScreenPrivateNetworkRoute.port,
                deviceKey: account.viewerBlob, deviceName: UIDevice.current.name, registeredAt: Date(timeIntervalSince1970: Double(peer.body.issuedAt) / 1000))
            mac.communityID = peer.body.communityId
            return MobileCommunityScreenTarget(peer: peer, mac: mac)
        }
    }
    func screenTarget(deviceID: String) async throws -> MobileCommunityScreenTarget {
        try await refreshScreenTargets()
        guard let target = screenTargets.first(where: { $0.peer.body.deviceId == deviceID }), target.peer.isCurrent() else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return target
    }
    func refreshPending(account: MobileCommunityAccount, certificate: ScreenCommunityCertificate) async throws {
        guard certificate.member.admin, let authority = ScreenCommunityAuthority.configured else { return }
        let host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
        let transport = CommunityAccessCoordinator(authority: authority, pending: nil, save: { _ in throw ScreenCommunityError.malformed })
        let reply = try await transport.request(.list, actor: certificate.member.enrollmentID, argumentsJSON: args([certificate.communityID]), signer: host)
        guard reply.kind == "pending-list" else { throw ScreenCommunityError.wrongRequest }
        let rows = try JSONDecoder().decode([MobilePendingEnrollment].self, from: reply.encodedValue())
        guard rows.count <= 32, Set(rows.map(\.planId)).count == rows.count, rows.allSatisfy({ UUID(uuidString: $0.planId)?.uuidString.lowercased() == $0.planId && RegistrationInvite.isShowableName($0.name) && $0.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) }) else { throw ScreenCommunityError.malformed }
        pending = rows.map { ($0.planId, $0.name) }
    }
    func loadReview(_ id: String, account: MobileCommunityAccount, certificate: ScreenCommunityCertificate) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        resetConfirmation()
        do {
            guard let authority = ScreenCommunityAuthority.configured, certificate.member.admin else { throw ScreenCommunityError.notConfigured }
            let (_, transport) = try transport(create: true), host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
            try await recover(host: host, transport: transport)
            let reply = try await transport.request(.review, actor: certificate.member.enrollmentID, argumentsJSON: args([certificate.communityID, id]), signer: host)
            review = try reply.review(authority: authority, adminId: certificate.member.enrollmentID)
        } catch { message = MobileScreenCommunity.describe(error) }
    }
    func approve(account: MobileCommunityAccount, certificate: ScreenCommunityCertificate, confirmedDigest: String) async {
        guard !busy, let review, confirmedDigest == review.digest, confirmation.isConfirmed(for: review),
              let authority = ScreenCommunityAuthority.configured else { return }; busy = true; defer { busy = false }
        actionEpoch &+= 1; let epoch = actionEpoch
        do {
            let (_, transport) = try transport(create: false)
            guard await transport.snapshot() == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
            guard epoch == actionEpoch, self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review), !Task.isCancelled else { return }
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: account.viewerBlob, reason: "‘\(review.plan.name)’의 선택한 기능을 함께 승인합니다")
            guard epoch == actionEpoch, self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review), !Task.isCancelled else { return }
            guard review.admin == certificate.member.enrollmentID,
                  signer.publicKey.x963Representation == certificate.member.viewerKey else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approving = review.plan; $0.approvingCommunity = certificate.communityID }
            let reply = try await transport.request(.approve, actor: review.admin,
                argumentsJSON: args([certificate.communityID, review.planId, review.digest, review.challenge, review.revision]), signer: signer, mutation: true)
            let grant = try reply.authorization(authority: authority)
            guard grant.body.profileId == review.plan.profileId, grant.body.deviceId == review.plan.deviceId, grant.body.deviceKind == review.plan.kind,
                  grant.body.name == review.plan.name, grant.body.hostPublicKey == review.plan.hostKey, grant.body.controlKey == review.plan.controlKey, grant.body.agentDeviceId == review.plan.agentDeviceId,
                  grant.body.publicKey == review.plan.operationKey, grant.body.biometricPublicKey == review.plan.biometricKey,
                  grant.body.capabilities == review.plan.capabilities, grant.body.communityId == certificate.communityID else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approvalReceipt = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)) }
            try await transport.acknowledge(reply.requestId); try store.update { $0.approving = nil; $0.approvingCommunity = nil }; confirmation.reset(); self.review = nil
            message = "선택한 기능을 한 번에 승인했습니다. 등록 기기에서 준비 상태를 확인하세요."
        } catch { message = MobileScreenCommunity.describe(error) }
    }
    func cancelReview() { resetConfirmation(); review = nil }
    /// Called only from a person's explicit use-start or Mac-row action. Errors, including BIO cancellation, propagate.
    func requireUse(account: MobileCommunityAccount, for capability: CommunityCapability = .screenView) async throws -> (CommunityAuthorization, CommunityUseSession) {
        try await refresh(account: account)
        guard let authorization, let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        if !useSession.isUsable {
            try await useSession.start(authorization: authorization, biometricBlob: account.viewerBlob, capabilities: authorization.body.capabilities, authority: authority)
        }
        try await useSession.waitUntilActive()
        let current = try await useSession.currentSession(for: capability)
        guard let own = self.authorization, own.isCurrent() else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return (own, current)
    }
    func startUse(account: MobileCommunityAccount) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            try await refresh(account: account)
            guard let capability = authorization?.body.capabilities.first else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            _ = try await requireUse(account: account, for: capability)
            if authorization?.body.capabilities.contains(.screenView) == true { try await refreshScreenTargets() }
        } catch { message = MobileScreenCommunity.describe(error) }
    }
    /// Relay renewal cannot start or approve a use session; it fails closed after lock, idle or process loss.
    func screenTicket(connectionID: String) async throws -> CommunityRelayTicket {
        guard useSession.isUsable, let account = boundAccount, let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        try await refresh(account: account)
        let use = try await useSession.currentSession(for: .screenView)
        guard let own = authorization else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        let signer = try useSession.signer(for: .screenView)
        let request = try CommunityAccessRequest(operation: .relayTicket, actor: own.body.enrollmentId,
            argumentsJSON: args([own.body.communityId, "screen", connectionID, "client", use.body.sessionId]))
        let reply = try await CommunityAccessHTTP(authority: authority).send(request.signed(by: signer), requestId: request.id)
        return try reply.relayTicket(for: own, session: use, connectionId: connectionID, purpose: .screen, role: .client)
    }
    /// Lease refresh only. A socket callback can never open or approve a new use episode.
    func liveUse(for capability: CommunityCapability) async throws -> (CommunityAuthorization, CommunityUseSession) {
        guard useSession.isUsable, let account = boundAccount else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        if authorization?.isCurrent(at: Date().addingTimeInterval(10)) != true { try await refresh(account: account) }
        let use = try await useSession.currentSession(for: capability)
        guard let own = authorization, own.isCurrent(), useSession.isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        return (own, use)
    }
    func actionTargets(for purpose: CommunityMobileControlPurpose, refresh: Bool = false) async throws -> [CommunityAuthorization] {
        let (own,use) = try await liveUse(for: purpose.capability)
        if !refresh, let cached = controlPeers[purpose], !cached.peers.isEmpty, cached.sessionID == use.body.sessionId,
           cached.peers.allSatisfy({ $0.isCurrent(at: Date().addingTimeInterval(10)) }) { return cached.peers }
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let signer = try useSession.signer(for: purpose.capability)
        let request = try CommunityAccessRequest(operation: .directory, actor: own.body.enrollmentId,
            argumentsJSON: args([own.body.communityId,use.body.sessionId]))
        let reply = try await CommunityAccessHTTP(authority: authority).send(request.signed(by: signer), requestId: request.id)
        guard useSession.isUsable, useSession.session?.body.sessionId == use.body.sessionId else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let peers = try reply.directory(authority: authority, communityId: own.body.communityId).filter {
            $0.body.deviceKind == .desktop && $0.body.enrollmentId != own.body.enrollmentId && $0.body.controlKey != nil && $0.body.capabilities.contains(purpose.capability)
        }
        controlPeers[purpose] = (use.body.sessionId,peers); return peers
    }
    func actionContext(for purpose: CommunityMobileControlPurpose, target: String) async throws -> CommunityMobileControlContext {
        let peers = try await actionTargets(for: purpose), (own,use) = try await liveUse(for: purpose.capability)
        guard let authority = ScreenCommunityAuthority.configured, let peer = peers.first(where: { $0.body.deviceId == target }) else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return try CommunityMobileControlContext(authority: authority,mobile: own,session: use,receiver: peer,purpose: purpose)
    }
    func actionTicket(for purpose: CommunityMobileControlPurpose, connectionID: String) async throws -> CommunityRelayTicket {
        let (own,use) = try await liveUse(for: purpose.capability)
        guard let authority = ScreenCommunityAuthority.configured, let relayPurpose = CommunityRelayPurpose(rawValue: purpose.rawValue) else { throw ScreenCommunityError.notConfigured }
        let signer = try useSession.signer(for: purpose.capability)
        let request = try CommunityAccessRequest(operation: .relayTicket, actor: own.body.enrollmentId,
            argumentsJSON: args([own.body.communityId,purpose.rawValue,connectionID,"client",use.body.sessionId]))
        let reply = try await CommunityAccessHTTP(authority: authority).send(request.signed(by: signer),requestId: request.id)
        guard useSession.isUsable else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        return try reply.relayTicket(for: own,session: use,connectionId: connectionID,purpose: relayPurpose,role: .client)
    }
    func endLocally() { generation &+= 1; controlPeers = [:]; fallbackCertificate = nil; approvalDeadline = nil; preparedDigest = nil; screenTargets = []; authorization = nil; pending = []; resetConfirmation(); review = nil; waiting = false; useSession.invalidate() }
    func status(_ capability: CommunityCapability) -> String {
        guard authorization?.isCurrent() == true, authorization?.body.capabilities.contains(capability) == true else { return isWaitingForApproval ? "관리 기기 승인 대기" : "등록 필요" }
        return capability == .screenView || capability == .screenControl ? "등록됨 · Screen 연결 준비 필요" : "등록됨 · 커뮤니티 기능에서 현재 Mac의 허용·연결 확인"
    }
}

struct ScreenUnifiedEnrollmentView: View {
    @State private var center = MobileScreenCommunity.shared
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(center.unified.message).font(.subheadline).foregroundStyle(.secondary)
                    Text("등록은 한 번, 모바일 사용 시작은 생체 인증 한 번입니다. OS 권한과 상대 Mac의 수신 허용은 따로 확인합니다.").font(.caption)
                }
                if let review = center.unified.review {
                    Section("\(review.plan.name) · 선택한 기능 검토") {
                        ForEach(review.plan.capabilities, id: \.rawValue) { Text($0.title) }
                        Text("등록 코드 \(CommunityEnrollmentCode.formatted(digest: review.digest) ?? "확인 불가")").font(.body.monospaced())
                        Text("새 관리자 추가나 OS 권한 자동 승인은 포함되지 않습니다.").font(.caption)
                        Toggle("상대 기기의 등록 코드와 같음을 확인했습니다", isOn: Binding(get: { center.unified.confirmation.isConfirmed(for: review) }, set: { center.unified.confirmRegistration(digest: review.digest, confirmed: $0) })).disabled(center.unified.busy)
                        Button("한 번 인증하고 선택한 기능 승인") { Task { await center.approveUnified(confirmedDigest: review.digest) } }.disabled(center.unified.busy || !center.unified.confirmation.isConfirmed(for: review))
                        Button("목록으로") { center.unified.cancelReview() }
                    }
                } else {
                    if let code = center.unified.registrationCode {
                        Section("이 기기의 등록 코드") {
                            Text(code).font(.title2.monospaced())
                            Text("관리 기기에 표시된 코드가 같은지 비교한 뒤 승인하세요. 이름만으로 승인하지 마세요.").font(.caption)
                        }
                    }
                    Section("이 기기에서 사용할 기능") {
                        Button("전체 선택") { center.unified.selectAll() }.disabled(center.unified.busy)
                        ForEach(MobileUnifiedEnrollment.available, id: \.rawValue) { capability in
                            Toggle(isOn: Binding(get: { center.unified.capabilities.contains(capability) }, set: { center.unified.set(capability, selected: $0) })) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(capability.title)
                                    Text(center.unified.status(capability)).font(.caption).foregroundStyle(.secondary)
                                }
                            }.disabled(center.unified.busy)
                        }
                        Button("선택한 기능 한 번에 등록 요청") { Task { await center.requestUnified() } }
                            .disabled(center.unified.busy || center.unified.capabilities.isEmpty)
                    }
                    if !center.unified.pending.isEmpty {
                        Section("등록 요청") {
                            ForEach(center.unified.pending, id: \.id) { item in
                                Button("\(item.name) · 선택 기능 검토") { Task { await center.loadUnifiedReview(item.id) } }.disabled(center.unified.busy)
                            }
                        }
                    }
                    if center.unified.authorization != nil {
                        Section("공통 사용 세션") {
                            Text(center.unified.useSession.message).font(.subheadline)
                            if center.unified.useSession.isUsable {
                                Button("사용 잠그기") { Task { await center.unified.useSession.close() } }
                            } else {
                                Button("한 번 인증하고 사용 시작") { Task { await center.startUnifiedUse() } }.disabled(center.unified.busy)
                            }
                        }
                    }
                }
                Button("등록 상태 새로 고침") { Task { await center.refreshUnified() } }.disabled(center.unified.busy)
            }.navigationTitle("커뮤니티 간편 등록")
                .toolbar { Button("닫기") { center.unified.cancelReview(); dismiss() } }
                .task { await center.refreshUnified() }
                .onDisappear { center.unified.cancelReview() }
        }
    }
}
