import Foundation

/// Explicit device/scope trust, never a claim of physical human intent. Only signed desktop credentials construct it.
public struct CommunityDesktopScreenTrust:Sendable,Equatable {
    public let controller:CommunityAuthorization.Body,receiver:CommunityAuthorization.Body
    public let channelId:String?
    private let authority:ScreenCommunityAuthority
    public var canControl:Bool { controller.capabilities.contains(.screenControl) && receiver.capabilities.contains(.receiveControl) }
    public var expiresAt:Date { Date(timeIntervalSince1970:Double(min(controller.expiresAt,receiver.expiresAt))/1000) }
    public func isCurrent(at:Date=Date()) -> Bool { expiresAt>at }
    public static func ==(lhs:Self,rhs:Self)->Bool {
        lhs.controller==rhs.controller && lhs.receiver==rhs.receiver && lhs.channelId==rhs.channelId && lhs.authority.origin==rhs.authority.origin && lhs.authority.profileID==rhs.authority.profileID && lhs.authority.issuer.x963Representation==rhs.authority.issuer.x963Representation
    }
    private init(controller:CommunityAuthorization.Body,receiver:CommunityAuthorization.Body,channelId:String?,authority:ScreenCommunityAuthority) {
        self.controller=controller;self.receiver=receiver;self.channelId=channelId;self.authority=authority
    }
    /// Selection authority grants no channel: key possession and v6 confirmation must still complete before input.
    public static func verified(authority:ScreenCommunityAuthority,controller:CommunityAuthorization,receiver:CommunityAuthorization,channelId:String?=nil,now:Date=Date()) throws -> Self {
        let c=try checked(controller,authority:authority,now:now)
        let r=try checked(receiver,authority:authority,now:now)
        guard c.body==controller.body,r.body==receiver.body,c.body.deviceKind == .desktop,r.body.deviceKind == .desktop,
              c.body.communityId==r.body.communityId,c.body.profileId==r.body.profileId,c.body.deviceId != r.body.deviceId,
              c.body.capabilities.contains(.desktopTrust),r.body.capabilities.contains(.desktopTrust),
              c.body.capabilities.contains(.screenView),r.body.capabilities.contains(.receiveView) else { throw ScreenCommunityError.service("DESKTOP_TRUST_REQUIRED") }
        if let channelId { _ = try AccessValue.id(channelId) }
        return Self(controller:c.body,receiver:r.body,channelId:channelId,authority:authority)
    }
    private static func checked(_ value:CommunityAuthorization,authority:ScreenCommunityAuthority,now:Date) throws -> CommunityAuthorization {
        let reply=try CommunityAccessReply.verify(value.envelope,authority:authority,now:now)
        if reply.kind=="authorization" { return try reply.authorization(authority:authority,now:now) }
        guard reply.kind=="directory",let exact=try reply.directory(authority:authority,communityId:value.body.communityId,now:now).first(where:{$0.body==value.body}) else { throw ScreenCommunityError.wrongCommunity }
        return exact
    }
    func renewed(controller:CommunityAuthorization,receiver:CommunityAuthorization,now:Date) throws -> Self {
        let fresh=try Self.verified(authority:authority,controller:controller,receiver:receiver,channelId:channelId,now:now)
        func policy(_ body:CommunityAuthorization.Body)->CommunityAuthorization.Body {
            // Issuance/expiry alone may renew. Every identity, key and policy field remains exact.
            var value=body;value = .init(version:body.version,communityId:body.communityId,profileId:body.profileId,enrollmentId:body.enrollmentId,deviceId:body.deviceId,deviceKind:body.deviceKind,name:body.name,hostPublicKey:body.hostPublicKey,publicKey:body.publicKey,biometricPublicKey:body.biometricPublicKey,controlKey:body.controlKey,agentDeviceId:body.agentDeviceId,capabilities:body.capabilities,revision:body.revision,keyEpoch:body.keyEpoch,issuedAt:0,expiresAt:0);return value
        }
        guard policy(fresh.controller)==policy(self.controller),policy(fresh.receiver)==policy(self.receiver) else { throw ScreenCommunityError.staleRevision }
        return fresh
    }
}

/// A per-connection lease. Once invalidated it cannot be revived by a late same- or different-connection response.
public final class CommunityDesktopTrustLease:@unchecked Sendable,Equatable {
    private let lock=NSLock()
    private var value:CommunityDesktopScreenTrust?
    public init(_ authority:CommunityDesktopScreenTrust,now:Date=Date()) throws {
        guard authority.channelId != nil,authority.isCurrent(at:now) else { throw ScreenCommunityError.expired };value=authority
    }
    public static func ==(lhs:CommunityDesktopTrustLease,rhs:CommunityDesktopTrustLease)->Bool { lhs===rhs }
    public func current(at:Date=Date())->CommunityDesktopScreenTrust? { lock.withLock { guard let value,value.isCurrent(at:at) else { return nil };return value } }
    public func invalidate() { lock.withLock { value=nil } }
    /// Revocation and every synchronous native effect serialize on the same lease lock.
    @discardableResult public func performControl(_ effect:()->Void,now:Date=Date())->Bool {
        lock.withLock { guard let value,value.isCurrent(at:now),value.canControl else { return false };effect();return true }
    }
    public func renew(controller:CommunityAuthorization,receiver:CommunityAuthorization,now:Date=Date()) throws {
        try lock.withLock { guard let old=value,old.isCurrent(at:now) else { value=nil;throw ScreenCommunityError.expired };value=try old.renewed(controller:controller,receiver:receiver,now:now) }
    }
}

/// Receiver-only explicit ON intent. It grants no controller, channel, input or hold-release authority.
public struct CommunityDesktopReceiveTrust:Sendable {
    public let body:CommunityAuthorization.Body
    private let authority:ScreenCommunityAuthority
    private init(_ body:CommunityAuthorization.Body,authority:ScreenCommunityAuthority) { self.body=body;self.authority=authority }
    public func isCurrent(at:Date=Date())->Bool { body.expiresAt>Int64(at.timeIntervalSince1970*1000) }
    public func hasSamePolicy(as other:Self)->Bool {
        let a=body,b=other.body
        return authority.origin==other.authority.origin && authority.issuer.x963Representation==other.authority.issuer.x963Representation && a.version==b.version && a.communityId==b.communityId && a.profileId==b.profileId && a.enrollmentId==b.enrollmentId && a.deviceId==b.deviceId && a.deviceKind==b.deviceKind && a.name==b.name && a.hostPublicKey==b.hostPublicKey && a.publicKey==b.publicKey && a.biometricPublicKey==b.biometricPublicKey && a.controlKey==b.controlKey && a.agentDeviceId==b.agentDeviceId && a.capabilities==b.capabilities && a.revision==b.revision && a.keyEpoch==b.keyEpoch
    }
    public static func verified(authority:ScreenCommunityAuthority,authorization:CommunityAuthorization,deviceID:String,hostKey:String,now:Date=Date()) throws -> Self {
        let own=try CommunityAccessReply.verify(authorization.envelope,authority:authority,now:now).authorization(authority:authority,now:now)
        guard own.body==authorization.body,own.body.deviceId==deviceID,own.body.hostPublicKey==hostKey,own.body.deviceKind == .desktop,
              own.body.capabilities.contains(.desktopTrust),own.body.capabilities.contains(.receiveView) else { throw ScreenCommunityError.service("DESKTOP_TRUST_REQUIRED") }
        return Self(own.body,authority:authority)
    }
}
