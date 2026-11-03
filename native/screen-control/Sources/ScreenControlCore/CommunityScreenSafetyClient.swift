import Foundation
import CryptoKit

/// Fixed native RAM-key operations. Constructing one neither starts a use episode nor requests biometrics.
public struct CommunitySafetyMobileRequest: Sendable {
    public let request: CommunityAccessRequest, authorization: CommunityAuthorization, session: CommunityUseSession
    private init(operation:CommunityAccessRequest.Operation,authorization:CommunityAuthorization,session:CommunityUseSession,arguments:[Any],id:UUID=UUID(),now:Date=Date()) throws {
        guard authorization.body.deviceKind == .mobile,authorization.isCurrent(at:now),session.body.communityId==authorization.body.communityId,
              session.body.enrollmentId==authorization.body.enrollmentId,session.body.revision==authorization.body.revision,
              session.body.capabilities.contains(.screenView),session.body.expiresAt>Int64(now.timeIntervalSince1970*1000) else { throw ScreenCommunityError.expired }
        self.authorization=authorization;self.session=session
        request=try CommunityAccessRequest(operation:operation,actor:authorization.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:arguments,options:.withoutEscapingSlashes),now:now,id:id)
    }
    public static func state(authorization:CommunityAuthorization,session:CommunityUseSession,receiverEnrollmentId:String) throws -> Self {
        _ = try AccessValue.id(receiverEnrollmentId)
        return try Self(operation:.safetyState,authorization:authorization,session:session,arguments:[authorization.body.communityId,session.body.sessionId,receiverEnrollmentId])
    }
    public static func stop(authorization:CommunityAuthorization,session:CommunityUseSession,receiverEnrollmentId:String,activationId:String,command:CommunitySafetyCommandBody,id:UUID=UUID(),now:Date=Date()) throws -> Self {
        _ = try AccessValue.id(receiverEnrollmentId);_ = try AccessValue.id(activationId)
        return try Self(operation:.safetyStop,authorization:authorization,session:session,arguments:[authorization.body.communityId,session.body.sessionId,receiverEnrollmentId,activationId,command.value()],id:id,now:now)
    }
    public static func result(authorization:CommunityAuthorization,session:CommunityUseSession,commandId:String) throws -> Self {
        _ = try AccessValue.id(commandId)
        return try Self(operation:.safetyResult,authorization:authorization,session:session,arguments:[authorization.body.communityId,session.body.sessionId,commandId])
    }
    public var bytes:Data { Data("agentstoz.community-access.request/v2\0".utf8)+request.bytes }
    public func validate(currentAuthorization:CommunityAuthorization,currentSession:CommunityUseSession,now:Date=Date()) throws {
        guard currentAuthorization.isCurrent(at:now),try CommunityMobileControlPolicy.authorizationDigest(currentAuthorization)==CommunityMobileControlPolicy.authorizationDigest(authorization),
              currentSession.body.sessionId==session.body.sessionId,currentSession.body.publicKey==session.body.publicKey,currentSession.body.revision==session.body.revision,
              currentSession.body.capabilities.contains(.screenView),currentSession.body.expiresAt>Int64(now.timeIntervalSince1970*1000) else { throw ScreenCommunityError.expired }
    }
    public func envelope(signature:Data) throws -> ScreenCommunityEnvelope {
        let key=try P256.Signing.PublicKey(x963Representation:AccessValue.key(session.body.publicKey)),sig=try P256.Signing.ECDSASignature(rawRepresentation:signature)
        guard key.isValidSignature(sig,for:bytes) else { throw ScreenCommunityError.invalidSignature }
        return .init(payload:ScreenCommunityRequest.base64(request.bytes),signature:ScreenCommunityRequest.base64(signature))
    }
}

