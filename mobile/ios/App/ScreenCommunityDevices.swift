import CryptoKit
import Foundation
import Observation
import ScreenControlCore
import Security
import SwiftUI
import UIKit

struct MobileCommunityAccount: Codable, Sendable {
    let deviceID: String
    let identityBlob: Data
    let viewerBlob: Data
    var enrollment: ScreenCommunityEnrollmentState?
}
enum MobileCommunityStore {
    private static var query: [String: Any] { [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.intenet.agentstoz.mobile.screen-community", kSecAttrAccount as String: "account-v1",
        kSecAttrSynchronizable as String: false] }
    static func read() throws -> MobileCommunityAccount? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return try JSONDecoder().decode(MobileCommunityAccount.self, from: data)
    }
    static func save(_ account: MobileCommunityAccount) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(account), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        } else if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    private static var routesQuery: [String: Any] { var value = query; value[kSecAttrAccount as String] = "routes-v1"; return value }
    static func routes() throws -> ScreenCommunityRoutePreferences {
        var q = routesQuery; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return ScreenCommunityRoutePreferences() }
        guard status == errSecSuccess, let data = item as? Data else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return try JSONDecoder().decode(ScreenCommunityRoutePreferences.self, from: data)
    }
    static func saveRoutes(_ value: ScreenCommunityRoutePreferences) throws {
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(value), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(routesQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(routesQuery.merging(attributes) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        } else if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

/// A phone/pad registers once; its one protected device key works with every verified Mac in its community.
/// Existing pairwise registrations remain separate. Peer entries below are ephemeral signed-directory projections.
@MainActor @Observable final class MobileScreenCommunity {
    static let shared = MobileScreenCommunity()
    let unified = MobileUnifiedEnrollment()
    private(set) var macs: [SavedScreenMac] = []
    private(set) var review: ScreenCommunityReview?
    private(set) var pending: [(id: String, name: String)] = []
    private(set) var message = "커뮤니티에 한 번 등록하면 등록된 Mac들이 함께 표시됩니다."
    private(set) var registered = false
    private(set) var administrator = false
    private(set) var managementStatus = "관리 역할 조회 전"
    private(set) var directory: ScreenCommunityDirectory?
    private(set) var certificate: ScreenCommunityCertificate?
    private var actionEpoch = 0
    @ObservationIgnored private let reviewLifecycle = CommunityReviewLifecycle()
    private(set) var busy = false
    @ObservationIgnored private var account: MobileCommunityAccount?
    @ObservationIgnored private var model: ScreenCommunityEnrollment?
    @ObservationIgnored private var polling: Task<Void, Never>?
    @ObservationIgnored private var expiry: Task<Void, Never>?

    private func prepare(create: Bool) throws -> ScreenCommunityEnrollment? {
        if let model { return model }
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let account: MobileCommunityAccount
        if let stored = try MobileCommunityStore.read() { account = stored }
        else {
            guard create else { return nil }
            var error: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else { throw ScreenCommunityError.malformed }
            account = MobileCommunityAccount(deviceID: UUID().uuidString.lowercased(),
                identityBlob: try SecureEnclave.P256.Signing.PrivateKey(accessControl: access).dataRepresentation,
                viewerBlob: try FaceIDApprovedSigner.createDeviceKey(), enrollment: nil)
            try MobileCommunityStore.save(account)
        }
        let identity = try SecureEnclaveTranscriptSigner(dataRepresentation: account.identityBlob)
        let viewer = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: account.viewerBlob).publicKey
        let name = RegistrationInvite.isShowableName(UIDevice.current.name) ? UIDevice.current.name : "iPhone·iPad"
        let model = try ScreenCommunityEnrollment(authority: authority,
            device: ScreenCommunityDevice(id: account.deviceID, name: name, platform: "ios", grant: .none),
            identity: identity, viewerKey: viewer.x963Representation, state: account.enrollment,
            save: { state in
                try MobileCommunityStore.save(MobileCommunityAccount(deviceID: account.deviceID, identityBlob: account.identityBlob, viewerBlob: account.viewerBlob, enrollment: state))
            })
        self.model = model; self.account = account; return model
    }
    func resume() {
        guard polling == nil, ScreenCommunityAuthority.configured != nil,
              let saved = try? MobileCommunityStore.read(), (saved.enrollment?.automaticRefreshInterval() != nil || unified.hasEnrollmentPlan) else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if !self.busy { await self.refresh() }
                guard let model = self.model else { self.polling = nil; return }
                let interval = (await model.snapshot()).automaticRefreshInterval() ?? (self.unified.isWaitingForApproval ? 3 : nil)
                guard let interval else { self.polling = nil; return }
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }
    func requestUnified() async {
        do { _ = try prepare(create: true); if let account { await unified.request(account: account) }; resume() }
        catch { message = Self.describe(error) }
    }
    func requireUnifiedUse(for capability: CommunityCapability = .screenView) async throws -> (CommunityAuthorization, CommunityUseSession) {
        guard !busy else { throw ScreenCommunityError.service("BUSY") }
        busy = true; defer { busy = false }
        guard let model = try prepare(create: false), let account else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        guard (await model.snapshot()).locallyLeft != true else { throw ScreenCommunityError.service("LOCALLY_LEFT") }
        let result = try await unified.requireUse(account: account, for: capability)
        guard (await model.snapshot()).locallyLeft != true else { unified.endLocally(); throw ScreenCommunityError.service("LOCALLY_LEFT") }
        return result
    }
    func screenTicket(connectionId: String) async throws -> CommunityRelayTicket { try await unified.screenTicket(connectionID: connectionId) }
    func startUnifiedUse() async {
        guard let model, (await model.snapshot()).locallyLeft != true else { message = Self.describe(ScreenCommunityError.service("LOCALLY_LEFT")); return }
        if let account { await unified.startUse(account: account) }
    }
    func refreshUnified() async { cancelUnifiedReview(); await refresh() }
    func cancelUnifiedReview() { reviewLifecycle.cancel(); unified.cancelReview() }
    func loadUnifiedReview(_ id: String, choice: CommunityManagementChoice = .unchanged, notice: CommunityAccessNotice? = nil) async {
        guard !busy, !unified.busy, let account, let model, let expected = certificate else { return }
        busy = true; defer { busy = false }
        do {
            let current = try await reviewLifecycle.freshCertificate { try await model.refreshSelfCertificate() }
            guard current.communityID == expected.communityID, current.member.enrollmentID == expected.member.enrollmentID,
                  current.member.hostKey == expected.member.hostKey, current.member.viewerKey == expected.member.viewerKey,
                  current.member.keyEpoch == expected.member.keyEpoch else { throw ScreenCommunityError.service("REVIEW_CONTEXT_CHANGED") }
            certificate = current; administrator = current.member.admin; managementStatus = current.member.admin ? "등록 승인 기기" : "등록됨 · 승인 역할 없음"
            await unified.loadReview(id, account: account, certificate: current, choice: choice, notice: notice)
        } catch { unified.cancelReview(); message = Self.describe(error) }
    }
    func approveUnified(confirmedDigest: String) async { if let account, let certificate { await unified.approve(account: account, certificate: certificate, confirmedDigest: confirmedDigest); await refresh() } }
    func refreshCommonSafety() async { if let account { await unified.refreshSafety(account:account) } }
    func stopCommonSafety(_ target:CommunityAuthorization,action:CommunitySafetyAction,targetEnrollmentId:String?=nil) async {
        guard administrator,let account else { return }
        await unified.stopSafety(account:account,target:target,action:action,targetEnrollmentId:targetEnrollmentId)
    }
    func readCommonSafetyResult(_ record:MobileSafetyPending) async { if let account { await unified.readSafetyResult(account:account,record:record) } }
    func receiveSafetyNotice(_ envelope:ScreenCommunityEnvelope) {
        guard let authority=ScreenCommunityAuthority.configured,let notice=try? CommunitySafetyNotice.verify(envelope,authority:authority),notice.communityId==certificate?.communityID else { return }
        message="등록한 Mac의 화면 연결·보안 알림입니다. 공통 원격 중지 화면에서 현재 상태를 확인하세요."
        // A notice is display-only: no permission prompt, use episode, session or stop starts here.
    }
    func join() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard let model = try prepare(create: true) else { return }
            if (await model.snapshot()).submittedID != nil { try await model.recover() }
            else { try await model.join(communityID: model.discover()) }
            message = "등록을 요청했습니다. 기존 관리 Mac 또는 승인용 모바일 기기에서 한 번 승인해 주세요."; resume()
        } catch { message = Self.describe(error) }
    }
    func refresh() async {
        var unifiedRefreshSucceeded = false
        var legacyCertificateLookupFailed = false
        do {
            guard let model = try prepare(create: false), let account else { return }
            let original = await model.snapshot()
            if original.uncertainMutation { try await model.recover() }
            do { certificate = try await model.refreshSelfCertificate(); administrator = certificate?.member.admin == true; managementStatus = administrator ? "등록 승인 기기" : "등록됨 · 승인 역할 없음" }
            catch ScreenCommunityError.service(let code) where ["NOT_ENROLLED", "COMMUNITY_NOT_READY"].contains(code) { certificate = nil; administrator = false; managementStatus = "이 기기 등록 전" }
            unified.validateReviewContext(certificate: certificate)
            if let recovered = try? await model.certificate() { certificate = recovered }
            try await unified.refresh(account: account, legacy: certificate)
            unifiedRefreshSucceeded = true
            await unified.syncSafetyNotifications(account:account,certificate:certificate,requestPermission:false)
            if unified.useSession.isUsable { try await unified.refreshScreenTargets() }
            let snapshot = await model.snapshot()
            if (try? await model.certificate()) == nil {
                legacyCertificateLookupFailed = true
                certificate = try await model.refreshSelfCertificate()
                legacyCertificateLookupFailed = false
            }
            if snapshot.uncertainMutation { try await model.recover() }
            let directory = try await model.directory(), certificate = try await model.certificate()
            let preferences = try MobileCommunityStore.routes()
            macs = try directory.members.filter { $0.enrollmentID != directory.selfEnrollmentID && $0.platform == "mac" && $0.grant != .none }.map { member in
                let host = try P256.Signing.PublicKey(x963Representation: member.hostKey), fingerprint = ScreenControlIdentity.fingerprint(of: host)
                var mac = SavedScreenMac(id: fingerprint.map { String(format: "%02x", $0) }.joined(), macName: member.name,
                    macPublicKey: member.hostKey, hostName: ScreenNearby.screenService(fingerprint: fingerprint), address: member.route ?? "",
                    port: ScreenPrivateNetworkRoute.port, deviceKey: account.viewerBlob, deviceName: UIDevice.current.name, registeredAt: member.joinedAt,
                    nearbyService: ScreenNearby.screenService(fingerprint: fingerprint), privateNetwork: try preferences.address(published: member.route.flatMap { try? ScreenPrivateNetworkRoute(address: $0) }, communityID: directory.communityID, hostKey: member.hostKey))
                mac.communityID = directory.communityID; mac.communityGrant = member.grant.rawValue
                return mac
            }
            guard directory.members.first(where: { $0.enrollmentID == directory.selfEnrollmentID })?.admin == certificate.member.admin else { throw ScreenCommunityError.staleRevision }
            unified.validateReviewContext(certificate: certificate, revision: directory.revision)
            registered = true; administrator = certificate.member.admin; self.directory = directory; self.certificate = certificate
            message = "\(directory.name) · Mac \(macs.count)대 · 각 Mac을 따로 등록하지 않습니다."
            expiry?.cancel()
            expiry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(max(0, directory.expiresAt.timeIntervalSinceNow)))
                guard !Task.isCancelled, let self else { return }
                self.macs = []; self.directory = nil; self.message = "커뮤니티 연결 확인이 만료됐습니다. 인터넷 연결을 확인해 주세요."
            }
            try await unified.refreshPending(account: account, certificate: certificate)
            if administrator {
                let a = try await model.pendingRequests().enrollmentFields(expectedKind: "pending-list", count: 7)
                pending = (a[6].array ?? []).compactMap { row in
                    guard let r = row.array, r.count == 8, let id = r[0].string, UUID(uuidString: id)?.uuidString.lowercased() == id,
                          let name = r[1].string, RegistrationInvite.isShowableName(name) else { return nil }; return (id, name)
                }
            } else { pending = [] }
        } catch {
            administrator = false; managementStatus = "관리 역할 조회 실패 · 새로 고침 필요"; unified.validateReviewContext(certificate: nil)
            unified.pendingUnavailable()
            if case ScreenCommunityError.service(let code) = error, ["NOT_ENROLLED", "REGISTRATION_REVOKED"].contains(code) {
                let preservePending = unified.pendingRegistrationPresentation?.preservesPending(afterLegacyError: code,
                    unifiedRefreshSucceeded: unifiedRefreshSucceeded, legacyCertificateLookupFailed: legacyCertificateLookupFailed,
                    hasAuthorization: unified.authorization != nil) == true
                if preservePending { managementStatus = "관리 기기 등록 승인 대기 · 승인 역할 없음"; unified.pendingRegistrationOnly() }
                else { unified.endLocally() }
                macs = []; registered = false; administrator = false; directory = nil; certificate = nil; pending = []; expiry?.cancel()
                if preservePending { message = unified.message; return }
            }
            if macs.isEmpty { message = Self.describe(error) }
        }
    }
    func receive(_ envelope: ScreenCommunityEnvelope) async {
        do {
            guard let model = try prepare(create: false), let authority = ScreenCommunityAuthority.configured else { return }
            switch try CommunityEnrollmentNoticeRoute.classify(envelope) {
            case .legacy:
                let id = try await model.pendingFromNotification(envelope); await showReview(id)
            case .access:
                let notice = try CommunityAccessNotice.verify(envelope, authority: authority)
                let current = try await reviewLifecycle.freshCertificate { try await model.refreshSelfCertificate() }; certificate = current; administrator = current.member.admin; managementStatus = current.member.admin ? "등록 승인 기기" : "등록됨 · 승인 역할 없음"
                guard current.member.admin, current.communityID == notice.communityId else { throw ScreenCommunityError.wrongCommunity }
                // An incoming notice must not replace an unrelated review or erase an explicit management choice.
                if let active = unified.review, active.planId != notice.planId {
                    message = "새 기능 등록 요청이 있습니다. 현재 검토를 마친 뒤 등록 요청 목록을 확인하세요."; return
                }
                await loadUnifiedReview(notice.planId, choice: unified.review == nil ? .unchanged : unified.managementChoice, notice: notice)
                guard unified.review?.planId == notice.planId else { return }
                guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
                      var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
                while let next = presenter.presentedViewController { presenter = next }
                presenter.present(UIHostingController(rootView: ScreenUnifiedEnrollmentView()), animated: true)
            }
        } catch { message = "만료되었거나 확인할 수 없는 등록 알림입니다. 앱에서 등록 요청을 새로 확인해 주세요." }
    }
    func showReview(_ id: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            guard let model = try prepare(create: false) else { return }
            review = try await model.review(pendingID: id)
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
                  var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
            while let next = presenter.presentedViewController { presenter = next }
            presenter.present(UIHostingController(rootView: ScreenCommunityApprovalView()), animated: true)
        } catch { message = Self.describe(error) }
    }
    func approve() async -> Bool {
        guard !busy, let model, let account, let review else { return false }; busy = true; defer { busy = false }
        do {
            guard !(await model.snapshot()).uncertainMutation else { message = Self.describe(ScreenCommunityError.service("RECOVER_EXISTING_REQUEST")); return false }
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: account.viewerBlob, reason: "‘\(review.device.name)’의 커뮤니티 원격 접근 등록을 승인합니다")
            guard self.review?.pendingID == review.pendingID, !Task.isCancelled else { return false }
            try await model.approve(review, grant: review.device.grant, administrator: review.device.platform == "ios", approvedSigner: signer)
            self.review = nil; await refresh(); return true
        } catch { message = Self.describe(error); return false }
    }
    func subscribe() async {
        guard !busy, let model, let account else { return }; busy = true; defer { busy = false }
        do {
            if unified.hasEnrollmentPlan {
                try await unified.refresh(account:account,legacy:certificate)
                await unified.syncSafetyNotifications(account:account,certificate:certificate,requestPermission:true)
                message=unified.safetyMessage;return
            }
            let token = try await ScreenPushCenter.shared.communityDeviceToken()
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: account.viewerBlob, reason: "이 기기에서 AgentsToZ 커뮤니티의 새 기기 등록을 승인합니다")
            try await model.subscribe(token: token, environment: ScreenPushConfig.environment == .sandbox ? "sandbox" : "production", topic: ScreenPushConfig.topic, approvedSigner: signer)
            message = "새 기기 등록 요청을 알림으로 받습니다. 승인하면 모든 등록 Mac에서 같은 기기를 사용할 수 있습니다."
        } catch { message = Self.describe(error) }
    }
    func dismissReview() { review = nil }
    func cancelManagement() { actionEpoch &+= 1; cancelUnifiedReview() }
    func saveRoute(for mac: SavedScreenMac, route: ScreenPrivateNetworkRoute?) throws {
        guard let directory, directory.isCurrent(at: Date()), mac.communityID == directory.communityID,
              macs.contains(where: { $0.id == mac.id && $0.macPublicKey == mac.macPublicKey }) else { throw ScreenCommunityError.wrongCommunity }
        var preferences = try MobileCommunityStore.routes()
        try preferences.save(address: route, communityID: directory.communityID, hostKey: mac.macPublicKey)
        try MobileCommunityStore.saveRoutes(preferences)
        macs = macs.map { value in var next = value; if value.id == mac.id { next.privateNetwork = route }; return next }
    }
    func revoke(_ member: ScreenCommunityMember) async {
        guard !busy, let model, let account, let directory else { return }
        busy = true; defer { busy = false }; actionEpoch &+= 1; let epoch = actionEpoch
        do {
            let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: account.viewerBlob, reason: "‘\(member.name)’의 모든 커뮤니티 Mac 접근 권한을 해제합니다")
            guard epoch == actionEpoch, self.directory?.revision == directory.revision, !Task.isCancelled else { return }
            try await model.revoke(member, directory: directory, approvedSigner: signer); await refresh()
        } catch { message = Self.describe(error) }
    }
    func leave() async {
        guard !busy, let model else { return }; busy = true; defer { busy = false }
        do {
            try await model.leave(); unified.endLocally(); registered = false; administrator = false; certificate = nil; pending = []
            message = "이 기기의 커뮤니티 원격 접근 등록을 해제했습니다. 다시 참여하려면 새 승인이 필요합니다."
        } catch { message = Self.describe(error) }
        if (await model.snapshot()).locallyLeft == true { macs = []; directory = nil; expiry?.cancel() }
    }
    static func describe(_ error: Error) -> String {
        if case ScreenCommunityError.notConfigured = error { return "커뮤니티 원격 접근 서비스 설정을 준비 중입니다. 기존 Mac 등록은 계속 사용할 수 있습니다." }
        if case ScreenCommunityError.service(let code) = error {
            switch code {
            case "NOT_ENROLLED": return "관리 기기의 등록 승인을 기다리는 중입니다."
            case "REGISTRATION_CODE_CONFIRMATION_REQUIRED": return "상대 기기의 등록 코드가 같은지 다시 확인한 뒤 승인해 주세요."
            case "COMMUNITY_NOT_READY": return "먼저 관리 Mac에서 커뮤니티 등록을 완료해 주세요."
            case "PUSH_NOT_CONFIGURED": return "서비스의 모바일 알림 설정이 아직 준비되지 않았습니다. 앱 안의 등록 요청 목록을 사용할 수 있습니다."
            case "REQUEST_STILL_POSSIBLE": return "이전 요청이 아직 도착할 수 있어 결과를 확인 중입니다. 새 요청을 보내지 않습니다."
            case "REVIEW_CONTEXT_CHANGED": return "검토 정보가 바뀌었습니다. 요청과 관리 역할을 다시 선택해 주세요."
            case "RECOVER_EXISTING_REQUEST": return "이전 등록 요청의 결과를 확인 중입니다. 같은 요청을 중복 실행하지 않습니다."
            case "REQUEST_EXPIRED": return "등록 요청이 만료되었습니다. 요청한 기기에서 등록을 다시 요청한 뒤 관리 기기에서 새 요청을 검토해 주세요."
            case "STALE_APPROVAL": return "승인 검토 정보가 바뀌었거나 만료되었습니다. 등록 요청 목록을 새로 고치고 해당 요청을 다시 검토해 주세요."
            case "STALE_REGISTRATION": return "등록 정보가 바뀌었습니다. 등록 상태를 새로 고친 뒤 다시 진행해 주세요."
            case "LAST_ADMIN": return "마지막 관리 기기는 나갈 수 없습니다. 다른 승인 기기를 먼저 등록해 주세요."
            case "LOCALLY_LEFT": return "이 기기의 접근을 중단했습니다. 이전 나가기 요청의 결과를 먼저 확인해 주세요."
            default: return "커뮤니티 등록을 확인하지 못했습니다(\(code)). 다시 조회해 주세요."
            }
        }
        return "커뮤니티에 연결하지 못했습니다. 인터넷 연결과 기기 인증 상태를 확인해 주세요."
    }
}

