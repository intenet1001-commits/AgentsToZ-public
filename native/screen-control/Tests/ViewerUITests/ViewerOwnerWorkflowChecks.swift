#if os(macOS)
import AppKit
import Foundation
import XCTest
import CryptoKit
import ScreenControlCore
@testable import AgentsToZViewer

private final class OwnerEvidenceMemory:ViewerTargetsBackend,@unchecked Sendable {
    var data:Data?,failNext=false
    var writes=0
    func read()throws->Data? {data}
    func write(_ bytes:Data)throws {writes+=1;if failNext {failNext=false;throw ScreenCommunityError.service("SOFTWARE_STORE_REFUSED")};data=bytes}
}
@MainActor private final class HandoffReadBarrier {
    let stream:AsyncStream<Void>,sink:AsyncStream<Void>.Continuation
    var reply:CheckedContinuation<Void,Never>?
    init(){(stream,sink)=AsyncStream.makeStream()}
    func hold()async {await withCheckedContinuation {reply=$0;sink.yield(())}}
    func entered()async {var iterator=stream.makeAsyncIterator();_ = await iterator.next()}
    func finish(){reply?.resume();reply=nil;sink.finish()}
}
@MainActor final class ViewerOwnerWorkflowChecks:XCTestCase {
    func testCapability10IsSeparateFromOrdinarySelectAllAndLosesSelectionWithDependency()throws {
        let file=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-desktop-trust-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any],a=f["authority"] as! [String:String]
        let authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:.init(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87)),profileID:a["profileId"]!)
        let ui=ViewerUnifiedEnrollment(authority:authority,store:ViewerUnifiedStore(backend:OwnerEvidenceMemory()))
        ui.selectAll();XCTAssertFalse(ui.selected.contains(.desktopTrust));XCTAssertFalse(ui.selected.contains(.ownerDelegation))
        ui.set(.ownerDelegation,selected:true);XCTAssertFalse(ui.selected.contains(.ownerDelegation))
        ui.set(.desktopTrust,selected:true);ui.set(.ownerDelegation,selected:true);XCTAssertTrue(ui.selected.contains(.ownerDelegation))
        ui.set(.receiveControl,selected:false);XCTAssertFalse(ui.selected.contains(.ownerDelegation))
    }
    func testOriginalUnknownEnvelopeIsPreservedAndKnownReceiptIsIdempotent()throws {
        let memory=OwnerEvidenceMemory(),store=ViewerOwnerStore(backend:memory)
        let e=ScreenCommunityEnvelope(payload:"unchanged original bytes",signature:"unchanged original signature")
        let j=try JSONDecoder().decode(CommunityAccessJournal.self,from:JSONSerialization.data(withJSONObject:["id":UUID().uuidString.lowercased(),"operation":"owner-recovery-approve","actor":UUID().uuidString.lowercased(),"envelope":["payload":e.payload,"signature":e.signature]]))
        try store.update{$0.pending=j};let original=memory.data
        XCTAssertEqual(try store.read().pending?.envelope,e);XCTAssertEqual(memory.data,original)
        let result=ScreenCommunityEnvelope(payload:"known original response",signature:"known response signature")
        try store.receipt(j,response:result);try store.receipt(j,response:result)
        XCTAssertEqual(try store.read().receipts.count,1);XCTAssertEqual(try store.read().pending,j)
        XCTAssertThrowsError(try store.receipt(j,response:e));XCTAssertEqual(try store.read().receipts.count,1)
    }
    func testFreshLookupEvidenceAndItsPendingClearAreAtomicAndPreserveEarlierOriginal()async throws {
        let memory=OwnerEvidenceMemory(),store=ViewerOwnerStore(backend:memory),envelope=ScreenCommunityEnvelope(payload:"exact original",signature:"exact original signature")
        let original=try JSONDecoder().decode(CommunityAccessJournal.self,from:JSONSerialization.data(withJSONObject:["id":UUID().uuidString.lowercased(),"operation":"owner-recovery-request","actor":UUID().uuidString.lowercased(),"envelope":["payload":envelope.payload,"signature":envelope.signature]]))
        let old=ScreenCommunityEnvelope(payload:"first verified lookup",signature:"first signed evidence"),fresh=ScreenCommunityEnvelope(payload:"fresh verified same-original lookup",signature:"fresh signed evidence")
        try store.update{$0.pending=original};try store.receipt(original,response:old)
        // Emulate the old format's committed evidence followed by a failed separate journal clear.
        let prior=memory.data;memory.failNext=true
        XCTAssertThrowsError(try store.receipt(original,response:fresh,closePending:true,allowRefreshedLookup:true))
        XCTAssertEqual(memory.data,prior);XCTAssertEqual(try store.read().pending,original)
        try store.receipt(original,response:fresh,closePending:true,allowRefreshedLookup:true)
        let complete=try store.read();XCTAssertNil(complete.pending);XCTAssertEqual(complete.receipts.first?.response,old);XCTAssertEqual(complete.receipts.first?.completion,fresh)
        let committedWrites=memory.writes
        // The coordinator still owns its RAM fence, but its save(nil) must be a no-op rather than a second fallible write.
        let issuer=P256.Signing.PrivateKey(),authority=try ScreenCommunityAuthority(origin:URL(string:"https://owner-fixture.workers.dev")!,issuer:issuer.publicKey,profileID:UUID().uuidString.lowercased())
        let coordinator=CommunityAccessCoordinator(authority:authority,pending:original,save:{pending in try store.update{$0.pending=pending}})
        memory.failNext=true
        try await coordinator.acknowledge(original.id)
        XCTAssertEqual(memory.writes,committedWrites);let pending=await coordinator.snapshot();XCTAssertNil(pending)
    }
    private func list()throws->TargetListController {
        _ = NSApplication.shared
        let raw=Data("{\"schemaVersion\":1,\"generatedAt\":1700000000000,\"expiresAt\":1700000090000,\"inside\":true,\"devices\":[]}".utf8)
        let directory=try ViewerCommunityDirectory.decode(raw,now:Date(timeIntervalSince1970:1_700_000_000))
        return TargetListController(ledger:ViewerTargetsLedger(backend:OwnerEvidenceMemory()),communityDirectory:{directory})
    }
    func testLockDuringEitherNativeReadInvalidatesActualListPendingSelectionBeforeConnectingExists()async throws {
        for phase in 0..<2 {
            let list=try list(),barrier=HandoffReadBarrier();defer{list.window.close()}
            var opened=0
            let pending=Task {
                do {
                    _=try await list.prepareScreenSelection {
                        if phase==0 {await barrier.hold()} // consume IPC
                        if phase==1 {await barrier.hold()} // currentAuthorization/directory
                        return "selected exact target"
                    }
                    opened+=1
                }catch{}
            }
            await barrier.entered();XCTAssertNil(list.active)
            list.guardTripped();barrier.finish();await pending.value
            XCTAssertEqual(opened,0);XCTAssertNil(list.active);XCTAssertFalse(list.window.isVisible)
        }
    }
    func testNewerSelectionCannotBeReplacedByAnOlderPendingRead()async throws {
        let list=try list(),barrier=HandoffReadBarrier();defer{list.window.close()}
        var opened:[String]=[]
        let old=Task {do{let name=try await list.prepareScreenSelection {await barrier.hold();return "old"};opened.append(name)}catch{}}
        await barrier.entered()
        let current=try await list.prepareScreenSelection {"current"};opened.append(current)
        barrier.finish();await old.value
        XCTAssertEqual(opened,["current"]);XCTAssertNil(list.active)
    }

}
#endif
