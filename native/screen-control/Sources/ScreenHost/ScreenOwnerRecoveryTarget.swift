#if os(macOS)
import Foundation
import CryptoKit
import ScreenControlCore

/// Private native target lifecycle. None of its publish/result inputs is accepted by Viewer.prepare.
actor ScreenOwnerRecoveryTarget {
    struct Context:Sendable { let own:CommunityAuthorization,peers:[CommunityAuthorization],receivingHeld:Bool }
    struct Snapshot:Sendable { let instance:String,holdGeneration:String,connectionId:String? }
    struct Status:Sendable { let localGeneration:String,enabled:Bool,revision:Int64,round:CommunityOwnerRound? }
    private let store:ScreenOwnerRecoveryStore,authority:ScreenCommunityAuthority,signer:any TranscriptSigner
    private let context:@Sendable (Bool)async throws->Context
    private let send:@Sendable (ScreenCommunityEnvelope,String)async throws->CommunityAccessReply
    private var lastRound:CommunityOwnerRound?
    private var emergencyOff=false
    init(store:ScreenOwnerRecoveryStore,authority:ScreenCommunityAuthority,signer:any TranscriptSigner,context:@escaping @Sendable (Bool)async throws->Context,send:(@Sendable (ScreenCommunityEnvelope,String)async throws->CommunityAccessReply)?=nil) {
        self.store=store;self.authority=authority;self.signer=signer;self.context=context
        self.send=send ?? {envelope,id in try await CommunityAccessHTTP(authority:authority).send(envelope,requestId:id)}
    }
    private func current(qualifying:Bool=true)async throws->Context {
        let c=try await context(qualifying),b=c.own.body
        guard b.deviceKind == .desktop,b.hostPublicKey==ScreenCommunityRequest.base64(signer.publicKey.x963Representation) else {throw ScreenCommunityError.service("OWNER_IDENTITY_REQUIRED")}
        if qualifying {guard c.own.isCurrent(),b.capabilities.contains(.desktopTrust),b.capabilities.contains(.receiveView),b.capabilities.contains(.receiveControl) else {throw ScreenCommunityError.service("OWNER_RECEIVER_REQUIRED")}}
        return c
    }
    private func request(_ operation:CommunityAccessRequest.Operation,_ values:[Any],own:CommunityAuthorization)async throws->CommunityAccessReply {
        let r=try CommunityAccessRequest(operation:operation,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value(values))
        return try await send(r.signed(by:signer),r.id)
    }
    func status(negativeOnly:Bool=false)async throws->Status {
        let c=try await current(qualifying:!negativeOnly)
        try await recoverDisable(own:c.own)
        let s=try store.read()
        let response=try await request(.ownerPoll,[c.own.body.communityId],own:c.own)
        let freshContext=try await current(qualifying:!negativeOnly)
        guard try CommunityMobileControlPolicy.authorizationDigest(freshContext.own)==CommunityMobileControlPolicy.authorizationDigest(c.own),
              try store.read().localGeneration==s.localGeneration else {throw ScreenCommunityError.service("OWNER_CONTEXT_CHANGED")}
        let round=try CommunityOwnerRound.verify(response.envelope,authority:authority,own:freshContext.own,target:true,requestId:response.requestId)
        guard let d=round.delegation,d.body.revision>=s.minimumRevision else { throw ScreenCommunityError.staleRevision }
        if !negativeOnly,s.pendingSetup,!store.isBlocked,c.own.body.capabilities.contains(.ownerDelegation),d.body.enabled,d.body.revision==c.own.body.revision {
            try store.update {value in
                guard value.pendingSetup,value.localGeneration==s.localGeneration,!value.enabled else {throw ScreenCommunityError.service("OWNER_SETUP_CHANGED")}
                value.enabled=true;value.pendingSetup=false;value.setupAuthorization=c.own.envelope;value.policy=d.envelope;value.minimumRevision=d.body.revision
            }
        }
        if d.body.revision>s.minimumRevision || (s.enabled && !d.body.enabled) {
            try store.update { state in
                guard state.localGeneration==s.localGeneration else {throw ScreenCommunityError.service("OWNER_LOCAL_OFF")}
                state.minimumRevision=d.body.revision;state.policy=d.envelope
                if !d.body.enabled {state.enabled=false;state.localGeneration=UUID().uuidString.lowercased()}
            }
        }
        lastRound=round;let fresh=try store.read()
        return Status(localGeneration:fresh.localGeneration,enabled:!negativeOnly && fresh.enabled && !emergencyOff && !store.isBlocked && d.body.enabled,revision:d.body.revision,round:round)
    }
    /// Original positive BIO request, exact CF reply and the pre-auth local generation are all necessary.
    func commit(policy:ScreenCommunityEnvelope,original:ScreenCommunityEnvelope,expectedLocalGeneration:String)async throws {
        let c=try await current(),before=try store.read(),b=c.own.body
        guard before.pendingDisable==nil else {throw ScreenCommunityError.service("OWNER_NEGATIVE_RESULT_UNKNOWN")}
        // A lost local IPC acknowledgement may recover this exact committed original. It cannot reopen a later OFF.
        if before.enabled,!store.isBlocked,before.positiveRequest==original,before.policy==policy {
            let latest=try await status();guard latest.enabled else {throw ScreenCommunityError.service("OWNER_LOCAL_OFF")};return
        }
        guard before.localGeneration==expectedLocalGeneration else { throw ScreenCommunityError.service("OWNER_LOCAL_OFF") }
        let raw=try CommunityOwnerWire.request(original,operation:.ownerDelegationSet,actor:b.enrollmentId,communityId:b.communityId)
        guard raw.args.count==2,let selection=raw.args[1] as? [String:Any],Set(selection.keys)==["version","enabled","expectedRevision"],selection["version"] as? Int==1,selection["enabled"] as? Bool==true,let revision=selection["expectedRevision"] as? Int64,
              abs(Double(raw.at)-Date().timeIntervalSince1970*1000)<=60_000,
              try P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(b.biometricPublicKey,max:87)).isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(original.signature,max:86)),for:Data("agentstoz.community-access.request/v2\0".utf8)+raw.bytes) else { throw ScreenCommunityError.invalidSignature }
        let granted=try CommunityOwnerDelegation.verify(policy,authority:authority,own:c.own,requestId:raw.id)
        guard granted.body.enabled,granted.body.revision==revision+1 else { throw ScreenCommunityError.staleRevision }
        let fresh=try await status(),latest=try requiredDelegation(fresh)
        guard latest.body.enabled,latest.body.revision==granted.body.revision else {throw ScreenCommunityError.staleRevision}
        try store.update(releaseBlock:true) { s in
            guard s.localGeneration==expectedLocalGeneration,s.minimumRevision<=granted.body.revision else {throw ScreenCommunityError.service("OWNER_LOCAL_OFF")}
            s.enabled=true;s.pendingSetup=false;s.localGeneration=UUID().uuidString.lowercased();s.minimumRevision=granted.body.revision;s.positiveRequest=original;s.policy=policy
        }
        emergencyOff=false
    }
    private func requiredDelegation(_ s:Status)throws->CommunityOwnerDelegation { guard let d=s.round?.delegation else {throw ScreenCommunityError.malformed};return d }
    /// Resolves only the exact old negative using the existing host-key receipt; it never dispatches that mutation.
    private func recoverDisable(own:CommunityAuthorization)async throws {
        guard let original=try store.read().pendingDisable else {return}
        let raw=try CommunityOwnerWire.request(original.envelope,operation:.ownerDelegationSet,actor:own.body.enrollmentId,communityId:own.body.communityId)
        guard raw.id==original.id,original.operation==CommunityAccessRequest.Operation.ownerDelegationSet.rawValue,
              raw.args.count==2,let selection=raw.args[1] as? [String:Any],Set(selection.keys)==["version","enabled","expectedRevision"],selection["version"] as? Int==1,selection["enabled"] as? Bool==false,
              let revision=selection["expectedRevision"] as? Int64,revision>=0,
              try signer.publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(original.envelope.signature,max:86)),for:Data("agentstoz.community-access.request/v2\0".utf8)+raw.bytes) else {throw ScreenCommunityError.wrongRequest}
        let coordinator=CommunityAccessCoordinator(authority:authority,pending:original,save:{_ in},exchange:send)
        let response=try await coordinator.recover(using:signer)
        // This historical false receipt closes a negative fence, never an execution lease or positive setup.
        let policy=try CommunityOwnerDelegation.verify(response.envelope,authority:authority,own:own,requestId:original.id,now:Date(timeIntervalSince1970:Double(response.issuedAt)/1000))
        guard !policy.body.enabled,policy.body.revision==revision+1,abs(Double(response.issuedAt)-Double(raw.at))<=60_000 else {throw ScreenCommunityError.wrongRequest}
        try store.update(block:true) {
            guard $0.pendingDisable==original,!$0.enabled else {throw ScreenCommunityError.service("OWNER_NEGATIVE_STATE_CHANGED")}
            $0.minimumRevision=max($0.minimumRevision,policy.body.revision);$0.policy=policy.envelope
        }
        try store.archivePending(disable:true,expected:original)
    }
    /// Failure to persist or reach the service never leaves this process accepting delegated positives.
    func disable()async throws {
        emergencyOff=true
        _=try store.closeLocally()
        let c=try await current(qualifying:false)
        if try store.read().pendingDisable != nil {try await recoverDisable(own:c.own);return}
        let status=try await status(negativeOnly:true)
        let r=try CommunityAccessRequest(operation:.ownerDelegationSet,actor:c.own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([c.own.body.communityId,["version":1,"enabled":false,"expectedRevision":status.revision]]))
        let envelope=try await r.signed(by:signer)
        let pending=try JSONDecoder().decode(CommunityAccessJournal.self,from:JSONSerialization.data(withJSONObject:["id":r.id,"operation":r.operation.rawValue,"actor":c.own.body.enrollmentId,"envelope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(envelope))]))
        try store.update { $0.pendingDisable=pending }
        let reply=try await send(envelope,r.id)
        let policy=try CommunityOwnerDelegation.verify(reply.envelope,authority:authority,own:c.own,requestId:r.id)
        guard !policy.body.enabled else {throw ScreenCommunityError.wrongRequest}
        try store.update{$0.minimumRevision=max($0.minimumRevision,policy.body.revision);$0.policy=policy.envelope}
        try store.archivePending(disable:true,expected:pending)
    }
    private func mutate(_ operation:CommunityAccessRequest.Operation,values:[Any],own:CommunityAuthorization)async throws->CommunityOwnerRecord {
        guard try store.read().pending==nil else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
        let r=try CommunityAccessRequest(operation:operation,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value(values)),envelope=try await r.signed(by:signer)
        let journal=try JSONDecoder().decode(CommunityAccessJournal.self,from:JSONSerialization.data(withJSONObject:["id":r.id,"operation":operation.rawValue,"actor":own.body.enrollmentId,"envelope":try JSONSerialization.jsonObject(with:JSONEncoder().encode(envelope))]))
        try store.update {
            guard $0.pending==nil else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
            if operation == .ownerResult {guard values.count==3,let id=values[1] as? String else {throw ScreenCommunityError.malformed};try $0.effects.reporting(id,requestId:r.id)}
            $0.pending=journal
        }
        let reply=try await send(envelope,r.id)
        let record=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId,requestId:r.id)
        try store.archivePending(expected:journal);return record
    }
    private func reconcile(_ round:CommunityOwnerRound,own:CommunityAuthorization)throws {
        guard let pending=try store.read().pending else {return}
        let raw=try CommunityOwnerWire.request(pending.envelope,operation:CommunityAccessRequest.Operation(rawValue:pending.operation)!,actor:own.body.enrollmentId,communityId:own.body.communityId)
        guard raw.args.count>=2,let id=raw.args[1] as? String,let record=round.records.first(where:{$0.body.requestId==id}) else {return}
        if pending.operation==CommunityAccessRequest.Operation.ownerPublish.rawValue,let intent=record.body.intent,let published=raw.args[2] as? [String:Any],published["holdGeneration"] as? String==intent.holdGeneration,published["challenge"] as? String==intent.challenge {
            let expected=published["connectionId"] as? String
            guard expected==intent.connectionId else {throw ScreenCommunityError.wrongRequest};try store.archivePending(expected:pending)
        } else if pending.operation==CommunityAccessRequest.Operation.ownerResult.rawValue,let value=raw.args[2] as? [String:Any],value["outcome"] as? String==record.body.outcome?.rawValue {try store.archivePending(expected:pending)}
    }
    private func recoverPending(own:CommunityAuthorization)async throws {
        guard let pending=try store.read().pending,let operation=CommunityAccessRequest.Operation(rawValue:pending.operation) else {return}
        let original=try CommunityOwnerWire.request(pending.envelope,operation:operation,actor:own.body.enrollmentId,communityId:own.body.communityId)
        guard original.args.count==3,let id=original.args[1] as? String else {throw ScreenCommunityError.malformed}
        do {
            let coordinator=CommunityAccessCoordinator(authority:authority,pending:pending,save:{_ in},exchange:send)
            let reply=try await coordinator.recover(using:signer)
            let record=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId)
            guard record.body.requestId==id else {throw ScreenCommunityError.wrongRequest}
            if operation == .ownerResult,let outcome=try store.read().effects.entries[id]?.outcome {
                guard record.body.targetEnrollmentId==own.body.enrollmentId,record.body.outcome==outcome else {throw ScreenCommunityError.service("OWNER_RESULT_CONFLICT")}
                try store.update {try $0.effects.reported(id,outcome:outcome)}
            }
            try store.archivePending(expected:pending)
        } catch ScreenCommunityError.service(let code) where ["RECEIPT_NOT_FOUND","RECEIPT_EXPIRED"].contains(code) {
            let reply=try await request(.ownerStatus,[own.body.communityId,id],own:own)
            let record=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId,requestId:reply.requestId)
            try reconcileRecord(record,pending:pending,raw:original.args)
        }
    }
    private func reconcileRecord(_ record:CommunityOwnerRecord,pending:CommunityAccessJournal,raw:[Any])throws {
        guard raw.count==3,record.body.requestId==raw[1] as? String else {throw ScreenCommunityError.wrongRequest}
        if pending.operation==CommunityAccessRequest.Operation.ownerPublish.rawValue,let intent=record.body.intent,let published=raw[2] as? [String:Any],published["holdGeneration"] as? String==intent.holdGeneration,published["challenge"] as? String==intent.challenge {
            guard published["connectionId"] as? String==intent.connectionId else {throw ScreenCommunityError.wrongRequest};try store.archivePending(expected:pending)
        } else if pending.operation==CommunityAccessRequest.Operation.ownerResult.rawValue,let result=raw[2] as? [String:Any],result["outcome"] as? String==record.body.outcome?.rawValue {try store.archivePending(expected:pending)}
        else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
    }
    /// Historical immutable outcome reporting uses only the target host identity. It never admits a positive effect.
    private func reportOutcomes()async throws {
        let own=try await current(qualifying:false).own
        try await recoverDisable(own:own)
        try await recoverPending(own:own)
        for (id,entry) in try store.read().effects.entries where entry.outcome != nil && !entry.reported {
            guard try store.read().pending==nil,let outcome=entry.outcome else {return}
            let record:CommunityOwnerRecord
            if let requestId=entry.reportRequestId {
                guard let original=try store.read().archive.first(where:{$0.id==requestId}) else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
                let c=CommunityAccessCoordinator(authority:authority,pending:original,save:{_ in},exchange:send)
                let reply=try await c.recover(using:signer)
                record=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId)
            } else {
                record=try await mutate(.ownerResult,values:[own.body.communityId,id,["version":1,"outcome":outcome.rawValue]],own:own)
            }
            guard record.body.requestId==id,record.body.targetEnrollmentId==own.body.enrollmentId,record.body.outcome==outcome else {throw ScreenCommunityError.service("OWNER_RESULT_CONFLICT")}
            try store.update {try $0.effects.reported(id,outcome:outcome)}
        }
    }
    func tick(snapshot:@Sendable ()async->Snapshot?,apply:@Sendable (ScreenDelegatedInputPermit)async throws->Bool)async throws->(notice:String,enabled:Bool) {
        try await reportOutcomes()
        let status=try await status(),c=try await current(),s=try store.read()
        guard let round=status.round,let delegation=round.delegation else {throw ScreenCommunityError.malformed}
        try reconcile(round,own:c.own)
        guard status.enabled,!c.receivingHeld,!emergencyOff,let snapshot=await snapshot() else {return (status.enabled ? "위임 등록 유지 · Screen 켜짐·잠금 해제·입력 보류 상태를 기다립니다.":"다른 승인 Mac의 입력 보류 해제 위임 · 꺼짐",status.enabled)}
        for record in round.records {
            let b=record.body
            if b.state == .waitingHost,try store.read().effects.entries[b.requestId]==nil,try store.read().pending==nil {
                let challenge=ScreenCommunityRequest.base64(SymmetricKey(size:.bits256).withUnsafeBytes{Data($0)})
                let p=CommunityOwnerEffectJournal.Publication(recordId:b.requestId,instance:snapshot.instance,localGeneration:s.localGeneration,holdGeneration:snapshot.holdGeneration,connectionId:snapshot.connectionId,challenge:challenge,targetPolicyDigest:b.targetPolicyDigest,sourcePolicyDigest:b.sourcePolicyDigest,delegationRevision:delegation.body.revision,expiresAt:b.expiresAt)
                try store.update {guard $0.enabled,$0.localGeneration==s.localGeneration else {throw ScreenCommunityError.service("OWNER_LOCAL_OFF")};try $0.effects.publish(p)}
                _=try await mutate(.ownerPublish,values:[b.communityId,b.requestId,["version":1,"action":"resume-input","holdGeneration":p.holdGeneration,"connectionId":p.connectionId as Any? ?? NSNull(),"challenge":p.challenge]],own:c.own)
            } else if b.state == .approved,let entry=try store.read().effects.entries[b.requestId],entry.reservationHash==nil,
                      let source=c.peers.first(where:{$0.body.enrollmentId==b.sourceEnrollmentId}) {
                let proof=try CommunityDelegatedInputConfirmation.verify(record:record,authority:authority,currentTarget:c.own,currentSource:source,currentDelegation:delegation)
                guard entry.publication.matches(proof,instance:snapshot.instance,localGeneration:s.localGeneration,holdGeneration:snapshot.holdGeneration,connectionId:snapshot.connectionId) else {continue}
                try store.update {guard $0.enabled,$0.localGeneration==s.localGeneration else {throw ScreenCommunityError.service("OWNER_LOCAL_OFF")};try $0.effects.reserve(proof)}
                let permit=ScreenDelegatedInputPermit(proof:proof,publication:entry.publication,store:store)
                let applied=try await apply(permit)
                try store.update {try $0.effects.finish(b.requestId,outcome:applied ? .applied:.superseded)}
                // Send on the next poll after the durable result, never infer execution from a transport response.
                return (applied ? "다른 승인 Mac의 생체 확인으로 입력 보류를 해제했습니다. 로컬 OS 인증을 대신한 것은 아닙니다.":"대상 상태가 바뀌어 이전 위임 승인을 적용하지 않았습니다.",true)
            }
        }
        return ("입력 보류 해제 위임 켜짐 · 요청별 다른 Mac의 실제 생체 승인을 기다립니다.",true)
    }
}
#endif
