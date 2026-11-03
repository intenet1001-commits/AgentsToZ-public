#if os(macOS)
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore
@testable import ScreenHost

private struct OwnerSoftwareSigner:TranscriptSigner,@unchecked Sendable {
    let key:P256.Signing.PrivateKey
    var publicKey:P256.Signing.PublicKey {key.publicKey}
    func signature(for data:Data)async throws->P256.Signing.ECDSASignature {try key.signature(for:data)}
}
private struct OwnerHostFixture:@unchecked Sendable {
    let issuer:P256.Signing.PrivateKey,host:P256.Signing.PrivateKey,sourceBIO:P256.Signing.PrivateKey,targetBIO:P256.Signing.PrivateKey
    let authority:ScreenCommunityAuthority,source:CommunityAuthorization,target:CommunityAuthorization
    let at:Int64
    init(bootstrap:Bool=true,revision:Int=1,qualifying:Bool=true)throws {
        let issuer=P256.Signing.PrivateKey(),host=P256.Signing.PrivateKey(),sourceBIO=P256.Signing.PrivateKey(),targetBIO=P256.Signing.PrivateKey()
        self.issuer=issuer;self.host=host;self.sourceBIO=sourceBIO;self.targetBIO=targetBIO
        let at=Int64(Date().timeIntervalSince1970*1000);self.at=at
        let file=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-owner-recovery-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any],a=f["authority"] as! [String:String]
        let authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:issuer.publicKey,profileID:a["profileId"]!);self.authority=authority
        func signed(_ name:String,hostKey:P256.Signing.PublicKey,bio:P256.Signing.PublicKey,caps:[String])throws->CommunityAuthorization {
            var b=f[name] as! [String:Any]
            b["hostPublicKey"]=ScreenCommunityRequest.base64(hostKey.x963Representation);b["biometricPublicKey"]=ScreenCommunityRequest.base64(bio.x963Representation);b["publicKey"]=ScreenCommunityRequest.base64(P256.Signing.PrivateKey().publicKey.x963Representation)
            b["capabilities"]=caps;b["issuedAt"]=at;b["expiresAt"]=at+90_000;b["revision"]=revision
            let bytes=try CommunityOwnerWire.value([2,"authorization",UUID().uuidString.lowercased(),at,b])
            let e=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
            return try CommunityAccessReply.verify(e,authority:authority).authorization(authority:authority)
        }
        source=try signed("source",hostKey:P256.Signing.PrivateKey().publicKey,bio:sourceBIO.publicKey,caps:["screen.view","screen.desktop-trust"])
        target=try signed("target",hostKey:host.publicKey,bio:targetBIO.publicKey,caps:qualifying ? ["screen.receive.view","screen.receive.control","screen.desktop-trust"]+(bootstrap ? ["screen.owner-delegation"]:[]):["screen.view"])
    }
    func reply(_ kind:String,_ value:Any,id:String=UUID().uuidString.lowercased())throws->CommunityAccessReply {
        let bytes=try CommunityOwnerWire.value([2,kind,id,at,value])
        let e=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        return try CommunityAccessReply.verify(e,authority:authority)
    }
    func policy(enabled:Bool=true,revision:Int64?=nil)throws->CommunityOwnerDelegation {
        let e=try reply("owner-delegation",["version":1,"communityId":target.body.communityId,"targetEnrollmentId":target.body.enrollmentId,"enabled":enabled,"revision":revision ?? target.body.revision,"issuedAt":at,"expiresAt":at+90_000]).envelope
        return try CommunityOwnerDelegation.verify(e,authority:authority,own:target)
    }
    func round(_ id:String,records:[[String:Any]]=[],enabled:Bool=true,revision:Int64?=nil)throws->CommunityAccessReply {
        try reply("owner-recovery-round",["version":1,"communityId":target.body.communityId,"targetEnrollmentId":target.body.enrollmentId,"delegation":JSONSerialization.jsonObject(with:JSONEncoder().encode(policy(enabled:enabled,revision:revision).envelope)),"requests":records,"issuedAt":at,"expiresAt":at+90_000],id:id)
    }
    func record(hold:String?=nil,connection:String?=nil,id:String=UUID().uuidString.lowercased())throws->[String:Any] {
        let sd=try CommunityMobileControlPolicy.authorizationDigest(source),td=try CommunityMobileControlPolicy.authorizationDigest(target)
        var r:[String:Any]=["version":1,"requestId":id,"communityId":target.body.communityId,"sourceEnrollmentId":source.body.enrollmentId,"targetEnrollmentId":target.body.enrollmentId,"delegationRevision":target.body.revision,"sourcePolicyDigest":sd,"targetPolicyDigest":td,"state":"waiting-host","createdAt":at,"expiresAt":at+300_000,"intent":NSNull(),"approval":NSNull(),"outcome":NSNull()]
        if let hold {
            let intent:[String:Any]=["version":1,"action":"resume-input","sourceEnrollmentId":source.body.enrollmentId,"targetEnrollmentId":target.body.enrollmentId,"delegationRevision":target.body.revision,"sourcePolicyDigest":sd,"targetPolicyDigest":td,"holdGeneration":hold,"connectionId":connection as Any? ?? NSNull(),"challenge":ScreenCommunityRequest.base64(Data(repeating:3,count:32)),"expiresAt":at+120_000]
            let raw=try CommunityOwnerWire.value([2,"owner-recovery-approve",UUID().uuidString.lowercased(),at,ScreenCommunityRequest.base64(Data(repeating:8,count:32)),source.body.enrollmentId,[source.body.communityId,id,intent]])
            let original=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(raw),signature:ScreenCommunityRequest.base64(try sourceBIO.signature(for:Data("agentstoz.community-access.request/v2\0".utf8)+raw).rawRepresentation))
            func value(_ e:ScreenCommunityEnvelope)throws->Any {try JSONSerialization.jsonObject(with:JSONEncoder().encode(e))}
            r["state"]="approved";r["expiresAt"]=at+120_000;r["intent"]=intent;r["approval"]=["request":try value(original),"source":try value(source.envelope),"target":try value(target.envelope),"delegation":try value(policy().envelope)]
        }
        return r
    }
    func proof(hold:String,connection:String?=nil)throws->CommunityDelegatedInputConfirmation {
        let r=try CommunityOwnerRecord.verify(reply("owner-recovery",record(hold:hold,connection:connection)).envelope,authority:authority,communityId:target.body.communityId)
        return try CommunityDelegatedInputConfirmation.verify(record:r,authority:authority,currentTarget:target,currentSource:source,currentDelegation:policy())
    }
}

