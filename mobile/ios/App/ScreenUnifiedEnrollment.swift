import CryptoKit
import Foundation
import Observation
import ScreenControlCore
import Security
import SwiftUI
import UIKit

struct MobileSafetyPending:Codable,Identifiable {
    let commandId:String,receiverEnrollmentId:String,receiver:ScreenCommunityEnvelope,receiverCheckedAt:Date,activationId:String,action:String,submittedAt:Date
    var id:String { commandId }
}

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
        var safetyRequests:[MobileSafetyPending]?
        var safetySubscriptionJournal:CommunitySafetySubscriptionJournal?
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
    private(set) var pendingStatus = "등록 요청을 아직 조회하지 않았습니다."
    private(set) var managementChoice = CommunityManagementChoice.unchanged
    private(set) var registrationExpired = false
    private(set) var safetyMessage="공통 알림·원격 중지 준비 전"
    private(set) var safetyStates:[String:CommunitySafetyRemoteState]=[:]
    private(set) var safetyTargets:[CommunityAuthorization]=[]
    private(set) var safetyPending:[MobileSafetyPending]=[]
    private(set) var safetyNotificationsDenied=false
    private var safetyBusy=false
    var registrationExpiresAt: Int64? { approvalDeadline }
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
        safetyPending=(try? store.read()?.safetyRequests) ?? []
        useSession.authorizationProvider = { [weak self] in
            guard let self, let account = self.boundAccount else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            try await self.refresh(account: account)
            guard let authorization = self.authorization else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            return authorization
        }
    }
    var isWaitingForApproval: Bool { waiting && (approvalDeadline ?? 0) > Int64(Date().timeIntervalSince1970 * 1000) }
    static let available = CommunityCapability.allCases.filter { $0 != .receiveView && $0 != .receiveControl && $0 != .desktopTrust && $0 != .ownerDelegation }
    var pendingRegistrationPresentation: CommunityPendingRegistrationPresentation? {
        CommunityPendingRegistrationPresentation(digest: preparedDigest, expiresAt: approvalDeadline, waiting: waiting)
    }
    var registrationCode: String? { pendingRegistrationPresentation?.code }
    func pendingRegistrationOnly() { pending = []; pendingStatus = "관리 기기 승인 대기 · 이 기기는 등록 승인 역할이 없습니다." }
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
        authorization = grant; waiting = false; preparedDigest = nil; approvalDeadline = nil; registrationExpired = false
    }
    private func installPrepared(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, recovered: Bool = false) throws {
        guard reply.kind == "prepared" else { throw ScreenCommunityError.wrongRequest }
        let receipt = try JSONDecoder().decode(MobilePreparedEnrollment.self, from: reply.encodedValue())
        guard UUID(uuidString: receipt.planId)?.uuidString.lowercased() == receipt.planId,
              UUID(uuidString: receipt.communityId)?.uuidString.lowercased() == receipt.communityId,
              receipt.digest == (try plan.digest), (recovered || receipt.expiresAt > Int64(Date().timeIntervalSince1970 * 1000)) else { throw ScreenCommunityError.wrongCommunity }
        try store.update { $0.prepared = receipt }; waiting = true; registrationExpired = false; approvalDeadline = receipt.expiresAt; preparedDigest = receipt.digest
    }
    private func recover(host: any TranscriptSigner, transport: CommunityAccessCoordinator) async throws {
        guard let journal = await transport.snapshot(), let state = try store.read(), let authority = ScreenCommunityAuthority.configured else { return }
        let reply: CommunityAccessReply
        do { reply = try await transport.recover(using: host) }
        catch {
            guard journal.operation == "prepare", let plan = state.plan,
                  (error as? ScreenCommunityError) == ScreenCommunityError.expired || (error as? ScreenCommunityError) == ScreenCommunityError.service("RECEIPT_NOT_FOUND") else { throw error }
            try await lookupRegistration(plan: plan, host: host, transport: transport, original: journal); return
        }
        if journal.operation == "prepare", let plan = state.plan { try installPrepared(reply, plan: plan, recovered: true) }
        else if ["approve", "approve-management"].contains(journal.operation), let plan = state.approving {
            let grant = try reply.authorization(authority: authority, now: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000))
            guard state.approvingCommunity == grant.body.communityId, grant.body.profileId == plan.profileId, grant.body.deviceId == plan.deviceId,
                  grant.body.name == plan.name, grant.body.hostPublicKey == plan.hostKey, grant.body.controlKey == plan.controlKey, grant.body.agentDeviceId == plan.agentDeviceId,
                  grant.body.publicKey == plan.operationKey, grant.body.biometricPublicKey == plan.biometricKey,
                  grant.body.capabilities == plan.capabilities, grant.body.deviceKind == plan.kind else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approvalReceipt = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)) }
        } else { throw ScreenCommunityError.wrongRequest }
        try await transport.acknowledge(journal.id); try store.update { $0.approving = nil; $0.approvingCommunity = nil }
    }
    private func lookupRegistration(plan: CommunityAccessPlan, host: any TranscriptSigner, transport: CommunityAccessCoordinator, original: CommunityAccessJournal? = nil) async throws {
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        var values: [Any] = [object]
        if let original { values.append(try JSONSerialization.jsonObject(with: JSONEncoder().encode(original.envelope))) }
        let reply = try await transport.request(.recoverRegistration, actor: nil, argumentsJSON: args(values), signer: host)
        switch try CommunityRegistrationLookup.verify(reply, authority: authority, plan: plan, communityId: try store.read()?.prepared?.communityId) {
        case .registered:
            try install(reply, plan: plan)
            if let original { try await transport.acknowledge(original.id) }
        case .pending:
            try installPrepared(reply, plan: plan)
            if let original { try await transport.acknowledge(original.id) }
        case .absent(let proof):
            if original != nil { try await transport.resolveExpiredPrepare(using: proof) }
            try store.update { $0.prepared = nil }; waiting = false; preparedDigest = nil; approvalDeadline = nil; registrationExpired = true
            message = "기존 요청이 없거나 만료되었음을 확인했습니다. 같은 기기 키로 다시 등록 요청할 수 있습니다."
        }
    }
    func request(account: MobileCommunityAccount) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
            let (_, transport) = try transport(create: true)
            let host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
            try await recover(host: host, transport: transport)
            let existing = try store.read()
            if existing?.prepared != nil || (existing?.plan != nil && existing?.accepted == nil) {
                try await refresh(account: account)
                if authorization != nil || waiting || !registrationExpired { return }
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
        do { try await refreshStored(account: account, legacy: legacy) }
        catch {
            message = (error as? ScreenCommunityError) == .service("REQUEST_STILL_POSSIBLE") ? "이전 요청이 아직 도착할 수 있어 결과를 확인 중입니다. 새 요청은 보내지 않습니다." : "등록 상태 조회 실패 · 기존 요청을 보존했습니다. 인터넷 연결을 확인하고 다시 조회하세요."
            throw error
        }
    }
    private func refreshStored(account: MobileCommunityAccount, legacy: ScreenCommunityCertificate?) async throws {
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
            waiting = prepared.expiresAt > Int64(Date().timeIntervalSince1970 * 1000); approvalDeadline = prepared.expiresAt; preparedDigest = waiting ? prepared.digest : nil
            message = isWaitingForApproval ? "관리 기기에서 선택한 기능의 등록 승인을 기다리는 중입니다." : "이전 등록 요청을 확인하는 중입니다."
            do {
                let reply = try await transport.request(.status, actor: nil, argumentsJSON: args([prepared.planId]), signer: host)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                if reply.kind == "authorization" { try install(reply, plan: plan) } else { try installPrepared(reply, plan: plan) }
            } catch ScreenCommunityError.service("REQUEST_EXPIRED") {
                try await lookupRegistration(plan: plan, host: host, transport: transport)
            }
        } else if let saved = state.accepted {
            let previous = try CommunityAccessReply.verify(saved.envelope, authority: authority, now: saved.checkedAt).authorization(authority: authority, now: saved.checkedAt)
            try validate(previous, plan: plan)
            let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
            let reply = try await transport.request(.authorization, actor: previous.body.enrollmentId, argumentsJSON: args([previous.body.communityId]), signer: operation)
            guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
            try install(reply, plan: plan)
        } else { try await lookupRegistration(plan: plan, host: host, transport: transport) }
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
        guard certificate.member.admin, let authority = ScreenCommunityAuthority.configured else { pending = []; pendingStatus = "이 기기는 등록 승인 역할이 없습니다."; validateReviewContext(certificate: certificate); return }
        let host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
        let transport = CommunityAccessCoordinator(authority: authority, pending: nil, save: { _ in throw ScreenCommunityError.malformed })
        let reply = try await transport.request(.list, actor: certificate.member.enrollmentID, argumentsJSON: args([certificate.communityID]), signer: host)
        guard reply.kind == "pending-list" else { throw ScreenCommunityError.wrongRequest }
        let rows = try JSONDecoder().decode([MobilePendingEnrollment].self, from: reply.encodedValue())
        guard rows.count <= 32, Set(rows.map(\.planId)).count == rows.count, rows.allSatisfy({ UUID(uuidString: $0.planId)?.uuidString.lowercased() == $0.planId && CommunityAccessName.isValid($0.name) && $0.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) }) else { throw ScreenCommunityError.malformed }
        pending = rows.map { ($0.planId, $0.name) }; pendingStatus = rows.isEmpty ? "현재 승인할 기능 등록 요청이 없습니다." : "기능 등록 요청 \(rows.count)건"
    }
    func loadReview(_ id: String, account: MobileCommunityAccount, certificate: ScreenCommunityCertificate, choice: CommunityManagementChoice = .unchanged, notice: CommunityAccessNotice? = nil) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        validateReviewContext(certificate: certificate)
        cancelReview(); managementChoice = choice; let epoch = actionEpoch
        do {
            guard let authority = ScreenCommunityAuthority.configured, certificate.member.admin else { throw ScreenCommunityError.notConfigured }
            let (_, transport) = try transport(create: true), host = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
            try await recover(host: host, transport: transport)
            let operation: CommunityAccessRequest.Operation = choice == .unchanged ? .review : .reviewManagement
            let values: [Any] = [certificate.communityID, id] + (choice.administrator.map { [$0] } ?? [])
            let reply = try await transport.request(operation, actor: certificate.member.enrollmentID, argumentsJSON: args(values), signer: host)
            let checked = try choice == .unchanged ? reply.review(authority: authority, adminId: certificate.member.enrollmentID) : reply.managementReview(authority: authority, administrator: certificate)
            if let notice { try notice.validate(review: checked, communityId: certificate.communityID) }
            guard epoch == actionEpoch, managementChoice == choice else { throw ScreenCommunityError.service("REVIEW_CONTEXT_CHANGED") }
            review = checked
        } catch { message = MobileScreenCommunity.describe(error) }
    }
    func approve(account: MobileCommunityAccount, certificate: ScreenCommunityCertificate, confirmedDigest: String) async {
        guard !busy, certificate.member.admin, let review, review.hasValidManagementBinding, confirmedDigest == review.digest, confirmation.isConfirmed(for: review),
              let authority = ScreenCommunityAuthority.configured else { return }; busy = true; defer { busy = false }
        actionEpoch &+= 1; let epoch = actionEpoch
        do {
            let (_, transport) = try transport(create: false)
            guard await transport.snapshot() == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
            guard epoch == actionEpoch, self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review), !Task.isCancelled else { return }
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: account.viewerBlob, reason: "‘\(review.plan.name)’의 선택 기능과 \(managementChoice.title)을 함께 확인합니다")
            guard epoch == actionEpoch, self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review), !Task.isCancelled else { return }
            guard review.admin == certificate.member.enrollmentID,
                  signer.publicKey.x963Representation == certificate.member.viewerKey else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approving = review.plan; $0.approvingCommunity = certificate.communityID }
            let reply = try await transport.request(review.approvalOperation, actor: review.admin,
                argumentsJSON: review.approvalArguments(communityId: certificate.communityID), signer: signer, mutation: true)
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
    func pendingUnavailable() { pending = []; pendingStatus = "등록 요청 조회 실패 · 새로 고침으로 다시 확인하세요." }
    func cancelReview() { resetConfirmation(); review = nil; managementChoice = .unchanged }
    private var administratorContext: String?
    private var administratorRevision: Int64?
    func validateReviewContext(certificate: ScreenCommunityCertificate?, revision: Int64? = nil) {
        let context = certificate.map { "\($0.communityID):\($0.member.enrollmentID):\($0.member.keyEpoch):\($0.member.admin):\(ScreenCommunityRequest.base64($0.member.hostKey)):\(ScreenCommunityRequest.base64($0.member.viewerKey))" }
        if administratorContext != context || (revision != nil && administratorRevision != nil && administratorRevision != revision) {
            cancelReview()
        }
        administratorContext = context
        if let revision { administratorRevision = revision }
        guard let review else { return }
        guard let certificate, certificate.member.admin, review.admin == certificate.member.enrollmentID,
              review.management == nil || review.management?.communityId == certificate.communityID,
              revision == nil || revision == review.revision,
              review.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { cancelReview(); return }
    }
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
    func endLocally() { generation &+= 1; controlPeers = [:]; fallbackCertificate = nil; approvalDeadline = nil; preparedDigest = nil; screenTargets = []; authorization = nil; pending = []; safetyStates=[:];safetyTargets=[];safetyPending=[];resetConfirmation(); review = nil; waiting = false; useSession.invalidate() }
    var isSafetyBusy:Bool { safetyBusy }
    /// Only explicit UI actions call this helper; normal poll/notification callbacks cannot start a use episode.
    private func safetyHumanUse(account:MobileCommunityAccount) async throws -> (CommunityAuthorization,CommunityUseSession) {
        let existing=useSession.isUsable,at=Date(),tick=ContinuousClock.now
        _ = try await requireUse(account:account,for:.screenView)
        if existing { try await useSession.recordHumanActivity(.action,observedAt:at,observedTick:tick) }
        return try await liveUse(for:.screenView)
    }
    func refreshSafety(account:MobileCommunityAccount) async {
        guard !safetyBusy else { return };safetyBusy=true;defer { safetyBusy=false }
        do {
            guard let authority=ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
            _ = try await safetyHumanUse(account:account)
            try await refreshScreenTargets();safetyTargets=screenTargets.map(\.peer);safetyStates=[:]
            for target in safetyTargets.prefix(32) {
                let (own,use)=try await liveUse(for:.screenView)
                let proof=try CommunitySafetyMobileRequest.state(authorization:own,session:use,receiverEnrollmentId:target.body.enrollmentId)
                let signature=try await useSession.signSafety(proof)
                let reply=try await CommunityAccessHTTP(authority:authority).send(proof.envelope(signature:signature),requestId:proof.request.id)
                guard useSession.isUsable else { throw ScreenCommunityError.expired }
                safetyStates[target.body.enrollmentId]=try CommunitySafetyRemoteState.verify(reply.envelope,authority:authority,requestId:proof.request.id,expectedReceiver:target)
            }
            safetyMessage="현재 공통 화면 상태를 확인했습니다. 알림의 실제 수신을 보증하는 표시는 아닙니다."
        } catch { safetyStates=[:];safetyMessage="등록 유지 · 공통 원격 중지 상태를 확인하지 못했습니다. " + MobileScreenCommunity.describe(error) }
    }
    func stopSafety(account:MobileCommunityAccount,target:CommunityAuthorization,action:CommunitySafetyAction,targetEnrollmentId:String?=nil) async {
        guard !safetyBusy else { return };safetyBusy=true;defer { safetyBusy=false }
        do {
            guard let authority=ScreenCommunityAuthority.configured,let remote=safetyStates[target.body.enrollmentId],let activation=remote.activationId,
                  remote.expiresAt>Int64(Date().timeIntervalSince1970*1000) else { throw ScreenCommunityError.expired }
            let (own,use)=try await safetyHumanUse(account:account)
            let command=try CommunitySafetyCommandBody(action:action,targetEnrollmentId:targetEnrollmentId,expectedSessionId:action == .end ? remote.state?.session?.channelId : nil)
            let proof=try CommunitySafetyMobileRequest.stop(authorization:own,session:use,receiverEnrollmentId:target.body.enrollmentId,activationId:activation,command:command)
            let record=MobileSafetyPending(commandId:proof.request.id,receiverEnrollmentId:target.body.enrollmentId,receiver:target.envelope,receiverCheckedAt:Date(),activationId:activation,action:action.rawValue,submittedAt:Date())
            try store.update { state in
                var records=state.safetyRequests ?? [];guard records.count<32 else { throw ScreenCommunityError.service("SAFETY_RECEIPT_LIMIT") };records.append(record);state.safetyRequests=records
            }
            safetyPending=try store.read()?.safetyRequests ?? []
            let signature=try await useSession.signSafety(proof)
            let reply=try await CommunityAccessHTTP(authority:authority).send(proof.envelope(signature:signature),requestId:proof.request.id)
            let receipt=try CommunitySafetyReceipt.verify(reply.envelope,authority:authority,requestId:proof.request.id,commandId:proof.request.id,receiver:target,activationId:activation)
            showSafetyReceipt(receipt)
        } catch { safetyMessage="실행 결과를 확정하지 못했습니다. 새로 보내지 말고 원래 요청의 결과만 확인하세요. " + MobileScreenCommunity.describe(error) }
    }
    private func storedSafetyReceiver(_ record:MobileSafetyPending,authority:ScreenCommunityAuthority,communityId:String) throws -> CommunityAuthorization {
        let reply=try CommunityAccessReply.verify(record.receiver,authority:authority,now:record.receiverCheckedAt)
        if reply.kind=="authorization" { return try reply.authorization(authority:authority,now:record.receiverCheckedAt) }
        let directory=try reply.directory(authority:authority,communityId:communityId,now:record.receiverCheckedAt)
        // The pending record stores the signed directory. Its receiver is the exact immutable command target.
        guard let target=directory.first(where:{$0.body.enrollmentId==record.receiverEnrollmentId}) else { throw ScreenCommunityError.service("SAFETY_TARGET_UNAVAILABLE") }
        return target
    }
    func readSafetyResult(account:MobileCommunityAccount,record:MobileSafetyPending) async {
        guard !safetyBusy else { return };safetyBusy=true;defer { safetyBusy=false }
        do {
            guard let authority=ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
            let (own,use)=try await safetyHumanUse(account:account)
            let receiver=try storedSafetyReceiver(record,authority:authority,communityId:own.body.communityId)
            let proof=try CommunitySafetyMobileRequest.result(authorization:own,session:use,commandId:record.commandId),signature=try await useSession.signSafety(proof)
            let reply=try await CommunityAccessHTTP(authority:authority).send(proof.envelope(signature:signature),requestId:proof.request.id)
            let receipt=try CommunitySafetyReceipt.verify(reply.envelope,authority:authority,requestId:proof.request.id,commandId:record.commandId,receiver:receiver,activationId:record.activationId)
            showSafetyReceipt(receipt)
            if [.result,.expired,.refused].contains(receipt.state) { try store.update { $0.safetyRequests=($0.safetyRequests ?? []).filter{$0.commandId != record.commandId} };safetyPending=try store.read()?.safetyRequests ?? [] }
        } catch { safetyMessage="원래 요청 결과를 확인하지 못했습니다. 재실행하지 않았습니다. " + MobileScreenCommunity.describe(error) }
    }
    private func showSafetyReceipt(_ receipt:CommunitySafetyReceipt) {
        switch receipt.state {
        case .result: safetyMessage="Mac 서명으로 확인한 결과: \(receipt.result?.outcome.rawValue ?? "확인 불가")"
        case .queued: safetyMessage="원격 중지 요청 접수 · Mac의 서명 결과를 기다립니다."
        case .unseen: safetyMessage="원래 요청의 접수를 확인하지 못했습니다. 실행하지 않았다고 단정하거나 자동 재전송하지 않습니다."
        case .expired: safetyMessage="원래 요청이 만료되었습니다. 자동 재실행하지 않습니다."
        case .refused: safetyMessage="원래 요청이 거절되었습니다. 자동 재실행하지 않습니다."
        }
    }
    /// No status refresh requests OS permission or biometrics. A separately observed denial supersedes unknown enables.
    func syncSafetyNotifications(account:MobileCommunityAccount,certificate:ScreenCommunityCertificate?,requestPermission:Bool) async {
        guard UIApplication.shared.applicationState == .active,let own=authorization,own.isCurrent(),let authority=ScreenCommunityAuthority.configured else { return }
        let epoch=generation
        do {
            let administrator=certificate?.member.admin == true
            let observation=try await CommunitySafetyNotificationObservation.read(token:{
                if administrator { return try await ScreenPushCenter.shared.commonSafetyDeviceToken(requestPermission:requestPermission) }
                return nil
            },denied:{ await ScreenPushCenter.shared.commonSafetyPermissionDenied() })
            let token=observation.token,denied=observation.permissionDenied
            guard epoch==generation,UIApplication.shared.applicationState == .active,authorization?.body.enrollmentId==own.body.enrollmentId else { return }
            safetyNotificationsDenied=denied
            let enabled=administrator && token != nil && !denied
            let digest=try CommunityMobileControlPolicy.authorizationDigest(own)
            let hex=token?.map { String(format:"%02x",$0) }.joined()
            let subscription:[String:Any]? = enabled ? ["token":hex!,"environment":ScreenPushConfig.environment == .sandbox ? "sandbox" : "production","topic":ScreenPushConfig.topic] : nil
            let binding=SHA256.hash(data:try args([own.body.communityId,own.body.enrollmentId,digest,own.body.keyEpoch,enabled ? [hex!,ScreenPushConfig.environment == .sandbox ? "sandbox" : "production",ScreenPushConfig.topic] as Any : NSNull()])).map { String(format:"%02x",$0) }.joined()
            guard let saved=try store.read() else { return }
            let journal=saved.safetySubscriptionJournal ?? CommunitySafetySubscriptionJournal()
            let signer=try SecureEnclaveTranscriptSigner(dataRepresentation:saved.operationBlob)
            guard ScreenCommunityRequest.base64(signer.publicKey.x963Representation)==own.body.publicKey else { throw ScreenCommunityError.wrongCommunity }
            let explicitNewNegative=requestPermission && denied
            if journal.desiredBinding != binding || explicitNewNegative {
                // A never-subscribed, unapproved mobile has no watcher to remove and needs no background mutation.
                if !enabled,!explicitNewNegative,journal.desiredBinding==nil,journal.pending.isEmpty {
                    safetyMessage=administrator ? "등록 유지 · 화면 연결·보안·등록 요청 알림은 ‘알림 허용’에서 준비하세요." : "등록됨 · 이 모바일은 등록 승인 역할이 없습니다.";return
                }
                let previous=journal.sequence,sequence=try journal.nextSequence
                let request=try CommunityAccessRequest(operation:.safetySubscribe,actor:own.body.enrollmentId,argumentsJSON:args([own.body.communityId,subscription as Any? ?? NSNull(),["sequence":sequence,"policyDigest":digest,"keyEpoch":own.body.keyEpoch]]))
                try store.update { state in
                    var next=state.safetySubscriptionJournal ?? CommunitySafetySubscriptionJournal()
                    try next.reserve(requestId:request.id,binding:binding,expectedPrevious:previous,isRemoval:!enabled);state.safetySubscriptionJournal=next
                }
                let envelope=try await request.signed(by:signer)
                guard epoch==generation,authorization?.body.enrollmentId==own.body.enrollmentId,try store.read()?.safetySubscriptionJournal?.mayDispatch(request.id)==true else {
                    // No dispatch occurred. A newer observed OS state owns the next request.
                    try store.update { $0.safetySubscriptionJournal?.abandonUnsigned(request.id) };return
                }
                try store.update { state in
                    guard state.safetySubscriptionJournal != nil else { throw ScreenCommunityError.wrongRequest }
                    try state.safetySubscriptionJournal?.recordSigned(envelope,requestId:request.id)
                }
                let reply=try await CommunityAccessHTTP(authority:authority).send(envelope,requestId:request.id)
                let receipt=try CommunitySafetySubscription.verify(reply,authority:authority,own:own,requestId:request.id)
                try receipt.validate(expectedEnabled:enabled,policyDigest:digest,keyEpoch:own.body.keyEpoch,revision:own.body.revision)
                try finishSafetySubscription(sequence:sequence)
                guard epoch==generation else { return }
                if try store.read()?.safetySubscriptionJournal?.sequence==sequence { safetyMessage=enabled ? "공통 알림 구독 등록됨 · 실제 수신과 Mac의 원격 중지 폴링은 별도 확인합니다." : "OS 알림 허용 해제 관찰 · 공통 알림 구독을 제거했습니다." }
            }
            // Unknown mutations are recovered only by their immutable original receipt, never resent under a new ID.
            for pending in try store.read()?.safetySubscriptionJournal?.recoveryCandidates ?? [] {
                guard epoch==generation else { return }
                if pending.envelope==nil {
                    try store.update { state in
                        state.safetySubscriptionJournal?.abandonUnsigned(pending.requestId)
                    };continue // Crash before the signed-envelope write proves no dispatch happened.
                }
                do {
                    guard let original=pending.envelope else { throw ScreenCommunityError.wrongRequest }
                    let recovery=try CommunitySafetySubscriptionRecovery(own:own,original:original)
                    let host=try SecureEnclaveTranscriptSigner(dataRepresentation:account.identityBlob)
                    let reply=try await CommunityAccessHTTP(authority:authority).send(recovery.signed(by:host),requestId:recovery.request.id)
                    let receipt=try CommunitySafetySubscription.recover(reply,authority:authority,own:own,originalRequestId:pending.requestId)
                    try receipt.validate(expectedEnabled:recovery.expectsSubscription)
                    try finishSafetySubscription(sequence:pending.sequence)
                } catch { if epoch==generation,pending.sequence >= (try store.read()?.safetySubscriptionJournal?.confirmedSequence ?? 0) { safetyMessage="등록 유지 · 공통 알림 구독의 원래 요청 결과를 확인하는 중입니다. 새 요청으로 재전송하지 않습니다." } }
            }
        } catch { if epoch==generation {
            if case ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL")=error {
                safetyMessage="공통 알림 구독 제거 미확인 · 미확정 요청의 증거 보존공간이 가득 찼습니다. 원본을 보존했으며 새 요청을 보내지 않았습니다."
            } else { safetyMessage="등록 유지 · 공통 알림 구독 결과를 확인하지 못했습니다. " + MobileScreenCommunity.describe(error) }
        } }
    }
    private func finishSafetySubscription(sequence:Int64) throws {
        // Preserve older unknown evidence even after the issuer tombstones its observation sequence.
        try store.update { $0.safetySubscriptionJournal?.committed(through:sequence) }
    }
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
                if center.unified.review == nil, let code = center.unified.registrationCode {
                    Section("이 기기의 등록 코드") {
                        Text(code).font(.title2.monospaced()).accessibilityIdentifier("screenCommunityRegistrationCode")
                        if let expires = center.unified.registrationExpiresAt {
                            Text("코드 만료: " + Date(timeIntervalSince1970: Double(expires) / 1000).formatted(date: .omitted, time: .standard))
                                .font(.caption).accessibilityIdentifier("screenCommunityRegistrationExpiry")
                        }
                        Text("관리 기기에 표시된 코드가 같은지 비교한 뒤 승인하세요. 이름만으로 승인하지 마세요.").font(.caption)
                    }
                }
                Section("관리 역할·승인 요청") {
                    Text(center.managementStatus)
                    Text(center.unified.pendingStatus).font(.caption).foregroundStyle(.secondary)
                    ForEach(center.unified.pending, id: \.id) { item in
                        Button("\(item.name) · 선택 기능 검토") { Task { await center.loadUnifiedReview(item.id) } }.disabled(center.unified.busy)
                    }
                    Button("등록 상태 새로 고침") { Task { await center.refreshUnified() } }.disabled(center.unified.busy)
                }
                if let review = center.unified.review {
                    Section("\(review.plan.name) · 선택한 기능 검토") {
                        ForEach(review.plan.capabilities, id: \.rawValue) { Text($0.title) }
                        if review.plan.capabilities.contains(.desktopTrust) {
                            Text("등록 Mac의 키와 선택 권한을 지속 신뢰합니다. 그 Mac에서 승인된 프로그램도 선택 범위에서 연결할 수 있으며, 매번 물리 클릭·생체 확인을 증명하는 모드는 아닙니다. 직접 입력 보류와 OS 권한은 유지됩니다.").font(.caption)
                        }
                        if review.plan.capabilities.contains(.ownerDelegation) {Text("이 계획의 같은 생체 승인으로 대상 Mac의 최초 입력 보류 해제 위임만 준비합니다. 이후 실제 해제는 현재 다른 승인 Mac에서 요청별 생체 확인이 필요하며, 대상이 직접 꺼 둔 위임·OS 권한·Screen 켜기는 바꾸지 않습니다.").font(.caption)}
                        Text("등록 코드 \(CommunityEnrollmentCode.formatted(digest: review.digest) ?? "확인 불가")").font(.body.monospaced())
                        Text(review.management.map { $0.administrator ? "이 모바일에 새 기기 등록 승인·해제 역할도 부여합니다. 전체 기능 선택과 별도의 관리 권한입니다." : "이 모바일의 등록 승인 역할과 알림 구독도 해제합니다." } ?? "선택 기능만 승인합니다. 기존 관리 역할을 보존하며 새 관리자는 자동으로 추가하지 않습니다.").font(.caption)
                        if review.plan.kind == .mobile {
                            Text("관리 역할 변경은 선택 사항입니다. 변경하면 새 검토의 코드를 다시 확인합니다. OS 권한은 포함되지 않습니다.").font(.caption)
                            ForEach(CommunityManagementChoice.allCases, id: \.rawValue) { choice in
                                Button((center.unified.managementChoice == choice ? "✓ " : "") + choice.title) { Task { await center.loadUnifiedReview(review.planId, choice: choice) } }.disabled(center.unified.busy)
                            }
                        }
                        Toggle("상대 기기의 등록 코드와 같음을 확인했습니다", isOn: Binding(get: { center.unified.confirmation.isConfirmed(for: review) }, set: { center.unified.confirmRegistration(digest: review.digest, confirmed: $0) })).disabled(center.unified.busy)
                        Button(review.management == nil ? "한 번 인증하고 선택한 기능 승인" : "한 번 인증하고 기능·관리 역할 승인") { Task { await center.approveUnified(confirmedDigest: review.digest) } }.disabled(center.unified.busy || !center.unified.confirmation.isConfirmed(for: review))
                        Button("목록으로") { center.cancelUnifiedReview() }
                    }
                } else {
                    if center.unified.authorization != nil {
                        Section("화면 연결·보안·등록 요청 알림") {
                            Text(center.unified.safetyMessage).font(.caption)
                            Button(center.unified.safetyNotificationsDenied ? "알림 꺼짐 상태 반영" : "공통 알림 허용·상태 반영") { Task { await center.subscribe() } }.disabled(center.unified.busy)
                            NavigationLink("공통 Mac 상태·원격 중지") { ScreenCommunitySafetyView() }
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
                        Button(center.unified.registrationExpired ? "같은 기기 키로 다시 등록 요청" : "선택한 기능 한 번에 등록 요청") { Task { await center.requestUnified() } }
                            .disabled(center.unified.busy || center.unified.capabilities.isEmpty)
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
                .toolbar { Button("닫기") { center.cancelUnifiedReview(); dismiss() } }
                .task { await center.refresh() }
                .onDisappear { center.cancelUnifiedReview() }
        }
    }
}

