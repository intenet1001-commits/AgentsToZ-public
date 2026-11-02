#if os(macOS)
import Foundation
import ScreenControlCore

/// Selection is only an intent. It creates neither device authority nor an executable feature.
struct ViewerFeatureSelection: Equatable {
    private(set) var capabilities: [CommunityCapability] = [.screenView, .screenControl]
    mutating func selectAll() { capabilities = CommunityCapability.allCases }
    mutating func set(_ capability: CommunityCapability, selected: Bool) {
        var set = Set(capabilities)
        if selected {
            set.insert(capability)
            if capability == .screenControl { set.insert(.screenView) }
            if capability == .receiveControl { set.insert(.receiveView) }
        } else {
            set.remove(capability)
            if capability == .screenView { set.remove(.screenControl) }
            if capability == .receiveView { set.remove(.receiveControl) }
        }
        capabilities = CommunityCapability.allCases.filter(set.contains)
    }
}

struct ViewerPreparedEnrollment: Codable, Equatable, Sendable {
    let planId: String, communityId: String, digest: String
    let expiresAt: Int64
    func isCurrent(at: Date = Date()) -> Bool { expiresAt > Int64(at.timeIntervalSince1970 * 1000) }
    func validate(plan: CommunityAccessPlan, at: Date, allowExpired: Bool = false) throws {
        guard UUID(uuidString: planId)?.uuidString.lowercased() == planId,
              UUID(uuidString: communityId)?.uuidString.lowercased() == communityId,
              digest == (try plan.digest), (allowExpired || expiresAt > Int64(at.timeIntervalSince1970 * 1000)) else {
            throw ScreenCommunityError.wrongCommunity
        }
    }
}
struct ViewerPendingEnrollment: Decodable, Sendable {
    let planId: String, name: String, kind: CommunityDeviceKind, expiresAt: Int64
}

/// No BIO key replacement. The operation key and unknown-result fence have their own access-grouped item.
final class ViewerUnifiedStore: @unchecked Sendable {
    struct Accepted: Codable, Sendable { let envelope: ScreenCommunityEnvelope; let checkedAt: Date }
    struct State: Codable, Sendable {
        let operationBlob: Data
        var plan: CommunityAccessPlan?
        var prepared: ViewerPreparedEnrollment?
        var accepted: Accepted?
        var approving: CommunityAccessPlan?
        var approvingCommunity: String?
        var approvedReceipt: Accepted?
        var journal: CommunityAccessJournal?
    }
    private let backend: any ViewerTargetsBackend
    private let lock = NSLock()
    init(backend: any ViewerTargetsBackend = KeychainTargets(account: "unified-enrollment-v2")) { self.backend = backend }
    func read() throws -> State? {
        lock.lock(); defer { lock.unlock() }
        return try backend.read().map { try JSONDecoder().decode(State.self, from: $0) }
    }
    @discardableResult func update(_ transform: (inout State) throws -> Void) throws -> State {
        lock.lock(); defer { lock.unlock() }
        guard let bytes = try backend.read() else { throw ScreenCommunityError.service("DEVICE_KEY_MISSING") }
        var state = try JSONDecoder().decode(State.self, from: bytes)
        try transform(&state); try backend.write(JSONEncoder().encode(state)); return state
    }
    func install(_ state: State) throws {
        lock.lock(); defer { lock.unlock() }
        guard try backend.read() == nil else { throw ScreenCommunityError.service("DEVICE_KEY_EXISTS") }
        try backend.write(JSONEncoder().encode(state))
    }
}

@MainActor
final class ViewerUnifiedEnrollment {
    let authority: ScreenCommunityAuthority
    private let store: ViewerUnifiedStore
    private var coordinator: CommunityAccessCoordinator?
    private(set) var authorization: CommunityAuthorization?
    private(set) var hasEnrollmentPlan = false
    private(set) var targets: [ViewerTarget] = []
    private(set) var peerAuthorizations: [String: CommunityAuthorization] = [:]
    var changed: () -> Void = {}
    private var expiry: Task<Void, Never>?
    private var generation = 0
    private(set) var prepared: ViewerPreparedEnrollment?
    private(set) var review: CommunityAccessReview?
    private(set) var confirmation = CommunityEnrollmentConfirmation()
    private(set) var pending: [ViewerPendingEnrollment] = []
    private(set) var selection = ViewerFeatureSelection()
    init(authority: ScreenCommunityAuthority, store: ViewerUnifiedStore = ViewerUnifiedStore()) {
        self.authority = authority; self.store = store
        do { hasEnrollmentPlan = try store.read()?.plan != nil }
        catch { hasEnrollmentPlan = true } // An unreadable common account cannot authorize a weaker community path.
    }
    func set(_ capability: CommunityCapability, selected: Bool) { confirmation.reset(); selection.set(capability, selected: selected) }
    func selectAll() { confirmation.reset(); selection.selectAll() }
    var selected: [CommunityCapability] { selection.capabilities }
    var isWaitingForApproval: Bool { prepared?.isCurrent() ?? false }
    var registrationCode: String? { guard isWaitingForApproval, let prepared else { return nil }; return CommunityEnrollmentCode.formatted(digest: prepared.digest) }
    func resetConfirmation() { confirmation.reset() }
    func confirmRegistration(digest: String, confirmed: Bool) {
        guard let review, review.digest == digest else { confirmation.reset(); return }
        confirmation.setConfirmed(confirmed, for: review)
    }
    func dismissReview() { confirmation.reset(); review = nil }
    var hasPendingMutation: Bool { (try? store.read()?.journal) != nil }

