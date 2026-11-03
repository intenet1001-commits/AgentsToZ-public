#if os(macOS)
import Foundation
import ScreenControlCore

/// One community key/account per Viewer installation. It never persists peer rows in the pairwise ledger.
@MainActor
final class ViewerCommunityAccount {
    struct Account: Codable, Sendable { let keyBlob: Data; var displayName: String?; var enrollment: ScreenCommunityEnrollmentState? }
    private var model: ScreenCommunityEnrollment?
    private(set) var unified: ViewerUnifiedEnrollment?
    private(set) var controlReady = false
    private var componentGeneration = 0
    init(unifiedStore: ViewerUnifiedStore = ViewerUnifiedStore()) { unified = ScreenCommunityAuthority.configured.map { ViewerUnifiedEnrollment(authority: $0, store: unifiedStore) }; unified?.changed = { [weak self] in self?.publish() } }
    var commonTargets: [ViewerTarget] { unified?.targets ?? [] }
    func commonPeer(_ id: String) -> CommunityAuthorization? { unified?.peerAuthorizations[id] }
    var selectedCapabilities: [CommunityCapability] { unified?.selected ?? [] }
    func selectAllFeatures() { unified?.selectAll(); publish() }
    func selectFeature(_ capability: CommunityCapability, selected: Bool) { unified?.set(capability, selected: selected); publish() }
    func featureStatus(_ capability: CommunityCapability) -> String {
        if [.communicate, .teams, .agentSettings, .browser].contains(capability), unified?.authorization?.body.capabilities.contains(capability) == true {
            return controlReady ? "등록됨 · 기기 키 준비됨 · 기능 연결 확인 필요" : "등록됨 · Control 연결 준비 필요"
        }
        return unified?.status(for: capability) ?? "등록 서비스 설정 필요"
    }
    private var blob: Data?
    private var adminEpoch = 0
    private let reviewLifecycle = CommunityReviewLifecycle()
    private var actionMessageLocked = false
    var requestedName = ""
    var prepareControlKey: (@MainActor () async throws -> CommunityEnrollmentTransport.ControlCandidate)? = {
        let identity = try await ScreenCommunityHostIdentity.load()
        return try await CommunityEnrollmentTransport.prepareControlKey(profileID: identity.profileID, deviceID: identity.deviceID)
    }
    var supported: Bool { ScreenCommunityAuthority.configured != nil }
    func cancelAdministratorAction() { reviewLifecycle.cancel(); adminEpoch &+= 1; unified?.dismissReview();ownerRecovery?.cancel() }
    let ownerRecovery:ViewerOwnerRecovery?=ScreenCommunityAuthority.configured.map{ViewerOwnerRecovery(authority:$0)}
    func confirmUnifiedRegistration(digest: String, confirmed: Bool) { unified?.confirmRegistration(digest: digest, confirmed: confirmed); publish() }
    func refreshRegistration() async { cancelAdministratorAction(); publish(); await refresh() }
    private var polling: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private let backend = KeychainTargets(account: "community-account-v1")
    private let routesBackend = KeychainTargets(account: "community-routes-v1")
    private(set) var targets: [ViewerTarget] = []
    private(set) var certificate: ScreenCommunityCertificate?
    private(set) var directory: ScreenCommunityDirectory?
    private(set) var removing: ScreenCommunityMember?
    private(set) var message = ScreenCommunityAuthority.configured == nil ? "커뮤니티 등록 서비스의 배포 설정을 준비 중입니다. 기존 직접 등록은 계속 사용할 수 있습니다." : "커뮤니티에 기기를 한 번 등록하면 등록된 Mac들이 함께 표시됩니다."
    private(set) var review: ScreenCommunityReview?
    private(set) var pending: [(id: String, name: String, platform: String)] = []
    private(set) var busy = false
    var changed: () -> Void = {}
    var sheetChanged: () -> Void = {}
    private func publish() { changed(); sheetChanged() }
    func inputRefused(_ reason: ScreenInputRefusal) {
        actionMessageLocked = true
        message = "인증을 시작하지 않았습니다. 이 Mac의 실제 입력을 확인하지 못했습니다(\(reason.rawValue)). 이 Mac의 마우스·트랙패드로 버튼을 누르거나, 버튼에 키보드 초점을 두고 Space를 눌러 주세요."
        publish()
    }

