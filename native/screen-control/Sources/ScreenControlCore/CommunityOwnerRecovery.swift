import Foundation
import CryptoKit
import CoreFoundation

/// App-owned delegated input recovery only. These types never represent target OS/local-owner authentication.
public struct CommunityOwnerDelegation:Sendable {
    public struct Body:Codable,Equatable,Sendable {
        public let version:Int,communityId:String,targetEnrollmentId:String,enabled:Bool,revision:Int64,issuedAt:Int64,expiresAt:Int64
    }
    public let body:Body,envelope:ScreenCommunityEnvelope
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,own:CommunityAuthorization,requestId:String?=nil,now:Date=Date())throws->Self {
        let reply=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard reply.kind=="owner-delegation" else { throw ScreenCommunityError.wrongRequest }
        _=try AccessValue.object(reply.value,["version","communityId","targetEnrollmentId","enabled","revision","issuedAt","expiresAt"])
        let b=try JSONDecoder().decode(Body.self,from:reply.encodedValue())
        guard b.version==1,b.communityId==own.body.communityId,b.targetEnrollmentId==own.body.enrollmentId,
              b.issuedAt==reply.issuedAt,b.expiresAt>b.issuedAt,b.expiresAt<=b.issuedAt+90_000,
              b.expiresAt>Int64(now.timeIntervalSince1970*1000),b.revision>=0 else { throw ScreenCommunityError.expired }
        return Self(body:b,envelope:envelope)
    }
}
public struct CommunityOwnerIntent:Codable,Equatable,Sendable {
    public let version:Int,action:String,targetEnrollmentId:String,sourceEnrollmentId:String,delegationRevision:Int64,targetPolicyDigest:String,sourcePolicyDigest:String,holdGeneration:String,connectionId:String?,challenge:String,expiresAt:Int64
    static let keys:Set<String>=["version","action","targetEnrollmentId","sourceEnrollmentId","delegationRevision","targetPolicyDigest","sourcePolicyDigest","holdGeneration","connectionId","challenge","expiresAt"]
    public var encodedValue:Data { get throws { try JSONEncoder().encode(self) } }
    public func value()throws->Any { try JSONSerialization.jsonObject(with:encodedValue) }
    public func encode(to encoder:any Encoder)throws {
        var c=encoder.container(keyedBy:Keys.self)
        try c.encode(version,forKey:.version);try c.encode(action,forKey:.action);try c.encode(targetEnrollmentId,forKey:.targetEnrollmentId);try c.encode(sourceEnrollmentId,forKey:.sourceEnrollmentId);try c.encode(delegationRevision,forKey:.delegationRevision);try c.encode(targetPolicyDigest,forKey:.targetPolicyDigest);try c.encode(sourcePolicyDigest,forKey:.sourcePolicyDigest);try c.encode(holdGeneration,forKey:.holdGeneration);try c.encode(challenge,forKey:.challenge);try c.encode(expiresAt,forKey:.expiresAt)
        if let connectionId { try c.encode(connectionId,forKey:.connectionId) } else { try c.encodeNil(forKey:.connectionId) }
    }
    private enum Keys:String,CodingKey { case version,action,targetEnrollmentId,sourceEnrollmentId,delegationRevision,targetPolicyDigest,sourcePolicyDigest,holdGeneration,connectionId,challenge,expiresAt }
    func validate()throws {
        guard version==1,action=="resume-input",delegationRevision>0,targetEnrollmentId != sourceEnrollmentId,
              try ScreenCommunityRequest.decodeBase64(challenge,max:43).count==32 else { throw ScreenCommunityError.malformed }
        for id in [targetEnrollmentId,sourceEnrollmentId,holdGeneration]+(connectionId.map{[$0]} ?? []) { _=try AccessValue.id(id) }
        for digest in [targetPolicyDigest,sourcePolicyDigest] { guard digest.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else { throw ScreenCommunityError.malformed } }
    }
}
public struct CommunityOwnerRecord:Sendable {
    public enum State:String,Codable,Sendable { case waitingHost="waiting-host",ready,approved,applied,refused,superseded,expired }
    public enum Outcome:String,Codable,Sendable { case applied,refused,superseded }
    public struct Approval:Codable,Equatable,Sendable { public let request:ScreenCommunityEnvelope,source:ScreenCommunityEnvelope,target:ScreenCommunityEnvelope,delegation:ScreenCommunityEnvelope }
    public struct Body:Decodable,Sendable {
        public let version:Int,requestId:String,communityId:String,targetEnrollmentId:String,sourceEnrollmentId:String,delegationRevision:Int64,targetPolicyDigest:String,sourcePolicyDigest:String,state:State,createdAt:Int64,expiresAt:Int64,intent:CommunityOwnerIntent?,approval:Approval?,outcome:Outcome?
    }
    public let body:Body,envelope:ScreenCommunityEnvelope
    public var isTerminal:Bool { [.applied,.refused,.superseded,.expired].contains(body.state) }
    public var reviewBinding:String { let b=body;return [b.requestId,b.sourceEnrollmentId,b.targetEnrollmentId,String(b.delegationRevision),b.state.rawValue,b.sourcePolicyDigest,b.targetPolicyDigest,b.intent?.challenge ?? "",b.intent?.holdGeneration ?? "",b.intent?.connectionId ?? "none",String(b.expiresAt)].joined(separator:":") }
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,communityId:String,requestId:String?=nil,now:Date=Date())throws->Self {
        let reply=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard reply.kind=="owner-recovery" else { throw ScreenCommunityError.wrongRequest }
        return try checked(reply.value,envelope:envelope,communityId:communityId)
    }
    static func checked(_ raw:Any,envelope:ScreenCommunityEnvelope,communityId:String)throws->Self {
        let o=try AccessValue.object(raw,["version","requestId","communityId","targetEnrollmentId","sourceEnrollmentId","delegationRevision","targetPolicyDigest","sourcePolicyDigest","state","createdAt","expiresAt","intent","approval","outcome"])
        if !(o["intent"] is NSNull) { _=try AccessValue.object(o["intent"]!,CommunityOwnerIntent.keys) }
        if !(o["approval"] is NSNull) { _=try AccessValue.object(o["approval"]!,["request","source","target","delegation"]) }
        let b=try JSONDecoder().decode(Body.self,from:JSONSerialization.data(withJSONObject:o))
        for id in [b.requestId,b.communityId,b.targetEnrollmentId,b.sourceEnrollmentId] { _=try AccessValue.id(id) }
        guard b.version==1,b.communityId==communityId,b.targetEnrollmentId != b.sourceEnrollmentId,b.delegationRevision>0,
              b.expiresAt>b.createdAt,b.expiresAt<=b.createdAt+300_000 else { throw ScreenCommunityError.malformed }
        for digest in [b.targetPolicyDigest,b.sourcePolicyDigest] { guard digest.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else { throw ScreenCommunityError.malformed } }
        if let intent=b.intent {
            try intent.validate()
            let outer=try JSONSerialization.jsonObject(with:ScreenCommunityRequest.decodeBase64(envelope.payload,max:65_536)) as? [Any]
            guard let outer,outer.count==5,intent.expiresAt <= (try AccessValue.integer(outer[3]))+120_000 else {throw ScreenCommunityError.expired}
            guard intent.targetEnrollmentId==b.targetEnrollmentId,intent.sourceEnrollmentId==b.sourceEnrollmentId,intent.delegationRevision==b.delegationRevision,intent.targetPolicyDigest==b.targetPolicyDigest,intent.sourcePolicyDigest==b.sourcePolicyDigest,intent.expiresAt==b.expiresAt else { throw ScreenCommunityError.wrongCommunity }
        }
        if [.ready,.approved,.applied].contains(b.state) { guard b.intent != nil else { throw ScreenCommunityError.malformed } }
        if [.approved,.applied].contains(b.state) { guard b.approval != nil else { throw ScreenCommunityError.malformed } }
        guard b.outcome==nil || b.state.rawValue==b.outcome?.rawValue else { throw ScreenCommunityError.malformed }
        return Self(body:b,envelope:envelope)
    }
}
public struct CommunityOwnerRound:Sendable {
    public let delegation:CommunityOwnerDelegation?,records:[CommunityOwnerRecord],envelope:ScreenCommunityEnvelope
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,own:CommunityAuthorization,target:Bool,requestId:String?=nil,now:Date=Date())throws->Self {
        let r=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard r.kind==(target ? "owner-recovery-round":"owner-recovery-list") else { throw ScreenCommunityError.wrongRequest }
        let keys:Set<String>=target ? ["version","communityId","targetEnrollmentId","delegation","requests","issuedAt","expiresAt"]:["version","communityId","requests","issuedAt","expiresAt"]
        let o=try AccessValue.object(r.value,keys),at=try AccessValue.integer(o["issuedAt"]!),end=try AccessValue.integer(o["expiresAt"]!)
        guard try AccessValue.integer(o["version"]!)==1,o["communityId"] as? String==own.body.communityId,at==r.issuedAt,end>Int64(now.timeIntervalSince1970*1000),end>at,end<=at+90_000,let rows=o["requests"] as? [Any],rows.count<=4 else { throw ScreenCommunityError.expired }
        var delegation:CommunityOwnerDelegation?
        if target {
            guard o["targetEnrollmentId"] as? String==own.body.enrollmentId else { throw ScreenCommunityError.wrongCommunity }
            delegation=try CommunityOwnerDelegation.verify(JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:o["delegation"]!)),authority:authority,own:own,now:now)
        }
        let records=try rows.map { try CommunityOwnerRecord.checked($0,envelope:envelope,communityId:own.body.communityId) }
        guard Set(records.map{$0.body.requestId}).count==records.count,records.allSatisfy({(target ? $0.body.targetEnrollmentId:$0.body.sourceEnrollmentId)==own.body.enrollmentId}) else { throw ScreenCommunityError.wrongCommunity }
        return Self(delegation:delegation,records:records,envelope:envelope)
    }
}
/// Constructor restricted positive proof. It is never a LocalOwnerConfirmation and cannot turn Screen ON.
public struct CommunityDelegatedInputConfirmation:Sendable {
    public let record:CommunityOwnerRecord,intent:CommunityOwnerIntent,source:CommunityAuthorization,target:CommunityAuthorization,delegation:CommunityOwnerDelegation
    public static func verify(record:CommunityOwnerRecord,authority:ScreenCommunityAuthority,currentTarget:CommunityAuthorization,currentSource:CommunityAuthorization,currentDelegation:CommunityOwnerDelegation,now:Date=Date())throws->Self {
        let b=record.body,clock=Int64(now.timeIntervalSince1970*1000)
        guard b.state == .approved,b.expiresAt>clock,let intent=b.intent,let approval=b.approval else { throw ScreenCommunityError.expired }
        let source=try CommunityAccessReply.verify(approval.source,authority:authority,now:now).authorization(authority:authority,now:now)
        let target=try CommunityAccessReply.verify(approval.target,authority:authority,now:now).authorization(authority:authority,now:now)
        _=try CommunityDesktopScreenTrust.verified(authority:authority,controller:currentSource,receiver:currentTarget,now:now)
        guard currentTarget.body.capabilities.contains(.receiveControl),source.body.deviceId != target.body.deviceId,
              try CommunityMobileControlPolicy.authorizationDigest(source)==b.sourcePolicyDigest,
              try CommunityMobileControlPolicy.authorizationDigest(target)==b.targetPolicyDigest,
              try CommunityMobileControlPolicy.authorizationDigest(currentSource)==b.sourcePolicyDigest,
              try CommunityMobileControlPolicy.authorizationDigest(currentTarget)==b.targetPolicyDigest,
              source.body.enrollmentId==b.sourceEnrollmentId,target.body.enrollmentId==b.targetEnrollmentId else { throw ScreenCommunityError.wrongCommunity }
        let delegated=try CommunityOwnerDelegation.verify(approval.delegation,authority:authority,own:target,now:now)
        let current=try CommunityOwnerDelegation.verify(currentDelegation.envelope,authority:authority,own:currentTarget,now:now)
        guard delegated.body.enabled,current.body.enabled,delegated.body.revision==b.delegationRevision,current.body.revision==b.delegationRevision else { throw ScreenCommunityError.staleRevision }
        let fields=try CommunityOwnerWire.request(approval.request,operation:.ownerApprove,actor:source.body.enrollmentId,communityId:b.communityId)
        guard fields.args.count==3,fields.args[1] as? String==b.requestId,fields.at>=b.createdAt-5_000,fields.at<=clock+5_000,fields.at<=intent.expiresAt,
              try CommunityOwnerWire.intent(fields.args[2])==intent,
              try P256.Signing.PublicKey(x963Representation:AccessValue.key(source.body.biometricPublicKey)).isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(approval.request.signature,max:86)),for:Data("agentstoz.community-access.request/v2\0".utf8)+fields.bytes) else { throw ScreenCommunityError.invalidSignature }
        return Self(record:record,intent:intent,source:source,target:target,delegation:delegated)
    }
}
public enum CommunityOwnerWire {
    public static func envelopeHash(_ envelope:ScreenCommunityEnvelope)throws->String {
        guard envelope.hostSignature==nil else {throw ScreenCommunityError.malformed}
        return SHA256.hash(data:try value([envelope.payload,envelope.signature])).map{String(format:"%02x",$0)}.joined()
    }
    public static func value(_ values:[Any])throws->Data { try JSONSerialization.data(withJSONObject:values,options:.withoutEscapingSlashes) }
    static func intent(_ raw:Any)throws->CommunityOwnerIntent { _=try AccessValue.object(raw,CommunityOwnerIntent.keys);let v=try JSONDecoder().decode(CommunityOwnerIntent.self,from:JSONSerialization.data(withJSONObject:raw));try v.validate();return v }
    public static func request(_ e:ScreenCommunityEnvelope,operation:CommunityAccessRequest.Operation,actor:String,communityId:String)throws->(id:String,at:Int64,args:[Any],bytes:Data) {
        guard e.hostSignature==nil else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)
        guard bytes.count<=24_000,let f=try JSONSerialization.jsonObject(with:bytes) as? [Any],f.count==7,try AccessValue.integer(f[0])==2,f[1] as? String==operation.rawValue,f[5] as? String==actor,let args=f[6] as? [Any],args.first as? String==communityId,let nonce=f[4] as? String,try ScreenCommunityRequest.decodeBase64(nonce,max:43).count==32 else { throw ScreenCommunityError.malformed }
        return (try AccessValue.id(f[2]),try AccessValue.integer(f[3]),args,bytes)
    }
}
/// Source operation key, not BIO or host delegation. Closed read/request surface only; no positive approval signature.
public struct CommunityOwnerOperationSigner:TranscriptSigner {
    private let inner:any TranscriptSigner,own:CommunityAuthorization
    public var publicKey:P256.Signing.PublicKey { inner.publicKey }
    public init(inner:any TranscriptSigner,own:CommunityAuthorization)throws {
        guard own.isCurrent(),own.body.deviceKind == .desktop,own.body.capabilities.contains(.desktopTrust),own.body.capabilities.contains(.screenView),ScreenCommunityRequest.base64(inner.publicKey.x963Representation)==own.body.publicKey else { throw ScreenCommunityError.wrongCommunity };self.inner=inner;self.own=own
    }
    public func signature(for data:Data)async throws->P256.Signing.ECDSASignature {
        let domain=Data("agentstoz.community-access.request/v2\0".utf8)
        guard own.isCurrent(),data.starts(with:domain),data.count<=24_100,let f=try JSONSerialization.jsonObject(with:data.dropFirst(domain.count)) as? [Any],f.count==7,try AccessValue.integer(f[0])==2,let op=f[1] as? String,f[5] as? String==own.body.enrollmentId,let args=f[6] as? [Any],args.first as? String==own.body.communityId else { throw ScreenCommunityError.malformed }
        let at=try AccessValue.integer(f[3]);_ = try AccessValue.id(f[2]);guard abs(Double(at)-Date().timeIntervalSince1970*1000)<=60_000,let nonce=f[4] as? String,try ScreenCommunityRequest.decodeBase64(nonce,max:43).count==32 else { throw ScreenCommunityError.expired }
        switch op {case "owner-recovery-request","owner-recovery-status":
            guard args.count==2 || (op=="owner-recovery-status" && args.count==3) else {throw ScreenCommunityError.malformed};_ = try AccessValue.id(args[1]);if op=="owner-recovery-request",args[1] as? String==own.body.enrollmentId {throw ScreenCommunityError.wrongCommunity}
            if args.count==3 {
                _=try AccessValue.object(args[2],["payload","signature"])
                let original=try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:args[2]))
                let raw=try CommunityOwnerWire.request(original,operation:.ownerRequest,actor:own.body.enrollmentId,communityId:own.body.communityId)
                guard raw.id==args[1] as? String,raw.args.count==2,
                      try inner.publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(original.signature,max:86)),for:domain+raw.bytes) else {throw ScreenCommunityError.invalidSignature}
            }
        case "owner-recovery-list":guard args.count==1 else {throw ScreenCommunityError.malformed}
        default:throw ScreenCommunityError.malformed}
        return try await inner.signature(for:data)
    }
}