    private func transport(create: Bool) throws -> (ViewerUnifiedStore.State, CommunityAccessCoordinator) {
        var state = try store.read()
        if state == nil, create {
            // Create only when the dedicated account has never existed. A missing/unreadable existing key is an error.
            let blob = try CommunityAutomaticKey.make()
            let initial = ViewerUnifiedStore.State(operationBlob: blob)
            try store.install(initial); state = initial
        }
        guard let state else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        _ = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
        if coordinator == nil {
            let store = store
            coordinator = CommunityAccessCoordinator(authority: authority, pending: state.journal, save: { journal in
                try store.update { $0.journal = journal }
            })
        }
        return (state, coordinator!)
    }
    private func args(_ values: [Any]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func checked(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, expectedEnrollment: String? = nil, recovered: Bool = false) throws -> CommunityAuthorization {
        let grant = try reply.authorization(authority: authority, now: recovered ? Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000) : Date())
        try Self.validate(grant, plan: plan, expectedEnrollment: expectedEnrollment)
        return grant
    }
    static func validate(_ grant: CommunityAuthorization, plan: CommunityAccessPlan, expectedEnrollment: String? = nil) throws {
        let value = grant.body
        guard value.profileId == plan.profileId, value.deviceId == plan.deviceId, value.deviceKind == plan.kind,
              value.name == plan.name, value.hostPublicKey == plan.hostKey, value.controlKey == plan.controlKey, value.agentDeviceId == plan.agentDeviceId,
              value.publicKey == plan.operationKey, value.biometricPublicKey == plan.biometricKey,
              value.capabilities == plan.capabilities,
              expectedEnrollment == nil || value.enrollmentId == expectedEnrollment else { throw ScreenCommunityError.wrongCommunity }
    }
    private func accept(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, expectedEnrollment: String? = nil) throws {
        let grant = try checked(reply, plan: plan, expectedEnrollment: expectedEnrollment)
        if let prepared = try store.read()?.prepared, grant.body.communityId != prepared.communityId { throw ScreenCommunityError.wrongCommunity }
        try store.update { $0.accepted = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)); $0.plan = plan; $0.prepared = nil }
        authorization = grant; prepared = nil
        expiry?.cancel()
        let expires = grant.body.expiresAt
        expiry = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(max(0, expires - Int64(Date().timeIntervalSince1970 * 1000))))
            guard !Task.isCancelled, let self, self.authorization?.body.expiresAt == expires else { return }
            self.authorization = nil; self.targets = []; self.peerAuthorizations = [:]; self.changed()
        }
    }
    private func acceptPrepared(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, recovered: Bool = false) throws {
        guard reply.kind == "prepared" else { throw ScreenCommunityError.wrongRequest }
        let receipt = try JSONDecoder().decode(ViewerPreparedEnrollment.self, from: reply.encodedValue())
        try receipt.validate(plan: plan, at: Date(), allowExpired: recovered)
        try store.update { $0.prepared = receipt }; prepared = receipt
    }
    /// Receipt recovery never replays a mutation. The original plan/review is persisted before dispatch.
    private func recover(host: any TranscriptSigner, coordinator: CommunityAccessCoordinator) async throws {
        guard let journal = await coordinator.snapshot(), let state = try store.read() else { return }
        let reply = try await coordinator.recover(using: host)
        switch journal.operation {
        case "prepare":
            guard let plan = state.plan else { throw ScreenCommunityError.malformed }; try acceptPrepared(reply, plan: plan, recovered: true)
        case "approve":
            guard let plan = state.approving else { throw ScreenCommunityError.malformed }
            let approved = try checked(reply, plan: plan, recovered: true) // This may be another device: never install it as our own grant.
            guard state.approvingCommunity == approved.body.communityId else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approvedReceipt = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)) }
        default: throw ScreenCommunityError.wrongRequest
        }
        try await coordinator.acknowledge(journal.id)
        try store.update { $0.approving = nil; $0.approvingCommunity = nil }
    }
    func request(identity: ScreenCommunityHostIdentity, biometricKey: Data, name: String, controlKey: Data? = nil, agentDeviceId: String? = nil) async throws {
        let (state, transport) = try transport(create: true)
        try await recover(host: identity.signer, coordinator: transport)
        let current = try store.read()!
        if let prepared = current.prepared, prepared.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) {
            // The visible selection cannot replace an already dispatched request until its outcome is checked.
            guard let plan = current.plan else { throw ScreenCommunityError.wrongCommunity }
            try prepared.validate(plan: plan, at: Date())
            self.prepared = prepared; try await refresh(identity: identity); return
        }
        let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
        let plan = try CommunityAccessPlan(profileId: identity.profileID, deviceId: identity.deviceID, name: name, kind: .desktop,
            hostKey: identity.publicKey.x963Representation, biometricKey: biometricKey, operationKey: operation.publicKey.x963Representation, controlKey: controlKey, agentDeviceId: agentDeviceId, capabilities: selected)
        try store.update { $0.plan = plan; $0.prepared = nil }; hasEnrollmentPlan = true
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        let reply = try await transport.request(.prepare, actor: nil, argumentsJSON: args([object]), signer: identity.signer, mutation: true)
        try acceptPrepared(reply, plan: plan); try await transport.acknowledge(reply.requestId)
    }
    func refresh(identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate? = nil) async throws {
        let epoch = generation
        try await refreshPending(identity: identity, legacy: legacy)
        guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        guard try store.read() != nil else { return }
        let (_, transport) = try transport(create: false)
        try await recover(host: identity.signer, coordinator: transport)
        guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        guard let state = try store.read(), let plan = state.plan else { return }
        guard plan.deviceId == identity.deviceID, plan.profileId == identity.profileID,
              plan.hostKey == ScreenCommunityRequest.base64(identity.publicKey.x963Representation) else { throw ScreenCommunityError.wrongCommunity }
        if let prepared = state.prepared {
            try prepared.validate(plan: plan, at: Date(), allowExpired: true)
            self.prepared = prepared
            do {
                let reply = try await transport.request(.status, actor: nil, argumentsJSON: args([prepared.planId]), signer: identity.signer)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                if reply.kind == "authorization" { try accept(reply, plan: plan, expectedEnrollment: legacy?.member.enrollmentID) }
                else { try acceptPrepared(reply, plan: plan) }
            } catch ScreenCommunityError.service("REQUEST_EXPIRED") {
                guard let legacy, legacy.communityID == prepared.communityId else { throw ScreenCommunityError.service("REQUEST_EXPIRED") }
                // An approved plan's short staging record may expire while the device is offline. Its persistent
                // membership and exact operation key still recover the same authorization without another approval.
                let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
                let reply = try await transport.request(.authorization, actor: legacy.member.enrollmentID,
                    argumentsJSON: args([legacy.communityID]), signer: signer)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                try accept(reply, plan: plan, expectedEnrollment: legacy.member.enrollmentID)
            }
        } else if let saved = state.accepted {
            // Validate the historical subject before using its ID to request a fresh lease. It authorizes no work.
            let old = try CommunityAccessReply.verify(saved.envelope, authority: authority, now: saved.checkedAt).authorization(authority: authority, now: saved.checkedAt)
            try Self.validate(old, plan: plan, expectedEnrollment: legacy?.member.enrollmentID)
            let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
            let reply = try await transport.request(.authorization, actor: old.body.enrollmentId, argumentsJSON: args([old.body.communityId]), signer: signer)
            guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
            try accept(reply, plan: plan, expectedEnrollment: old.body.enrollmentId)
        }
        if let authorization {
            _ = try await ScreenCommunityCommand(.accessCommit, certificate: authorization.envelope).call()
            guard epoch == generation else {
                _ = try? await ScreenCommunityCommand(.withdraw).call()
                throw ScreenCommunityError.service("LOCALLY_LEFT")
            }
            if authorization.body.capabilities.contains(.screenView), let state = try store.read() {
                let directory = try await accessDirectory()
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                var targets: [ViewerTarget] = [], peers: [String: CommunityAuthorization] = [:]
                for peer in directory where peer.body.deviceKind == .desktop && peer.body.enrollmentId != authorization.body.enrollmentId && peer.body.capabilities.contains(.receiveView) {
                    let target = try CommunityViewerTarget.make(peer: peer, own: authorization, operationBlob: state.operationBlob)
                    targets.append(target); peers[target.id] = peer
                }
                self.targets = targets; peerAuthorizations = peers
            } else { targets = []; peerAuthorizations = [:] }
        }
    }
    private func refreshPending(identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate?) async throws {
        if let legacy, legacy.member.admin {
            let transport = CommunityAccessCoordinator(authority: authority, pending: nil, save: { _ in throw ScreenCommunityError.malformed })
            let reply = try await transport.request(.list, actor: legacy.member.enrollmentID, argumentsJSON: args([legacy.communityID]), signer: identity.signer)
            guard reply.kind == "pending-list" else { throw ScreenCommunityError.wrongRequest }
            let rows = try JSONDecoder().decode([ViewerPendingEnrollment].self, from: reply.encodedValue())
            guard rows.count <= 32, Set(rows.map(\.planId)).count == rows.count,
                  rows.allSatisfy({ UUID(uuidString: $0.planId)?.uuidString.lowercased() == $0.planId && RegistrationInvite.isShowableName($0.name) && $0.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) }) else { throw ScreenCommunityError.malformed }
            pending = rows
        }
    }
    func loadReview(_ id: String, identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate) async throws {
        confirmation.reset()
        let (_, transport) = try transport(create: true)
        try await recover(host: identity.signer, coordinator: transport)
        let response = try await transport.request(.review, actor: legacy.member.enrollmentID, argumentsJSON: args([legacy.communityID, id]), signer: identity.signer)
        review = try response.review(authority: authority, adminId: legacy.member.enrollmentID)
    }
    func approve(signer: any TranscriptSigner, legacy: ScreenCommunityCertificate, confirmedDigest: String) async throws {
        guard let review, confirmedDigest == review.digest, confirmation.isConfirmed(for: review), review.admin == legacy.member.enrollmentID, review.expiresAt > Int64(Date().timeIntervalSince1970 * 1000),
              ScreenCommunityRequest.base64(signer.publicKey.x963Representation) == ScreenCommunityRequest.base64(legacy.member.viewerKey) else { throw ScreenCommunityError.wrongCommunity }
        let (_, transport) = try transport(create: false)
        guard await transport.snapshot() == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
        guard self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review) else { throw ScreenCommunityError.service("REGISTRATION_CODE_CONFIRMATION_REQUIRED") }
        try store.update { $0.approving = review.plan; $0.approvingCommunity = legacy.communityID }
        let response = try await transport.request(.approve, actor: review.admin,
            argumentsJSON: args([legacy.communityID, review.planId, review.digest, review.challenge, review.revision]), signer: signer, mutation: true)
        let grant = try checked(response, plan: review.plan)
        guard grant.body.communityId == legacy.communityID else { throw ScreenCommunityError.wrongCommunity }
        // Keep an approval receipt even for a different subject before clearing its unknown-result fence.
        try store.update { $0.approvedReceipt = .init(envelope: response.envelope, checkedAt: Date(timeIntervalSince1970: Double(response.issuedAt) / 1000)) }
        try await transport.acknowledge(response.requestId)
        try store.update { $0.approving = nil; $0.approvingCommunity = nil }; confirmation.reset(); self.review = nil
    }
    func operationSigner(for capability: CommunityCapability) throws -> any TranscriptSigner {
        guard let authorization, authorization.isCurrent(), authorization.body.capabilities.contains(capability),
              let state = try store.read(), let plan = state.plan else { throw ScreenCommunityError.service("NOT_AUTHORIZED") }
        try Self.validate(authorization, plan: plan)
        let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
        guard ScreenCommunityRequest.base64(signer.publicKey.x963Representation) == authorization.body.publicKey else { throw ScreenCommunityError.wrongCommunity }
        return try CommunityPurposeSigner(inner: signer, authorization: authorization, capability: capability)
    }
    func accessDirectory() async throws -> [CommunityAuthorization] {
        guard let authorization else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        let (_, transport) = try transport(create: false)
        let response = try await transport.request(.directory, actor: authorization.body.enrollmentId,
            argumentsJSON: args([authorization.body.communityId, NSNull()]), signer: operationSigner(for: .screenView))
        return try response.directory(authority: authority, communityId: authorization.body.communityId)
    }
    func endLocally() { generation &+= 1; expiry?.cancel(); authorization = nil; targets = []; peerAuthorizations = [:]; pending = []; confirmation.reset(); review = nil }
    /// Registration is deliberately separate from driver readiness; these labels never claim live control.
    func status(for capability: CommunityCapability) -> String {
        guard let authorization, authorization.isCurrent(), authorization.body.capabilities.contains(capability) else {
            return prepared == nil ? "선택 후 등록 필요" : "관리 기기 승인 대기"
        }
        switch capability {
        case .screenView, .screenControl, .receiveView, .receiveControl: return "등록됨 · Screen 연결·OS 권한 확인 필요"
        case .communicate, .teams, .agentSettings, .browser: return "등록됨 · 기능 연결 준비 중"
        }
    }
}
#endif
