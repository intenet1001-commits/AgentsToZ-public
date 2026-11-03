#if os(macOS)
import CryptoKit
import Foundation
import LocalAuthentication
import XCTest
@testable import ScreenControlCore
@testable import ScreenHost

@MainActor private final class TrustedOnBarrier {
    enum Failure:Error { case delayed }
    private let stream:AsyncStream<Void>
    private let sink:AsyncStream<Void>.Continuation
    private var reply:CheckedContinuation<Void,Error>?
    init() { (stream,sink)=AsyncStream.makeStream() }
    func hold() async throws { try await withCheckedThrowingContinuation { reply=$0;sink.yield(()) } }
    func entered() async { var iterator=stream.makeAsyncIterator();_ = await iterator.next() }
    func fail() { reply?.resume(throwing:Failure.delayed);reply=nil;sink.finish() }
    func succeed() { reply?.resume(returning:());reply=nil;sink.finish() }
}

/// Software credentials, in-memory Keychain backend and the existing no-capture/no-injection HostRig only.
@MainActor final class DesktopTrustHostTests:XCTestCase {
    private func authorizations(now:Date,revision:Int=1)throws->(ScreenCommunityAuthority,CommunityAuthorization,CommunityAuthorization) {
        let file=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-desktop-trust-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
        var raw=Data(repeating:0,count:32);raw[31]=7;let issuer=try P256.Signing.PrivateKey(rawRepresentation:raw)
        let a=f["authority"] as! [String:String],authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:issuer.publicKey,profileID:a["profileId"]!)
        let at=Int64(now.timeIntervalSince1970*1000)
        func signed(_ name:String)throws->CommunityAuthorization {
            var b=f[name] as! [String:Any];b["issuedAt"]=at;b["expiresAt"]=at+90_000;b["revision"]=revision
            let bytes=try JSONSerialization.data(withJSONObject:[2,"authorization",UUID().uuidString.lowercased(),at,b],options:.withoutEscapingSlashes)
            let e=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
            return try CommunityAccessReply.verify(e,authority:authority,now:now).authorization(authority:authority,now:now)
        }
        return (authority,try signed("controller"),try signed("receiver"))
    }
    private func consent(_ now:Date,revision:Int=1)throws->CommunityDesktopReceiveTrust {
        let (a,_,r)=try authorizations(now:now,revision:revision)
        return try .verified(authority:a,authorization:r,deviceID:r.body.deviceId,hostKey:r.body.hostPublicKey,now:now)
    }
    func testAllNativeInputAndControlEffectsStopAtTheSameLeaseBoundary() throws {
        let now=Date(),(a,c,r)=try authorizations(now:now)
        let lease=try CommunityDesktopTrustLease(CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:r,channelId:UUID().uuidString.lowercased(),now:now))
        let posts=Recorded<InputEvent>(),actions=Recorded<String>()
        let input=InputReceiver(physicalInput:{PhysicalInputSnapshot(available:true)},compound:{_,_ in actions.add("text-return");return .posted},desktopTrust:lease,inject:{posts.add($0)})
        try input.receive(InputCodec.encode(.pointerMove(x:0.2,y:0.3)))
        XCTAssertTrue(input.performControlInput { actions.add("Caps/TIS/Spaces") })
        XCTAssertEqual(posts.all.count,1);XCTAssertEqual(actions.all,["Caps/TIS/Spaces"])
        lease.invalidate()
        try input.receive(InputCodec.encode(.pointerMove(x:0.4,y:0.5)))
        let result=try input.receive(InputCodec.encode(.textAndReturn(id:1,text:"no effect")))
        XCTAssertEqual(result?.1,.blocked)
        XCTAssertFalse(input.performControlInput { actions.add("late Caps/TIS/Spaces") })
        XCTAssertEqual(posts.all.count,1);XCTAssertEqual(actions.all,["Caps/TIS/Spaces"])
        XCTAssertFalse(ReleaseGate.controlOpen(flags:ScreenBuildFlags(macControl:true),pushLive:true,desktopTrust:lease),"An expired opted-in connection never falls back to legacy calibration")
    }
    func testFirstMigrationUsesFreshOwnerPolicyAndOrdinaryAuthenticatedOnReusesItsOwnConfirmation() async throws {
        let rig=try HostRig(),service=rig.makeService(),trust=try consent(rig.clock.now)
        let accepted=await service.confirmTrustedInputOwner(consent:trust)
        XCTAssertTrue(accepted);XCTAssertEqual(rig.policies,[.deviceOwnerAuthentication])
        let old=try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData()))
        XCTAssertFalse(old.held);XCTAssertTrue(old.ownerConfirmed);XCTAssertNotNil(old.instance)
        // An unclean new process conservatively starts held; the old explicit ON's own fresh owner authentication suffices.
        let replacement=rig.makeService()
        let before=try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData()));XCTAssertTrue(before.held)
        await replacement.turnOn()
        let after=try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData()));XCTAssertFalse(after.held)
        XCTAssertEqual(rig.policies,[.deviceOwnerAuthentication,.deviceOwnerAuthentication])
        await replacement.quit();await service.quit()
    }
    func testDelayedOwnerCannotClearANewerNegativeOrAReplacementConnection() async throws {
        let rig=try HostRig(),phone=HostTestSigner();try rig.seed(phones:[rig.phone(phone)])
        let service=rig.makeService();await service.turnOn();let first=try await rig.connect(service,phone,as:.phone)
        var resume:CheckedContinuation<Bool,Never>?
        rig.authenticationReply={_ in await withCheckedContinuation { resume=$0 }}
        let task=Task { await service.confirmTrustedInputOwner(consent:try self.consent(rig.clock.now)) }
        for _ in 0..<100 where resume==nil { await Task.yield() };XCTAssertNotNil(resume)
        service.pauseRemoteInput();let negative=try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData()))
        resume?.resume(returning:true);let taskResult=try await task.value;XCTAssertFalse(taskResult)
        XCTAssertEqual(try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData())),negative)
        XCTAssertEqual(service.sessionInput?.mode,.paused)
        resume=nil
        let next=Task { await service.confirmTrustedInputOwner(consent:try self.consent(rig.clock.now)) }
        for _ in 0..<100 where resume==nil { await Task.yield() };XCTAssertNotNil(resume)
        let second=try await rig.connect(service,phone,as:.phone)
        resume?.resume(returning:true);let nextResult=try await next.value;XCTAssertFalse(nextResult);XCTAssertEqual(service.sessionInput?.mode,.paused)
        first.close();second.close();await service.quit()
    }
    func testNilToSessionAndQuitWhileOwnerIsPendingRemainViewOnly() async throws {
        let rig=try HostRig(),phone=HostTestSigner();try rig.seed(phones:[rig.phone(phone)])
        let service=rig.makeService();await service.turnOn()
        var resume:CheckedContinuation<Bool,Never>?
        rig.authenticationReply={_ in await withCheckedContinuation { resume=$0 }}
        let task=Task { await service.confirmTrustedInputOwner(consent:try self.consent(rig.clock.now)) }
        for _ in 0..<100 where resume==nil { await Task.yield() }
        let peer=try await rig.connect(service,phone,as:.phone)
        resume?.resume(returning:true);let taskResult=try await task.value;XCTAssertFalse(taskResult);XCTAssertEqual(service.sessionInput?.mode,.paused)
        resume=nil
        let quitting=Task { await service.confirmTrustedInputOwner(consent:try self.consent(rig.clock.now)) }
        for _ in 0..<100 where resume==nil { await Task.yield() }
        await service.quit();let sealed=try rig.store.inputHoldData()
        resume?.resume(returning:true);let quitResult=try await quitting.value;XCTAssertFalse(quitResult)
        XCTAssertEqual(try rig.store.inputHoldData(),sealed);XCTAssertNil(service.session)
        let afterQuit=await service.confirmTrustedInputOwner(consent:try consent(rig.clock.now));XCTAssertFalse(afterQuit)
        peer.close()
    }
    func testOwnerPolicyChangeAndStorageFailureNeverUnpauseTheLiveSession() async throws {
        let rig=try HostRig(),phone=HostTestSigner();try rig.seed(phones:[rig.phone(phone)])
        let service=rig.makeService();await service.turnOn();let peer=try await rig.connect(service,phone,as:.phone)
        let trust=try consent(rig.clock.now),changed=try consent(rig.clock.now,revision:2)
        let changedResult=await service.confirmTrustedInputOwner(consent:trust,refreshConsent:{changed});XCTAssertFalse(changedResult)
        XCTAssertEqual(service.sessionInput?.mode,.paused)
        rig.items.fail(["input-hold-v1"])
        let failedWrite=await service.confirmTrustedInputOwner(consent:trust);XCTAssertFalse(failedWrite);XCTAssertEqual(service.sessionInput?.mode,.paused)
        XCTAssertNotNil(service.inputProtectionNotice)
        rig.items.fail([]);await service.quit();peer.close()
    }
    func testLegacySessionWithPriorOptInUsesFreshOwnerToClearTheSameDurableGenerationOnly() async throws {
        let rig=try HostRig(),phone=HostTestSigner();try rig.seed(phones:[rig.phone(phone)])
        let service=rig.makeService();await service.turnOn();let peer=try await rig.connect(service,phone,as:.phone)
        // Migrate through a typed opted-in own grant, but leave this already-running phone on its legacy path.
        rig.authenticates=false;let denied=await service.confirmTrustedInputOwner(consent:try consent(rig.clock.now));XCTAssertFalse(denied)
        XCTAssertEqual(service.sessionInput?.mode,.paused)
        rig.authenticates=true
        let resumed=await service.resumeRemoteInput(refusal:nil);XCTAssertTrue(resumed)
        XCTAssertEqual(rig.policies.last,.deviceOwnerAuthentication)
        XCTAssertEqual(service.sessionInput?.mode,.remote)
        XCTAssertFalse(try ScreenInputHoldRecord.decode(XCTUnwrap(try rig.store.inputHoldData())).held)
        service.lowerSessionToView();XCTAssertEqual(service.sessionInput?.mode,.viewOnly)
        let confirmed=await service.confirmTrustedInputOwner(consent:try consent(rig.clock.now));XCTAssertTrue(confirmed)
        XCTAssertEqual(service.sessionInput?.mode,.viewOnly,"Owner recovery never raises this session's deliberate view-only choice")
        await service.quit();peer.close()
    }
    func testOldTrustedOnFailureAfterOffAndNewOnPreservesTheNewListenerAndSession() async throws {
        for phase in 0..<3 { // Actual lifecycle: consent, openNearby, final refresh await.
            let rig=try HostRig(),phone=HostTestSigner();try rig.seed(phones:[rig.phone(phone)])
            let service=rig.makeService(),own=try consent(Date()),barrier=TrustedOnBarrier()
            if phase==1 { rig.beforeOpenNearby={try await barrier.hold()} }
            let old=Task { await service.turnOnFromTrustedCommunity(consent:{ if phase==0 {try await barrier.hold()};return own },refresh:{ if phase==2 {try await barrier.hold()} }) }
            await barrier.entered()
            if phase==0 {
                XCTAssertEqual(service.power,.starting)
                var duplicateEntered=false
                await service.turnOnFromTrustedCommunity(consent:{duplicateEntered=true;return own},refresh:{})
                XCTAssertFalse(duplicateEntered,"A pending ON exclusively claims its epoch before verifying consent")
            }
            service.turnOff();rig.beforeOpenNearby=nil
            await service.turnOnFromTrustedCommunity(consent:{own},refresh:{})
            let replacement=try XCTUnwrap(rig.opened.last),power=service.power
            XCTAssertFalse(replacement.isStopped)
            let peer=try await rig.connect(service,phone,as:.phone),session=try XCTUnwrap(service.session)
            barrier.fail();await old.value
            XCTAssertEqual(service.power,power,"Old failure phase \(phase) cannot switch a replacement OFF")
            XCTAssertFalse(replacement.isStopped,"Old failure phase \(phase) cannot stop the new listener")
            XCTAssertEqual(service.session,session);XCTAssertTrue(rig.policies.isEmpty)
            await service.quit();peer.close()
        }
    }
    func testCurrentTrustedOnFailureStopsOnlyItsOwnListenerWithoutRetrying() async throws {
        let rig=try HostRig(),service=rig.makeService(),own=try consent(Date())
        await service.turnOnFromTrustedCommunity(consent:{own},refresh:{throw TrustedOnBarrier.Failure.delayed})
        XCTAssertEqual(rig.opened.count,1);XCTAssertTrue(try XCTUnwrap(rig.opened.first).isStopped)
        if case .off(let reason)=service.power { XCTAssertTrue(reason?.contains("기기 신뢰 수신 권한을 확인하지 못했습니다") == true) }
        else { XCTFail("The current failed startup must be OFF") }
        XCTAssertTrue(rig.policies.isEmpty);await service.quit()
    }
    func testExpiredConsentReleasesItsOwnStartingClaimWithoutOpeningAnything() async throws {
        let rig=try HostRig(),service=rig.makeService(),expired=try consent(Date().addingTimeInterval(-1_000))
        await service.turnOnFromTrustedCommunity(consent:{expired},refresh:{XCTFail("Expired consent must not refresh/open")})
        if case .off=service.power {} else { XCTFail("An expired own attempt cannot remain stuck in starting") }
        XCTAssertTrue(rig.opened.isEmpty);XCTAssertTrue(rig.policies.isEmpty);await service.quit()
    }
    func testReceivingHoldDuringConsentReleasesOnlyItsOwnStartingClaim() async throws {
        let rig=try HostRig(),service=rig.makeService(),own=try consent(Date()),barrier=TrustedOnBarrier()
        let pending=Task { await service.turnOnFromTrustedCommunity(consent:{try await barrier.hold();return own},refresh:{XCTFail("A held receiver cannot proceed to refresh/open")}) }
        await barrier.entered();XCTAssertEqual(service.power,.starting)
        // Exactly the callback invoked by the production broker; this does not end/change the power epoch itself.
        service.unifiedAccessChanged(nil,peers:[],held:true)
        XCTAssertEqual(service.power,.starting)
        barrier.succeed();await pending.value
        if case .off=service.power {} else { XCTFail("The same-attempt receive hold cannot strand startup") }
        XCTAssertTrue(rig.opened.isEmpty);XCTAssertTrue(rig.policies.isEmpty)
        service.unifiedAccessChanged(nil,peers:[],held:false)
        await service.turnOnFromTrustedCommunity(consent:{own},refresh:{})
        XCTAssertFalse(try XCTUnwrap(rig.opened.last).isStopped,"A later permitted explicit ON remains reachable")
        await service.quit()
    }
    func testKnownReceivingHoldDisablesPresentationAndExplainsTheExistingLocalRecoveryWithoutEffects() async throws {
        let rig=try HostRig(),now=Date()
        rig.clock.advance(now.timeIntervalSince(rig.clock.now)) // The production presentation reads the real current time.
        let service=rig.makeService(),(authority,_,own)=try authorizations(now:now)
        let trust=try CommunityDesktopReceiveTrust.verified(authority:authority,authorization:own,deviceID:own.body.deviceId,hostKey:own.body.hostPublicKey,now:now)
        service.unifiedAccessChanged(own,peers:[],held:true)
        XCTAssertTrue(service.offersTrustedCommunityTurnOn)
        XCTAssertFalse(service.canTurnOnFromTrustedCommunity)
        XCTAssertEqual(service.trustedCommunityTurnOnNotice,ScreenService.receivingHoldRecoveryNotice)
        XCTAssertTrue(service.trustedCommunityTurnOnNotice?.contains("고급 · 이전 직접 등록 관리") == true)
        XCTAssertTrue(service.trustedCommunityTurnOnNotice?.contains("Touch ID 또는 Apple Watch") == true)
        await service.turnOnFromTrustedCommunity(consent:{XCTFail("A held receiver cannot request positive consent");return trust},refresh:{XCTFail("A held receiver cannot refresh/open")})
        if case .off=service.power {} else {XCTFail("Known receiving hold must leave power OFF")}
        XCTAssertEqual(service.problem,ScreenService.receivingHoldRecoveryNotice)
        XCTAssertTrue(rig.opened.isEmpty);XCTAssertTrue(rig.policies.isEmpty)
        // A user action, issuer renewal, and an input-resume delegation do not implicitly clear this hold.
        XCTAssertFalse(service.canTurnOnFromTrustedCommunity)
        service.unifiedAccessChanged(own,peers:[],held:false) // Fixture invokes the existing native callback only.
        XCTAssertNil(service.trustedCommunityTurnOnNotice);XCTAssertTrue(service.canTurnOnFromTrustedCommunity)
        await service.turnOnFromTrustedCommunity(consent:{trust},refresh:{})
        XCTAssertEqual(rig.opened.count,1);XCTAssertFalse(try XCTUnwrap(rig.opened.first).isStopped)
        XCTAssertTrue(rig.policies.isEmpty);await service.quit()
    }
    func testUnknownOrRevokedTrustedAuthorityNeverLooksReadyOrStartsAListener() async throws {
        for error in [ScreenCommunityError.service("NOT_ENROLLED"),.service("REVOKED")] {
            let rig=try HostRig(),service=rig.makeService()
            service.unifiedAccessChanged(nil,peers:[],held:false)
            XCTAssertFalse(service.offersTrustedCommunityTurnOn);XCTAssertFalse(service.canTurnOnFromTrustedCommunity)
            await service.turnOnFromTrustedCommunity() // Missing broker is also a stated refusal, not a silent no-op.
            XCTAssertTrue(service.problem?.contains("등록 상태를 새로 고침") == true)
            await service.turnOnFromTrustedCommunity(consent:{throw error},refresh:{XCTFail("Unknown/revoked authority cannot refresh/open")})
            if case .off(let reason)=service.power {XCTAssertTrue(reason?.contains("기기 신뢰 수신 권한을 확인하지 못했습니다") == true)}
            else {XCTFail("Unknown/revoked authority must remain OFF")}
            XCTAssertTrue(rig.opened.isEmpty);XCTAssertTrue(rig.policies.isEmpty)
            await service.quit()
        }
    }
}