/// Explicit native owner actions only. Entering the view neither starts a biometric use episode nor a screen session.
struct ScreenCommunitySafetyView:View {
    private let center=MobileScreenCommunity.shared
    @State private var confirming:SafetyChoice?
    private struct SafetyChoice:Identifiable {
        let id=UUID(),target:CommunityAuthorization,action:CommunitySafetyAction,targetEnrollmentId:String?
    }
    var body:some View {
        List {
            Section {
                Text(center.unified.safetyMessage).font(.callout)
                Text("관리 모바일의 공통 사용 인증을 공유합니다. Mac별 추가 생체 인증 없이 중지를 요청하고, 실제 Mac이 서명한 결과를 확인합니다.").font(.caption)
                Button("현재 Mac 상태 확인") { Task { await center.refreshCommonSafety() } }.disabled(center.unified.isSafetyBusy)
            }
            ForEach(center.unified.safetyTargets,id:\.body.enrollmentId) { target in
                Section(target.body.name) {
                    let remote=center.unified.safetyStates[target.body.enrollmentId]
                    let current=remote.map{$0.expiresAt>Int64(Date().timeIntervalSince1970*1000)} ?? false
                    Text(remote?.state == nil ? "현재 상태 미확인 · 오프라인일 수 있습니다." : (remote?.state?.power == .off ? "화면 수신 꺼짐" : "Mac의 최근 수신 상태 확인됨"))
                    if current,remote?.activationId != nil {
                        if remote?.state?.session != nil {
                            Button("지금 화면 연결 끊기") { confirming = .init(target:target,action:.end,targetEnrollmentId:nil) }
                            if let peer=remote?.state?.session?.controllerEnrollmentId {
                                Button("현재 연결 기기의 이 Mac 공통 화면 접근 차단",role:.destructive) { confirming = .init(target:target,action:.revoke,targetEnrollmentId:peer) }
                            }
                        }
                        Button("이 Mac 화면 수신 끄기",role:.destructive) { confirming = .init(target:target,action:.turnOff,targetEnrollmentId:nil) }
                    }
                }.disabled(center.unified.isSafetyBusy || !center.administrator)
            }
            if !center.unified.safetyPending.isEmpty {
                Section("원래 요청 결과 확인") {
                    Text("결과가 미확정인 요청은 다시 실행하지 않습니다. 원래 요청의 서명 결과만 조회합니다.").font(.caption)
                    ForEach(center.unified.safetyPending) { record in
                        Button(record.submittedAt.formatted(date:.omitted,time:.shortened) + " · 결과만 확인") { Task { await center.readCommonSafetyResult(record) } }
                            .disabled(center.unified.isSafetyBusy)
                    }
                }
            }
        }.navigationTitle("공통 원격 중지")
            .alert(item:$confirming) { choice in
                Alert(title:Text(choice.action == .revoke ? "이 기기의 해당 Mac 공통 화면 접근을 차단할까요?" : "선택한 Mac의 화면 연결을 중지할까요?"),message:Text("전역 커뮤니티 등록·Teams·컴퓨터 유즈 권한·관리 역할은 변경하지 않습니다. 수신을 끄면 해당 Mac에서 직접 다시 켜야 합니다."),primaryButton:.destructive(Text("중지 요청")) { Task { await center.stopCommonSafety(choice.target,action:choice.action,targetEnrollmentId:choice.targetEnrollmentId) } },secondaryButton:.cancel())
            }
    }
}
