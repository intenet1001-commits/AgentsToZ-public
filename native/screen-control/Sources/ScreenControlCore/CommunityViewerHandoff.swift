import Foundation

/// A short-lived, single-consume local UI selection. It is not screen authority and is never received over CF.
public struct CommunityViewerHandoff:Codable,Sendable {
    public let version:Int,nonce:String,ownEnrollmentId:String,targetEnrollmentId:String,targetDeviceId:String,ownPolicyDigest:String,targetPolicyDigest:String,issuedAt:Int64,expiresAt:Int64
    public init(selection:CommunityDesktopScreenTrust,now:Date=Date())throws {
        guard selection.channelId==nil,selection.isCurrent(at:now) else {throw ScreenCommunityError.expired}
        version=1;nonce=UUID().uuidString.lowercased();ownEnrollmentId=selection.controller.enrollmentId;targetEnrollmentId=selection.receiver.enrollmentId;targetDeviceId=selection.receiver.deviceId
        ownPolicyDigest=try CommunityMobileControlPolicy.authorizationDigest(selection.controller);targetPolicyDigest=try CommunityMobileControlPolicy.authorizationDigest(selection.receiver)
        issuedAt=Int64(now.timeIntervalSince1970*1000);expiresAt=min(issuedAt+30_000,Int64(selection.expiresAt.timeIntervalSince1970*1000))
    }
    public func validate(authority:ScreenCommunityAuthority,own:CommunityAuthorization,target:CommunityAuthorization,now:Date=Date())throws {
        for id in [nonce,ownEnrollmentId,targetEnrollmentId,targetDeviceId] { _=try AccessValue.id(id) }
        guard version==1,expiresAt>Int64(now.timeIntervalSince1970*1000),expiresAt>issuedAt,expiresAt<=issuedAt+30_000,issuedAt<=Int64(now.timeIntervalSince1970*1000)+5_000,ownEnrollmentId==own.body.enrollmentId,targetEnrollmentId==target.body.enrollmentId,targetDeviceId==target.body.deviceId,
              ownPolicyDigest == (try CommunityMobileControlPolicy.authorizationDigest(own)),targetPolicyDigest == (try CommunityMobileControlPolicy.authorizationDigest(target)) else {throw ScreenCommunityError.wrongCommunity}
        _=try CommunityDesktopScreenTrust.verified(authority:authority,controller:own,receiver:target,now:now)
    }
}
