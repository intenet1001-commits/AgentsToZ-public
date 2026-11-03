#if os(macOS)
import Foundation
import ScreenControlCore

/// Selection is only an intent. It creates neither device authority nor an executable feature.
struct ViewerFeatureSelection: Equatable {
    private(set) var capabilities: [CommunityCapability] = [.screenView, .screenControl]
    mutating func selectAll() {let explicit=Set(capabilities.filter{$0 == .desktopTrust || $0 == .ownerDelegation});capabilities=CommunityCapability.allCases.filter{($0 != .desktopTrust && $0 != .ownerDelegation) || explicit.contains($0)}}
    mutating func restore(_ values:[CommunityCapability]) { capabilities=values }
    mutating func set(_ capability: CommunityCapability, selected: Bool) {
        var set = Set(capabilities)
        if selected {
            if capability == .ownerDelegation,![CommunityCapability.desktopTrust,.receiveView,.receiveControl].allSatisfy(set.contains) {return}
            set.insert(capability)
            if capability == .screenControl { set.insert(.screenView) }
            if capability == .receiveControl { set.insert(.receiveView) }
        } else {
            set.remove(capability)
            if capability == .screenView { set.remove(.screenControl) }
            if capability == .receiveView { set.remove(.receiveControl) }
            if !set.contains(.screenView),!set.contains(.receiveView) { set.remove(.desktopTrust) }
        }
        if ![CommunityCapability.desktopTrust,.receiveView,.receiveControl].allSatisfy(set.contains) {set.remove(.ownerDelegation)}
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
        var stagedPlan:CommunityAccessPlan?
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
    /// Preserve accepted authority while a new intent is awaiting review. Stale/unknown writes cannot start a new plan.
    func stage(_ plan:CommunityAccessPlan,expectedAcceptedPlan:CommunityAccessPlan?) throws {
        try update { state in
            guard state.journal==nil,state.stagedPlan==nil,state.prepared==nil,
                  (state.accepted==nil ? nil : state.plan)==expectedAcceptedPlan else { throw ScreenCommunityError.service("REGISTRATION_RESULT_PENDING") }
            if state.accepted != nil { state.stagedPlan=plan } else { state.plan=plan }
        }
    }
    @MainActor func commitAccepted(_ grant:CommunityAuthorization,plan:CommunityAccessPlan,preserveStaged:Bool) throws {
        try ViewerUnifiedEnrollment.validate(grant,plan:plan)
        try update { state in
            guard preserveStaged ? state.plan==plan : (state.stagedPlan ?? state.plan)==plan else { throw ScreenCommunityError.staleRevision }
            state.accepted = .init(envelope:grant.envelope,checkedAt:Date(timeIntervalSince1970:Double(grant.body.issuedAt)/1000))
            state.plan=plan
            if !preserveStaged { state.prepared=nil;state.stagedPlan=nil }
        }
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
    private(set) var pendingStatus = "등록 요청을 아직 조회하지 않았습니다."
    private(set) var managementChoice = CommunityManagementChoice.unchanged
    private(set) var registrationExpired = false
    private(set) var registrationMessage = ""
    private var reviewEpoch = 0
    var registrationExpiresAt: Int64? { prepared?.expiresAt }
    private(set) var selection = ViewerFeatureSelection()
    private var selectionEdited=false
    init(authority: ScreenCommunityAuthority, store: ViewerUnifiedStore = ViewerUnifiedStore()) {
        self.authority = authority; self.store = store
        do { hasEnrollmentPlan = try store.read()?.plan != nil }
        catch { hasEnrollmentPlan = true } // An unreadable common account cannot authorize a weaker community path.
    }
    func set(_ capability: CommunityCapability, selected: Bool) { selectionEdited=true;confirmation.reset(); selection.set(capability, selected: selected) }
    func selectAll() { selectionEdited=true;confirmation.reset(); selection.selectAll() }
    func cancelSelectionChanges() { if let plan=try? store.read()?.plan { selection.restore(plan.capabilities) };selectionEdited=false;confirmation.reset() }
    var selected: [CommunityCapability] { selection.capabilities }
    var isWaitingForApproval: Bool { prepared?.isCurrent() ?? false }
    var registrationCode: String? { guard isWaitingForApproval, let prepared else { return nil }; return CommunityEnrollmentCode.formatted(digest: prepared.digest) }
    func pendingUnavailable() { pending = []; pendingStatus = "등록 요청 조회 실패 · 새로 고침으로 다시 확인하세요." }
    func resetConfirmation() { confirmation.reset() }
    func confirmRegistration(digest: String, confirmed: Bool) {
        guard let review, review.digest == digest else { confirmation.reset(); return }
        confirmation.setConfirmed(confirmed, for: review)
    }
    func dismissReview() { reviewEpoch &+= 1; confirmation.reset(); review = nil; managementChoice = .unchanged }
    private var administratorContext: String?
    private var administratorRevision: Int64?
    func validateReviewContext(certificate: ScreenCommunityCertificate?, revision: Int64? = nil) {
        let context = certificate.map { "\($0.communityID):\($0.member.enrollmentID):\($0.member.keyEpoch):\($0.member.admin):\(ScreenCommunityRequest.base64($0.member.hostKey)):\(ScreenCommunityRequest.base64($0.member.viewerKey))" }
        if administratorContext != context || (revision != nil && administratorRevision != nil && administratorRevision != revision) {
            dismissReview()
        }
        administratorContext = context
        if let revision { administratorRevision = revision }
        guard let review else { return }
        guard let certificate, certificate.member.admin, review.admin == certificate.member.enrollmentID,
              review.management == nil || review.management?.communityId == certificate.communityID,
              revision == nil || revision == review.revision,
              review.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else { dismissReview(); return }
    }
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
    private func accept(_ reply: CommunityAccessReply, plan: CommunityAccessPlan, expectedEnrollment: String? = nil,preserveStaged:Bool=false) throws {
        let grant = try checked(reply, plan: plan, expectedEnrollment: expectedEnrollment)
        if let prepared = try store.read()?.prepared, grant.body.communityId != prepared.communityId { throw ScreenCommunityError.wrongCommunity }
        try store.commitAccepted(grant,plan:plan,preserveStaged:preserveStaged)
        if !selectionEdited { selection.restore(plan.capabilities) }
        authorization = grant;if !preserveStaged { prepared = nil }; registrationExpired = false; registrationMessage = preserveStaged ? "기존 기능 등록 유지 · 변경 승인 결과를 확인하는 중입니다." : "기능 등록 완료 · 실제 연결·OS 권한은 별도 확인"
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
        try store.update { $0.prepared = receipt }; prepared = receipt; registrationExpired = false; registrationMessage = receipt.isCurrent() ? "관리 기기 승인 대기 · 등록 코드 유효 시간 안에 확인하세요." : "이전 요청의 승인 여부를 확인하는 중입니다."
    }
    /// Receipt recovery never replays a mutation. The original plan/review is persisted before dispatch.
    private func recover(host: any TranscriptSigner, coordinator: CommunityAccessCoordinator) async throws {
        guard let journal = await coordinator.snapshot(), let state = try store.read() else { return }
        let reply: CommunityAccessReply
        do { reply = try await coordinator.recover(using: host) }
        catch {
            guard journal.operation == "prepare", let plan = state.stagedPlan ?? state.plan,
                  (error as? ScreenCommunityError) == ScreenCommunityError.expired || (error as? ScreenCommunityError) == ScreenCommunityError.service("RECEIPT_NOT_FOUND") else { throw error }
            try await lookupRegistration(plan: plan, host: host, transport: coordinator, original: journal); return
        }
        switch journal.operation {
        case "prepare":
            guard let plan = state.stagedPlan ?? state.plan else { throw ScreenCommunityError.malformed }; try acceptPrepared(reply, plan: plan, recovered: true)
        case "approve", "approve-management":
            guard let plan = state.approving else { throw ScreenCommunityError.malformed }
            let approved = try checked(reply, plan: plan, recovered: true) // This may be another device: never install it as our own grant.
            guard state.approvingCommunity == approved.body.communityId else { throw ScreenCommunityError.wrongCommunity }
            try store.update { $0.approvedReceipt = .init(envelope: reply.envelope, checkedAt: Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000)) }
        default: throw ScreenCommunityError.wrongRequest
        }
        try await coordinator.acknowledge(journal.id)
        try store.update { $0.approving = nil; $0.approvingCommunity = nil }
    }
    /// Read-only recovery; neither expiry nor absence dispatches a replacement prepare.
    private func lookupRegistration(plan: CommunityAccessPlan, host: any TranscriptSigner, transport: CommunityAccessCoordinator, original: CommunityAccessJournal? = nil) async throws {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        var values: [Any] = [object]
        if let original { values.append(try JSONSerialization.jsonObject(with: JSONEncoder().encode(original.envelope))) }
        let reply = try await transport.request(.recoverRegistration, actor: nil, argumentsJSON: args(values), signer: host)
        switch try CommunityRegistrationLookup.verify(reply, authority: authority, plan: plan, communityId: prepared?.communityId) {
        case .registered:
            try accept(reply, plan: plan)
            if let original { try await transport.acknowledge(original.id) }
        case .pending:
            try acceptPrepared(reply, plan: plan)
            if let original { try await transport.acknowledge(original.id) }
        case .absent(let proof):
            if original != nil { try await transport.resolveExpiredPrepare(using: proof) }
            try store.update { $0.prepared = nil;$0.stagedPlan=nil }; prepared = nil; registrationExpired = true
            registrationMessage = "기존 요청이 없거나 만료되었음을 확인했습니다. 같은 기기 키로 다시 등록 요청할 수 있습니다."
        }
    }
    func request(identity: ScreenCommunityHostIdentity, biometricKey: Data, name: String, controlKey: Data? = nil, agentDeviceId: String? = nil,controlCandidate:CommunityEnrollmentTransport.ControlCandidate?=nil) async throws {
        let (state, transport) = try transport(create: true)
        try await recover(host: identity.signer, coordinator: transport)
        let current = try store.read()!
        if current.prepared != nil || current.stagedPlan != nil || (current.plan != nil && current.accepted == nil) {
            // Even an expired staging record may have been approved while this device was offline.
            try await refresh(identity: identity)
            if prepared != nil || !registrationExpired { return }
        }
        let operation = try SecureEnclaveTranscriptSigner(dataRepresentation: state.operationBlob)
        let prior = current.accepted == nil ? nil : current.plan
        let preservedControl:Data?
        if let value=prior?.controlKey { preservedControl=try ScreenCommunityRequest.decodeBase64(value,max:87) } else { preservedControl=nil }
        let preservedAgent = prior?.agentDeviceId
        let plan = try CommunityAccessPlan(profileId: identity.profileID, deviceId: identity.deviceID, name: name, kind: .desktop,
            hostKey: identity.publicKey.x963Representation, biometricKey: biometricKey, operationKey: operation.publicKey.x963Representation, controlKey: preservedControl ?? controlKey, agentDeviceId: preservedAgent ?? agentDeviceId, capabilities: selected)
        if let prior,plan.capabilities.contains(.desktopTrust) || prior.capabilities.contains(.desktopTrust) {
            guard prior.hostKey==plan.hostKey,prior.biometricKey==plan.biometricKey,prior.operationKey==plan.operationKey,
                  prior.controlKey==nil || prior.controlKey==plan.controlKey else { throw ScreenCommunityError.service("TRUST_UPDATE_KEY_ROTATION_REFUSED") }
            if prior.controlKey==nil,plan.controlKey != nil {
                guard plan.capabilities.contains(.agentSettings) || plan.capabilities.contains(.browser),let controlCandidate,
                      plan.controlKey==ScreenCommunityRequest.base64(controlCandidate.publicKey),plan.agentDeviceId==controlCandidate.agentDeviceId else { throw ScreenCommunityError.service("TRUST_UPDATE_CONTROL_BINDING_REQUIRED") }
            }
        }
        try store.stage(plan,expectedAcceptedPlan:prior);hasEnrollmentPlan = true
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        let reply = try await transport.request(.prepare, actor: nil, argumentsJSON: args([object]), signer: identity.signer, mutation: true)
        try acceptPrepared(reply, plan: plan); try await transport.acknowledge(reply.requestId)
    }
    func refresh(identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate? = nil) async throws {
        do { try await refreshStored(identity: identity, legacy: legacy) }
        catch {
            registrationMessage = (error as? ScreenCommunityError) == .service("REQUEST_STILL_POSSIBLE") ? "이전 요청이 아직 도착할 수 있어 결과를 확인 중입니다. 새 요청은 보내지 않습니다." : "등록 상태 조회 실패 · 기존 요청을 보존했습니다. 인터넷 연결을 확인하고 다시 조회하세요."
            throw error
        }
    }
    private func refreshStored(identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate?) async throws {
        let epoch = generation
        try await refreshPending(identity: identity, legacy: legacy)
        guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        guard try store.read() != nil else { return }
        let (_, transport) = try transport(create: false)
        var uncertainStage=false
        do { try await recover(host: identity.signer, coordinator: transport) }
        catch {
            guard let state=try store.read(),state.journal?.operation=="prepare",let staged=state.stagedPlan,
                  let accepted=state.accepted,let plan=state.plan else { throw error }
            // A read-only lease renewal can coexist with an unresolved staged mutation. It never clears or replays it.
            try await refreshAccepted(accepted,plan:plan,staged:staged,identity:identity,transport:transport,epoch:epoch,expectedEnrollment:legacy?.member.enrollmentID)
            uncertainStage=true;registrationMessage="기존 등록 유지 · 변경 요청 결과는 불명이며 원래 요청을 보존했습니다."
        }
        guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        guard let state = try store.read(), let plan = state.plan else { return }
        guard plan.deviceId == identity.deviceID, plan.profileId == identity.profileID,
              plan.hostKey == ScreenCommunityRequest.base64(identity.publicKey.x963Representation) else { throw ScreenCommunityError.wrongCommunity }
        if uncertainStage { /* The current accepted policy was renewed above; keep the original stage fence. */ }
        else if let prepared = state.prepared {
            let pendingPlan=state.stagedPlan ?? plan
            try prepared.validate(plan: pendingPlan, at: Date(), allowExpired: true)
            self.prepared = prepared
            do {
                let reply = try await transport.request(.status, actor: nil, argumentsJSON: args([prepared.planId]), signer: identity.signer)
                guard epoch == generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
                if reply.kind == "authorization" { try accept(reply, plan: pendingPlan, expectedEnrollment: legacy?.member.enrollmentID) }
                else { try acceptPrepared(reply, plan: pendingPlan) }
            } catch ScreenCommunityError.service("REQUEST_EXPIRED") {
                try await lookupRegistration(plan: pendingPlan, host: identity.signer, transport: transport)
            }
            if let after=try store.read(),after.stagedPlan != nil,let accepted=after.accepted,let oldPlan=after.plan {
                try await refreshAccepted(accepted,plan:oldPlan,staged:after.stagedPlan,identity:identity,transport:transport,epoch:epoch,expectedEnrollment:legacy?.member.enrollmentID)
            }
        } else if let staged=state.stagedPlan {
            try await lookupRegistration(plan:staged,host:identity.signer,transport:transport)
            if let after=try store.read(),let accepted=after.accepted,let oldPlan=after.plan { try await refreshAccepted(accepted,plan:oldPlan,staged:after.stagedPlan,identity:identity,transport:transport,epoch:epoch,expectedEnrollment:legacy?.member.enrollmentID) }
        } else if let saved = state.accepted {
            try await refreshAccepted(saved,plan:plan,staged:nil,identity:identity,transport:transport,epoch:epoch,expectedEnrollment:legacy?.member.enrollmentID)
        } else { try await lookupRegistration(plan: plan, host: identity.signer, transport: transport) }
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
        guard let legacy else { pending = []; pendingStatus = "이 기기 등록 전 · 관리 기기에서 등록 요청을 확인하세요."; return }
        guard legacy.member.admin else { pending = []; pendingStatus = "등록됨 · 이 기기는 등록 승인 역할이 없습니다."; validateReviewContext(certificate: legacy); return }
        do {
            let transport = CommunityAccessCoordinator(authority: authority, pending: nil, save: { _ in throw ScreenCommunityError.malformed })
            let reply = try await transport.request(.list, actor: legacy.member.enrollmentID, argumentsJSON: args([legacy.communityID]), signer: identity.signer)
            guard reply.kind == "pending-list" else { throw ScreenCommunityError.wrongRequest }
            let rows = try JSONDecoder().decode([ViewerPendingEnrollment].self, from: reply.encodedValue())
            guard rows.count <= 32, Set(rows.map(\.planId)).count == rows.count,
                  rows.allSatisfy({ UUID(uuidString: $0.planId)?.uuidString.lowercased() == $0.planId && CommunityAccessName.isValid($0.name) && $0.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) }) else { throw ScreenCommunityError.malformed }
            pending = rows; pendingStatus = rows.isEmpty ? "관리 기기 · 현재 승인할 기능 등록 요청이 없습니다." : "관리 기기 · 기능 등록 요청 \(rows.count)건"
        } catch { pending = []; pendingStatus = "등록 요청 조회 실패 · 새로 고침으로 다시 확인하세요."; throw error }
    }
    private func refreshAccepted(_ saved:ViewerUnifiedStore.Accepted,plan:CommunityAccessPlan,staged:CommunityAccessPlan?,identity:ScreenCommunityHostIdentity,transport:CommunityAccessCoordinator,epoch:Int,expectedEnrollment:String?) async throws {
        let old=try CommunityAccessReply.verify(saved.envelope,authority:authority,now:saved.checkedAt).authorization(authority:authority,now:saved.checkedAt)
        try Self.validate(old,plan:plan,expectedEnrollment:expectedEnrollment)
        guard let stored=try store.read() else { throw ScreenCommunityError.service("DEVICE_KEY_MISSING") }
        let signer=try SecureEnclaveTranscriptSigner(dataRepresentation:stored.operationBlob)
        let reply=try await transport.request(.authorization,actor:old.body.enrollmentId,argumentsJSON:args([old.body.communityId]),signer:signer)
        guard epoch==generation else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        let grant=try reply.authorization(authority:authority)
        if let staged,(try? Self.validate(grant,plan:staged,expectedEnrollment:old.body.enrollmentId)) != nil {
            try accept(reply,plan:staged,expectedEnrollment:old.body.enrollmentId)
        } else { try accept(reply,plan:plan,expectedEnrollment:old.body.enrollmentId,preserveStaged:staged != nil) }
    }
    func loadReview(_ id: String, identity: ScreenCommunityHostIdentity, legacy: ScreenCommunityCertificate, choice: CommunityManagementChoice = .unchanged) async throws {
        validateReviewContext(certificate: legacy)
        dismissReview(); managementChoice = choice; let epoch = reviewEpoch
        guard legacy.member.admin else { throw ScreenCommunityError.service("ADMIN_REQUIRED") }
        let (_, transport) = try transport(create: true)
        try await recover(host: identity.signer, coordinator: transport)
        let operation: CommunityAccessRequest.Operation = choice == .unchanged ? .review : .reviewManagement
        let values: [Any] = [legacy.communityID, id] + (choice.administrator.map { [$0] } ?? [])
        let response = try await transport.request(operation, actor: legacy.member.enrollmentID, argumentsJSON: args(values), signer: identity.signer)
        let checked = try choice == .unchanged ? response.review(authority: authority, adminId: legacy.member.enrollmentID) : response.managementReview(authority: authority, administrator: legacy)
        guard epoch == reviewEpoch, managementChoice == choice else { throw ScreenCommunityError.service("REVIEW_CONTEXT_CHANGED") }
        review = checked
    }
    func approve(signer: any TranscriptSigner, legacy: ScreenCommunityCertificate, confirmedDigest: String) async throws {
        guard let review, review.hasValidManagementBinding, legacy.member.admin, confirmedDigest == review.digest, confirmation.isConfirmed(for: review), review.admin == legacy.member.enrollmentID, review.expiresAt > Int64(Date().timeIntervalSince1970 * 1000),
              ScreenCommunityRequest.base64(signer.publicKey.x963Representation) == ScreenCommunityRequest.base64(legacy.member.viewerKey) else { throw ScreenCommunityError.wrongCommunity }
        let (_, transport) = try transport(create: false)
        guard await transport.snapshot() == nil else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
        guard self.review?.digest == confirmedDigest, confirmation.isConfirmed(for: review) else { throw ScreenCommunityError.service("REGISTRATION_CODE_CONFIRMATION_REQUIRED") }
        try store.update { $0.approving = review.plan; $0.approvingCommunity = legacy.communityID }
        let response = try await transport.request(review.approvalOperation, actor: review.admin,
            argumentsJSON: review.approvalArguments(communityId: legacy.communityID), signer: signer, mutation: true)
        let grant = try checked(response, plan: review.plan)
        guard grant.body.communityId == legacy.communityID else { throw ScreenCommunityError.wrongCommunity }
        // Keep an approval receipt even for a different subject before clearing its unknown-result fence.
        try store.update { $0.approvedReceipt = .init(envelope: response.envelope, checkedAt: Date(timeIntervalSince1970: Double(response.issuedAt) / 1000)) }
        try await transport.acknowledge(response.requestId)
        try store.update { $0.approving = nil; $0.approvingCommunity = nil }; dismissReview()
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
        let peers=try response.directory(authority:authority,communityId:authorization.body.communityId)
        if authorization.body.capabilities.contains(.desktopTrust) {_ = try await ScreenCommunityCommand(.viewerDirectoryCommit,certificate:response.envelope).call()}
        return peers
    }
    func ownerOperationSigner()throws->any TranscriptSigner {
        guard let authorization,let state=try store.read(),let plan=state.plan else {throw ScreenCommunityError.service("NOT_ENROLLED")}
        try Self.validate(authorization,plan:plan)
        return try CommunityOwnerOperationSigner(inner:SecureEnclaveTranscriptSigner(dataRepresentation:state.operationBlob),own:authorization)
    }
    func endLocally() { generation &+= 1; expiry?.cancel(); authorization = nil; targets = []; peerAuthorizations = [:]; pending = []; confirmation.reset(); review = nil }
    /// Registration is deliberately separate from driver readiness; these labels never claim live control.
    func status(for capability: CommunityCapability) -> String {
        guard let authorization, authorization.isCurrent(), authorization.body.capabilities.contains(capability) else {
            return registrationExpired ? "요청 만료 · 명시적으로 다시 요청 가능" : (prepared == nil ? "선택 후 등록 필요" : "관리 기기 승인 대기")
        }
        switch capability {
        case .screenView, .screenControl, .receiveView, .receiveControl, .desktopTrust: return "등록됨 · Screen 연결·OS 권한 확인 필요"
        case .ownerDelegation: return "등록됨 · 최초 위임 준비만 포함 · 실제 보류 해제는 다른 Mac의 요청별 생체 승인"
        case .communicate, .teams, .agentSettings, .browser: return "등록됨 · 기능 연결 준비 중"
        }
    }
}
#endif