    func resume() {
        guard polling == nil, ScreenCommunityAuthority.configured != nil,
              let data = try? backend.read(), let saved = try? JSONDecoder().decode(Account.self, from: data),
              (saved.enrollment?.automaticRefreshInterval() != nil || unified?.hasEnrollmentPlan == true) else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.busy { await self.refresh() }
                guard let model = self.model else { self.polling = nil; return }
                let interval = (await model.snapshot()).automaticRefreshInterval() ?? (self.unified?.isWaitingForApproval == true ? 3 : nil)
                guard let interval else { self.polling = nil; return }
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
    func stop() { polling?.cancel(); polling = nil; expiry?.cancel() }
    private func prepare(create: Bool) async throws -> ScreenCommunityEnrollment? {
        if let model { return model }
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let stored = try backend.read()
        if stored == nil && !create { return nil }
        let identity = try await ScreenCommunityHostIdentity.load()
        guard identity.profileID == authority.profileID else { throw ScreenCommunityError.wrongCommunity }
        let account: Account
        if let stored { account = try JSONDecoder().decode(Account.self, from: stored) }
        else {
            guard create else { return nil }
            let key = try ControllerKeyFactory.make()
            let chosen = requestedName.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = chosen.isEmpty ? identity.name : chosen
            guard RegistrationInvite.isShowableName(name) else { throw ScreenCommunityError.malformed }
            account = Account(keyBlob: key.blob, displayName: name, enrollment: nil)
            try backend.write(JSONEncoder().encode(account))
        }
        let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: account.keyBlob)
        guard identity.boundViewerKey == nil || identity.boundViewerKey == signer.publicKey.x963Representation else { throw ScreenCommunityError.wrongCommunity }
        _ = try await ScreenCommunityCommand(.bind, [.string(ScreenCommunityRequest.key(signer))]).call()
        let backend = backend, keyBlob = account.keyBlob, displayName = account.displayName ?? identity.name
        let model = try ScreenCommunityEnrollment(authority: authority,
            device: ScreenCommunityDevice(id: identity.deviceID, name: displayName, platform: "mac", grant: .control),
            identity: identity.signer, viewerKey: signer.publicKey.x963Representation, state: account.enrollment,
            save: { try backend.write(JSONEncoder().encode(Account(keyBlob: keyBlob, displayName: displayName, enrollment: $0))) })
        self.model = model; blob = keyBlob; return model
    }
    /// A single intent covers the exact selected feature set; staging itself grants no authority.
    func requestUnifiedMembership() async {
        guard !busy else { return }; busy = true; actionMessageLocked = false; publish()
        defer { busy = false; publish() }
        do {
            guard try await prepare(create: true) != nil, let blob, let unified else { return }
            let identity = try await ScreenCommunityHostIdentity.load()
            let biometricSigner = try SecureEnclaveTranscriptSigner(dataRepresentation: blob)
            let saved = try backend.read().map { try JSONDecoder().decode(Account.self, from: $0) }
            let controlKey: Data?, agentDeviceId: String?
            var verifiedControlCandidate:CommunityEnrollmentTransport.ControlCandidate?
            if unified.selected.contains(where: { $0 == .communicate || $0 == .teams || $0 == .agentSettings || $0 == .browser }) {
                guard let prepareControlKey else { throw ScreenCommunityError.service("CONTROL_KEY_NOT_READY") }
                do { let candidate = try await prepareControlKey();verifiedControlCandidate=candidate;controlKey = candidate.publicKey; agentDeviceId = candidate.agentDeviceId }
                catch { throw ScreenCommunityError.service("CONTROL_KEY_NOT_READY") }
            } else { controlKey = nil; agentDeviceId = nil }
            try await unified.request(identity: identity, biometricKey: biometricSigner.publicKey.x963Representation, name: saved?.displayName ?? identity.name, controlKey: controlKey, agentDeviceId: agentDeviceId,controlCandidate:verifiedControlCandidate)
            message = "선택한 기능을 한 번에 등록 요청했습니다. 관리 기기에서 선택 목록을 확인하고 한 번 승인해 주세요."
            resume()
        } catch { actionMessageLocked = true; message = Self.describe(error) }
    }
    func loadUnifiedReview(_ id: String, choice: CommunityManagementChoice = .unchanged) async {
        guard !busy, let certificate, certificate.member.admin, let unified else { return }
        busy = true; publish(); defer { busy = false; publish() }
        do {
            guard let model else { throw ScreenCommunityError.service("NOT_ENROLLED") }
            let (current, identity) = try await reviewLifecycle.prepare {
                let current = try await model.refreshSelfCertificate()
                let identity = try await ScreenCommunityHostIdentity.load()
                return (current, identity)
            }
            guard identity.profileID == current.profileID, identity.deviceID == current.member.deviceID,
                  identity.publicKey.x963Representation == current.member.hostKey, identity.boundViewerKey == current.member.viewerKey,
                  current.communityID == certificate.communityID, current.member.enrollmentID == certificate.member.enrollmentID,
                  current.member.hostKey == certificate.member.hostKey, current.member.viewerKey == certificate.member.viewerKey,
                  current.member.keyEpoch == certificate.member.keyEpoch else { throw ScreenCommunityError.service("REVIEW_CONTEXT_CHANGED") }
            self.certificate = current
            try await unified.loadReview(id, identity: identity, legacy: current, choice: choice)
        }
        catch { message = Self.describe(error) }
    }
    func approveUnified(_ proof: HumanProof, confirmedDigest: String) async {
        guard !busy, let certificate, let blob, let unified, let review = unified.review,
              confirmedDigest == review.digest, unified.confirmation.isConfirmed(for: review) else { return }
        busy = true; publish(); defer { busy = false; publish() }
        adminEpoch &+= 1; let epoch = adminEpoch
        do {
            guard !unified.hasPendingMutation else { throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST") }
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: blob, reason: "‘\(review.plan.name)’의 선택 기능과 \(unified.managementChoice.title)을 함께 확인합니다")
            guard epoch == adminEpoch, unified.review?.digest == confirmedDigest, unified.confirmation.isConfirmed(for: review), !Task.isCancelled else { return }
            try await unified.approve(signer: signer, legacy: certificate, confirmedDigest: confirmedDigest)
            message = "선택한 기능 등록을 승인했습니다. 각 기기의 OS 권한과 기능 준비 상태를 확인하세요."
            await refresh()
        } catch { actionMessageLocked = true; message = Self.describe(error) }
    }
    func dismissUnifiedReview() { cancelAdministratorAction(); unified?.dismissReview(); publish() }
    func currentAuthorization() async throws -> CommunityAuthorization {
        guard let unified, let model = try await prepare(create: false) else { throw ScreenCommunityError.notConfigured }
        guard (await model.snapshot()).locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        try await unified.refresh(identity: ScreenCommunityHostIdentity.load(), legacy: certificate)
        guard (await model.snapshot()).locallyLeft != true else {
            unified.endLocally(); _ = try? await ScreenCommunityCommand(.withdraw).call()
            throw ScreenCommunityError.service("LOCALLY_LEFT")
        }
        await syncNativeComponents()
        guard let grant = unified.authorization, grant.isCurrent() else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return grant
    }
    func operationSigner(for capability: CommunityCapability) async throws -> any TranscriptSigner {
        _ = try await currentAuthorization()
        guard let unified else { throw ScreenCommunityError.notConfigured }
        return try unified.operationSigner(for: capability)
    }
    func accessDirectory() async throws -> [CommunityAuthorization] {
        _ = try await currentAuthorization()
        guard let unified else { throw ScreenCommunityError.notConfigured }
        return try await unified.accessDirectory()
    }
    /// Installing the separately signed component lease is independent of legacy discovery/Screen power.
    private func syncNativeComponents() async {
        controlReady = false; let epoch = componentGeneration
        guard let unified, let authorization = unified.authorization, authorization.body.controlKey != nil else { return }
        do {
            try await CommunityEnrollmentTransport.installControlAuthorization(authorization, authority: unified.authority)
            guard epoch == componentGeneration else { try? await CommunityEnrollmentTransport.disableControlAccess(); return }
            controlReady = true
        } catch { controlReady = false }
    }
    func screenRelayTicket(connectionID: String) async throws -> CommunityRelayTicket {
        let own = try await currentAuthorization()
        guard let unified else { throw ScreenCommunityError.notConfigured }
        let signer = try unified.operationSigner(for: .screenView)
        let request = try CommunityAccessRequest(operation: .relayTicket, actor: own.body.enrollmentId,
            argumentsJSON: JSONSerialization.data(withJSONObject: [own.body.communityId, "screen", connectionID, "client", NSNull()]))
        let reply = try await CommunityAccessHTTP(authority: unified.authority).send(request.signed(by: signer), requestId: request.id)
        return try reply.relayTicket(for: own, connectionId: connectionID, purpose: .screen, role: .client)
    }
    func requestMembership() async {
        guard !busy else { return }; busy = true; actionMessageLocked = false; message = "이 Mac의 등록 요청을 준비하는 중…"; publish()
        defer { busy = false; publish() }
        do {
            guard let model = try await prepare(create: true) else { return }
            let state = await model.snapshot()
            if state.submittedID != nil { try await model.recover() }
            else { try await model.join(communityID: model.discover()) }
            message = "등록 요청을 보냈습니다. 기존 관리 기기의 모바일 알림 또는 커뮤니티 기기 목록에서 승인해 주세요."
            resume()
        } catch { actionMessageLocked = true; message = Self.describe(error) }
    }
    func refreshOwnerRecovery()async {
        guard let ownerRecovery,let unified,let own=unified.authorization else {return}
        ownerRecovery.changed={ [weak self] in self?.publish() }
        do {let identity=try await ScreenCommunityHostIdentity.load();await ownerRecovery.refresh(own:own,peers:Array(unified.peerAuthorizations.values),operation:try? unified.ownerOperationSigner(),host:identity.signer)}
        catch {ownerRecovery.failed("원래 위임 상태 조회가 필요합니다. 새 승인을 자동으로 보내지 않습니다.")}
    }
    private func ownerBiometricSigner(_ reason:String,expected:CommunityAuthorization)async throws->any TranscriptSigner {
        guard let blob else {throw ScreenCommunityError.service("DEVICE_KEY_MISSING")}
        let signer=try await FaceIDApprovedSigner.approve(dataRepresentation:blob,reason:reason)
        let fresh=try await currentAuthorization()
        guard try CommunityMobileControlPolicy.authorizationDigest(fresh)==CommunityMobileControlPolicy.authorizationDigest(expected),ScreenCommunityRequest.base64(signer.publicKey.x963Representation)==fresh.body.biometricPublicKey else {throw ScreenCommunityError.staleRevision}
        return signer
    }
    func requestInputRecovery(_ targetId:String)async {
        guard !busy,let ownerRecovery,let unified else {return}
        do {
            let own=try await currentAuthorization()
            guard let target=unified.peerAuthorizations.values.first(where:{$0.body.enrollmentId==targetId}) else {throw ScreenCommunityError.expired}
            await ownerRecovery.request(target:target,own:own,signer:try unified.ownerOperationSigner())
        } catch {ownerRecovery.failed("대상 Mac·현재 기기 신뢰를 확인하지 못했습니다. 원래 요청은 보존합니다.")}
        publish()
    }
    func enableInputDelegation()async {
        guard !busy,let ownerRecovery else {return}
        do {
            let own=try await currentAuthorization();await refreshOwnerRecovery()
            await ownerRecovery.enable(own:own,biometric:{ [weak self] reason in guard let self else {throw ScreenCommunityError.expired};return try await self.ownerBiometricSigner(reason,expected:own) })
        } catch {ownerRecovery.failed("위임 설정을 시작하지 못했습니다. 이 Mac에서 등록한 생체 키를 확인해 주세요.")}
        publish()
    }
    func approveInputRecovery(_ id:String)async {
        guard !busy,let ownerRecovery,let selected=ownerRecovery.records.first(where:{$0.body.requestId==id}) else {return}
        do {
            let own=try await currentAuthorization();await refreshOwnerRecovery()
            guard ownerRecovery.records.contains(where:{$0.reviewBinding==selected.reviewBinding}) else {throw ScreenCommunityError.staleRevision}
            await ownerRecovery.approve(selected,own:own,biometric:{ [weak self] reason in guard let self else {throw ScreenCommunityError.expired};return try await self.ownerBiometricSigner(reason,expected:own) })
        } catch {ownerRecovery.failed("검토할 요청·권한이 바뀌었습니다. 최신 대상과 범위를 다시 확인해 주세요.")}
        publish()
    }
    func disableInputDelegation()async {
        ownerRecovery?.cancel()
        do {_ = try await ScreenCommunityCommand(.ownerDelegationDisable).call();ownerRecovery?.failed("이 Mac의 입력 보류 해제 위임을 껐습니다. 이미 열린 화면·OS 권한은 바꾸지 않았습니다.")}
        catch {ownerRecovery?.failed("이 실행의 위임 승인은 차단합니다. 지속 저장·서버 해제 결과는 조회가 필요합니다.")}
        await refreshOwnerRecovery();publish()
    }