public struct CommunitySafetyRemoteState:Sendable {
    public let receiver:CommunityAuthorization.Body,activationId:String?,state:CommunitySafetyHostState?,lastPollAt:Int64?
    public let issuedAt:Int64,expiresAt:Int64
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,requestId:String,expectedReceiver:CommunityAuthorization,now:Date=Date()) throws -> Self {
        let reply=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard reply.kind=="safety-state" else { throw ScreenCommunityError.wrongRequest }
        let o=try AccessValue.object(reply.value,["version","receiver","activationId","state","lastPollAt","issuedAt","expiresAt"])
        let receiver=try CommunityAccessReply(kind:"authorization",requestId:reply.requestId,issuedAt:reply.issuedAt,envelope:reply.envelope,value:o["receiver"] as Any).authorization(authority:authority,now:now)
        let at=try AccessValue.integer(o["issuedAt"] as Any),expiry=try AccessValue.integer(o["expiresAt"] as Any)
        let activation=o["activationId"] is NSNull ? nil : try AccessValue.id(o["activationId"] as Any)
        let last=o["lastPollAt"] is NSNull ? nil : try AccessValue.integer(o["lastPollAt"] as Any)
        let state=o["state"] is NSNull ? nil : try CommunitySafetyWire.hostState(o["state"] as Any)
        guard try AccessValue.integer(o["version"] as Any)==1,at==reply.issuedAt,expiry>Int64(now.timeIntervalSince1970*1000),expiry<=min(receiver.body.expiresAt,at+90_000),
              receiver.body.deviceKind == .desktop,receiver.body.capabilities.contains(.receiveView),
              try CommunityMobileControlPolicy.authorizationDigest(receiver)==CommunityMobileControlPolicy.authorizationDigest(expectedReceiver),
              state==nil || (activation != nil && last != nil && last!<=at+5_000 && last!>=at-90_000) else { throw ScreenCommunityError.wrongCommunity }
        return Self(receiver:receiver.body,activationId:activation,state:state,lastPollAt:last,issuedAt:at,expiresAt:expiry)
    }
}

public struct CommunitySafetyReceipt:Sendable {
    public enum State:String,Sendable { case queued,result,expired,refused,unseen }
    public let commandId:String,receiverEnrollmentId:String,activationId:String,state:State,result:CommunitySafetyHostResult?
    public static func verify(_ envelope:ScreenCommunityEnvelope,authority:ScreenCommunityAuthority,requestId:String,commandId:String,receiver:CommunityAuthorization,activationId:String,now:Date=Date()) throws -> Self {
        let reply=try CommunityAccessReply.verify(envelope,authority:authority,requestId:requestId,now:now)
        guard reply.kind=="safety-result" else { throw ScreenCommunityError.wrongRequest }
        let o=try AccessValue.object(reply.value,["version","commandId","receiverEnrollmentId","activationId","state","result","code","issuedAt","expiresAt"])
        guard let raw=o["state"] as? String,let state=State(rawValue:raw),try AccessValue.integer(o["version"] as Any)==1,o["commandId"] as? String==commandId,
              (state == .unseen ? (o["receiverEnrollmentId"] is NSNull && o["activationId"] is NSNull) : (o["receiverEnrollmentId"] as? String==receiver.body.enrollmentId && o["activationId"] as? String==activationId)),
              try AccessValue.integer(o["issuedAt"] as Any)==reply.issuedAt,
              try AccessValue.integer(o["expiresAt"] as Any)>Int64(now.timeIntervalSince1970*1000),
              o["code"] is NSNull || ((o["code"] as? String)?.range(of:"^[A-Z_]{1,80}$",options:.regularExpression) != nil) else { throw ScreenCommunityError.wrongCommunity }
        let result=o["result"] is NSNull ? nil : try CommunitySafetyHostResult.verify(CommunitySafetyWire.envelope(o["result"] as Any),hostKey:AccessValue.key(receiver.body.hostPublicKey),communityId:receiver.body.communityId,receiverEnrollmentId:receiver.body.enrollmentId,activationId:activationId,commandId:commandId,now:now)
        guard (state == .result)==(result != nil) else { throw ScreenCommunityError.malformed }
        return Self(commandId:commandId,receiverEnrollmentId:receiver.body.enrollmentId,activationId:activationId,state:state,result:result)
    }
}

extension CommunitySafetyWire {
    static func hostState(_ value:Any) throws -> CommunitySafetyHostState {
        let o=try AccessValue.object(value,["power","held","session","observationSequence"])
        if !(o["session"] is NSNull) { _ = try AccessValue.object(o["session"] as Any,["channelId","controllerEnrollmentId","since"]) }
        let state=try JSONDecoder().decode(CommunitySafetyHostState.self,from:json(o))
        if let session=state.session { _ = try CommunitySafetyHostState.Session(channelId:session.channelId,controllerEnrollmentId:session.controllerEnrollmentId,since:session.since) }
        guard state.observationSequence>0,state.observationSequence<=9_007_199_254_740_991,state.power != .off || state.session == nil else { throw ScreenCommunityError.malformed }
        return state
    }
}
