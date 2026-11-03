import Foundation
import CryptoKit

/// A fresh, issuer-signed owner lookup proved there is neither this plan's live request nor a registered policy.
/// It can release an expired *prepare* fence, never an uncertain approval or other mutation.
public struct CommunityRegistrationAbsence: Sendable {
    public let communityId:String,profileId:String,deviceId:String,planDigest:String,issuedAt:Int64
    public let originalRequestId:String?,originalRequestHash:String?,originalIssuedAt:Int64?
    private let authorityOrigin:URL,authorityIssuer:Data
    private init(communityId:String,profileId:String,deviceId:String,planDigest:String,issuedAt:Int64,originalRequestId:String?,originalRequestHash:String?,originalIssuedAt:Int64?,authority:ScreenCommunityAuthority) { self.authorityOrigin=authority.origin;self.authorityIssuer=authority.issuer.x963Representation;self.communityId=communityId;self.profileId=profileId;self.deviceId=deviceId;self.planDigest=planDigest;self.issuedAt=issuedAt;self.originalRequestId=originalRequestId;self.originalRequestHash=originalRequestHash;self.originalIssuedAt=originalIssuedAt }
    public static func verify(_ reply:CommunityAccessReply,authority:ScreenCommunityAuthority,plan:CommunityAccessPlan,now:Date=Date()) throws -> Self {
        let checked=try CommunityAccessReply.verify(reply.envelope,authority:authority,requestId:reply.requestId,now:now)
        guard checked.kind=="registration-absent",plan.profileId==authority.profileID else { throw ScreenCommunityError.wrongCommunity }
        let raw=try AccessValue.object(checked.value,["communityId","profileId","deviceId","planDigest","originalRequestId","originalRequestHash","originalIssuedAt"])
        let cid=try AccessValue.id(raw["communityId"] as Any)
        guard raw["profileId"] as? String==plan.profileId,raw["deviceId"] as? String==plan.deviceId,raw["planDigest"] as? String==(try plan.digest),
              checked.issuedAt<=Int64(now.timeIntervalSince1970*1000)+5_000 else { throw ScreenCommunityError.wrongCommunity }
        let originalId=raw["originalRequestId"] is NSNull ? nil : try AccessValue.id(raw["originalRequestId"] as Any)
        let originalAt=raw["originalIssuedAt"] is NSNull ? nil : try AccessValue.integer(raw["originalIssuedAt"] as Any)
        guard raw["originalRequestHash"] is NSNull || raw["originalRequestHash"] is String else { throw ScreenCommunityError.malformed }
        let originalHash=raw["originalRequestHash"] is NSNull ? nil : raw["originalRequestHash"] as? String
        guard (originalId==nil && originalAt==nil && originalHash==nil) ||
              (originalId != nil && originalAt != nil && originalHash?.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil && checked.issuedAt>originalAt!+60_000) else { throw ScreenCommunityError.wrongCommunity }
        return Self(communityId:cid,profileId:plan.profileId,deviceId:plan.deviceId,planDigest:try plan.digest,issuedAt:checked.issuedAt,originalRequestId:originalId,originalRequestHash:originalHash,originalIssuedAt:originalAt,authority:authority)
    }
    func matches(_ plan:CommunityAccessPlan,authority:ScreenCommunityAuthority,now:Date) -> Bool {
        let clock=Int64(now.timeIntervalSince1970*1000)
        return authority.origin==authorityOrigin&&authority.issuer.x963Representation==authorityIssuer&&authority.profileID==profileId&&profileId==plan.profileId&&deviceId==plan.deviceId&&(try? plan.digest)==planDigest&&issuedAt<=clock+5_000&&issuedAt>=clock-60_000
    }
}
/// Validate an old signed prepare as evidence only. It is never submitted again.
struct CommunityOriginalPrepare {
    let id:String,issuedAt:Int64,envelopeHash:String,plan:CommunityAccessPlan
    init(_ envelope:ScreenCommunityEnvelope) throws {
        guard envelope.hostSignature==nil else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:32000)
        guard bytes.count<=24000,let fields=try JSONSerialization.jsonObject(with:bytes) as? [Any],fields.count==7,
              try AccessValue.integer(fields[0])==2,fields[1] as? String=="prepare",fields[5] is NSNull,
              let args=fields[6] as? [Any],args.count==1,let nonce=fields[4] as? String,
              try ScreenCommunityRequest.decodeBase64(nonce,max:43).count==32 else { throw ScreenCommunityError.malformed }
        id=try AccessValue.id(fields[2]);issuedAt=try AccessValue.integer(fields[3]);plan=try CommunityAccessPlan.checked(args[0])
        let signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(envelope.signature,max:86))
        guard try P256.Signing.PublicKey(x963Representation:AccessValue.key(plan.hostKey)).isValidSignature(signature,for:Data("agentstoz.community-access.request/v2\0".utf8)+bytes) else { throw ScreenCommunityError.invalidSignature }
        envelopeHash=SHA256.hash(data:try JSONSerialization.data(withJSONObject:[envelope.payload,envelope.signature],options:.withoutEscapingSlashes)).map { String(format:"%02x",$0) }.joined()
    }
}

public struct CommunityPreparedRegistration: Codable, Equatable, Sendable {
    public let planId:String,communityId:String,digest:String,expiresAt:Int64
}
public enum CommunityRegistrationLookup: Sendable {
    case registered(CommunityAuthorization),pending(CommunityPreparedRegistration),absent(CommunityRegistrationAbsence)
    public static func verify(_ reply:CommunityAccessReply,authority:ScreenCommunityAuthority,plan:CommunityAccessPlan,communityId:String?=nil,now:Date=Date()) throws -> Self {
        let pinned=try CommunityAccessReply.verify(reply.envelope,authority:authority,requestId:reply.requestId,now:now)
        switch pinned.kind {
        case "authorization":
            let a=try pinned.authorization(authority:authority,now:now),b=a.body
            guard b.profileId==plan.profileId,b.deviceId==plan.deviceId,b.deviceKind==plan.kind,b.name==plan.name,b.hostPublicKey==plan.hostKey,
                  b.biometricPublicKey==plan.biometricKey,b.publicKey==plan.operationKey,b.controlKey==plan.controlKey,b.agentDeviceId==plan.agentDeviceId,b.capabilities==plan.capabilities,
                  communityId==nil || b.communityId==communityId else { throw ScreenCommunityError.wrongCommunity }
            return .registered(a)
        case "prepared":
            let raw=try AccessValue.object(pinned.value,["planId","communityId","digest","expiresAt"])
            let id=try AccessValue.id(raw["planId"] as Any),cid=try AccessValue.id(raw["communityId"] as Any),expires=try AccessValue.integer(raw["expiresAt"] as Any)
            guard raw["digest"] as? String==(try plan.digest),expires>Int64(now.timeIntervalSince1970*1000),expires<=pinned.issuedAt+600_000,
                  communityId==nil || cid==communityId else { throw ScreenCommunityError.wrongCommunity }
            return .pending(CommunityPreparedRegistration(planId:id,communityId:cid,digest:try plan.digest,expiresAt:expires))
        case "registration-absent":
            let absent=try CommunityRegistrationAbsence.verify(pinned,authority:authority,plan:plan,now:now)
            guard communityId==nil || absent.communityId==communityId else { throw ScreenCommunityError.wrongCommunity };return .absent(absent)
        default:throw ScreenCommunityError.wrongRequest
        }
    }
}
