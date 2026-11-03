#if os(macOS)
import XCTest
import Foundation
import CryptoKit
import os
@testable import ScreenControlCore
@testable import ScreenHost

private actor SafetyTestGate<Value:Sendable> {
    private var continuation:CheckedContinuation<Value,Error>?,start:CheckedContinuation<Void,Never>?,began=false,result:Result<Value,Error>?
    func read() async throws -> Value {
        began=true;start?.resume();start=nil
        if let value=result { result=nil;return try value.get() }
        return try await withCheckedThrowingContinuation { continuation=$0 }
    }
    func started() async { if began { return };await withCheckedContinuation { start=$0 } }
    func finish(_ value:Result<Value,Error>) { if let c=continuation { continuation=nil;c.resume(with:value) } else { result=value } }
}
private final class SafetyTestClock:Sendable {
    private let value:OSAllocatedUnfairLock<(Date,TimeInterval)>
    init(_ date:Date) { value = .init(initialState:(date,0)) }
    var now:Date { value.withLock{$0.0} }
    var uptime:TimeInterval { value.withLock{$0.1} }
    func advance(_ delta:TimeInterval) { value.withLock{$0.0=$0.0.addingTimeInterval(delta);$0.1 += delta} }
}

/// Software lifetime checks of the exact production poller/renewal scope. No Screen singleton, Keychain, TCC,
/// actual listener, displays, capture or injection is created here.
final class ScreenCommunitySafetyPollerTests:XCTestCase {
    private func fixture() throws -> (CommunitySafetyRound,Date) {
        let url=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-screen-safety-paging-v1.json")
        let f=try JSONSerialization.jsonObject(with:Data(contentsOf:url)) as! [String:Any],a=f["authority"] as! [String:String],b=f["roundBody"] as! [String:Any]
        let now=Date(timeIntervalSince1970:(f["now"] as! NSNumber).doubleValue/1000)
        let authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87)),profileID:a["profileId"]!)
        func envelope(_ value:Any) throws -> ScreenCommunityEnvelope { try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:value)) }
        let own=try CommunityAccessReply.verify(envelope(f["receiverAuthorization"]!),authority:authority,now:now).authorization(authority:authority,now:now)
        return (try CommunitySafetyRound.checked(envelope(f["round"]!),authority:authority,own:own,activationId:f["activationId"] as! String,requestId:b["pollRequestId"] as! String,nonce:b["pollNonce"] as! String,now:now),now)
    }
    @MainActor func testOnlyVerifiedRoundOpensWitnessAndReceiptReplayCannotExtendItsOriginalMonotonicDeadline() throws {
        let (round,now)=try fixture(),clock=SafetyTestClock(now)
        let poller=ScreenCommunitySafetyPoller(now:{clock.now},uptime:{clock.uptime},changed:{_,_ in})
        XCTAssertFalse(poller.isReady)
        try poller.accept(round,dispatchedAt:0);XCTAssertTrue(poller.isReady)
        clock.advance(20);try poller.accept(round,dispatchedAt:20)
        clock.advance(71);XCTAssertFalse(poller.isReady)
        poller.stop()
        XCTAssertFalse(poller.isReady)
    }
    @MainActor func testObservedPollFailureImmediatelyClosesTheLiveWitness() async throws {
        let (round,now)=try fixture(),clock=SafetyTestClock(now),pause=SafetyTestGate<Void>(),ready=SafetyTestGate<Void>(),closed=SafetyTestGate<Void>()
        var active=false,closures=0,polls=0
        let poller=ScreenCommunitySafetyPoller(now:{clock.now},uptime:{clock.uptime},pause:{try await pause.read()},changed:{positive,_ in
            if positive { active=true;Task { await ready.finish(.success(())) } }
            else if active { active=false;closures += 1;Task { await closed.finish(.success(())) } }
        })
        poller.start(binding:"actual-signed-round",poll:{ polls += 1;if polls==1 { return round };throw URLError(.networkConnectionLost) },apply:{_ in})
        try await ready.read();XCTAssertTrue(poller.isReady);await pause.started()
        await pause.finish(.success(()));try await closed.read()
        XCTAssertFalse(poller.isReady);XCTAssertFalse(active);XCTAssertEqual(closures,1)
        let previous=poller.stop();await pause.finish(.success(()));await previous?.value
    }
    @MainActor func testIndependentMonotonicExpiryClosesWithoutWaitingForAnotherPoll() async throws {
        let (round,now)=try fixture(),clock=SafetyTestClock(now),deadline=SafetyTestGate<Void>(),closed=SafetyTestGate<Void>()
        var active=false,closures=0
        let poller=ScreenCommunitySafetyPoller(now:{clock.now},uptime:{clock.uptime},waitForDeadline:{_ in try await deadline.read()},changed:{positive,_ in
            if positive { active=true } else if active { active=false;closures += 1;Task { await closed.finish(.success(())) } }
        })
        try poller.accept(round,dispatchedAt:0);await deadline.started()
        clock.advance(91);await deadline.finish(.success(()));try await closed.read()
        XCTAssertFalse(poller.isReady);XCTAssertEqual(closures,1);poller.stop()
    }
    @MainActor func testLateRenewalSuccessAndFailureCannotReplaceTheNewConnectionDeadlineOrCloseIt() async throws {
        for succeeds in [true,false] {
            let scope=ScreenCommunityRenewalScope(),old=scope.begin(),deferred=SafetyTestGate<Void>()
            var deadline=10,closed=0
            let task=Task {
                do { try await deferred.read();scope.perform(old) { deadline=11 } }
                catch { scope.perform(old) { closed += 1 } }
            }
            await deferred.started()
            let replacement=scope.begin();deadline=200
            await deferred.finish(succeeds ? .success(()) : .failure(URLError(.networkConnectionLost)))
            await task.value
            XCTAssertEqual(deadline,200);XCTAssertEqual(closed,0)
            XCTAssertTrue(scope.perform(replacement) { deadline=201 });XCTAssertEqual(deadline,201)
            scope.cancel();XCTAssertFalse(scope.perform(replacement) { closed += 1 });XCTAssertEqual(closed,0)
        }
    }
}
#endif
