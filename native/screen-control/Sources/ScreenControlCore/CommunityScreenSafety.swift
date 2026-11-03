import Foundation
import CryptoKit

/// Native receiving-state metadata, never an execution grant or a fabricated legacy phone registration.
public struct CommunitySafetyHostState: Codable, Equatable, Sendable {
    public enum Power: String, Codable, Sendable { case on, waiting, off }
    public struct Session: Codable, Equatable, Sendable {
        public let channelId: String, controllerEnrollmentId: String, since: Int64
        public init(channelId: String, controllerEnrollmentId: String, since: Int64) throws {
            _ = try AccessValue.id(channelId); _ = try AccessValue.id(controllerEnrollmentId)
            guard since >= 0,since<=9_007_199_254_740_991 else { throw ScreenCommunityError.malformed }
            self.channelId=channelId;self.controllerEnrollmentId=controllerEnrollmentId;self.since=since
        }
    }
    public let power: Power, held: Bool, session: Session?, observationSequence:Int64
    public init(power: Power, held: Bool, session: Session?,observationSequence:Int64=0) { self.power=power;self.held=held;self.session=session;self.observationSequence=observationSequence }
    public func value() -> [String:Any] {
        ["power":power.rawValue,"held":held,"observationSequence":observationSequence,"session":session.map{["channelId":$0.channelId,"controllerEnrollmentId":$0.controllerEnrollmentId,"since":$0.since] as [String:Any]} as Any? ?? NSNull()]
    }
}

public struct CommunitySafetyWatcher: Codable, Sendable {
    public let enrollmentId: String, deviceId: String, hostPublicKey: String, operationPublicKey: String
    public let keyEpoch: Int64, revision: Int64, policyDigest: String, subscriptionGeneration: String, authorizationExpiresAt: Int64
    public let administrator: Bool
}

public enum CommunitySafetyAction: String, Codable, Sendable { case end, turnOff, revoke
    public var lifetime: Int64 { self == .end ? 600_000 : 604_800_000 }
}
public enum CommunitySafetyOutcome: String, Codable, Sendable { case ended, turnedOff = "turned-off", revoked, nothingToDo = "nothing-to-do", refused, superseded }
public struct CommunitySafetyCommandBody: Codable, Sendable {
    public let action: CommunitySafetyAction, targetEnrollmentId: String?, expectedSessionId: String?
    public init(action: CommunitySafetyAction, targetEnrollmentId: String? = nil, expectedSessionId: String? = nil) throws {
        if let targetEnrollmentId { _ = try AccessValue.id(targetEnrollmentId) }
        if let expectedSessionId { _ = try AccessValue.id(expectedSessionId) }
        guard (action == .end && targetEnrollmentId == nil && expectedSessionId != nil) ||
              (action == .turnOff && targetEnrollmentId == nil && expectedSessionId == nil) ||
              (action == .revoke && targetEnrollmentId != nil && expectedSessionId == nil) else { throw ScreenCommunityError.malformed }
        self.action=action;self.targetEnrollmentId=targetEnrollmentId;self.expectedSessionId=expectedSessionId
    }
    public func value() -> [String: Any] { ["action":action.rawValue,"targetEnrollmentId":targetEnrollmentId as Any? ?? NSNull(),"expectedSessionId":expectedSessionId as Any? ?? NSNull()] }
    static func checked(_ value: Any) throws -> Self {
        let o=try AccessValue.object(value,["action","targetEnrollmentId","expectedSessionId"])
        guard let text=o["action"] as? String,let action=CommunitySafetyAction(rawValue:text) else { throw ScreenCommunityError.malformed }
        return try Self(action:action,targetEnrollmentId:o["targetEnrollmentId"] is NSNull ? nil : AccessValue.id(o["targetEnrollmentId"] as Any),expectedSessionId:o["expectedSessionId"] is NSNull ? nil : AccessValue.id(o["expectedSessionId"] as Any))
    }
}

