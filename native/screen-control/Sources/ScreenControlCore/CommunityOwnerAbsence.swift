import Foundation
import CryptoKit

/// Absence is a signed negative tied to the exact source operation request and its closed acceptance window.
public struct CommunityOwnerAbsence:Sendable {
    public let original:ScreenCommunityEnvelope
    public let requestId:String,issuedAt:Int64,expiresAt:Int64
    private let origin:URL,issuer:Data,profileId:String,sourceEnrollmentId:String,communityId:String
    public static func verify(_ supplied:CommunityAccessReply,original:CommunityAccessJournal,own:CommunityAuthorization,authority:ScreenCommunityAuthority,now:Date=Date())throws->Self {
        let reply=try CommunityAccessReply.verify(supplied.envelope,authority:authority,requestId:supplied.requestId,now:now)
        guard original.operation==CommunityAccessRequest.Operation.ownerRequest.rawValue,original.actor==own.body.enrollmentId,reply.kind=="owner-recovery-absent" else {throw ScreenCommunityError.wrongRequest}
        let raw=try CommunityOwnerWire.request(original.envelope,operation:.ownerRequest,actor:own.body.enrollmentId,communityId:own.body.communityId)
        guard raw.args.count==2,raw.id==original.id else {throw ScreenCommunityError.wrongRequest}
        let o=try AccessValue.object(reply.value,["version","communityId","sourceEnrollmentId","targetEnrollmentId","requestId","originalRequestHash","originalIssuedAt","issuedAt","expiresAt"])
        let at=try AccessValue.integer(o["issuedAt"]!),end=try AccessValue.integer(o["expiresAt"]!)
        let hash=SHA256.hash(data:try JSONSerialization.data(withJSONObject:[original.envelope.payload,original.envelope.signature],options:.withoutEscapingSlashes)).map{String(format:"%02x",$0)}.joined()
        guard try AccessValue.integer(o["version"]!)==1,o["communityId"] as? String==own.body.communityId,o["sourceEnrollmentId"] as? String==own.body.enrollmentId,o["targetEnrollmentId"] as? String==raw.args[1] as? String,o["requestId"] as? String==original.id,o["originalRequestHash"] as? String==hash,try AccessValue.integer(o["originalIssuedAt"]!)==raw.at,at==reply.issuedAt,at>raw.at+60_000,end>at,end<=at+90_000,end>Int64(now.timeIntervalSince1970*1000),
              try P256.Signing.PublicKey(x963Representation:AccessValue.key(own.body.publicKey)).isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(original.envelope.signature,max:86)),for:Data("agentstoz.community-access.request/v2\0".utf8)+raw.bytes) else {throw ScreenCommunityError.wrongCommunity}
        return Self(original:original.envelope,requestId:original.id,issuedAt:at,expiresAt:end,origin:authority.origin,issuer:authority.issuer.x963Representation,profileId:authority.profileID,sourceEnrollmentId:own.body.enrollmentId,communityId:own.body.communityId)
    }
    func matches(_ pending:CommunityAccessJournal,authority:ScreenCommunityAuthority,now:Date)->Bool {
        pending.operation==CommunityAccessRequest.Operation.ownerRequest.rawValue && pending.id==requestId && pending.envelope==original && pending.actor==sourceEnrollmentId && origin==authority.origin && issuer==authority.issuer.x963Representation && profileId==authority.profileID && expiresAt>Int64(now.timeIntervalSince1970*1000)
    }
}
