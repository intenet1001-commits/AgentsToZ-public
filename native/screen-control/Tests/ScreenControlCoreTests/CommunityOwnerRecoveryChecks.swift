#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

final class CommunityOwnerRecoveryChecks:XCTestCase {
    private func golden()throws->(ScreenCommunityAuthority,CommunityAuthorization,CommunityAuthorization,CommunityOwnerDelegation,CommunityOwnerRecord,CommunityOwnerRound,Date) {
        let url=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-owner-recovery-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any],a=f["authority"] as! [String:String]
        let now=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87)),profileID:a["profileId"]!)
        func e(_ key:String)throws->ScreenCommunityEnvelope {try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:f[key]!))}
        let source=try CommunityAccessReply.verify(e("sourceEnvelope"),authority:authority,now:now).authorization(authority:authority,now:now)
        let target=try CommunityAccessReply.verify(e("targetEnvelope"),authority:authority,now:now).authorization(authority:authority,now:now)
        let d=try CommunityOwnerDelegation.verify(e("delegationEnvelope"),authority:authority,own:target,now:now)
        let record=try CommunityOwnerRecord.verify(e("approvedEnvelope"),authority:authority,communityId:target.body.communityId,now:now)
        let round=try CommunityOwnerRound.verify(e("roundEnvelope"),authority:authority,own:target,target:true,now:now)
        return (authority,source,target,d,record,round,now)
    }
    func testActualCFPublicGoldenVerifiesSourceBIOAndTargetScopedDelegation()throws {
        let (a,s,t,d,r,round,now)=try golden()
        XCTAssertEqual(round.records.count,1);XCTAssertEqual(round.records[0].body.requestId,r.body.requestId)
        let proof=try CommunityDelegatedInputConfirmation.verify(record:r,authority:a,currentTarget:t,currentSource:s,currentDelegation:d,now:now)
        XCTAssertEqual(proof.intent.action,"resume-input");XCTAssertNil(proof.intent.connectionId)
        XCTAssertEqual(try CommunityMobileControlPolicy.authorizationDigest(s),r.body.sourcePolicyDigest)
        XCTAssertEqual(try CommunityMobileControlPolicy.authorizationDigest(t),r.body.targetPolicyDigest)
        XCTAssertEqual(try CommunityOwnerWire.envelopeHash(r.envelope),try CommunityOwnerWire.envelopeHash(r.envelope))
        // The existing 9-capability software record remains valid; BIO setup is a management alternative to cap10.
        XCTAssertFalse(t.body.capabilities.contains(.ownerDelegation))
    }
    func testDifferentIssuerTargetCurrentPolicyAndExpiryCannotAuthorizeADelegatedEffect()throws {
        let (a,s,t,d,r,_,now)=try golden()
        let foreign=try ScreenCommunityAuthority(origin:a.origin,issuer:P256.Signing.PrivateKey().publicKey,profileID:a.profileID)
        XCTAssertThrowsError(try CommunityDelegatedInputConfirmation.verify(record:r,authority:foreign,currentTarget:t,currentSource:s,currentDelegation:d,now:now))
        XCTAssertThrowsError(try CommunityDelegatedInputConfirmation.verify(record:r,authority:a,currentTarget:s,currentSource:t,currentDelegation:d,now:now))
        XCTAssertThrowsError(try CommunityDelegatedInputConfirmation.verify(record:r,authority:a,currentTarget:t,currentSource:s,currentDelegation:d,now:now.addingTimeInterval(121)))
        let forged=CommunityAuthorization(body:s.body,envelope:t.envelope)
        XCTAssertThrowsError(try CommunityDelegatedInputConfirmation.verify(record:r,authority:a,currentTarget:t,currentSource:forged,currentDelegation:d,now:now))
    }
    func testExplicitCapability10DoesNotChangeNineOrPermitMobileStandaloneOrPartialReceiver()throws {
        let old=Array(CommunityCapability.allCases.prefix(9))
        XCTAssertEqual(old.last,.desktopTrust);XCTAssertEqual(CommunityCapability.allCases.count,10)
        let selected:[CommunityCapability]=[.receiveView,.receiveControl,.desktopTrust,.ownerDelegation]
        XCTAssertEqual(try CommunityCapability.normalized(selected,kind:.desktop),selected)
        XCTAssertThrowsError(try CommunityCapability.normalized(selected,kind:.mobile))
        XCTAssertThrowsError(try CommunityCapability.normalized([.ownerDelegation],kind:.desktop))
        XCTAssertThrowsError(try CommunityCapability.normalized([.receiveView,.desktopTrust,.ownerDelegation],kind:.desktop))
    }
    func testReserveBeforeEffectSurvivesRestartAndNeverAllowsSecondExecution()throws {
        let (a,s,t,d,r,_,now)=try golden(),proof=try CommunityDelegatedInputConfirmation.verify(record:r,authority:a,currentTarget:t,currentSource:s,currentDelegation:d,now:now)
        let local=UUID().uuidString.lowercased(),instance=UUID().uuidString.lowercased(),i=proof.intent
        let p=CommunityOwnerEffectJournal.Publication(recordId:r.body.requestId,instance:instance,localGeneration:local,holdGeneration:i.holdGeneration,connectionId:i.connectionId,challenge:i.challenge,targetPolicyDigest:i.targetPolicyDigest,sourcePolicyDigest:i.sourcePolicyDigest,delegationRevision:i.delegationRevision,expiresAt:i.expiresAt)
        var journal=CommunityOwnerEffectJournal();try journal.publish(p,now:now)
        XCTAssertTrue(p.matches(proof,instance:instance,localGeneration:local,holdGeneration:i.holdGeneration,connectionId:nil,now:now))
        XCTAssertFalse(p.matches(proof,instance:UUID().uuidString.lowercased(),localGeneration:local,holdGeneration:i.holdGeneration,connectionId:nil,now:now))
        XCTAssertFalse(p.matches(proof,instance:instance,localGeneration:local,holdGeneration:i.holdGeneration,connectionId:UUID().uuidString.lowercased(),now:now))
        try journal.reserve(proof)
        var restarted=try CommunityOwnerEffectJournal.decode(journal.encoded())
        XCTAssertEqual(restarted.entries[r.body.requestId]?.reservationHash,try CommunityOwnerWire.envelopeHash(r.envelope))
        XCTAssertThrowsError(try restarted.reserve(proof),"A persisted reservation has an unknown effect and cannot execute again")
        try restarted.finish(r.body.requestId,outcome:.applied);try restarted.reported(r.body.requestId,outcome:.applied)
        XCTAssertThrowsError(try restarted.finish(r.body.requestId,outcome:.refused))
        XCTAssertThrowsError(try restarted.reserve(proof))
        var raw=try JSONSerialization.jsonObject(with:restarted.encoded()) as! [String:Any]
        var entries=raw["entries"] as! [String:[String:Any]];entries[r.body.requestId]!["reservationHash"]=NSNull();raw["entries"]=entries
        XCTAssertThrowsError(try CommunityOwnerEffectJournal.decode(JSONSerialization.data(withJSONObject:raw)))
    }
    func testLocalSelectionHandoffRequiresBothCurrentPoliciesAndCannotCarryASessionAuthority()throws {
        let (a,s,t,_,_,_,now)=try golden()
        let trust=try CommunityDesktopScreenTrust.verified(authority:a,controller:s,receiver:t,now:now)
        let hint=try CommunityViewerHandoff(selection:trust,now:now)
        XCTAssertNoThrow(try hint.validate(authority:a,own:s,target:t,now:now))
        XCTAssertThrowsError(try hint.validate(authority:a,own:s,target:t,now:now.addingTimeInterval(31)))
        XCTAssertThrowsError(try hint.validate(authority:a,own:t,target:s,now:now))
        let channel=try CommunityDesktopScreenTrust.verified(authority:a,controller:s,receiver:t,channelId:UUID().uuidString.lowercased(),now:now)
        XCTAssertThrowsError(try CommunityViewerHandoff(selection:channel,now:now),"An existing connection is not a new UI selection")
    }
    func testClosedWindowAbsenceIsBoundToExactOriginalAndPinnedIssuerAndOnlyClosesThatFence()async throws {
        let url=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-owner-recovery-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any]
        let original=try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:f["request"]!))
        let oldSource=try golden().1,issuer=P256.Signing.PrivateKey(),a=try ScreenCommunityAuthority(origin:URL(string:"https://owner-recovery-fixture.workers.dev")!,issuer:issuer.publicKey,profileID:oldSource.body.profileId)
        let raw=try CommunityOwnerWire.request(original,operation:.ownerRequest,actor:oldSource.body.enrollmentId,communityId:oldSource.body.communityId),at=raw.at+61_000,now=Date(timeIntervalSince1970:Double(at)/1000)
        func reply(_ kind:String,_ body:Any,signer:P256.Signing.PrivateKey?=nil)throws->CommunityAccessReply {
            let bytes=try CommunityOwnerWire.value([2,kind,UUID().uuidString.lowercased(),at,body]),key=signer ?? issuer
            let envelope=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try key.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
            let authority=try ScreenCommunityAuthority(origin:a.origin,issuer:key.publicKey,profileID:a.profileID)
            return try CommunityAccessReply.verify(envelope,authority:authority,now:now)
        }
        var ownBody=f["source"] as! [String:Any];ownBody["issuedAt"]=at;ownBody["expiresAt"]=at+90_000
        let own=try reply("authorization",ownBody).authorization(authority:a,now:now)
        let journal=CommunityAccessJournal(id:raw.id,operation:CommunityAccessRequest.Operation.ownerRequest.rawValue,actor:own.body.enrollmentId,envelope:original)
        let body:[String:Any]=["version":1,"communityId":own.body.communityId,"sourceEnrollmentId":own.body.enrollmentId,"targetEnrollmentId":raw.args[1],"requestId":raw.id,"originalRequestHash":try CommunityOwnerWire.envelopeHash(original),"originalIssuedAt":raw.at,"issuedAt":at,"expiresAt":at+90_000]
        let proof=try CommunityOwnerAbsence.verify(reply("owner-recovery-absent",body),original:journal,own:own,authority:a,now:now)
        let transport=CommunityAccessCoordinator(authority:a,pending:journal,save:{_ in})
        try await transport.resolveOwnerAbsence(proof,now:now)
        let ended=await transport.snapshot();XCTAssertNil(ended)
        let other=CommunityAccessJournal(id:UUID().uuidString.lowercased(),operation:journal.operation,actor:journal.actor,envelope:original)
        let preserved=CommunityAccessCoordinator(authority:a,pending:other,save:{_ in})
        do{try await preserved.resolveOwnerAbsence(proof,now:now);XCTFail("Different original must stay fenced")}catch{}
        let remaining=await preserved.snapshot();XCTAssertEqual(remaining,other)
        XCTAssertThrowsError(try CommunityOwnerAbsence.verify(reply("owner-recovery-absent",body,signer:P256.Signing.PrivateKey()),original:journal,own:own,authority:a,now:now))
        var changed=body;changed["originalRequestHash"]=String(repeating:"0",count:64)
        XCTAssertThrowsError(try CommunityOwnerAbsence.verify(reply("owner-recovery-absent",changed),original:journal,own:own,authority:a,now:now))
        changed=body;changed["originalIssuedAt"]=at-59_000
        XCTAssertThrowsError(try CommunityOwnerAbsence.verify(reply("owner-recovery-absent",changed),original:journal,own:own,authority:a,now:now))
    }

}
#endif
