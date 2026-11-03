import Foundation

/// A later native OS denial supersedes an earlier token result, including a failed token wait.
/// This only combines observations; it cannot request OS consent, sign, dispatch or grant a session.
public struct CommunitySafetyNotificationObservation:Sendable {
    public let token:Data?,permissionDenied:Bool
    @MainActor public static func read(token:() async throws -> Data?,denied:() async -> Bool) async throws -> Self {
        let result:Result<Data?,Error>
        do { result = .success(try await token()) } catch { result = .failure(error) }
        if await denied() { return Self(token:nil,permissionDenied:true) }
        return Self(token:try result.get(),permissionDenied:false)
    }
}

/// Durable observation ordering shared by the native OS adapter and software race checks. This is metadata only;
/// it cannot mint a signature, execute a request, grant a session or choose an authority.
public struct CommunitySafetySubscriptionJournal:Codable,Sendable {
    public struct Mutation:Codable,Sendable {
        public let requestId:String,sequence:Int64,binding:String,isRemoval:Bool
        public fileprivate(set) var envelope:ScreenCommunityEnvelope?
        private enum CodingKeys:String,CodingKey { case requestId,sequence,binding,isRemoval,envelope }
        fileprivate init(requestId:String,sequence:Int64,binding:String,isRemoval:Bool,envelope:ScreenCommunityEnvelope?=nil) {
            self.requestId=requestId;self.sequence=sequence;self.binding=binding;self.isRemoval=isRemoval;self.envelope=envelope
        }
        public init(from decoder:Decoder) throws {
            let c=try decoder.container(keyedBy:CodingKeys.self)
            requestId=try c.decode(String.self,forKey:.requestId);sequence=try c.decode(Int64.self,forKey:.sequence);binding=try c.decode(String.self,forKey:.binding)
            envelope=try c.decodeIfPresent(ScreenCommunityEnvelope.self,forKey:.envelope)
            let explicit=try c.decodeIfPresent(Bool.self,forKey:.isRemoval)
            let original=try envelope.map { try CommunitySafetySubscriptionJournal.original($0).removal }
            guard explicit==nil || original==nil || explicit==original else { throw ScreenCommunityError.malformed }
            isRemoval=explicit ?? original ?? false // A legacy unsigned reservation is conservatively charged to positive capacity.
        }
    }
    public let version:Int
    public private(set) var sequence:Int64,confirmedSequence:Int64,desiredBinding:String?,pending:[Mutation],superseded:[Mutation]
    private static let positiveLimit=16,evidenceLimit=128,evidenceByteLimit=256_000,negativeByteReserve=48_000
    public init() { version=2;sequence=0;confirmedSequence=0;desiredBinding=nil;pending=[];superseded=[] }
    private enum CodingKeys:String,CodingKey { case version,sequence,confirmedSequence,desiredBinding,pending,superseded }
    public init(from decoder:Decoder) throws {
        let c=try decoder.container(keyedBy:CodingKeys.self),storedVersion=try c.decode(Int.self,forKey:.version)
        version=2;sequence=try c.decode(Int64.self,forKey:.sequence)
        confirmedSequence=try c.decodeIfPresent(Int64.self,forKey:.confirmedSequence) ?? 0
        desiredBinding=try c.decodeIfPresent(String.self,forKey:.desiredBinding);pending=try c.decode([Mutation].self,forKey:.pending)
        superseded=try c.decodeIfPresent([Mutation].self,forKey:.superseded) ?? []
        guard storedVersion==1 || storedVersion==2 else { throw ScreenCommunityError.malformed }
        // The old 16-record format had no separate negative lane. Preserve every signed original while migrating it.
        if storedVersion==1 {
            guard pending.count<=16,superseded.isEmpty else { throw ScreenCommunityError.malformed }
            let newest=pending.filter(\.isRemoval).map(\.sequence).max()
            superseded=pending.filter{$0.isRemoval && $0.sequence != newest && $0.envelope != nil}
            pending.removeAll{$0.isRemoval && $0.sequence != newest}
        }
        let all=pending+superseded
        guard sequence>=0,sequence<=9_007_199_254_740_990,confirmedSequence>=0,confirmedSequence<=sequence,
              pending.filter({!$0.isRemoval}).count<=Self.positiveLimit,pending.filter(\.isRemoval).count<=1,
              Set(all.map(\.requestId)).count==all.count,Set(all.map(\.sequence)).count==all.count,
              all.allSatisfy({$0.sequence>0 && $0.sequence<=sequence && (try? AccessValue.id($0.requestId)) != nil && CommunitySafetyWire.isDigest($0.binding)}),
              superseded.allSatisfy({$0.envelope != nil}),desiredBinding==nil || CommunitySafetyWire.isDigest(desiredBinding!) else { throw ScreenCommunityError.malformed }
        try validateEvidence()
    }
    public var nextSequence:Int64 {
        get throws {
            guard sequence>=0,sequence<9_007_199_254_740_990 else { throw ScreenCommunityError.service("SUBSCRIPTION_SEQUENCE_EXHAUSTED") }
            return sequence+1
        }
    }
    private func validateEvidence(reservingNegative:Bool=false) throws {
        let byteLimit=Self.evidenceByteLimit-(reservingNegative ? Self.negativeByteReserve : 0)
        guard pending.count+superseded.count<=Self.evidenceLimit,try JSONEncoder().encode(pending+superseded).count<=byteLimit else {
            throw ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL")
        }
    }
    public mutating func reserve(requestId:String,binding:String,expectedPrevious:Int64,isRemoval:Bool=false) throws {
        _ = try AccessValue.id(requestId)
        guard CommunitySafetyWire.isDigest(binding),sequence==expectedPrevious,!(pending+superseded).contains(where:{$0.requestId==requestId}) else { throw ScreenCommunityError.service("SUBSCRIPTION_OBSERVATION_BUSY") }
        var next=self
        if isRemoval {
            next.superseded += next.pending.filter{$0.isRemoval && $0.envelope != nil}
            next.pending.removeAll( where: \.isRemoval)
        } else {
            guard next.pending.filter({!$0.isRemoval}).count<Self.positiveLimit else { throw ScreenCommunityError.service("SUBSCRIPTION_OBSERVATION_BUSY") }
            // Positives never consume the final evidence slot reserved for a newly observed negative.
            guard next.pending.count+next.superseded.count<Self.evidenceLimit-1 else { throw ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL") }
        }
        let newSequence=try next.nextSequence
        next.sequence=newSequence;next.desiredBinding=binding
        next.pending.append(.init(requestId:requestId,sequence:newSequence,binding:binding,isRemoval:isRemoval))
        try next.validateEvidence(reservingNegative:!isRemoval);self=next
    }
    public func mayDispatch(_ requestId:String) -> Bool { pending.contains{$0.requestId==requestId && $0.sequence==sequence} }
    public var recoveryCandidates:[Mutation] { Array((pending+superseded).sorted{$0.sequence>$1.sequence}.prefix(4)) }
    private static func original(_ envelope:ScreenCommunityEnvelope) throws -> (fields:[Any],args:[Any],removal:Bool) {
        guard envelope.hostSignature==nil else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:32_000)
        guard let fields=try JSONSerialization.jsonObject(with:bytes) as? [Any],fields.count==7,fields[1] as? String=="screen-safety-subscribe",
              let args=fields[6] as? [Any],args.count==3 else { throw ScreenCommunityError.wrongRequest }
        return (fields,args,args[1] is NSNull)
    }
    public mutating func recordSigned(_ envelope:ScreenCommunityEnvelope,requestId:String) throws {
        guard mayDispatch(requestId),let index=pending.firstIndex(where:{$0.requestId==requestId}) else { throw ScreenCommunityError.service("SUBSCRIPTION_OBSERVATION_SUPERSEDED") }
        let original=try Self.original(envelope)
        guard original.fields[2] as? String==requestId,original.removal==pending[index].isRemoval else { throw ScreenCommunityError.wrongRequest }
        let fence=try AccessValue.object(original.args[2],["sequence","policyDigest","keyEpoch"])
        guard try AccessValue.integer(fence["sequence"] as Any)==pending[index].sequence else { throw ScreenCommunityError.wrongRequest }
        var next=self;next.pending[index].envelope=envelope;try next.validateEvidence(reservingNegative:!pending[index].isRemoval);self=next
    }
    public mutating func abandonUnsigned(_ requestId:String) {
        guard let record=pending.first(where:{$0.requestId==requestId}),record.envelope==nil else { return }
        pending.removeAll{$0.requestId==requestId}
        if record.sequence==sequence { desiredBinding=nil }
    }
    public mutating func committed(through confirmedSequence:Int64) {
        guard confirmedSequence>=0,confirmedSequence<=sequence,let original=(pending+superseded).first(where:{$0.sequence==confirmedSequence}) else { return }
        self.confirmedSequence=max(self.confirmedSequence,confirmedSequence)
        pending.removeAll{$0.sequence==confirmedSequence};superseded.removeAll{$0.sequence==confirmedSequence}
        if original.isRemoval,original.envelope != nil {
            // Only an issuer-confirmed negative supersedes older positives. Their outcome remains unknown and their raw proof is retained.
            superseded += pending.filter{$0.sequence<confirmedSequence && $0.envelope != nil}
            pending.removeAll{$0.sequence<confirmedSequence}
        }
    }
}
