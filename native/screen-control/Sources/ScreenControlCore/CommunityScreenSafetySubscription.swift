import Foundation
import CryptoKit

/// A subscription receipt authorizes no stream, session or execution; only the native host's fresh poll can do that.
public struct CommunitySafetySubscription:Sendable {
    public let subscriptionGeneration:String?,policyDigest:String,keyEpoch:Int64,revision:Int64
    public func validate(expectedEnabled:Bool,policyDigest:String?=nil,keyEpoch:Int64?=nil,revision:Int64?=nil) throws {
        guard (subscriptionGeneration != nil)==expectedEnabled,policyDigest==nil || self.policyDigest==policyDigest,
              keyEpoch==nil || self.keyEpoch==keyEpoch,revision==nil || self.revision==revision else { throw ScreenCommunityError.wrongCommunity }
    }
    public static func verify(_ reply:CommunityAccessReply,authority:ScreenCommunityAuthority,own:CommunityAuthorization,requestId:String,historical:Bool=false,now:Date=Date()) throws -> Self {
        let date=historical ? Date(timeIntervalSince1970:Double(reply.issuedAt)/1000) : now
        let checked=try CommunityAccessReply.verify(reply.envelope,authority:authority,requestId:historical ? nil : requestId,now:date)
        guard checked.kind=="safety-subscribed",checked.requestId==requestId else { throw ScreenCommunityError.wrongRequest }
        let o=try AccessValue.object(checked.value,["version","communityId","enrollmentId","subscriptionGeneration","policyDigest","keyEpoch","revision","issuedAt","expiresAt"])
        let epoch=try AccessValue.integer(o["keyEpoch"] as Any),revision=try AccessValue.integer(o["revision"] as Any),at=try AccessValue.integer(o["issuedAt"] as Any),expiry=try AccessValue.integer(o["expiresAt"] as Any)
        guard try AccessValue.integer(o["version"] as Any)==1,o["communityId"] as? String==own.body.communityId,o["enrollmentId"] as? String==own.body.enrollmentId,
              let digest=o["policyDigest"] as? String,CommunitySafetyWire.isDigest(digest),epoch>0,revision>0,at==reply.issuedAt,expiry>Int64(date.timeIntervalSince1970*1000),expiry<=at+90_000 else { throw ScreenCommunityError.wrongCommunity }
        let generation=o["subscriptionGeneration"] is NSNull ? nil : try AccessValue.id(o["subscriptionGeneration"] as Any)
        return Self(subscriptionGeneration:generation,policyDigest:digest,keyEpoch:epoch,revision:revision)
    }
    public static func recover(_ receipt:CommunityAccessReply,authority:ScreenCommunityAuthority,own:CommunityAuthorization,originalRequestId:String,now:Date=Date()) throws -> Self {
        let checked=try CommunityAccessReply.verify(receipt.envelope,authority:authority,requestId:receipt.requestId,now:now)
        guard checked.kind=="receipt" else { throw ScreenCommunityError.wrongRequest }
        let o=try AccessValue.object(checked.value,["originalRequestId","result"])
        guard o["originalRequestId"] as? String==originalRequestId else { throw ScreenCommunityError.wrongRequest }
        let inner=try CommunityAccessReply.verify(CommunitySafetyWire.envelope(o["result"] as Any),authority:authority,now:now)
        return try verify(inner,authority:authority,own:own,requestId:originalRequestId,historical:true,now:now)
    }
}

/// The existing mutation-receipt recovery key is the member host key, distinct from its operation and BIO keys.
/// Only a valid original self-subscribe from this account can request this narrowly bound read proof.
public struct CommunitySafetySubscriptionRecovery:Sendable {
    public let request:CommunityAccessRequest
    public let expectsSubscription:Bool
    private let hostKey:String
    public init(own:CommunityAuthorization,original:ScreenCommunityEnvelope) throws {
        guard original.hostSignature==nil,own.body.deviceKind == .mobile else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(original.payload,max:32_000)
        guard let f=try JSONSerialization.jsonObject(with:bytes) as? [Any],f.count==7,try AccessValue.integer(f[0])==2,f[1] as? String=="screen-safety-subscribe",
              f[5] as? String==own.body.enrollmentId,let args=f[6] as? [Any],args.count==3,args[0] as? String==own.body.communityId else { throw ScreenCommunityError.wrongCommunity }
        let id=try AccessValue.id(f[2]),signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(original.signature,max:86)),key=try P256.Signing.PublicKey(x963Representation:AccessValue.key(own.body.publicKey))
        guard key.isValidSignature(signature,for:Data("agentstoz.community-access.request/v2\0".utf8)+bytes) else { throw ScreenCommunityError.invalidSignature }
        expectsSubscription = !(args[1] is NSNull)
        hostKey=own.body.hostPublicKey
        request=try CommunityAccessRequest(operation:.receipt,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[id]))
    }
    public func signed(by signer:any TranscriptSigner) async throws -> ScreenCommunityEnvelope {
        guard ScreenCommunityRequest.base64(signer.publicKey.x963Representation)==hostKey else { throw ScreenCommunityError.wrongCommunity }
        return try await request.signed(by:signer)
    }
}

public struct CommunitySafetyNotice:Sendable {
    public let eventId:String,communityId:String,profileId:String,receiverEnrollmentId:String,activationId:String,eventKind:String,actorEnrollmentId:String?,expiresAt:Int64
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,now:Date=Date()) throws -> Self {
        guard envelope.hostSignature==nil else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:4096),signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(envelope.signature,max:86))
        guard authority.issuer.isValidSignature(signature,for:Data("agentstoz.community-screen-safety.notice/v1\0".utf8)+bytes),let f=try JSONSerialization.jsonObject(with:bytes) as? [Any],f.count==11,
              try AccessValue.integer(f[0])==1,f[1] as? String=="screen-safety-notice",f[5] as? String==authority.profileID,let kind=f[8] as? String,["connection","enrollment","security"].contains(kind) else { throw ScreenCommunityError.invalidSignature }
        let at=try AccessValue.integer(f[3]),expiry=try AccessValue.integer(f[10]),clock=Int64(now.timeIntervalSince1970*1000)
        guard at<=clock+5_000,expiry>clock,expiry<=at+600_000 else { throw ScreenCommunityError.expired }
        let actor:String? = try (f[9] is NSNull ? nil : AccessValue.id(f[9]))
        return Self(eventId:try AccessValue.id(f[2]),communityId:try AccessValue.id(f[4]),profileId:authority.profileID,receiverEnrollmentId:try AccessValue.id(f[6]),activationId:try AccessValue.id(f[7]),eventKind:kind,actorEnrollmentId:actor,expiresAt:expiry)
    }
}