/// Software peer that accepts exactly one result and loses only its response; recovery must use the original receipt.
private actor OwnerResultRemote {
    let fixture:OwnerHostFixture,record:Data
    private(set) var resultIDs:[String]=[],receiptIDs:[String]=[]
    private var accepted:CommunityAccessReply?
    init(_ fixture:OwnerHostFixture,record:Data){self.fixture=fixture;self.record=record}
    func send(_ e:ScreenCommunityEnvelope,id:String)throws->CommunityAccessReply {
        let f=try JSONSerialization.jsonObject(with:ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)) as! [Any],op=f[1] as! String,args=f[6] as! [Any]
        XCTAssertTrue(try fixture.host.publicKey.isValidSignature(P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(e.signature,max:86)),for:Data("agentstoz.community-access.request/v2\0".utf8)+ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)))
        if op=="owner-recovery-result" {
            resultIDs.append(id)
            var body=try JSONSerialization.jsonObject(with:record) as! [String:Any];body["outcome"]="applied";body["state"]="applied"
            accepted=try fixture.reply("owner-recovery",body,id:id)
            throw ScreenCommunityError.service("SERVICE_UNAVAILABLE")
        }
        XCTAssertEqual(op,"receipt");let original=args[0] as! String;receiptIDs.append(original)
        let response=try XCTUnwrap(accepted)
        return try fixture.reply("receipt",["originalRequestId":original,"result":JSONSerialization.jsonObject(with:JSONEncoder().encode(response.envelope))],id:id)
    }
}

