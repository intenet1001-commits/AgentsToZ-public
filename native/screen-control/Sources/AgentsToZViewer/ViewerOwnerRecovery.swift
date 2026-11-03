#if os(macOS)
import Foundation
import ScreenControlCore

final class ViewerOwnerStore:@unchecked Sendable {
    struct Receipt:Codable,Equatable { let original:CommunityAccessJournal,response:ScreenCommunityEnvelope,retireAt:Int64;var completion:ScreenCommunityEnvelope? }
    struct State:Codable,Equatable {var pending:CommunityAccessJournal?;var localGeneration:String?;var tracked:[String]=[];var receipts:[Receipt]=[]}
    private let backend:any ViewerTargetsBackend,lock=NSLock()
    init(backend:any ViewerTargetsBackend=KeychainTargets(account:"owner-recovery-v1")){self.backend=backend}
    func read()throws->State {try lock.withLock{guard let bytes=try backend.read() else {return State()};guard bytes.count<=524_288 else {throw ScreenCommunityError.malformed};let s=try JSONDecoder().decode(State.self,from:bytes);guard s.receipts.count<=128,s.tracked.count<=4 else {throw ScreenCommunityError.malformed};return s}}
    func update(_ mutate:(inout State)throws->Void)throws {
        try lock.withLock {
            var s=try backend.read().map{try JSONDecoder().decode(State.self,from:$0)} ?? State();let before=s;try mutate(&s)
            if s==before {return}
            guard s.receipts.count<=128,s.tracked.count<=4 else {throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL")};let bytes=try JSONEncoder().encode(s);guard bytes.count<=524_288 else {throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL")};try backend.write(bytes)
        }
    }
    func receipt(_ original:CommunityAccessJournal,response:ScreenCommunityEnvelope,closePending:Bool=false,allowRefreshedLookup:Bool=false)throws {
        try update {s in
            if closePending {
                guard s.pending==nil || s.pending==original else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
                s.pending=nil // Exact known evidence and release of its durable fence are one protected write.
            }
            if let index=s.receipts.firstIndex(where:{$0.original.id==original.id}) {
                guard s.receipts[index].original==original else {throw ScreenCommunityError.service("OWNER_EVIDENCE_CONFLICT")}
                if s.receipts[index].response != response {
                    guard closePending,allowRefreshedLookup else {throw ScreenCommunityError.service("OWNER_EVIDENCE_CONFLICT")}
                    s.receipts[index].completion=response // Preserve the first original evidence and exact fresh closure proof.
                }
                return
            }
            s.receipts=s.receipts.filter{$0.retireAt>Int64(Date().timeIntervalSince1970*1000)};guard s.receipts.count<128 else {throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL")};s.receipts.append(.init(original:original,response:response,retireAt:Int64(Date().timeIntervalSince1970*1000)+604_800_000))
        }
    }
}

