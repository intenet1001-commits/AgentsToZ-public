import Foundation
import CryptoKit
import CoreFoundation

/// No role change is the default. Selecting all execution features never selects management.
public enum CommunityManagementChoice: String, CaseIterable, Sendable {
    case unchanged, grant, revoke
    public var administrator: Bool? { switch self { case .unchanged: nil; case .grant: true; case .revoke: false } }
    public var title: String { switch self { case .unchanged: "관리 역할 변경 안 함"; case .grant: "이 모바일을 등록 승인 기기로 지정"; case .revoke: "이 모바일의 등록 승인 역할 해제" } }
}
public struct CommunityManagementIntent: Equatable, Sendable {
    public let version: Int, communityId: String, targetEnrollmentId: String?
    public let targetKeyEpoch: Int64, previousAdministrator: Bool, administrator: Bool, issuedAt: Int64
    public let nonce: String, digest: String
    public func bytes(for review: CommunityAccessReview) throws -> Data {
        Data("agentstoz.community-access.management/v1\0".utf8) + (try JSONSerialization.data(withJSONObject: [version,communityId,review.admin,review.planId,review.digest,
            review.plan.deviceId,review.plan.hostKey,review.plan.biometricKey,review.plan.operationKey,review.plan.controlKey as Any? ?? NSNull(),review.plan.agentDeviceId as Any? ?? NSNull(),review.revision,
            targetEnrollmentId as Any? ?? NSNull(),targetKeyEpoch,previousAdministrator,administrator,review.challenge,issuedAt,review.expiresAt,nonce],options:.withoutEscapingSlashes))
    }
    public func computedDigest(for review: CommunityAccessReview) throws -> String { SHA256.hash(data: try bytes(for: review)).map { String(format:"%02x",$0) }.joined() }
}
public extension CommunityAccessReview {
    var approvalOperation: CommunityAccessRequest.Operation { management == nil ? .approve : .approveManagement }
    var hasValidManagementBinding: Bool { guard let management else { return true }; return (try? management.computedDigest(for:self)) == management.digest }
    func approvalArguments(communityId: String) throws -> Data {
        guard hasValidManagementBinding, management == nil || management?.communityId == communityId else { throw ScreenCommunityError.wrongCommunity }
        let values:[Any] = [communityId,planId,digest,challenge,revision] + (management.map { [$0.digest] } ?? [])
        return try JSONSerialization.data(withJSONObject:values,options:.withoutEscapingSlashes)
    }
}
public extension CommunityAccessReply {
    /// Never sign an opaque management digest: every field is issuer-verified and recomputed locally.
    func managementReview(authority: ScreenCommunityAuthority, administrator: ScreenCommunityCertificate, now: Date = Date()) throws -> CommunityAccessReview {
        let pinned=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        let ownCertificate=try ScreenCommunityResponse.verify(administrator.envelope,issuer:authority.issuer,now:now).certificate(profileID:authority.profileID,deviceID:administrator.member.deviceID,hostKey:administrator.member.hostKey,viewerKey:administrator.member.viewerKey,now:now)
        guard pinned.kind == "management-review",ownCertificate.member.admin,ownCertificate.communityID==administrator.communityID,
              ownCertificate.member.enrollmentID==administrator.member.enrollmentID else { throw ScreenCommunityError.wrongCommunity }
        let object=try AccessValue.object(pinned.value,["admin","planId","digest","revision","challenge","expiresAt","plan","management"])
        var base=object; base.removeValue(forKey:"management")
        let normal=CommunityAccessReply(kind:"review",requestId:pinned.requestId,issuedAt:pinned.issuedAt,envelope:pinned.envelope,value:base)
        let review=try normal.review(authority:authority,adminId:administrator.member.enrollmentID,now:now)
        let raw=try AccessValue.object(object["management"] as Any,["version","communityId","targetEnrollmentId","targetKeyEpoch","previousAdministrator","administrator","issuedAt","nonce","digest"])
        func bool(_ value:Any?) throws -> Bool {
            guard let number=value as? NSNumber, CFGetTypeID(number)==CFBooleanGetTypeID() else { throw ScreenCommunityError.malformed };return number.boolValue
        }
        let target=raw["targetEnrollmentId"] is NSNull ? nil : try AccessValue.id(raw["targetEnrollmentId"] as Any)
        let intent=CommunityManagementIntent(version:Int(try AccessValue.integer(raw["version"] as Any)),communityId:try AccessValue.id(raw["communityId"] as Any),targetEnrollmentId:target,
            targetKeyEpoch:try AccessValue.integer(raw["targetKeyEpoch"] as Any),previousAdministrator:try bool(raw["previousAdministrator"]),administrator:try bool(raw["administrator"]),
            issuedAt:try AccessValue.integer(raw["issuedAt"] as Any),nonce:raw["nonce"] as? String ?? "",digest:raw["digest"] as? String ?? "")
        let own=administrator.member
        guard intent.version==1,intent.communityId==administrator.communityID,intent.targetKeyEpoch>0,intent.issuedAt==pinned.issuedAt,
              intent.issuedAt<=Int64(now.timeIntervalSince1970*1000)+5_000,intent.issuedAt>=Int64(now.timeIntervalSince1970*1000)-60_000,
              intent.administrator != intent.previousAdministrator, review.plan.kind == .mobile,
              target != own.enrollmentID,review.plan.deviceId != own.deviceID,
              ![review.plan.hostKey,review.plan.biometricKey].contains(ScreenCommunityRequest.base64(own.hostKey)),
              ![review.plan.hostKey,review.plan.biometricKey].contains(ScreenCommunityRequest.base64(own.viewerKey)),
              target != nil || (!intent.previousAdministrator && intent.administrator && intent.targetKeyEpoch==1),
              try ScreenCommunityRequest.decodeBase64(intent.nonce,max:43).count==32,
              intent.digest.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,
              try intent.computedDigest(for:review)==intent.digest else { throw ScreenCommunityError.wrongCommunity }
        return CommunityAccessReview(plan:review.plan,planId:review.planId,admin:review.admin,digest:review.digest,challenge:review.challenge,revision:review.revision,expiresAt:review.expiresAt,management:intent)
    }
}
