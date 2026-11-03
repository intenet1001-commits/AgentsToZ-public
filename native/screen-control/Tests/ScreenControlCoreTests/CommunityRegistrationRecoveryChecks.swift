#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

private final class RecoverySavedState: @unchecked Sendable {
    let lock=NSLock();private var journal:CommunityAccessJournal?;private var enrollment:ScreenCommunityEnrollmentState?
    func save(_ value:CommunityAccessJournal?) { lock.withLock { journal=value } }
    func saveEnrollment(_ value:ScreenCommunityEnrollmentState) { lock.withLock { enrollment=value } }
    func readEnrollment()->ScreenCommunityEnrollmentState? { lock.withLock { enrollment } }
}
private struct RegistrationFixture: @unchecked Sendable {
    let issuer=P256.Signing.PrivateKey(),host=SoftwareSigner(),bio=SoftwareSigner(),operation=SoftwareSigner()
    let profile=UUID().uuidString.lowercased(),device=UUID().uuidString.lowercased(),community=UUID().uuidString.lowercased(),enrollment=UUID().uuidString.lowercased()
    let now=Date(timeIntervalSince1970:1_800_000_000)
    var at:Int64 {Int64(now.timeIntervalSince1970*1000)}
    var authority:ScreenCommunityAuthority {try! ScreenCommunityAuthority(origin:URL(string:"https://recovery-fixture.workers.dev")!,issuer:issuer.publicKey,profileID:profile)}
    var plan:CommunityAccessPlan {try! .init(profileId:profile,deviceId:device,name:"iPad / 복구",kind:.mobile,hostKey:host.publicKey.x963Representation,biometricKey:bio.publicKey.x963Representation,operationKey:operation.publicKey.x963Representation,capabilities:[.screenView])}
    func response(_ kind:String,_ value:Any,date:Date) throws -> CommunityAccessReply {
        let bytes=try JSONSerialization.data(withJSONObject:[2,kind,UUID().uuidString.lowercased(),Int64(date.timeIntervalSince1970*1000),value],options:.withoutEscapingSlashes)
        let sig=try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes)
        return try .verify(.init(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(sig.rawRepresentation)),authority:authority,now:date)
    }
    func original() async throws -> CommunityAccessJournal {
        let args=try JSONEncoder().encode([plan]),request=try CommunityAccessRequest(operation:.prepare,actor:nil,argumentsJSON:args,now:now)
        return CommunityAccessJournal(id:request.id,operation:"prepare",actor:nil,envelope:try await request.signed(by:host))
    }
    func absence(_ original:CommunityAccessJournal?,date:Date) throws -> CommunityRegistrationAbsence {
        let checked=try original.map { try CommunityOriginalPrepare($0.envelope) }
        let body:[String:Any]=["communityId":community,"profileId":profile,"deviceId":device,"planDigest":try plan.digest,"originalRequestId":checked?.id as Any? ?? NSNull(),"originalRequestHash":checked?.envelopeHash as Any? ?? NSNull(),"originalIssuedAt":checked?.issuedAt as Any? ?? NSNull()]
        return try .verify(response("registration-absent",body,date:date),authority:authority,plan:plan,now:date)
    }
    func certificate(_ administrator:Bool,id:String=UUID().uuidString.lowercased()) throws -> ScreenCommunityEnvelope {
        let bytes=try JSONSerialization.data(withJSONObject:[1,"member",id,at,community,profile,enrollment,device,"iPad",ScreenCommunityRequest.base64(host.publicKey.x963Representation),ScreenCommunityRequest.base64(bio.publicKey.x963Representation),"none",administrator,1,at-1_000,NSNull(),"ios",at+30*24*60*60*1_000],options:.withoutEscapingSlashes)
        return .init(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.screen-community.response/v1\0".utf8)+bytes).rawRepresentation))
    }
}
private actor CurrentManagementRole {
    let fixture:RegistrationFixture;var administrator:Bool;var calls:[String]=[]
    init(_ fixture:RegistrationFixture,administrator:Bool){self.fixture=fixture;self.administrator=administrator}
    func set(_ value:Bool){administrator=value}
    func operations()->[String]{calls}
    func send(_ envelope:ScreenCommunityEnvelope,_ id:String) throws -> ScreenCommunityResponse {
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload),fields=try JSONSerialization.jsonObject(with:bytes) as! [Any]
        let op=fields[1] as! String;calls.append(op)
        let sig=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(envelope.signature,max:86))
        guard fixture.host.publicKey.isValidSignature(sig,for:Data("agentstoz.screen-community.request/v1\0".utf8)+bytes),op=="recover" else {throw ScreenCommunityError.malformed}
        return try .verify(fixture.certificate(administrator,id:id),issuer:fixture.issuer.publicKey,expectedRequestID:id,now:fixture.now)
    }
}
private actor DeferredManagementCertificate {
    private var answer: CheckedContinuation<ScreenCommunityCertificate, Never>?
    private var onStart: CheckedContinuation<Void, Never>?
    private var began = false
    func read() async -> ScreenCommunityCertificate {
        await withCheckedContinuation { continuation in
            answer = continuation; began = true; onStart?.resume(); onStart = nil
        }
    }
    func started() async { if !began { await withCheckedContinuation { onStart = $0 } } }
    func finish(_ certificate: ScreenCommunityCertificate) { answer?.resume(returning: certificate); answer = nil }
}
final class CommunityRegistrationRecoveryChecks:XCTestCase {
    @MainActor func testDeferredNativeCertificateCannotReviveClosedOrSupersededReview() async throws {
        let f=RegistrationFixture(),envelope=try f.certificate(true)
        let certificate=try ScreenCommunityResponse.verify(envelope,issuer:f.issuer.publicKey,now:f.now).certificate(profileID:f.profile,deviceID:f.device,hostKey:f.host.publicKey.x963Representation,viewerKey:f.bio.publicKey.x963Representation,now:f.now)
        for replacement in [false,true] {
            let lifecycle=CommunityReviewLifecycle(),deferred=DeferredManagementCertificate();var opened=0
            let task=Task { let _=try await lifecycle.freshCertificate { await deferred.read() }; opened += 1 }
            await deferred.started()
            if replacement { let current=try await lifecycle.freshCertificate { certificate }; XCTAssertEqual(current.member.enrollmentID,f.enrollment) }
            else { lifecycle.cancel() }
            await deferred.finish(certificate)
            do { try await task.value;XCTFail("Cancelled or superseded certificate read") } catch { XCTAssertEqual(error as? ScreenCommunityError,.service("REVIEW_CONTEXT_CHANGED")) }
            XCTAssertEqual(opened,0)
        }
    }
    @MainActor func testCancelDuringSecondIdentityReadAfterFreshCertificateStillPreventsReviewRevival() async throws {
        let f=RegistrationFixture(),envelope=try f.certificate(true)
        let certificate=try ScreenCommunityResponse.verify(envelope,issuer:f.issuer.publicKey,now:f.now).certificate(profileID:f.profile,deviceID:f.device,hostKey:f.host.publicKey.x963Representation,viewerKey:f.bio.publicKey.x963Representation,now:f.now)
        let lifecycle=CommunityReviewLifecycle(),identityRead=DeferredManagementCertificate();var opened=0
        let task=Task {
            let _=try await lifecycle.prepare {
                let first=certificate // The issuer certificate already returned before the second native read suspends.
                let second=await identityRead.read()
                return (first,second)
            }
            opened += 1
        }
        await identityRead.started();lifecycle.cancel();await identityRead.finish(certificate)
        do { try await task.value;XCTFail("Identity response after close") } catch { XCTAssertEqual(error as? ScreenCommunityError,.service("REVIEW_CONTEXT_CHANGED")) }
        XCTAssertEqual(opened,0)
    }
    func testOnlyAnExactOriginalWhoseAcceptanceWindowClosedCanReleasePrepare() async throws {
        let f=RegistrationFixture(),journal=try await f.original(),box=RecoverySavedState(),later=f.now.addingTimeInterval(61)
        let coordinator=CommunityAccessCoordinator(authority:f.authority,pending:journal,save:box.save,exchange:{_,_ in XCTFail("No mutation or network dispatch");throw ScreenCommunityError.malformed})
        XCTAssertThrowsError(try f.absence(journal,date:f.now.addingTimeInterval(59)))
        let plain=try f.absence(nil,date:later)
        do{try await coordinator.resolveExpiredPrepare(using:plain,now:later);XCTFail("Unbound absence cannot release a fence")}catch{}
        let stillPending=await coordinator.snapshot();XCTAssertEqual(stillPending?.id,journal.id)
        let bound=try f.absence(journal,date:later);try await coordinator.resolveExpiredPrepare(using:bound,now:later)
        let cleared=await coordinator.snapshot();XCTAssertNil(cleared)
    }
    func testAnAbsenceVerifiedForAnotherIssuerOrOriginCannotClearThisAuthorityFence() async throws {
        let f=RegistrationFixture(),old=try await f.original(),later=f.now.addingTimeInterval(61),original=try CommunityOriginalPrepare(old.envelope)
        let object:[String:Any]=["communityId":f.community,"profileId":f.profile,"deviceId":f.device,"planDigest":try f.plan.digest,"originalRequestId":original.id,"originalRequestHash":original.envelopeHash,"originalIssuedAt":original.issuedAt]
        for foreignIssuer in [false,true] {
            let other=P256.Signing.PrivateKey()
            let issuer=foreignIssuer ? other : f.issuer
            let authority=try ScreenCommunityAuthority(origin:URL(string:foreignIssuer ? "https://recovery-fixture.workers.dev" : "https://other-fixture.workers.dev")!,issuer:issuer.publicKey,profileID:f.profile)
            let bytes=try JSONSerialization.data(withJSONObject:[2,"registration-absent",UUID().uuidString.lowercased(),Int64(later.timeIntervalSince1970*1000),object])
            let envelope=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
            let reply=try CommunityAccessReply.verify(envelope,authority:authority,now:later)
            let proof=try CommunityRegistrationAbsence.verify(reply,authority:authority,plan:f.plan,now:later)
            let coordinator=CommunityAccessCoordinator(authority:f.authority,pending:old,save:{_ in XCTFail("Foreign absence must never clear the journal")})
            do { try await coordinator.resolveExpiredPrepare(using:proof,now:later);XCTFail("Foreign authority") } catch {}
            let retained=await coordinator.snapshot();XCTAssertEqual(retained?.id,old.id)
        }
    }
    func testDifferentOriginalAndUnknownApprovalsRemainFenced() async throws {
        let f=RegistrationFixture(),old=try await f.original(),other=try await f.original(),later=f.now.addingTimeInterval(61),box=RecoverySavedState()
        let proof=try f.absence(other,date:later),coordinator=CommunityAccessCoordinator(authority:f.authority,pending:old,save:box.save)
        do{try await coordinator.resolveExpiredPrepare(using:proof,now:later);XCTFail("Different original")}catch{}
        let snapshot=await coordinator.snapshot();XCTAssertEqual(snapshot?.id,old.id)
        for operation in ["approve","approve-management"] {
            let journal=CommunityAccessJournal(id:old.id,operation:operation,actor:f.enrollment,envelope:old.envelope)
            let protected=CommunityAccessCoordinator(authority:f.authority,pending:journal,save:box.save)
            do{try await protected.resolveExpiredPrepare(using:f.absence(old,date:later),now:later);XCTFail("Approval fence")}catch{}
            let retained=await protected.snapshot();XCTAssertEqual(retained?.operation,operation)
        }
    }
    func testPostApprovalLookupAfterStagingExpiryValidatesOwnPolicyWithoutLegacyCertificate() throws {
        let f=RegistrationFixture(),date=f.now.addingTimeInterval(601),at=Int64(date.timeIntervalSince1970*1000),p=f.plan
        let value:[String:Any]=["version":1,"communityId":f.community,"profileId":p.profileId,"enrollmentId":f.enrollment,"deviceId":p.deviceId,"deviceKind":p.kind.rawValue,"name":p.name,"hostPublicKey":p.hostKey,"publicKey":p.operationKey,"biometricPublicKey":p.biometricKey,"controlKey":NSNull(),"agentDeviceId":NSNull(),"capabilities":p.capabilities.map(\.rawValue),"revision":3,"keyEpoch":1,"issuedAt":at,"expiresAt":at+90_000]
        let reply=try f.response("authorization",value,date:date)
        if case .registered(let auth)=try CommunityRegistrationLookup.verify(reply,authority:f.authority,plan:p,communityId:f.community,now:date){XCTAssertEqual(auth.body.enrollmentId,f.enrollment)}else{XCTFail("Original policy recovery")}
        XCTAssertThrowsError(try CommunityRegistrationLookup.verify(reply,authority:f.authority,plan:p,communityId:UUID().uuidString.lowercased(),now:date))
    }
    func testFreshSelfRoleReadUpdatesStillValidLegacyCertificatesBothDirectionsWithoutReceiptReplayOrBIO() async throws {
        for initial in [false,true] {
            let f=RegistrationFixture(),service=CurrentManagementRole(f,administrator:!initial),box=RecoverySavedState()
            var state=ScreenCommunityEnrollmentState(deviceID:f.device,hostKey:f.host.publicKey.x963Representation,viewerKey:f.bio.publicKey.x963Representation)
            state.certificate=try f.certificate(initial)
            let request=try ScreenCommunityRequest(operation:.pushRegister,actor:f.enrollment,arguments:[.string(f.community),.string(String(repeating:"ab",count:32)),.string("sandbox"),.string("com.example.fixture.mobile")],now:f.now)
            state.submittedID=request.id;state.submittedEnvelope=try await request.signed(by:f.bio);state.uncertainMutation=true
            let originalId=state.submittedID
            let model=try ScreenCommunityEnrollment(authority:f.authority,device:.init(id:f.device,name:"iPad",platform:"ios",grant:.none),identity:f.host,viewerKey:f.bio.publicKey.x963Representation,state:state,save:box.saveEnrollment,exchange:{try await service.send($0,$1)},now:{f.now})
            let old=try await model.certificate();XCTAssertEqual(old.member.admin,initial);XCTAssertGreaterThan(old.expiresAt,f.now)
            let fresh=try await model.refreshSelfCertificate();XCTAssertEqual(fresh.member.admin,!initial)
            let row:[Any]=[f.enrollment,f.device,"iPad",ScreenCommunityRequest.base64(f.host.publicKey.x963Representation),ScreenCommunityRequest.base64(f.bio.publicKey.x963Representation),"none",!initial,1,f.at-1_000,NSNull(),"ios"]
            let directoryBytes=try JSONSerialization.data(withJSONObject:[1,"directory",UUID().uuidString.lowercased(),f.at,f.community,f.profile,"Fixture",2,f.at+90_000,f.enrollment,[row]])
            let directoryEnvelope=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(directoryBytes),signature:ScreenCommunityRequest.base64(try f.issuer.signature(for:Data("agentstoz.screen-community.response/v1\0".utf8)+directoryBytes).rawRepresentation))
            let directory=try ScreenCommunityResponse.verify(directoryEnvelope,issuer:f.issuer.publicKey,now:f.now).directory(for:fresh,now:f.now)
            XCTAssertEqual(directory.members.first?.admin,fresh.member.admin)
            XCTAssertNotEqual(directory.members.first?.admin,old.member.admin,"A still-valid old certificate cannot determine current management UI")
            let operations=await service.operations();XCTAssertEqual(operations,["recover"])
            let saved=await model.snapshot();XCTAssertTrue(saved.uncertainMutation);XCTAssertEqual(saved.submittedID,originalId)
            XCTAssertEqual(box.readEnrollment()?.submittedID,originalId)
        }
    }
}
#endif