public struct CommunitySafetyCommand: Sendable {
    public let commandId: String, sequence: Int64, acceptedAt: Int64, expiresAt: Int64
    public let receiverPolicyDigest: String, subscriptionGeneration: String
    public let authorization: CommunityAuthorization, useSession: CommunityUseSession, request: ScreenCommunityEnvelope
    public let command: CommunitySafetyCommandBody
    static func verify(_ value: Any, authority: ScreenCommunityAuthority, receiver: CommunityAuthorization,
                       activationId: String, watchers: [CommunitySafetyWatcher], now: Date) throws -> Self {
        let o=try AccessValue.object(value,["commandId","sequence","acceptedAt","expiresAt","receiverPolicyDigest","subscriptionGeneration","authorization","useSession","request"])
        let id=try AccessValue.id(o["commandId"] as Any),sequence=try AccessValue.integer(o["sequence"] as Any),at=try AccessValue.integer(o["acceptedAt"] as Any),expiry=try AccessValue.integer(o["expiresAt"] as Any)
        let accepted=Date(timeIntervalSince1970:Double(at)/1000)
        let auth=try CommunityAccessReply.verify(CommunitySafetyWire.envelope(o["authorization"] as Any),authority:authority,now:accepted).authorization(authority:authority,now:accepted)
        let use=try CommunityAccessReply.verify(CommunitySafetyWire.envelope(o["useSession"] as Any),authority:authority,now:accepted).session(for:auth,now:accepted)
        let request=try CommunitySafetyWire.envelope(o["request"] as Any),bytes=try ScreenCommunityRequest.decodeBase64(request.payload,max:32_000)
        guard let f=try JSONSerialization.jsonObject(with:bytes) as? [Any],f.count==7,try AccessValue.integer(f[0])==2,f[1] as? String=="screen-safety-stop",
              f[2] as? String==id,f[5] as? String==auth.body.enrollmentId,let args=f[6] as? [Any],args.count==5,
              args[0] as? String==receiver.body.communityId,args[1] as? String==use.body.sessionId,args[2] as? String==receiver.body.enrollmentId,args[3] as? String==activationId,
              auth.body.communityId==receiver.body.communityId,auth.body.deviceKind == .mobile,use.body.capabilities.contains(.screenView),sequence>0,
              o["receiverPolicyDigest"] as? String==(try CommunityMobileControlPolicy.authorizationDigest(receiver)),
              let watcher=watchers.first(where:{$0.enrollmentId==auth.body.enrollmentId}),watcher.administrator,
              watcher.deviceId==auth.body.deviceId,watcher.hostPublicKey==auth.body.hostPublicKey,watcher.operationPublicKey==auth.body.publicKey,
              watcher.keyEpoch==auth.body.keyEpoch,watcher.revision==auth.body.revision,watcher.policyDigest==(try CommunityMobileControlPolicy.authorizationDigest(auth)),
              o["subscriptionGeneration"] as? String==watcher.subscriptionGeneration else { throw ScreenCommunityError.wrongCommunity }
        let originalAt=try AccessValue.integer(f[3]);guard let nonce=f[4] as? String,try ScreenCommunityRequest.decodeBase64(nonce,max:43).count==32,
              originalAt<=at+5_000,at<=originalAt+60_000,at<=Int64(now.timeIntervalSince1970*1000)+5_000 else { throw ScreenCommunityError.expired }
        let command=try CommunitySafetyCommandBody.checked(args[4])
        guard expiry>Int64(now.timeIntervalSince1970*1000),expiry<=originalAt+command.action.lifetime,expiry>at else { throw ScreenCommunityError.expired }
        let key=try P256.Signing.PublicKey(x963Representation:AccessValue.key(use.body.publicKey)),signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(request.signature,max:86))
        guard key.isValidSignature(signature,for:Data("agentstoz.community-access.request/v2\0".utf8)+bytes) else { throw ScreenCommunityError.invalidSignature }
        return Self(commandId:id,sequence:sequence,acceptedAt:at,expiresAt:expiry,receiverPolicyDigest:try CommunityMobileControlPolicy.authorizationDigest(receiver),subscriptionGeneration:watcher.subscriptionGeneration,authorization:auth,useSession:use,request:request,command:command)
    }
}