struct ScreenCommunityControls: View {
    @State private var center = MobileScreenCommunity.shared
    @State private var managing = false
    @State private var enrolling = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("아젠투지 커뮤니티", systemImage: "person.3.fill").font(.headline)
            Text(center.message).font(.subheadline).foregroundStyle(.secondary)
            Text(center.unified.pendingStatus).font(.caption).foregroundStyle(.secondary)
            ForEach(center.unified.pending, id: \.id) { item in
                Button("\(item.name) · 기능 등록 검토") { enrolling = true; Task { await center.loadUnifiedReview(item.id) } }.disabled(center.busy || center.unified.busy)
            }
            Button("기능 한 번에 등록·공통 사용 인증…") { enrolling = true }.disabled(center.busy)
            if center.unified.authorization != nil, !center.unified.useSession.isUsable {
                Button("한 번 인증하고 커뮤니티 Mac 사용") { Task { await center.startUnifiedUse() } }.disabled(center.busy || center.unified.busy)
            }
            if center.administrator { Button("새 기기 승인 알림 받기") { Task { await center.subscribe() } }.disabled(center.busy) }
            if center.registered { Button("등록 기기 관리…") { managing = true } }
            ForEach(center.pending, id: \.id) { pending in Button("\(pending.name) · 등록 요청 검토") { Task { await center.showReview(pending.id) } }.disabled(center.busy) }
        }
        .accessibilityIdentifier("screenCommunityDevices")
        .onAppear { center.resume() }
        .sheet(isPresented: $managing) { ScreenCommunityManagementView() }
        .sheet(isPresented: $enrolling) { ScreenUnifiedEnrollmentView() }
    }
}
private struct ScreenCommunityManagementView: View {
    @State private var center = MobileScreenCommunity.shared
    @State private var removing: ScreenCommunityMember?
    @State private var leaving = false
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                Text(center.message).font(.subheadline).foregroundStyle(.secondary)
                if let directory = center.directory {
                    ForEach(directory.members, id: \.enrollmentID) { member in
                        VStack(alignment: .leading) {
                            Text(member.name)
                            Text(member.platform == "ios" ? "iPhone·iPad" : "Mac").font(.caption).foregroundStyle(.secondary)
                            if center.administrator, member.enrollmentID != directory.selfEnrollmentID {
                                Button("이 기기 등록 해제…", role: .destructive) { removing = member }.disabled(center.busy)
                            }
                        }
                    }
                }
                Button("이 기기 커뮤니티 등록 해제…", role: .destructive) { leaving = true }.disabled(center.busy)
            }.navigationTitle("커뮤니티 등록 기기")
                .toolbar { Button("닫기") { center.cancelManagement(); dismiss() } }
                .onDisappear { center.cancelManagement() }
                .confirmationDialog("‘\(removing?.name ?? "")’의 등록을 해제할까요?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                    if let member = removing { Button("인증하고 등록 해제", role: .destructive) { Task { await center.revoke(member); removing = nil } } }
                    Button("취소", role: .cancel) { removing = nil }
                } message: {
                    Text("모든 커뮤니티 Mac에 대한 접근이 해제됩니다. 연결 중인 화면은 목록 갱신 또는 최대 90초 이내에 닫힙니다.")
                }
                .confirmationDialog("이 기기의 커뮤니티 등록을 해제할까요?", isPresented: $leaving, titleVisibility: .visible) {
                    Button("이 기기 등록 해제", role: .destructive) { Task { await center.leave() } }
                } message: { Text("다시 참여하려면 새 승인이 필요합니다. 마지막 관리 기기는 먼저 다른 승인 기기를 등록해야 합니다.") }
        }
    }
}
private struct ScreenCommunityApprovalView: View {
    @State private var center = MobileScreenCommunity.shared
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 18) {
                if let review = center.review {
                    Text(review.device.name).font(.title2.bold())
                    Text(review.device.platform == "ios" ? "이 기기를 등록하고 새 기기 등록을 승인하는 모바일 기기로 사용합니다." : "이 Mac을 커뮤니티에 등록합니다. 등록된 기기끼리 화면에 연결할 수 있습니다.")
                    Text("기기 키 \(review.fingerprint)").font(.caption.monospaced())
                    Text("본인이 참여시킨 기기인지 확인해 주세요. 실제 화면 연결은 각 Mac의 수신 허용과 권한을 따릅니다.")
                    Button(review.device.platform == "ios" ? "등록하고 승인 기기로 사용" : "이 기기 등록 승인") {
                        Task { if await center.approve() { dismiss() } }
                    }.buttonStyle(.borderedProminent).disabled(center.busy)
                }
                Text(center.message).font(.subheadline).foregroundStyle(.secondary)
            }.padding().onDisappear { center.dismissReview() }.navigationTitle("커뮤니티 기기 등록")
                .toolbar { Button("닫기") { center.dismissReview(); dismiss() } }
        }
    }
}