    /// Root provisioning asks for a fresh local biometric approval; never invoked by polling or discovery.
    func createCommunity(_ proof: HumanProof) async {
        guard !busy else { return }; busy = true; actionMessageLocked = false; message = "관리 Mac 등록을 준비하는 중…"; publish()
        defer { busy = false; publish() }
        adminEpoch &+= 1; let epoch = adminEpoch
        do {
            guard let model = try await prepare(create: true), let blob else { return }
            let existing = await model.snapshot()
            if existing.submittedID != nil || existing.certificate != nil {
                message = "이전 등록 요청의 결과를 확인하는 중…"; publish()
                try await model.recover(); await refresh(); resume(); return
            }
            message = "이 Mac의 기기 키를 Touch ID 또는 Apple Watch로 인증하는 중…"; publish()
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: blob, reason: "이 Mac을 AgentsToZ 커뮤니티 관리 기기로 등록합니다")
            guard adminEpoch == epoch, !Task.isCancelled else { return }
            try await model.createCommunity(name: "내 AgentsToZ 커뮤니티", approvedSigner: signer)
            await refresh(); resume()
        } catch { actionMessageLocked = true; message = Self.describe(error) }
    }
    func refresh() async {
        do {
            guard let model = try await prepare(create: false), let blob else { return }
            let identity = try await ScreenCommunityHostIdentity.load()
            let original = await model.snapshot()
            if original.uncertainMutation { try await model.recover() }
            do { certificate = try await model.refreshSelfCertificate() }
            catch ScreenCommunityError.service(let code) where ["NOT_ENROLLED", "COMMUNITY_NOT_READY"].contains(code) { certificate = nil }
            unified?.validateReviewContext(certificate: certificate)
            if let recovered = try? await model.certificate() { certificate = recovered }
            do { try await unified?.refresh(identity: identity, legacy: certificate) }
            catch { if unified?.prepared != nil || unified?.hasPendingMutation == true { throw error } }
            guard (await model.snapshot()).locallyLeft != true else {
                unified?.endLocally(); _ = try? await ScreenCommunityCommand(.withdraw).call()
                throw ScreenCommunityError.service("LOCALLY_LEFT")
            }
            await syncNativeComponents()
            await refreshOwnerRecovery()
            let snapshot = await model.snapshot()
            if (try? await model.certificate()) == nil { certificate = try await model.refreshSelfCertificate() }
            if snapshot.uncertainMutation { try await model.recover() }
            let directory = try await model.directory(prepareHost: { certificate in
                _ = try await ScreenCommunityCommand(.commit, certificate: certificate.envelope).call()
            }), certificate = try await model.certificate()
            let signer = try SecureEnclaveTranscriptSigner(dataRepresentation: blob)
            let preferences = try routePreferences()
            let targets = try directory.viewerTargets(controllerKeyBlob: blob, controllerPublicKey: signer.publicKey).map {
                try preferences.applying(to: $0, communityID: directory.communityID)
            }
            guard directory.members.first(where: { $0.enrollmentID == directory.selfEnrollmentID })?.admin == certificate.member.admin else { throw ScreenCommunityError.staleRevision }
            unified?.validateReviewContext(certificate: certificate, revision: directory.revision)
            self.certificate = certificate; self.directory = directory; self.targets = targets
            actionMessageLocked = false; message = "\(certificate.member.name) 등록 완료 · \(directory.name) · 연결할 다른 Mac \(unified?.hasEnrollmentPlan == true ? commonTargets.count : targets.count)대 · 기기마다 다시 등록하지 않습니다."
            expiry?.cancel()
            expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, directory.expiresAt.timeIntervalSinceNow)))
                guard !Task.isCancelled, let self else { return }
                self.targets = []; self.directory = nil; self.removing = nil; self.message = "커뮤니티 연결 확인이 만료됐습니다. 다시 연결되면 목록을 갱신합니다."; self.publish()
            }
            if certificate.member.admin {
                let response = try await model.pendingRequests()
                let a = try response.enrollmentFields(expectedKind: "pending-list", count: 7)
                guard a[4].string == certificate.communityID else { throw ScreenCommunityError.wrongCommunity }
                pending = (a[6].array ?? []).compactMap { row in
                    guard let r = row.array, r.count == 8, let id = r[0].string, UUID(uuidString: id)?.uuidString.lowercased() == id,
                          let name = r[1].string, RegistrationInvite.isShowableName(name), let platform = r[5].string else { return nil }
                    return (id, name, platform)
                }
            } else { pending = [] }
        } catch {
            unified?.validateReviewContext(certificate: nil)
            unified?.pendingUnavailable()
            if case ScreenCommunityError.service(let code) = error, ["NOT_ENROLLED", "REGISTRATION_REVOKED"].contains(code) {
                targets = []; certificate = nil; directory = nil; removing = nil; pending = []; expiry?.cancel(); unified?.endLocally()
            }
            if targets.isEmpty, !actionMessageLocked, !busy { message = Self.describe(error) }
        }
        resume(); publish()
    }
    func loadReview(_ id: String) async {
        guard !busy, let model else { return }; busy = true; publish()
        defer { busy = false; publish() }
        do { review = try await model.review(pendingID: id) }
        catch { message = Self.describe(error) }
    }
    func approve(_ proof: HumanProof) async {
        guard !busy, let model, let review, let blob else { return }; busy = true; publish()
        defer { busy = false; publish() }
        adminEpoch &+= 1; let epoch = adminEpoch
        do {
            let snapshot = await model.snapshot()
            guard !snapshot.uncertainMutation else { message = Self.describe(ScreenCommunityError.service("RECOVER_EXISTING_REQUEST")); return }
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: blob, reason: "‘\(review.device.name)’의 커뮤니티 원격 접근 등록을 승인합니다")
            guard adminEpoch == epoch, !Task.isCancelled else { return }
            // A phone/pad chosen here becomes the owner's approval device; the button explicitly says so.
            try await model.approve(review, grant: review.device.grant, administrator: review.device.platform == "ios", approvedSigner: signer)
            self.review = nil; message = "기기를 등록했습니다. 모든 커뮤니티 Mac에서 같은 등록을 사용합니다."; await refresh()
        } catch { message = Self.describe(error) }
    }
    func dismissReview() { review = nil; publish() }
    func reviewRemoval(_ member: ScreenCommunityMember?) { cancelAdministratorAction(); removing = member; publish() }
    private func routePreferences() throws -> ScreenCommunityRoutePreferences {
        guard let data = try routesBackend.read() else { return ScreenCommunityRoutePreferences() }
        return try JSONDecoder().decode(ScreenCommunityRoutePreferences.self, from: data)
    }
    func saveRoute(for target: ViewerTarget, address: ScreenPrivateNetworkRoute?, selection: ViewerTarget.Route? = nil, _ proof: HumanProof) throws {
        guard let directory, directory.isCurrent(at: Date()), targets.contains(where: { $0.id == target.id && $0.hostPublicKey == target.hostPublicKey }) else { throw ScreenCommunityError.wrongCommunity }
        var preferences = try routePreferences()
        try preferences.save(address: address, selection: selection, communityID: directory.communityID, hostKey: target.hostPublicKey)
        try routesBackend.write(JSONEncoder().encode(preferences))
        targets = try targets.map { try preferences.applying(to: $0, communityID: directory.communityID) }; publish()
    }
    func revoke(_ proof: HumanProof) async {
        guard !busy, let model, let removing, let directory, let blob else { return }
        busy = true; publish(); defer { busy = false; publish() }
        adminEpoch &+= 1; let epoch = adminEpoch
        do {
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: blob, reason: "‘\(removing.name)’의 모든 커뮤니티 Mac 접근 권한을 해제합니다")
            guard adminEpoch == epoch, self.removing == removing, self.directory?.revision == directory.revision, !Task.isCancelled else { return }
            try await model.revoke(removing, directory: directory, approvedSigner: signer)
            self.removing = nil; await refresh()
        } catch { message = Self.describe(error) }
    }
    func leave() async {
        guard !busy, let model else { return }; busy = true; publish(); defer { busy = false; publish() }
        do { try await model.leave(); unified?.endLocally(); targets = []; certificate = nil; directory = nil; pending = []; expiry?.cancel(); message = "이 Mac의 커뮤니티 원격 접근 등록을 해제했습니다." }
        catch { message = Self.describe(error) }
        if (await model.snapshot()).locallyLeft == true {
            componentGeneration &+= 1; unified?.endLocally(); controlReady = false
            targets = []; directory = nil; expiry?.cancel()
            do { try await CommunityEnrollmentTransport.disableControlAccess() }
            catch { message += " Control의 즉시 중단을 확인하지 못했습니다. 새 갱신은 중단했으며, 이미 전달된 권한은 최대 90초 남을 수 있습니다. Control에서도 직접 중단 상태를 확인하세요." }
            // Only lowers this host's authority, including when the central leave reply was lost.
            do { _ = try await ScreenCommunityCommand(.withdraw).call() }
            catch { message += " Screen의 커뮤니티 수신 상태도 확인해 주세요." }
        }
    }
    static func describe(_ error: Error) -> String {
        if case ScreenCommunityError.notConfigured = error { return "커뮤니티 등록 서비스의 배포 설정을 준비 중입니다. 기존 직접 등록은 계속 사용할 수 있습니다." }
        if case ScreenCommunitySocketError.unavailable = error { return "커뮤니티 등록을 지원하는 AgentsToZ Screen을 먼저 열어 주세요." }
        if case ScreenCommunityError.service(let code) = error {
            switch code {
            case "CONTROL_KEY_NOT_READY": return "통신·Teams·에포트·브라우저 등록을 준비하지 못했습니다. 최신 AgentsToZ와 Control을 열고 다시 요청하세요. 해당 기능을 빼고 먼저 등록할 수도 있습니다."
            case "REGISTRATION_CODE_CONFIRMATION_REQUIRED": return "상대 기기의 등록 코드가 같은지 다시 확인한 뒤 승인해 주세요."
            case "NOT_ENROLLED": return "이 기기는 아직 커뮤니티 원격 접근에 등록되지 않았습니다. 관리 기기의 승인을 확인해 주세요."
            case "COMMUNITY_NOT_READY": return "첫 관리 Mac을 아직 등록하지 않았습니다. 이 Mac에서 커뮤니티를 만들거나 기존 관리 기기의 등록을 마쳐 주세요."
            case "BOOTSTRAP_REQUIRES_DEVICE_BINDING": return "관리 Mac의 공개키 설정을 확인해야 합니다. 준비된 기기 키를 서비스에 연결한 뒤 다시 시도하세요."
            case "RECOVER_EXISTING_REQUEST": return "이전 등록 요청의 결과를 확인 중입니다. 새 요청을 중복해서 보내지 않습니다."
            case "REQUEST_STILL_POSSIBLE": return "이전 요청이 아직 도착할 수 있어 결과를 확인 중입니다. 새 요청을 보내지 않습니다."
            case "REVIEW_CONTEXT_CHANGED": return "검토 정보가 바뀌었습니다. 요청과 관리 역할을 다시 선택해 주세요."
            case "BUSY": return "현재 등록 요청을 처리 중입니다. 잠시 뒤 다시 확인합니다."
            case "LAST_ADMIN": return "마지막 관리 기기는 나갈 수 없습니다. 다른 승인 기기를 먼저 등록해 주세요."
            case "LOCALLY_LEFT": return "이 기기의 접근을 중단했습니다. 이전 나가기 요청의 결과를 먼저 확인해 주세요."
            case "REQUEST_EXPIRED", "CODE_EXPIRED_OR_USED", "STALE_APPROVAL", "STALE_REGISTRATION": return "승인 정보가 만료되었거나 바뀌었습니다. 목록을 갱신한 뒤 다시 검토해 주세요."
            default: return "커뮤니티 등록을 확인하지 못했습니다(\(code)). 연결 상태를 확인한 뒤 다시 조회하세요."
            }
        }
        let detail = error as NSError
        if ["NSOSStatusErrorDomain", "com.apple.LocalAuthentication"].contains(detail.domain) {
            return "Mac 기기 인증을 시작하거나 완료하지 못했습니다(\(detail.domain):\(detail.code)). 현재 Mac의 잠금·Touch ID 사용 가능 상태를 확인해 주세요."
        }
        return "커뮤니티 등록을 확인하지 못했습니다. Screen 실행과 인터넷 연결을 확인해 주세요."
    }
}
#endif