private actor OwnerNegativeRemote {
    enum Mode:Sendable {case valid,wrongIssuer,wrongTarget,wrongOriginal,notFound}
    let fixture:OwnerHostFixture
    private(set) var mutationIDs:[String]=[],receiptIDs:[String]=[]
    private var accepted:CommunityAccessReply?
    var mode=Mode.valid
    init(_ fixture:OwnerHostFixture){self.fixture=fixture}
    func setMode(_ value:Mode){mode=value}
    func send(_ e:ScreenCommunityEnvelope,id:String)throws->CommunityAccessReply {
        let fields=try JSONSerialization.jsonObject(with:ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)) as! [Any],op=fields[1] as! String,args=fields[6] as! [Any]
        if op=="owner-recovery-poll" {return try fixture.round(id,enabled:accepted==nil,revision:accepted==nil ? 1:2)}
        if op=="owner-delegation-set" {
            mutationIDs.append(id)
            let selection=args[1] as! [String:Any];XCTAssertEqual(selection["enabled"] as? Bool,false)
            let body=try JSONSerialization.jsonObject(with:JSONEncoder().encode(fixture.policy(enabled:false,revision:2).body))
            accepted=try fixture.reply("owner-delegation",body,id:id)
            throw ScreenCommunityError.service("SERVICE_UNAVAILABLE")
        }
        XCTAssertEqual(op,"receipt");let original=args[0] as! String;receiptIDs.append(original)
        if mode == .notFound {throw ScreenCommunityError.service("RECEIPT_NOT_FOUND")}
        var response=try XCTUnwrap(accepted)
        if mode == .wrongTarget {
            var body=try JSONSerialization.jsonObject(with:JSONEncoder().encode(fixture.policy(enabled:false,revision:2).body)) as! [String:Any];body["targetEnrollmentId"]=UUID().uuidString.lowercased()
            response=try fixture.reply("owner-delegation",body,id:original)
        }
        if mode == .wrongIssuer {
            let foreign=try OwnerHostFixture()
            let body=try JSONSerialization.jsonObject(with:JSONEncoder().encode(fixture.policy(enabled:false,revision:2).body))
            response=try foreign.reply("owner-delegation",body,id:original)
        }
        return try fixture.reply("receipt",["originalRequestId":mode == .wrongOriginal ? UUID().uuidString.lowercased():original,"result":JSONSerialization.jsonObject(with:JSONEncoder().encode(response.envelope))],id:id)
    }
}

