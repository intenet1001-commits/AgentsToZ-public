#if os(macOS)
import Foundation
import CryptoKit
import XCTest
import ScreenControlCore
@testable import AgentsToZViewer

private final class TrustEnrollmentMemory:ViewerTargetsBackend,@unchecked Sendable {
    var data:Data?,fail=false
    func read()throws->Data? { data }
    func write(_ data:Data)throws { if fail { throw ScreenCommunityError.service("SOFTWARE_STORE_REFUSED") };self.data=data }
}
@MainActor final class ViewerDesktopTrustChecks:XCTestCase {
    private func fixtures()throws->(ScreenCommunityAuthority,CommunityAuthorization,CommunityAccessPlan,CommunityAccessPlan) {
        let file=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-desktop-trust-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any],a=f["authority"] as! [String:String]
        let publicKey=try P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87))
        let authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:publicKey,profileID:a["profileId"]!)
        let at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let envelope=try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:f["controllerEnvelope"]!))
        let grant=try CommunityAccessReply.verify(envelope,authority:authority,now:at).authorization(authority:authority,now:at),b=grant.body
        func plan(_ caps:[CommunityCapability])throws->CommunityAccessPlan {
            try .init(profileId:b.profileId,deviceId:b.deviceId,name:b.name,kind:.desktop,hostKey:ScreenCommunityRequest.decodeBase64(b.hostPublicKey,max:87),biometricKey:ScreenCommunityRequest.decodeBase64(b.biometricPublicKey,max:87),operationKey:ScreenCommunityRequest.decodeBase64(b.publicKey,max:87),capabilities:caps)
        }
        return (authority,grant,try plan([.screenView,.screenControl]),try plan(b.capabilities))
    }
    func testTrustRequiresAnExplicitChoiceAndDraftCancellationDoesNotTouchStagedEvidence() throws {
        let (authority,_,old,new)=try fixtures(),backend=TrustEnrollmentMemory(),store=ViewerUnifiedStore(backend:backend)
        let envelope=ScreenCommunityEnvelope(payload:"old exact software evidence",signature:"not used as authority")
        try store.install(.init(operationBlob:Data("existing-opaque-key-blob".utf8),plan:old,accepted:.init(envelope:envelope,checkedAt:Date())))
        try store.stage(new,expectedAcceptedPlan:old);let original=backend.data
        let ui=ViewerUnifiedEnrollment(authority:authority,store:store)
        ui.selectAll();XCTAssertFalse(ui.selected.contains(.desktopTrust))
        ui.set(.desktopTrust,selected:true);XCTAssertTrue(ui.selected.contains(.desktopTrust))
        ui.cancelSelectionChanges();XCTAssertEqual(ui.selected,old.capabilities);XCTAssertEqual(backend.data,original)
        XCTAssertEqual(try store.read()?.plan,old);XCTAssertEqual(try store.read()?.stagedPlan,new)
        XCTAssertEqual(try store.read()?.accepted?.envelope,envelope)
    }
    func testStagingFailureAndUnknownOriginalFencePreserveAcceptedAuthorityAndKeys() throws {
        let (_,_,old,new)=try fixtures(),backend=TrustEnrollmentMemory(),store=ViewerUnifiedStore(backend:backend)
        let envelope=ScreenCommunityEnvelope(payload:"accepted-original",signature:"kept-byte-for-byte")
        try store.install(.init(operationBlob:Data("existing-key".utf8),plan:old,accepted:.init(envelope:envelope,checkedAt:Date())))
        let original=backend.data;backend.fail=true;XCTAssertThrowsError(try store.stage(new,expectedAcceptedPlan:old));XCTAssertEqual(backend.data,original)
        backend.fail=false
        let journal=try JSONDecoder().decode(CommunityAccessJournal.self,from:JSONSerialization.data(withJSONObject:["id":UUID().uuidString.lowercased(),"operation":"prepare","actor":NSNull(),"envelope":["payload":"exact-unknown-original","signature":"exact-signature"]]))
        try store.update{$0.journal=journal};let unknown=backend.data
        XCTAssertThrowsError(try store.stage(new,expectedAcceptedPlan:old));XCTAssertEqual(backend.data,unknown)
        XCTAssertEqual(try store.read()?.journal?.envelope,journal.envelope);XCTAssertEqual(try store.read()?.operationBlob,Data("existing-key".utf8))
    }
    func testOnlyTheExactSignedStagedPolicyCommitsAndLateOldRenewalCannotEraseIt() throws {
        let (_,grant,old,new)=try fixtures(),backend=TrustEnrollmentMemory(),store=ViewerUnifiedStore(backend:backend)
        let envelope=ScreenCommunityEnvelope(payload:"old",signature:"old")
        try store.install(.init(operationBlob:Data("opaque".utf8),plan:old,accepted:.init(envelope:envelope,checkedAt:Date())))
        try store.stage(new,expectedAcceptedPlan:old)
        XCTAssertThrowsError(try store.commitAccepted(grant,plan:old,preserveStaged:false));XCTAssertEqual(try store.read()?.stagedPlan,new)
        XCTAssertThrowsError(try store.stage(old,expectedAcceptedPlan:old))
        try store.commitAccepted(grant,plan:new,preserveStaged:false)
        XCTAssertEqual(try store.read()?.plan,new);XCTAssertNil(try store.read()?.stagedPlan)
        XCTAssertEqual(try store.read()?.accepted?.envelope,grant.envelope);XCTAssertEqual(try store.read()?.operationBlob,Data("opaque".utf8))
    }
}
#endif
