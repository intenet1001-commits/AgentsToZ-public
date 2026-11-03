import Foundation
import CryptoKit

/// Original mutation envelopes survive uncertainty. Effect reservation is a one-way fence, never a retry token.
public struct CommunityOwnerEffectJournal:Codable,Sendable {
    public struct Publication:Codable,Equatable,Sendable {
        public let recordId:String,instance:String,localGeneration:String,holdGeneration:String,connectionId:String?,challenge:String,targetPolicyDigest:String,sourcePolicyDigest:String,delegationRevision:Int64,expiresAt:Int64
        public init(recordId:String,instance:String,localGeneration:String,holdGeneration:String,connectionId:String?,challenge:String,targetPolicyDigest:String,sourcePolicyDigest:String,delegationRevision:Int64,expiresAt:Int64) {
            self.recordId=recordId;self.instance=instance;self.localGeneration=localGeneration;self.holdGeneration=holdGeneration;self.connectionId=connectionId;self.challenge=challenge;self.targetPolicyDigest=targetPolicyDigest;self.sourcePolicyDigest=sourcePolicyDigest;self.delegationRevision=delegationRevision;self.expiresAt=expiresAt
        }
        public func matches(_ proof:CommunityDelegatedInputConfirmation,instance:String,localGeneration:String,holdGeneration:String,connectionId:String?,now:Date=Date())->Bool {
            let i=proof.intent
            return self.instance==instance && self.localGeneration==localGeneration && self.holdGeneration==holdGeneration && self.connectionId==connectionId && self.expiresAt>Int64(now.timeIntervalSince1970*1000) && recordId==proof.record.body.requestId && challenge==i.challenge && i.holdGeneration==holdGeneration && i.connectionId==connectionId && targetPolicyDigest==i.targetPolicyDigest && sourcePolicyDigest==i.sourcePolicyDigest && delegationRevision==i.delegationRevision && i.expiresAt<=expiresAt
        }
    }
    public struct Entry:Codable,Sendable {
        public let publication:Publication
        public var reservationHash:String?,outcome:CommunityOwnerRecord.Outcome?
        public var reportRequestId:String?
        public var reported=false
        public let retireAt:Int64
    }
    public private(set) var version=1
    public private(set) var entries:[String:Entry]=[:]
    public init() {}
    public mutating func publish(_ publication:Publication,now:Date=Date())throws {
        let at=Int64(now.timeIntervalSince1970*1000)
        entries=entries.filter{$0.value.retireAt>at}
        if let old=entries[publication.recordId] { guard old.publication==publication else { throw ScreenCommunityError.service("OWNER_PUBLICATION_CHANGED") };return }
        guard entries.count<128 else { throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL") }
        entries[publication.recordId]=Entry(publication:publication,reservationHash:nil,outcome:nil,retireAt:at+7*86_400_000)
    }
    public mutating func reserve(_ proof:CommunityDelegatedInputConfirmation)throws {
        let id=proof.record.body.requestId
        guard var entry=entries[id],entry.reservationHash==nil,entry.outcome==nil else { throw ScreenCommunityError.service("OWNER_EFFECT_UNKNOWN") }
        // The exact approval and original issuer response are retained by the enclosing signed record hash.
        entry.reservationHash=try CommunityOwnerWire.envelopeHash(proof.record.envelope);entries[id]=entry
    }
    public mutating func finish(_ id:String,outcome:CommunityOwnerRecord.Outcome)throws {
        guard var entry=entries[id],entry.outcome==nil || entry.outcome==outcome else { throw ScreenCommunityError.service("OWNER_EFFECT_UNKNOWN") }
        if outcome == .applied { guard entry.reservationHash != nil else { throw ScreenCommunityError.service("OWNER_EFFECT_UNKNOWN") } }
        entry.outcome=outcome;entries[id]=entry
    }
    public mutating func reporting(_ id:String,requestId:String)throws {
        _ = try AccessValue.id(requestId)
        guard var entry=entries[id],entry.outcome != nil,entry.reportRequestId==nil || entry.reportRequestId==requestId else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
        entry.reportRequestId=requestId;entries[id]=entry
    }
    public mutating func reported(_ id:String,outcome:CommunityOwnerRecord.Outcome)throws {
        guard var entry=entries[id],entry.outcome==outcome else {throw ScreenCommunityError.service("OWNER_RESULT_CONFLICT")};entry.reported=true;entries[id]=entry
    }
    public func encoded()throws->Data { let d=try JSONEncoder().encode(self);guard d.count<=262_144 else { throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL") };return d }
    public static func decode(_ data:Data)throws->Self {
        guard data.count<=262_144 else { throw ScreenCommunityError.malformed }
        let v=try JSONDecoder().decode(Self.self,from:data)
        guard v.version==1,v.entries.count<=128 else { throw ScreenCommunityError.malformed }
        for (id,e) in v.entries {
            let p=e.publication
            guard id==p.recordId,e.retireAt>=p.expiresAt,p.delegationRevision>0,
                  (e.outcome != .applied || e.reservationHash != nil),(!e.reported || e.outcome != nil),
                  try ScreenCommunityRequest.decodeBase64(p.challenge,max:43).count==32 else {throw ScreenCommunityError.malformed}
            for value in [id,p.instance,p.localGeneration,p.holdGeneration]+(p.connectionId.map{[$0]} ?? [])+(e.reportRequestId.map{[$0]} ?? []) {_ = try AccessValue.id(value)}
            for hash in [p.targetPolicyDigest,p.sourcePolicyDigest]+(e.reservationHash.map{[$0]} ?? []) {
                guard hash.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil else {throw ScreenCommunityError.malformed}
            }
        }
        return v
    }
}