@MainActor final class ScreenPersistentInputHoldTests:XCTestCase {
    func testMissingAndUncleanMigrateHeldButCleanOwnerConfirmedStateMayRestore() throws {
        let items=HostTestItems(),store=ScreenStore(items:items),a=ScreenPersistentInputHold(store:store)
        a.arm();XCTAssertTrue(a.held);try a.clearAfterOwnerConfirmation(expectedGeneration:XCTUnwrap(a.record?.generation));XCTAssertFalse(a.held)
        let b=ScreenPersistentInputHold(store:store);b.arm();XCTAssertTrue(b.held,"A live/unclean armed record cannot be treated as clean false")
        XCTAssertThrowsError(try a.clearAfterOwnerConfirmation(expectedGeneration:XCTUnwrap(a.record?.generation)))
        try b.clearAfterOwnerConfirmation(expectedGeneration:XCTUnwrap(b.record?.generation));b.sealAfterClosingInput()
        let c=ScreenPersistentInputHold(store:store);c.arm();XCTAssertFalse(c.held);XCTAssertNotNil(c.record?.instance)
    }
    func testCorruptLockedArmingAndNegativeWriteFailuresNeverProduceACleanUnheldSeal() throws {
        let items=HostTestItems(),store=ScreenStore(items:items)
        try items.write("input-hold-v1",Data("corrupt".utf8));let corrupt=ScreenPersistentInputHold(store:store);corrupt.arm();XCTAssertTrue(corrupt.held);XCTAssertFalse(corrupt.armed)
        XCTAssertEqual(try items.read("input-hold-v1"),Data("corrupt".utf8))
        _=items.items.withLock{$0.removeValue(forKey:"input-hold-v1")};items.fail(["input-hold-v1"])
        let locked=ScreenPersistentInputHold(store:store);locked.arm();XCTAssertTrue(locked.held);XCTAssertFalse(locked.armed)
        items.fail([]);locked.arm();try locked.clearAfterOwnerConfirmation(expectedGeneration:XCTUnwrap(locked.record?.generation));XCTAssertFalse(locked.held)
        items.fail(["input-hold-v1"]);locked.engage();XCTAssertTrue(locked.held);locked.sealAfterClosingInput()
        items.fail([]);let restarted=ScreenPersistentInputHold(store:store);restarted.arm();XCTAssertTrue(restarted.held)
    }
    func testOldInstanceAndPostSealActionsCannotOverwriteTheNewGeneration() throws {
        let items=HostTestItems(),store=ScreenStore(items:items),old=ScreenPersistentInputHold(store:store);old.arm()
        let pending=try XCTUnwrap(old.record?.generation),replacement=ScreenPersistentInputHold(store:store);replacement.arm()
        let current=try store.inputHoldData();XCTAssertThrowsError(try old.clearAfterOwnerConfirmation(expectedGeneration:pending))
        old.engage();old.sealAfterClosingInput();XCTAssertEqual(try store.inputHoldData(),current)
        replacement.sealAfterClosingInput();let sealed=try store.inputHoldData()
        XCTAssertThrowsError(try replacement.clearAfterOwnerConfirmation(expectedGeneration:XCTUnwrap(replacement.record?.generation)))
        replacement.engage();replacement.arm();XCTAssertEqual(try store.inputHoldData(),sealed)
    }
}
#endif