/// Explicit UI workflow. A fresh protected-key signer is requested only by enable/approve, never by refresh.
@MainActor final class ViewerOwnerRecovery {
    let authority:ScreenCommunityAuthority
    private var store:ViewerOwnerStore
    private let injectedStore:Bool
    private var subject:String?
    private var coordinator:CommunityAccessCoordinator?
    private var generation=0
    private(set) var records:[CommunityOwnerRecord]=[]
    private(set) var targets:[CommunityAuthorization]=[]
    private(set) var own:CommunityAuthorization?
    private(set) var targetStatus:CommunityOwnerRound?
    private(set) var targetLocalGeneration:String?
    private(set) var targetEnabled:Bool?
    private(set) var status="입력 보류 해제 위임은 별도 선택입니다. 이 Mac의 OS 인증을 다른 Mac이 대신하지 않습니다."
    private(set) var busy=false
    var changed:()->Void={}
    init(authority:ScreenCommunityAuthority,store:ViewerOwnerStore?=nil){self.authority=authority;self.store=store ?? ViewerOwnerStore();self.injectedStore=store != nil}
    private func selectSubject(_ own:CommunityAuthorization) {
        guard subject != own.body.enrollmentId else {return}
        cancel();subject=own.body.enrollmentId;coordinator=nil;records=[];targets=[];targetStatus=nil;targetEnabled=nil;targetLocalGeneration=nil
        if !injectedStore {store=ViewerOwnerStore(backend:KeychainTargets(account:"owner-recovery-v1."+own.body.enrollmentId))}
        // Former enrollment evidence remains in its original protected account; it is never reused for a new member.
    }
    func cancel(){generation &+= 1}
    func failed(_ message:String){status=message;changed()}
    private func transport()throws->CommunityAccessCoordinator {
        if let coordinator{return coordinator}
        let store=store,c=CommunityAccessCoordinator(authority:authority,pending:try store.read().pending,save:{pending in try store.update{$0.pending=pending}});coordinator=c;return c
    }
    private func saveResult(_ reply:CommunityAccessReply,transport:CommunityAccessCoordinator,originalLookup:Bool=false)async throws {
        guard let original=await transport.snapshot() else {throw ScreenCommunityError.wrongRequest}
        try store.receipt(original,response:reply.envelope,closePending:true,allowRefreshedLookup:originalLookup);try await transport.acknowledge(original.id)
    }
    func refresh(own:CommunityAuthorization,peers:[CommunityAuthorization],operation:(any TranscriptSigner)?,host:any TranscriptSigner)async {
        guard !busy else {return};selectSubject(own);self.own=own
        targets=peers.filter{$0.isCurrent() && $0.body.deviceKind == .desktop && $0.body.deviceId != own.body.deviceId && $0.body.capabilities.contains(.desktopTrust) && $0.body.capabilities.contains(.receiveView) && $0.body.capabilities.contains(.receiveControl)}
        do {
            let initial=try store.read()
            if initial.pending==nil,let coordinator,let original=await coordinator.snapshot(),initial.receipts.contains(where:{$0.original==original}) {
                try await coordinator.acknowledge(original.id) // A prior write may have committed before reporting failure.
            }
            if let pending=try store.read().pending {
                let t=try transport()
                do {
                    let recovered=try await t.recover(using:host)
                    // A recovered enable is a known server result; it never replays setup or approves a new intent.
                    if pending.operation==CommunityAccessRequest.Operation.ownerDelegationSet.rawValue,let local=try store.read().localGeneration {
                        do {_ = try await ScreenCommunityCommand(.ownerDelegationCommit,[.string(local),.string(ScreenCommunityRequest.base64(try JSONEncoder().encode(pending.envelope)))],certificate:recovered.envelope).call()}
                        catch {status="원래 위임 등록 결과는 확인했습니다. 기기 반영이 되지 않았다면 새 명시 설정·생체 확인이 필요합니다."}
                    }
                    try await saveResult(recovered,transport:t)
                } catch ScreenCommunityError.service(let code) where ["RECEIPT_NOT_FOUND","RECEIPT_EXPIRED"].contains(code) && pending.operation==CommunityAccessRequest.Operation.ownerRequest.rawValue {
                    guard let operation else {throw ScreenCommunityError.service("OWNER_SOURCE_REQUIRED")}
                    let args=try CommunityOwnerWire.value([own.body.communityId,pending.id,try JSONSerialization.jsonObject(with:JSONEncoder().encode(pending.envelope))])
                    let reply=try await t.request(.ownerStatus,actor:own.body.enrollmentId,argumentsJSON:args,signer:operation)
                    if reply.kind=="owner-recovery-absent" {
                        let proof=try CommunityOwnerAbsence.verify(reply,original:pending,own:own,authority:authority)
                        try store.receipt(pending,response:reply.envelope,closePending:true,allowRefreshedLookup:true);try await t.resolveOwnerAbsence(proof)
                        status="원래 요청이 없고 수락 시간이 끝났음을 확인했습니다. 새 요청은 직접 선택해 주세요."
                    } else {
                        let r=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId,requestId:reply.requestId)
                        let original=try CommunityOwnerWire.request(pending.envelope,operation:.ownerRequest,actor:own.body.enrollmentId,communityId:own.body.communityId)
                        guard r.body.requestId==pending.id,r.body.sourceEnrollmentId==own.body.enrollmentId,original.args.count==2,r.body.targetEnrollmentId==original.args[1] as? String else {throw ScreenCommunityError.wrongCommunity}
                        try await saveResult(reply,transport:t,originalLookup:true)
                    }
                }
            }
            if let operation {
                let reply=try await transport().request(.ownerList,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([own.body.communityId]),signer:operation)
                let round=try CommunityOwnerRound.verify(reply.envelope,authority:authority,own:own,target:false,requestId:reply.requestId)
                var current=round.records
                for id in try store.read().tracked where !current.contains(where:{$0.body.requestId==id}) {
                    let r=try await transport().request(.ownerStatus,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([own.body.communityId,id]),signer:operation)
                    current.append(try CommunityOwnerRecord.verify(r.envelope,authority:authority,communityId:own.body.communityId,requestId:r.requestId))
                }
                records=current
            } else {records=[]}
            if own.body.capabilities.contains(.receiveControl),own.body.capabilities.contains(.desktopTrust) {
                let reply=try await ScreenCommunityCommand(.ownerDelegationStatus).call()
                guard reply.values.count==3,let local=reply.values[0].string,let envelope=reply.envelopes.first else {throw ScreenCommunityError.malformed}
                targetLocalGeneration=local
                if case .bool(let enabled)=reply.values[1]{targetEnabled=enabled}else{throw ScreenCommunityError.malformed}
                targetStatus=try CommunityOwnerRound.verify(envelope,authority:authority,own:own,target:true)
            } else {targetStatus=nil;targetEnabled=nil;targetLocalGeneration=nil}
        } catch {targetStatus=nil;targetEnabled=nil;targetLocalGeneration=nil;status="위임 상태·원래 요청 결과 조회가 필요합니다(\(String(describing:error))). 미확정 요청은 자동으로 다시 보내지 않습니다."}
        changed()
    }
    func request(target:CommunityAuthorization,own:CommunityAuthorization,signer:any TranscriptSigner)async {
        guard !busy,target.body.deviceId != own.body.deviceId else{return};selectSubject(own);busy=true;defer{busy=false;changed()}
        do {
            _=try CommunityDesktopScreenTrust.verified(authority:authority,controller:own,receiver:target)
            let t=try transport();guard await t.snapshot()==nil else {throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST")}
            let reply=try await t.request(.ownerRequest,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([own.body.communityId,target.body.enrollmentId]),signer:signer,mutation:true)
            let r=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId,requestId:reply.requestId)
            guard r.body.sourceEnrollmentId==own.body.enrollmentId,r.body.targetEnrollmentId==target.body.enrollmentId else {throw ScreenCommunityError.wrongCommunity}
            try store.update{$0.tracked=Array(([$0.tracked.first(where:{$0==r.body.requestId}) ?? r.body.requestId]+$0.tracked.filter{$0 != r.body.requestId}).prefix(4))}
            try await saveResult(reply,transport:t);records.removeAll{$0.body.requestId==r.body.requestId};records.insert(r,at:0)
            status="대상 Mac에 입력 보류 상태 확인을 요청했습니다. 아직 해제·승인이 완료된 것은 아닙니다."
        } catch {status="요청 결과를 확인하지 못했습니다. 원래 요청 번호를 보존하고 조회합니다: \(error)"}
    }
    func enable(own:CommunityAuthorization,biometric:@MainActor (String)async throws->any TranscriptSigner)async {
        guard !busy,let delegation=targetStatus?.delegation,let local=targetLocalGeneration else{return}
        busy=true;let epoch=generation;defer{busy=false;changed()}
        do {
            let t=try transport();guard await t.snapshot()==nil else {throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST")}
            let signer=try await biometric("이 Mac의 입력 보류 해제만 현재 자격 있는 커뮤니티 Mac에 위임합니다. 요청마다 그 Mac에서 생체 승인합니다")
            guard epoch==generation,own.isCurrent(),targetLocalGeneration==local,ScreenCommunityRequest.base64(signer.publicKey.x963Representation)==own.body.biometricPublicKey else {throw ScreenCommunityError.expired}
            try store.update{$0.localGeneration=local}
            let reply=try await t.request(.ownerDelegationSet,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([own.body.communityId,["version":1,"enabled":true,"expectedRevision":delegation.body.revision]]),signer:signer,mutation:true)
            guard let original=await t.snapshot() else {throw ScreenCommunityError.wrongRequest}
            _=try CommunityOwnerDelegation.verify(reply.envelope,authority:authority,own:own,requestId:reply.requestId)
            guard epoch==generation else {throw ScreenCommunityError.service("OWNER_UI_CHANGED")}
            _=try await ScreenCommunityCommand(.ownerDelegationCommit,[.string(local),.string(ScreenCommunityRequest.base64(try JSONEncoder().encode(original.envelope)))],certificate:reply.envelope).call()
            try await saveResult(reply,transport:t);targetEnabled=true;status="이 Mac의 입력 보류 해제 위임을 켰습니다. Screen 켜기·수신 보류·OS 권한은 바꾸지 않았습니다."
        } catch {status="위임 설정·기기 반영 결과를 확인하지 못했습니다. 자동 재시도하지 않습니다: \(error)"}
    }
    func approve(_ record:CommunityOwnerRecord,own:CommunityAuthorization,biometric:@MainActor (String)async throws->any TranscriptSigner)async {
        guard !busy,record.body.state == .ready,let intent=record.body.intent,record.body.sourceEnrollmentId==own.body.enrollmentId,let target=targets.first(where:{$0.body.enrollmentId==record.body.targetEnrollmentId}) else{return}
        busy=true;let epoch=generation,binding=record.reviewBinding;defer{busy=false;changed()}
        do {
            _=try CommunityDesktopScreenTrust.verified(authority:authority,controller:own,receiver:target)
            guard try CommunityMobileControlPolicy.authorizationDigest(own)==intent.sourcePolicyDigest,try CommunityMobileControlPolicy.authorizationDigest(target)==intent.targetPolicyDigest else {throw ScreenCommunityError.staleRevision}
            let t=try transport();guard await t.snapshot()==nil else {throw ScreenCommunityError.service("RECOVER_EXISTING_REQUEST")}
            let signer=try await biometric("‘\(target.body.name)’의 현재 입력 보류만 위임 승인으로 해제합니다. 대상 Mac의 OS 인증을 대신하지 않습니다")
            guard epoch==generation,own.isCurrent(),records.contains(where:{$0.reviewBinding==binding}),intent.expiresAt>Int64(Date().timeIntervalSince1970*1000),ScreenCommunityRequest.base64(signer.publicKey.x963Representation)==own.body.biometricPublicKey else {throw ScreenCommunityError.expired}
            let reply=try await t.request(.ownerApprove,actor:own.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([own.body.communityId,record.body.requestId,try intent.value()]),signer:signer,mutation:true)
            let approved=try CommunityOwnerRecord.verify(reply.envelope,authority:authority,communityId:own.body.communityId,requestId:reply.requestId)
            guard approved.body.requestId==record.body.requestId,approved.body.intent==intent else {throw ScreenCommunityError.wrongCommunity}
            try await saveResult(reply,transport:t);records.removeAll{$0.body.requestId==record.body.requestId};records.append(approved)
            status="위임 승인을 제출했습니다. 대상 Mac의 실제 적용 영수증을 기다립니다."
        } catch {status="위임 승인 결과를 확인하지 못했습니다. 원래 요청만 조회합니다: \(error)"}
    }
}
#endif