public struct CommunitySafetyRound: Sendable {
    public let receiver: CommunityAuthorization.Body, activationId: String, pollRequestId: String, pollNonce: String
    public let watchers: [CommunitySafetyWatcher], commands: [CommunitySafetyCommand], watcherSetHash: String
    public let communityRevision: Int64, nextSequence: Int64, issuedAt: Int64, expiresAt: Int64
    public static func verify(_ envelope: ScreenCommunityEnvelope, authority: ScreenCommunityAuthority, own: CommunityAuthorization,
                              activationId: String, request: CommunityAccessRequest, now: Date = Date()) throws -> Self {
        guard request.operation == .safetyPoll,let fields=try JSONSerialization.jsonObject(with:request.bytes) as? [Any],fields.count==7,let nonce=fields[4] as? String else { throw ScreenCommunityError.wrongRequest }
        return try checked(envelope,authority:authority,own:own,activationId:activationId,requestId:request.id,nonce:nonce,now:now)
    }
    /// Shared parser; only the public request-taking entry is used by the native polling owner.
    public static func verifyAcknowledgement(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,own:CommunityAuthorization,activationId:String,request:CommunityAccessRequest,now:Date=Date()) throws {
        guard request.operation == .safetyPoll,let fields=try JSONSerialization.jsonObject(with:request.bytes) as? [Any],fields.count==7,let nonce=fields[4] as? String else { throw ScreenCommunityError.wrongRequest }
        _ = try checked(envelope,authority:authority,own:own,activationId:activationId,requestId:request.id,nonce:nonce,now:now,acknowledgementOnly:true)
    }
    static func checked(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,own:CommunityAuthorization,activationId:String,requestId:String,nonce:String,now:Date,acknowledgementOnly:Bool=false) throws -> Self {
        let reply=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard reply.kind=="safety-round" else { throw ScreenCommunityError.wrongRequest }
        let o=try AccessValue.object(reply.value,["version","receiver","activationId","pollRequestId","pollNonce","communityRevision","watcherSetHash","watchers","commands","nextSequence","issuedAt","expiresAt"])
        let receiver=try CommunityAccessReply(kind:"authorization",requestId:reply.requestId,issuedAt:reply.issuedAt,envelope:envelope,value:o["receiver"] as Any).authorization(authority:authority,now:now)
        let at=try AccessValue.integer(o["issuedAt"] as Any),expiry=try AccessValue.integer(o["expiresAt"] as Any),revision=try AccessValue.integer(o["communityRevision"] as Any),next=try AccessValue.integer(o["nextSequence"] as Any)
        guard try AccessValue.integer(o["version"] as Any)==1,o["activationId"] as? String==activationId,o["pollRequestId"] as? String==requestId,
              o["pollNonce"] as? String==nonce,receiver.body.deviceKind == .desktop,receiver.body.capabilities.contains(.receiveView),
              try CommunityMobileControlPolicy.authorizationDigest(receiver)==CommunityMobileControlPolicy.authorizationDigest(own),
              at==reply.issuedAt,at<=Int64(now.timeIntervalSince1970*1000)+5_000,expiry>Int64(now.timeIntervalSince1970*1000),expiry<=min(receiver.body.expiresAt,at+90_000),revision>=receiver.body.revision,next>=0,
              let rows=o["watchers"] as? [Any],(acknowledgementOnly || !rows.isEmpty),rows.count<=16,let records=o["commands"] as? [Any],records.count<=4 else { throw ScreenCommunityError.expired }
        var watchers:[CommunitySafetyWatcher]=[]
        for row in rows {
            let raw=try AccessValue.object(row,["enrollmentId","deviceId","hostPublicKey","operationPublicKey","keyEpoch","revision","policyDigest","subscriptionGeneration","authorizationExpiresAt","administrator"])
            let w=try JSONDecoder().decode(CommunitySafetyWatcher.self,from:JSONSerialization.data(withJSONObject:raw))
            for id in [w.enrollmentId,w.deviceId,w.subscriptionGeneration] { _ = try AccessValue.id(id) }
            _ = try AccessValue.key(w.hostPublicKey);_ = try AccessValue.key(w.operationPublicKey)
            guard w.administrator,w.keyEpoch>0,w.revision>0,w.revision<=revision,w.hostPublicKey != w.operationPublicKey,
                  CommunitySafetyWire.isDigest(w.policyDigest),w.authorizationExpiresAt>=expiry,w.authorizationExpiresAt<=at+90_000 else { throw ScreenCommunityError.wrongCommunity }
            watchers.append(w)
        }
        guard watchers.map(\.enrollmentId)==watchers.map(\.enrollmentId).sorted(),Set(watchers.map(\.enrollmentId)).count==watchers.count,Set(watchers.map(\.deviceId)).count==watchers.count else { throw ScreenCommunityError.malformed }
        let hash=try watcherHash(communityId:own.body.communityId,receiverEnrollmentId:own.body.enrollmentId,activationId:activationId,receiverPolicyDigest:CommunityMobileControlPolicy.authorizationDigest(receiver),watchers:watchers)
        guard o["watcherSetHash"] as? String==hash else { throw ScreenCommunityError.invalidSignature }
        let commands=acknowledgementOnly ? [] : try records.map { try CommunitySafetyCommand.verify($0,authority:authority,receiver:receiver,activationId:activationId,watchers:watchers,now:now) }
        guard Set(commands.map(\.commandId)).count==commands.count,Set(commands.map(\.sequence)).count==commands.count,
              commands.isEmpty || commands.last?.sequence==next else { throw ScreenCommunityError.malformed }
        return Self(receiver:receiver.body,activationId:activationId,pollRequestId:requestId,pollNonce:nonce,watchers:watchers,commands:commands,watcherSetHash:hash,communityRevision:revision,nextSequence:next,issuedAt:at,expiresAt:expiry)
    }
    public static func watcherHash(communityId:String,receiverEnrollmentId:String,activationId:String,receiverPolicyDigest:String,watchers:[CommunitySafetyWatcher]) throws -> String {
        let values:[Any]=[1,communityId,receiverEnrollmentId,activationId,receiverPolicyDigest,watchers.map { [$0.enrollmentId,$0.deviceId,$0.hostPublicKey,$0.operationPublicKey,$0.keyEpoch,$0.revision,$0.policyDigest,$0.subscriptionGeneration,true] as [Any] }]
        return SHA256.hash(data:Data("agentstoz.community-screen-safety.watchers/v1\0".utf8)+(try CommunitySafetyWire.json(values))).map { String(format:"%02x",$0) }.joined()
    }
}