@MainActor final class CommunityOwnerRecoveryHostTests:XCTestCase {
    private func store()throws->(HostTestItems,ScreenStore,ScreenOwnerRecoveryStore) {
        let items=HostTestItems(),screen=ScreenStore(items:items),owner=ScreenOwnerRecoveryStore(store:screen)
        owner.allowFreshInitialization();_ = try owner.read();return (items,screen,owner)
    }
    func testCap10BootstrapsOnlyIntactPendingSetupAndNeverClearsInputHoldOrLocalOff()async throws {
        let (_,screen,owner)=try store(),f=try OwnerHostFixture(),hold=ScreenPersistentInputHold(store:screen);hold.arm()
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{_,id in try f.round(id)})
        let first=try await target.status();XCTAssertTrue(first.enabled);XCTAssertTrue(hold.held)
        let initial=try owner.read();XCTAssertFalse(initial.pendingSetup);XCTAssertEqual(initial.setupAuthorization,f.target.envelope);XCTAssertNil(initial.positiveRequest)
        _=try owner.closeLocally()
        let renewal=try await target.status();XCTAssertFalse(renewal.enabled);XCTAssertFalse(try owner.read().pendingSetup);XCTAssertTrue(hold.held)
    }
    func testOldNineCapabilitiesRequireExplicitTargetSetupAndUnknownStorageNeverBootstraps()async throws {
        let (items,_,owner)=try store(),f=try OwnerHostFixture(bootstrap:false)
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{_,id in try f.round(id)})
        let state=try await target.status();XCTAssertFalse(state.enabled)
        items.failReads(["owner-recovery-v1"])
        do {_ = try owner.read();XCTFail("locked storage")}catch{}
        items.failReads([]);XCTAssertTrue(owner.isBlocked)
        let refreshed=try await target.status();XCTAssertFalse(refreshed.enabled)
        items.items.withLock{$0.removeValue(forKey:"owner-recovery-v1")}
        let replacement=ScreenOwnerRecoveryStore(store:ScreenStore(items:items))
        XCTAssertThrowsError(try replacement.read(),"Missing known state is not a new setup")
        try items.write("owner-recovery-v1",Data("{}".utf8))
        XCTAssertThrowsError(try replacement.read());XCTAssertTrue(replacement.isBlocked)
    }
    func testDelegatedProofClearsOnlyItsCASAndPersistsSeparateProvenanceAcrossRestart()throws {
        let (_,screen,owner)=try store(),hold=ScreenPersistentInputHold(store:screen);hold.arm()
        let f=try OwnerHostFixture(),proof=try f.proof(hold:XCTUnwrap(hold.record).generation),local=try owner.read().localGeneration
        let p=CommunityOwnerEffectJournal.Publication(recordId:proof.record.body.requestId,instance:UUID().uuidString.lowercased(),localGeneration:local,holdGeneration:proof.intent.holdGeneration,connectionId:nil,challenge:proof.intent.challenge,targetPolicyDigest:proof.intent.targetPolicyDigest,sourcePolicyDigest:proof.intent.sourcePolicyDigest,delegationRevision:1,expiresAt:proof.intent.expiresAt)
        try owner.update {$0.enabled=true;$0.pendingSetup=false;$0.minimumRevision=1;try $0.effects.publish(p);try $0.effects.reserve(proof)}
        let applied=try ScreenDelegatedInputPermit(proof:proof,publication:p,store:owner).perform {do{try hold.clearAfterDelegatedConfirmation(proof,expectedGeneration:p.holdGeneration);return true}catch{return false}}
        XCTAssertTrue(applied);XCTAssertFalse(hold.held);XCTAssertFalse(try XCTUnwrap(hold.record).ownerConfirmed)
        XCTAssertEqual(try XCTUnwrap(hold.record).delegatedConfirmationHash,try CommunityOwnerWire.envelopeHash(proof.record.envelope))
        XCTAssertThrowsError(try owner.update {try $0.effects.reserve(proof)})
        let restarted=ScreenPersistentInputHold(store:screen);restarted.arm();XCTAssertTrue(restarted.held);XCTAssertFalse(try XCTUnwrap(restarted.record).ownerConfirmed)
    }
    func testLatePositiveAfterLocalOffOrNewHoldCannotClearOrExecuteAgain()throws {
        let (_,screen,owner)=try store(),hold=ScreenPersistentInputHold(store:screen);hold.arm()
        let f=try OwnerHostFixture(),proof=try f.proof(hold:XCTUnwrap(hold.record).generation),local=try owner.read().localGeneration
        let p=CommunityOwnerEffectJournal.Publication(recordId:proof.record.body.requestId,instance:UUID().uuidString.lowercased(),localGeneration:local,holdGeneration:proof.intent.holdGeneration,connectionId:nil,challenge:proof.intent.challenge,targetPolicyDigest:proof.intent.targetPolicyDigest,sourcePolicyDigest:proof.intent.sourcePolicyDigest,delegationRevision:1,expiresAt:proof.intent.expiresAt)
        try owner.update {$0.enabled=true;$0.minimumRevision=1;try $0.effects.publish(p);try $0.effects.reserve(proof)}
        _=try owner.closeLocally();var effects=0
        XCTAssertThrowsError(try ScreenDelegatedInputPermit(proof:proof,publication:p,store:owner).perform {effects+=1;return true});XCTAssertEqual(effects,0);XCTAssertTrue(hold.held)
        hold.engage();XCTAssertThrowsError(try hold.clearAfterDelegatedConfirmation(proof,expectedGeneration:p.holdGeneration));XCTAssertTrue(hold.held)
    }
    func testPublishResponseLostPreservesExactOriginalAndNeverReplaysWithNewId()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(),r=try JSONSerialization.data(withJSONObject:f.record()),calls=Recorded<String>()
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{e,id in
            let bytes=try ScreenCommunityRequest.decodeBase64(e.payload,max:32_000),fields=try JSONSerialization.jsonObject(with:bytes) as! [Any],op=fields[1] as! String
            calls.add(op+":"+id)
            if op=="owner-recovery-poll" {return try f.round(id,records:[JSONSerialization.jsonObject(with:r) as! [String:Any]])}
            throw ScreenCommunityError.service("SERVICE_UNAVAILABLE")
        })
        let snapshot=ScreenOwnerRecoveryTarget.Snapshot(instance:UUID().uuidString.lowercased(),holdGeneration:UUID().uuidString.lowercased(),connectionId:nil)
        for _ in 0..<2 {do{_ = try await target.tick(snapshot:{snapshot},apply:{_ in XCTFail("No approval");return false});XCTFail("lost response")}catch{}}
        let pending=try XCTUnwrap(owner.read().pending)
        XCTAssertEqual(calls.all.filter{$0.hasPrefix("owner-recovery-publish:")},["owner-recovery-publish:"+pending.id]);XCTAssertTrue(calls.all.contains(where:{$0.hasPrefix("receipt:")}))
        XCTAssertEqual(try owner.read().pending,pending)
    }
    func testScreenListSupportsViewOnlySourceExcludesOwnDeviceAndRejectsChangedOrExpiredTarget()async throws {
        let rig=try HostRig(),f=try OwnerHostFixture(),service=rig.makeService(directoryAuthority:f.authority)
        rig.clock.advance(Date().timeIntervalSince(rig.clock.now))
        // The own source has screen.view/trust only; no receiver or Control scope is added to populate its list.
        XCTAssertFalse(f.source.body.capabilities.contains(.receiveView));XCTAssertNil(f.source.body.controlKey)
        service.unifiedAccessChanged(f.source,peers:[f.source,f.target],held:false)
        XCTAssertEqual(service.communityDesktops.map{$0.deviceId},[f.target.body.deviceId])
        XCTAssertEqual(service.communityDesktops.first?.name,f.target.body.name);XCTAssertTrue(service.communityDesktops.first?.ready==true)
        let replacement=try OwnerHostFixture()
        service.unifiedAccessChanged(f.source,peers:[replacement.target],held:false)
        XCTAssertFalse(service.communityDesktops.first?.ready==true,"A substituted signed peer from another issuer cannot create an action")
        rig.clock.advance(91)
        service.unifiedAccessChanged(f.source,peers:[f.target],held:false)
        XCTAssertTrue(service.communityDesktops.isEmpty,"A 90-second expired directory never leaves an enabled target")
        await service.quit()
    }

    func testHostNegativeOffSynchronizesAfterReceiverScopesWereRemovedWithoutPositiveOrBIO()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(qualifying:false),calls=Recorded<String>()
        try owner.update{$0.enabled=true;$0.pendingSetup=false}
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{qualifying in
            if qualifying {throw ScreenCommunityError.service("OWNER_RECEIVER_REQUIRED")}
            return .init(own:f.target,peers:[],receivingHeld:true)
        },send:{e,id in
            let fields=try JSONSerialization.jsonObject(with:ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)) as! [Any],op=fields[1] as! String
            calls.add(op)
            if op=="owner-recovery-poll" {return try f.round(id,enabled:false)}
            XCTAssertEqual(op,"owner-delegation-set")
            let args=fields[6] as! [Any],selection=args[1] as! [String:Any]
            XCTAssertEqual(selection["enabled"] as? Bool,false)
            let bytes=try JSONEncoder().encode(f.policy(enabled:false,revision:2).body)
            return try f.reply("owner-delegation",JSONSerialization.jsonObject(with:bytes),id:id)
        })
        try await target.disable();XCTAssertFalse(try owner.read().enabled);XCTAssertFalse(try owner.read().pendingSetup);XCTAssertTrue(owner.isBlocked)
        XCTAssertEqual(calls.all,["owner-recovery-poll","owner-delegation-set"])
        XCTAssertNil(try owner.read().pendingDisable);XCTAssertEqual(try owner.read().archive.count,1)
    }

    func testAppliedFactAfterScopeRemovalRecoversOnlyOriginalResultIdWithoutAnotherEffect()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(),proof=try f.proof(hold:UUID().uuidString.lowercased()),state=try owner.read()
        let p=CommunityOwnerEffectJournal.Publication(recordId:proof.record.body.requestId,instance:UUID().uuidString.lowercased(),localGeneration:state.localGeneration,holdGeneration:proof.intent.holdGeneration,connectionId:nil,challenge:proof.intent.challenge,targetPolicyDigest:proof.intent.targetPolicyDigest,sourcePolicyDigest:proof.intent.sourcePolicyDigest,delegationRevision:1,expiresAt:proof.intent.expiresAt)
        try owner.update{$0.enabled=true;$0.minimumRevision=1;try $0.effects.publish(p);try $0.effects.reserve(proof);try $0.effects.finish(proof.record.body.requestId,outcome:.applied)}
        let bytes=try ScreenCommunityRequest.decodeBase64(proof.record.envelope.payload,max:65_536),raw=try JSONSerialization.jsonObject(with:bytes) as! [Any]
        let remote=OwnerResultRemote(f,record:try JSONSerialization.data(withJSONObject:raw[4]))
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{qualifying in
            if qualifying {throw ScreenCommunityError.service("OWNER_RECEIVER_REQUIRED")}
            return .init(own:f.target,peers:[],receivingHeld:true)
        },send:{try await remote.send($0,id:$1)})
        for _ in 0..<3 {do{_ = try await target.tick(snapshot:{nil},apply:{_ in XCTFail("A historical outcome cannot run an effect");return false})}catch{}}
        let resultIDs=await remote.resultIDs,receiptIDs=await remote.receiptIDs
        XCTAssertEqual(resultIDs.count,1);XCTAssertEqual(receiptIDs,[try XCTUnwrap(resultIDs.first)])
        let entry=try XCTUnwrap(owner.read().effects.entries[proof.record.body.requestId])
        XCTAssertTrue(entry.reported);XCTAssertEqual(entry.outcome,.applied);XCTAssertNil(try owner.read().pending)
        XCTAssertEqual(entry.reportRequestId,resultIDs.first)
    }
    func testKnownSetupReplyCanBeAcknowledgedAgainButNeverReopensALaterLocalOff()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(bootstrap:false),state=try owner.read()
        let request=try CommunityAccessRequest(operation:.ownerDelegationSet,actor:f.target.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([f.target.body.communityId,["version":1,"enabled":true,"expectedRevision":0]]))
        let original=try await request.signed(by:OwnerSoftwareSigner(key:f.targetBIO))
        let policy=try f.reply("owner-delegation",JSONSerialization.jsonObject(with:JSONEncoder().encode(f.policy().body)),id:request.id).envelope
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{_,id in try f.round(id)})
        try await target.commit(policy:policy,original:original,expectedLocalGeneration:state.localGeneration)
        let committed=try owner.read();XCTAssertTrue(committed.enabled);XCTAssertEqual(committed.positiveRequest,original)
        try await target.commit(policy:policy,original:original,expectedLocalGeneration:state.localGeneration)
        XCTAssertEqual(try owner.read().localGeneration,committed.localGeneration)
        _=try owner.closeLocally()
        do {try await target.commit(policy:policy,original:original,expectedLocalGeneration:state.localGeneration);XCTFail("Late old setup cannot reopen explicit OFF")}catch{}
        XCTAssertFalse(try owner.read().enabled);XCTAssertTrue(owner.isBlocked)
    }

    func testLostNegativeRecoversOnlyOriginalHostReceiptAcrossRestartAndStorageFailure()async throws {
        let (items,screen,owner)=try store(),f=try OwnerHostFixture(),remote=OwnerNegativeRemote(f)
        func target(_ state:ScreenOwnerRecoveryStore)->ScreenOwnerRecoveryTarget {ScreenOwnerRecoveryTarget(store:state,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{try await remote.send($0,id:$1)})}
        let first=target(owner)
        do {try await first.disable();XCTFail("lost OFF response")}catch{}
        let original=try XCTUnwrap(owner.read().pendingDisable)
        XCTAssertFalse(try owner.read().enabled);XCTAssertTrue(owner.isBlocked)
        let restarted=ScreenOwnerRecoveryStore(store:screen),next=target(restarted)
        items.fail(["owner-recovery-v1"])
        do {_ = try await next.status();XCTFail("cannot archive while protected write fails")}catch{}
        items.fail([]);XCTAssertEqual(try restarted.read().pendingDisable,original)
        // No new negative mutation is emitted by this read; the same receipt is validated again.
        _ = try await next.status()
        XCTAssertNil(try restarted.read().pendingDisable);XCTAssertFalse(try restarted.read().enabled);XCTAssertFalse(try restarted.read().pendingSetup)
        XCTAssertEqual(try restarted.read().archive.filter{$0==original}.count,1)
        let mutations=await remote.mutationIDs,receipts=await remote.receiptIDs
        XCTAssertEqual(mutations,[original.id]);XCTAssertEqual(receipts,[original.id,original.id])
    }
    func testWrongNegativeReceiptOrAbsenceNeverClearsEvidenceOrPermitsNewSetup()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(),remote=OwnerNegativeRemote(f)
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{try await remote.send($0,id:$1)})
        do {try await target.disable();XCTFail("lost response")}catch{}
        let original=try XCTUnwrap(owner.read().pendingDisable)
        for mode in [OwnerNegativeRemote.Mode.wrongIssuer,.wrongTarget,.wrongOriginal,.notFound] {
            await remote.setMode(mode)
            do {_ = try await target.status();XCTFail("wrong negative proof")}catch{}
            XCTAssertEqual(try owner.read().pendingDisable,original);XCTAssertFalse(try owner.read().enabled);XCTAssertTrue(owner.isBlocked)
        }
        let generation=try owner.read().localGeneration
        let request=try CommunityAccessRequest(operation:.ownerDelegationSet,actor:f.target.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([f.target.body.communityId,["version":1,"enabled":true,"expectedRevision":1]]))
        let positive=try await request.signed(by:OwnerSoftwareSigner(key:f.targetBIO))
        do {try await target.commit(policy:f.policy().envelope,original:positive,expectedLocalGeneration:generation);XCTFail("Unknown OFF must not be overwritten by a positive setup")}catch{}
        XCTAssertEqual(try owner.read().pendingDisable,original);let ids=await remote.mutationIDs;XCTAssertEqual(ids,[original.id])
    }

    func testHistoricalFalseReceiptAfterItsNinetySecondLeaseOnlyClosesTheNegativeFence()async throws {
        let (_,_,owner)=try store(),f=try OwnerHostFixture(),calls=Recorded<String>(),old=Date().addingTimeInterval(-180)
        let request=try CommunityAccessRequest(operation:.ownerDelegationSet,actor:f.target.body.enrollmentId,argumentsJSON:CommunityOwnerWire.value([f.target.body.communityId,["version":1,"enabled":false,"expectedRevision":0]]),now:old)
        let original=try await request.signed(by:OwnerSoftwareSigner(key:f.host)),at=Int64(old.timeIntervalSince1970*1000)
        let journal=CommunityAccessJournal(id:request.id,operation:request.operation.rawValue,actor:f.target.body.enrollmentId,envelope:original)
        _=try owner.closeLocally();try owner.update{$0.pendingDisable=journal}
        let body:[String:Any]=["version":1,"communityId":f.target.body.communityId,"targetEnrollmentId":f.target.body.enrollmentId,"enabled":false,"revision":1,"issuedAt":at,"expiresAt":at+90_000]
        let bytes=try CommunityOwnerWire.value([2,"owner-delegation",request.id,at,body])
        let historical=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try f.issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        XCTAssertThrowsError(try CommunityOwnerDelegation.verify(historical,authority:f.authority,own:f.target),"It is not a current positive lease")
        let target=ScreenOwnerRecoveryTarget(store:owner,authority:f.authority,signer:OwnerSoftwareSigner(key:f.host),context:{_ in .init(own:f.target,peers:[f.source],receivingHeld:false)},send:{e,id in
            let fields=try JSONSerialization.jsonObject(with:ScreenCommunityRequest.decodeBase64(e.payload,max:32_000)) as! [Any],op=fields[1] as! String
            calls.add(op)
            if op=="receipt" {return try f.reply("receipt",["originalRequestId":request.id,"result":JSONSerialization.jsonObject(with:JSONEncoder().encode(historical))],id:id)}
            XCTAssertEqual(op,"owner-recovery-poll");return try f.round(id,enabled:false)
        })
        let status=try await target.status();XCTAssertFalse(status.enabled);XCTAssertTrue(owner.isBlocked)
        XCTAssertNil(try owner.read().pendingDisable);XCTAssertEqual(try owner.read().archive.first,journal);XCTAssertEqual(calls.all,["receipt","owner-recovery-poll"])
        XCTAssertFalse(try owner.read().enabled);XCTAssertFalse(try owner.read().pendingSetup)
    }

}
#endif