public struct CommunitySafetyHostResult: Sendable {
    public let commandId:String,activationId:String,outcome:CommunitySafetyOutcome,issuedAt:Int64,envelope:ScreenCommunityEnvelope
    public static func make(communityId:String,receiverEnrollmentId:String,activationId:String,commandId:String,outcome:CommunitySafetyOutcome,signer:any TranscriptSigner,now:Date=Date()) async throws -> Self {
        for id in [communityId,receiverEnrollmentId,activationId,commandId] { _ = try AccessValue.id(id) }
        let at=Int64(now.timeIntervalSince1970*1000),bytes=try CommunitySafetyWire.json([1,communityId,receiverEnrollmentId,activationId,commandId,outcome.rawValue,at])
        let signature=try await signer.signature(for:Data("agentstoz.community-screen-safety.result/v1\0".utf8)+bytes)
        return Self(commandId:commandId,activationId:activationId,outcome:outcome,issuedAt:at,envelope:.init(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(signature.rawRepresentation)))
    }
    public static func verify(_ envelope:ScreenCommunityEnvelope,hostKey:Data,communityId:String,receiverEnrollmentId:String,activationId:String,commandId:String,now:Date=Date()) throws -> Self {
        guard envelope.hostSignature==nil else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:4096),key=try P256.Signing.PublicKey(x963Representation:hostKey),signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(envelope.signature,max:86))
        guard key.isValidSignature(signature,for:Data("agentstoz.community-screen-safety.result/v1\0".utf8)+bytes),let f=try JSONSerialization.jsonObject(with:bytes) as? [Any],f.count==7,
              try AccessValue.integer(f[0])==1,f[1] as? String==communityId,f[2] as? String==receiverEnrollmentId,f[3] as? String==activationId,f[4] as? String==commandId,
              let raw=f[5] as? String,let outcome=CommunitySafetyOutcome(rawValue:raw) else { throw ScreenCommunityError.invalidSignature }
        let at=try AccessValue.integer(f[6]);guard at<=Int64(now.timeIntervalSince1970*1000)+5_000 else { throw ScreenCommunityError.expired }
        return Self(commandId:commandId,activationId:activationId,outcome:outcome,issuedAt:at,envelope:envelope)
    }
}

enum CommunitySafetyWire {
    static func json(_ value:Any) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:.withoutEscapingSlashes) }
    static func envelope(_ value:Any) throws -> ScreenCommunityEnvelope {
        let raw=try AccessValue.object(value,["payload","signature"])
        return try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:json(raw))
    }
    static func isDigest(_ value:String) -> Bool { value.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil }
}
