#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

private struct SafetySoftwareSigner:TranscriptSigner {
    let key:P256.Signing.PrivateKey
    var publicKey:P256.Signing.PublicKey { key.publicKey }
    func signature(for data:Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for:data) }
}
private actor DelayedSafetySignature {
    private var continuation:CheckedContinuation<ScreenCommunityEnvelope,Never>?,began=false,start:CheckedContinuation<Void,Never>?
    func wait() async -> ScreenCommunityEnvelope { began=true;start?.resume();start=nil;return await withCheckedContinuation { continuation=$0 } }
    func started() async { if began { return };await withCheckedContinuation { start=$0 } }
    func finish(_ value:ScreenCommunityEnvelope) { continuation?.resume(returning:value);continuation=nil }
}
private actor DelayedSafetyToken {
    private var continuation:CheckedContinuation<Data?,Error>?,began=false,start:CheckedContinuation<Void,Never>?
    func wait() async throws -> Data? { began=true;start?.resume();start=nil;return try await withCheckedThrowingContinuation { continuation=$0 } }
    func started() async { if began { return };await withCheckedContinuation { start=$0 } }
    func finish(_ result:Result<Data?,Error>) { continuation?.resume(with:result);continuation=nil }
}
private enum SafetyTokenFailure:Error { case unavailable }
final class CommunityScreenSafetyChecks:XCTestCase {
    private func load(_ name:String="community-screen-safety-v1.json") throws -> [String:Any] {
        let path=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/"+name)
        return try JSONSerialization.jsonObject(with:Data(contentsOf:path)) as! [String:Any]
    }
    private func envelope(_ value:Any) throws -> ScreenCommunityEnvelope { try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:value)) }
    private func authority(_ fixture:[String:Any]) throws -> ScreenCommunityAuthority {
        let a=fixture["authority"] as! [String:String]
        return try .init(origin:URL(string:a["origin"]!)!,issuer:P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87)),profileID:a["profileId"]!)
    }
    private func key(_ fixture:[String:Any],_ name:String) throws -> SafetySoftwareSigner {
        let keys=fixture["keys"] as! [String:[String:Any]],scalar=(keys[name]!["scalar"] as! NSNumber).uint8Value
        var bytes=Data(repeating:0,count:32);bytes[31]=scalar
        return try .init(key:P256.Signing.PrivateKey(rawRepresentation:bytes))
    }
    private func round(_ f:[String:Any],body:[String:Any]?=nil,now:Date?=nil,nonce:String?=nil) throws -> CommunitySafetyRound {
        let authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000),ids=f["ids"] as! [String:String]
        let own=try CommunityAccessReply.verify(envelope(f["hostAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let body=body ?? (f["round"] as! [String:Any]),clock=now ?? at
        let wrapped:ScreenCommunityEnvelope
        if body["pollRequestId"] != nil {
            let bytes=try JSONSerialization.data(withJSONObject:[2,"safety-round",ids["poll"]!,body["issuedAt"]!,body],options:.withoutEscapingSlashes)
            wrapped = .init(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try key(f,"issuer").key.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        } else { throw ScreenCommunityError.malformed }
        return try CommunitySafetyRound.checked(wrapped,authority:authority,own:own,activationId:ids["activation"]!,requestId:ids["poll"]!,nonce:nonce ?? (body["pollNonce"] as! String),now:clock)
    }
    func testSharedSoftwareGoldenVerifiesIssuerWatcherHashMobileStopAndHostResult() throws {
        let f=try load(),authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000),ids=f["ids"] as! [String:String]
        let own=try CommunityAccessReply.verify(envelope(f["hostAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let actual=try CommunitySafetyRound.checked(envelope(f["roundEnvelope"]!),authority:authority,own:own,activationId:ids["activation"]!,requestId:ids["poll"]!,nonce:(f["round"] as! [String:Any])["pollNonce"] as! String,now:at)
        XCTAssertEqual(actual.watcherSetHash,f["watcherSetHash"] as? String)
        XCTAssertEqual(try CommunityMobileControlPolicy.authorizationDigest(own),f["receiverPolicyDigest"] as? String)
        XCTAssertEqual(actual.commands.count,1);XCTAssertEqual(actual.commands[0].command.action,.end)
        let result=try CommunitySafetyHostResult.verify(envelope(f["resultEnvelope"]!),hostKey:ScreenCommunityRequest.decodeBase64(own.body.hostPublicKey,max:87),communityId:ids["community"]!,receiverEnrollmentId:ids["host"]!,activationId:ids["activation"]!,commandId:ids["command"]!,now:at)
        XCTAssertEqual(result.outcome,.ended)
    }
    func testActualCFSQLiteAndSDKFivePendingCursorThreeWrapsWithoutAcknowledgingAnyCommand() throws {
        let f=try load("community-screen-safety-paging-v1.json"),authority=try authority(f),at=Date(timeIntervalSince1970:(f["now"] as! NSNumber).doubleValue/1000)
        let own=try CommunityAccessReply.verify(envelope(f["receiverAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let body=f["roundBody"] as! [String:Any]
        let actual=try CommunitySafetyRound.checked(envelope(f["round"]!),authority:authority,own:own,activationId:f["activationId"] as! String,requestId:body["pollRequestId"] as! String,nonce:body["pollNonce"] as! String,now:at)
        XCTAssertEqual(actual.commands.map(\.sequence),[4,5,1,2]);XCTAssertEqual(actual.nextSequence,2)
        XCTAssertEqual(Set(actual.commands.map(\.commandId)).count,4)
    }
    func testMismatchedNonceDuplicateSequenceAndChangedWatcherCannotOpenGate() throws {
        let f=try load()
        XCTAssertEqual(try round(f).commands.count,1) // Every rejection below starts from a verified positive fixture.
        XCTAssertThrowsError(try round(f,nonce:ScreenCommunityRequest.base64(Data(repeating:99,count:32))))
        var body=f["round"] as! [String:Any],commands=body["commands"] as! [[String:Any]]
        commands.append(commands[0]);body["commands"]=commands
        XCTAssertThrowsError(try round(f,body:body))
        body=f["round"] as! [String:Any];var watchers=body["watchers"] as! [[String:Any]]
        watchers[0]["subscriptionGeneration"]=UUID().uuidString.lowercased();body["watchers"]=watchers
        XCTAssertThrowsError(try round(f,body:body))
    }
    func testExpiredRAMUseAloneDoesNotDiscardAnAlreadyAdmittedNegativeCommand() throws {
        let f=try load(),at=(f["at"] as! NSNumber).int64Value+120_000
        var body=f["round"] as! [String:Any],receiver=body["receiver"] as! [String:Any],watchers=body["watchers"] as! [[String:Any]]
        receiver["issuedAt"]=at;receiver["expiresAt"]=at+90_000;watchers[0]["authorizationExpiresAt"]=at+90_000
        body["receiver"]=receiver;body["watchers"]=watchers;body["issuedAt"]=at;body["expiresAt"]=at+90_000
        let actual=try round(f,body:body,now:Date(timeIntervalSince1970:Double(at)/1000))
        XCTAssertEqual(actual.commands.count,1);XCTAssertLessThan(actual.commands[0].useSession.body.expiresAt,at)
    }
    func testOriginalSubscribeReceiptUsesDistinctNativeHostKeyAndNeverOperationKey() async throws {
        let f=try load(),authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let own=try CommunityAccessReply.verify(envelope(f["mobileAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let request=try CommunityAccessRequest(operation:.safetySubscribe,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,NSNull(),["sequence":2,"policyDigest":try CommunityMobileControlPolicy.authorizationDigest(own),"keyEpoch":own.body.keyEpoch]]),now:at)
        let original=try await request.signed(by:key(f,"mobileOperation")),recovery=try CommunitySafetySubscriptionRecovery(own:own,original:original)
        do { _ = try await recovery.signed(by:key(f,"mobileOperation"));XCTFail("Distinct operation key is not the recovery key") } catch {}
        let proof=try await recovery.signed(by:key(f,"mobileHost"))
        let bytes=try ScreenCommunityRequest.decodeBase64(proof.payload),fields=try JSONSerialization.jsonObject(with:bytes) as! [Any]
        XCTAssertEqual(fields[1] as? String,"receipt");XCTAssertEqual((fields[6] as? [String])?.first,request.id)
        let signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(proof.signature,max:86))
        XCTAssertTrue(try key(f,"mobileHost").publicKey.isValidSignature(signature,for:Data("agentstoz.community-access.request/v2\0".utf8)+bytes))
    }
    func testAutomaticHostIPCStillRejectsEveryNewSafetyOperation() throws {
        let f=try load(),ids=f["ids"] as! [String:String],at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        for op in [CommunityAccessRequest.Operation.safetySubscribe,.safetyPoll,.safetyStop,.safetyResult,.safetyEvent,.safetyState] {
            let request=try CommunityAccessRequest(operation:op,actor:ids["host"],argumentsJSON:JSONSerialization.data(withJSONObject:[ids["community"]!]),now:at)
            XCTAssertThrowsError(try CommunityAccessRequest.validateHostProof(Data("agentstoz.community-access.request/v2\0".utf8)+request.bytes,profileId:ids["profile"]!,deviceId:ids["hostDevice"]!,hostKey:key(f,"host").publicKey.x963Representation,biometricKey:key(f,"hostBio").publicKey.x963Representation,certificate:nil,now:at))
        }
    }
    @MainActor func testOSDenialSupersedesDelayedPositiveSignatureAndOldResponseCannotClearTheNewRemoval() async throws {
        let f=try load(),authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let own=try CommunityAccessReply.verify(envelope(f["mobileAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        func request(_ sequence:Int64,_ subscription:Any) throws -> CommunityAccessRequest {
            try .init(operation:.safetySubscribe,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,subscription,["sequence":sequence,"policyDigest":try CommunityMobileControlPolicy.authorizationDigest(own),"keyEpoch":own.body.keyEpoch]]),now:at)
        }
        let first=try request(1,["token":String(repeating:"ab",count:32),"environment":"sandbox","topic":"software.fixture"]),removed=try request(2,NSNull())
        let delayed=DelayedSafetySignature(),positive=try await first.signed(by:key(f,"mobileOperation"))
        var journal=CommunitySafetySubscriptionJournal(),dispatched:[String]=[]
        try journal.reserve(requestId:first.id,binding:String(repeating:"a",count:64),expectedPrevious:0)
        // Actual persisted native metadata, including an unsigned reserve, survives process restoration.
        journal=try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:JSONEncoder().encode(journal))
        let task=Task {
            let signed=await delayed.wait()
            if journal.mayDispatch(first.id) {
                do { try journal.recordSigned(signed,requestId:first.id);dispatched.append(first.id) } catch {}
            }
        }
        await delayed.started()
        try journal.reserve(requestId:removed.id,binding:String(repeating:"b",count:64),expectedPrevious:1,isRemoval:true)
        let negative=try await removed.signed(by:key(f,"mobileOperation"));try journal.recordSigned(negative,requestId:removed.id)
        await delayed.finish(positive);await task.value
        XCTAssertTrue(dispatched.isEmpty);XCTAssertEqual(journal.sequence,2)
        journal.committed(through:1) // A late earlier HTTP result cannot remove the newer pending negative mutation.
        XCTAssertEqual(journal.pending.map(\.requestId),[removed.id]);XCTAssertEqual(journal.desiredBinding,String(repeating:"b",count:64))
        journal.committed(through:2)
        let next=try request(3,["token":String(repeating:"cd",count:32),"environment":"sandbox","topic":"software.fixture"])
        try journal.reserve(requestId:next.id,binding:String(repeating:"c",count:64),expectedPrevious:2)
        journal.committed(through:2)
        XCTAssertEqual(journal.pending.map(\.requestId),[next.id]);XCTAssertEqual(journal.sequence,3)
    }
    func testUnsignedCrashRecoveryNeverResetsTheProtectedCounterAndExhaustionFailsClosed() throws {
        var journal=CommunitySafetySubscriptionJournal();let first=UUID().uuidString.lowercased()
        try journal.reserve(requestId:first,binding:String(repeating:"a",count:64),expectedPrevious:0)
        journal=try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:JSONEncoder().encode(journal))
        journal.abandonUnsigned(first)
        XCTAssertEqual(journal.sequence,1);XCTAssertNil(journal.desiredBinding);XCTAssertTrue(journal.pending.isEmpty)
        try journal.reserve(requestId:UUID().uuidString.lowercased(),binding:String(repeating:"b",count:64),expectedPrevious:1)
        XCTAssertEqual(journal.sequence,2)
        let invalid=try JSONSerialization.data(withJSONObject:["version":1,"sequence":9_007_199_254_740_991,"pending":[]])
        XCTAssertThrowsError(try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:invalid))
    }
    func testExplicitNewNegativeAfterLostRemovalKeepsOriginalEvidenceAndCannotReviveDelayedObservations() async throws {
        let f=try load(),authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let own=try CommunityAccessReply.verify(envelope(f["mobileAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        func request(_ sequence:Int64,_ enabled:Bool,_ date:Date) throws -> CommunityAccessRequest {
            try .init(operation:.safetySubscribe,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,enabled ? ["token":String(repeating:"ab",count:32),"environment":"sandbox","topic":"software.fixture"] as Any : NSNull(),["sequence":sequence,"policyDigest":try CommunityMobileControlPolicy.authorizationDigest(own),"keyEpoch":own.body.keyEpoch]]),now:date)
        }
        var journal=CommunitySafetySubscriptionJournal()
        let s1=try request(1,true,at),r2=try request(2,false,at),r3=try request(3,false,at.addingTimeInterval(61))
        let positive=try await s1.signed(by:key(f,"mobileOperation")),lost=try await r2.signed(by:key(f,"mobileOperation")),explicit=try await r3.signed(by:key(f,"mobileOperation"))
        for (i,request,envelope,binding) in [(Int64(1),s1,positive,"a"),(2,r2,lost,"b"),(3,r3,explicit,"b")] {
            try journal.reserve(requestId:request.id,binding:String(repeating:binding,count:64),expectedPrevious:i-1,isRemoval:i != 1)
            try journal.recordSigned(envelope,requestId:request.id)
        }
        // R2 was never observed by the issuer. The person's new denied-state reflection is R3, not an old-ID replay.
        journal.committed(through:3)
        XCTAssertEqual(journal.sequence,3);XCTAssertEqual(journal.confirmedSequence,3)
        XCTAssertTrue(journal.pending.isEmpty);XCTAssertEqual(Set(journal.superseded.map(\.requestId)),[s1.id,r2.id]);XCTAssertEqual(journal.superseded.first{$0.requestId==s1.id}?.envelope?.payload,positive.payload);XCTAssertEqual(journal.superseded.first{$0.requestId==r2.id}?.envelope?.payload,lost.payload)
        XCTAssertEqual(journal.recoveryCandidates.map(\.requestId),[r2.id,s1.id])
        XCTAssertFalse(journal.mayDispatch(s1.id));XCTAssertFalse(journal.mayDispatch(r2.id))
        journal.committed(through:1);journal.committed(through:2)
        XCTAssertEqual(journal.desiredBinding,String(repeating:"b",count:64));XCTAssertEqual(journal.confirmedSequence,3)
    }
    func testFreshWatcherGenerationCannotAuthorizeAnOlderQueuedCommandEvenWithAValidNewSetHash() throws {
        let f=try load(),ids=f["ids"] as! [String:String]
        var body=f["round"] as! [String:Any],raw=body["watchers"] as! [[String:Any]]
        raw[0]["subscriptionGeneration"]=UUID().uuidString.lowercased();body["watchers"]=raw
        let watchers=try JSONDecoder().decode([CommunitySafetyWatcher].self,from:JSONSerialization.data(withJSONObject:raw))
        body["watcherSetHash"]=try CommunitySafetyRound.watcherHash(communityId:ids["community"]!,receiverEnrollmentId:ids["host"]!,activationId:ids["activation"]!,receiverPolicyDigest:f["receiverPolicyDigest"] as! String,watchers:watchers)
        XCTAssertThrowsError(try round(f,body:body)) // Hash and issuer signature are valid; the old command's sub-generation is not.
    }
    func testOffAcknowledgementAllowsZeroWatchersButStillRequiresOriginalNonceAndReceiverSubject() throws {
        let f=try load(),authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000),ids=f["ids"] as! [String:String]
        let own=try CommunityAccessReply.verify(envelope(f["hostAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let request=try CommunityAccessRequest(operation:.safetyPoll,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[ids["community"]!,ids["activation"]!,0,[],["power":"off","held":false,"session":NSNull(),"observationSequence":2]]),now:at,id:UUID(uuidString:ids["poll"]!)!)
        let fields=try JSONSerialization.jsonObject(with:request.bytes) as! [Any]
        var body=f["round"] as! [String:Any]
        body["watchers"]=[];body["commands"]=[];body["nextSequence"]=0;body["pollNonce"]=fields[4]
        body["watcherSetHash"]=try CommunitySafetyRound.watcherHash(communityId:ids["community"]!,receiverEnrollmentId:ids["host"]!,activationId:ids["activation"]!,receiverPolicyDigest:f["receiverPolicyDigest"] as! String,watchers:[])
        func sign(_ object:[String:Any]) throws -> ScreenCommunityEnvelope {
            let bytes=try JSONSerialization.data(withJSONObject:[2,"safety-round",request.id,body["issuedAt"]!,object],options:.withoutEscapingSlashes)
            return .init(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try key(f,"issuer").key.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        }
        let valid=try sign(body)
        XCTAssertNoThrow(try CommunitySafetyRound.verifyAcknowledgement(valid,authority:authority,own:own,activationId:ids["activation"]!,request:request,now:at))
        XCTAssertThrowsError(try CommunitySafetyRound.verify(valid,authority:authority,own:own,activationId:ids["activation"]!,request:request,now:at))
        body["pollNonce"]=ScreenCommunityRequest.base64(Data(repeating:99,count:32))
        XCTAssertThrowsError(try CommunitySafetyRound.verifyAcknowledgement(sign(body),authority:authority,own:own,activationId:ids["activation"]!,request:request,now:at))
    }
    @MainActor func testOSDenialAfterDelayedTokenSuccessDiscardsTheStaleToken() async throws {
        let token=DelayedSafetyToken();var denied=false
        let task=Task { try await CommunitySafetyNotificationObservation.read(token:{try await token.wait()},denied:{denied}) }
        await token.started();denied=true;await token.finish(.success(Data(repeating:71,count:32)))
        let observation=try await task.value
        XCTAssertTrue(observation.permissionDenied);XCTAssertNil(observation.token)
    }
    @MainActor func testOSDenialAfterDelayedTokenFailureWinsButWithoutDenialTheOriginalErrorSurvives() async throws {
        let token=DelayedSafetyToken();var denied=false
        let task=Task { try await CommunitySafetyNotificationObservation.read(token:{try await token.wait()},denied:{denied}) }
        await token.started();denied=true;await token.finish(.failure(SafetyTokenFailure.unavailable))
        let observation=try await task.value
        XCTAssertTrue(observation.permissionDenied);XCTAssertNil(observation.token)
        do {
            _ = try await CommunitySafetyNotificationObservation.read(token:{throw SafetyTokenFailure.unavailable},denied:{false})
            XCTFail("A token error without a later observed OS denial must remain an error")
        } catch SafetyTokenFailure.unavailable {} catch { XCTFail("Original token error was replaced: \(error)") }
    }
    private func subscriptionObservation(_ f:[String:Any],sequence:Int64,enabled:Bool,tokenCharacters:Int=64) async throws -> (CommunityAccessRequest,ScreenCommunityEnvelope) {
        let authority=try authority(f),at=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        let own=try CommunityAccessReply.verify(envelope(f["mobileAuthorization"]!),authority:authority,now:at).authorization(authority:authority,now:at)
        let request=try CommunityAccessRequest(operation:.safetySubscribe,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,enabled ? ["token":String(repeating:"a",count:tokenCharacters),"environment":"sandbox","topic":"software.fixture"] as Any : NSNull(),["sequence":sequence,"policyDigest":try CommunityMobileControlPolicy.authorizationDigest(own),"keyEpoch":own.body.keyEpoch]]),now:at)
        return (request,try await request.signed(by:key(f,"mobileOperation")))
    }
    func testSixteenUnknownPositivesCannotBlockExplicitDenialAndLateOriginalsCannotReviveThem() async throws {
        let f=try load();var journal=CommunitySafetySubscriptionJournal(),originals:[String:ScreenCommunityEnvelope]=[:]
        for i in Int64(1)...16 {
            let (request,envelope)=try await subscriptionObservation(f,sequence:i,enabled:true)
            try journal.reserve(requestId:request.id,binding:String(repeating:"a",count:64),expectedPrevious:i-1)
            try journal.recordSigned(envelope,requestId:request.id);originals[request.id]=envelope
        }
        XCTAssertThrowsError(try journal.reserve(requestId:UUID().uuidString.lowercased(),binding:String(repeating:"a",count:64),expectedPrevious:16))
        let (removal,envelope)=try await subscriptionObservation(f,sequence:17,enabled:false)
        try journal.reserve(requestId:removal.id,binding:String(repeating:"b",count:64),expectedPrevious:16,isRemoval:true)
        try journal.recordSigned(envelope,requestId:removal.id)
        XCTAssertEqual(journal.pending.count,17) // Negative lane does not consume positive admission capacity.
        journal.committed(through:17) // Actual caller invokes this only after verifying the issuer's exact null-subscription receipt.
        XCTAssertTrue(journal.pending.isEmpty);XCTAssertEqual(journal.superseded.count,16)
        for record in journal.superseded { XCTAssertEqual(record.envelope?.payload,originals[record.requestId]?.payload);XCTAssertEqual(record.envelope?.signature,originals[record.requestId]?.signature);XCTAssertFalse(journal.mayDispatch(record.requestId)) }
        let (newer,newerEnvelope)=try await subscriptionObservation(f,sequence:18,enabled:true)
        try journal.reserve(requestId:newer.id,binding:String(repeating:"c",count:64),expectedPrevious:17)
        try journal.recordSigned(newerEnvelope,requestId:newer.id)
        journal.committed(through:1) // A late original receipt settles only itself, never the newer observation.
        XCTAssertEqual(journal.pending.map(\.requestId),[newer.id]);XCTAssertEqual(journal.confirmedSequence,17);XCTAssertEqual(journal.sequence,18)
        XCTAssertEqual(journal.desiredBinding,String(repeating:"c",count:64))
    }
    func testLegacySixteenObservationDecodePreservesExactOriginalsAndMonotonicSequence() async throws {
        let f=try load();var records:[[String:Any]]=[],originals:[String:ScreenCommunityEnvelope]=[:]
        for i in Int64(1)...16 {
            let (request,envelope)=try await subscriptionObservation(f,sequence:i,enabled:i != 2 && i != 16)
            records.append(["requestId":request.id,"sequence":i,"binding":String(repeating:"a",count:64),"envelope":["payload":envelope.payload,"signature":envelope.signature]])
            originals[request.id]=envelope
        }
        let legacy=try JSONSerialization.data(withJSONObject:["version":1,"sequence":16,"desiredBinding":String(repeating:"a",count:64),"pending":records])
        var journal=try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:legacy)
        XCTAssertEqual(journal.version,2);XCTAssertEqual(journal.sequence,16);XCTAssertEqual(journal.pending.filter(\.isRemoval).count,1);XCTAssertEqual(journal.superseded.count,1)
        for record in journal.pending+journal.superseded { XCTAssertEqual(record.envelope?.payload,originals[record.requestId]?.payload);XCTAssertEqual(record.envelope?.signature,originals[record.requestId]?.signature) }
        let (request,envelope)=try await subscriptionObservation(f,sequence:17,enabled:false)
        try journal.reserve(requestId:request.id,binding:String(repeating:"b",count:64),expectedPrevious:16,isRemoval:true)
        try journal.recordSigned(envelope,requestId:request.id)
        journal=try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:JSONEncoder().encode(journal))
        XCTAssertEqual(journal.sequence,17);XCTAssertEqual(journal.superseded.count,2)
        XCTAssertEqual((journal.pending+journal.superseded).count,17)
    }
    func testBoundedOriginalEvidenceReservesTheLastSlotForNegativeAndRefusesFullStorageWithoutLoss() async throws {
        let f=try load();var journal=CommunitySafetySubscriptionJournal()
        for i in Int64(1)...127 {
            let (request,envelope)=try await subscriptionObservation(f,sequence:i,enabled:false)
            try journal.reserve(requestId:request.id,binding:String(repeating:"b",count:64),expectedPrevious:i-1,isRemoval:true)
            try journal.recordSigned(envelope,requestId:request.id)
        }
        XCTAssertThrowsError(try journal.reserve(requestId:UUID().uuidString.lowercased(),binding:String(repeating:"a",count:64),expectedPrevious:127)) { error in
            guard case ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL")=error else { return XCTFail("Expected explicit evidence-full refusal") }
        }
        let (last,lastEnvelope)=try await subscriptionObservation(f,sequence:128,enabled:false)
        try journal.reserve(requestId:last.id,binding:String(repeating:"b",count:64),expectedPrevious:127,isRemoval:true)
        try journal.recordSigned(lastEnvelope,requestId:last.id)
        let before=try JSONEncoder().encode(journal)
        XCTAssertLessThan(before.count,256_000);XCTAssertEqual(journal.superseded.count,127);XCTAssertEqual(journal.pending.count,1)
        XCTAssertThrowsError(try journal.reserve(requestId:UUID().uuidString.lowercased(),binding:String(repeating:"b",count:64),expectedPrevious:128,isRemoval:true)) { error in
            guard case ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL")=error else { return XCTFail("Unknown removal must not be advertised as applied") }
        }
        XCTAssertEqual(journal.sequence,128);XCTAssertEqual(journal.pending.first?.envelope?.payload,lastEnvelope.payload)
        let after=try JSONEncoder().encode(journal)
        let restored=try JSONDecoder().decode(CommunitySafetySubscriptionJournal.self,from:after)
        XCTAssertEqual(restored.sequence,128);XCTAssertEqual(restored.pending.count+restored.superseded.count,128)
        XCTAssertEqual(Set((restored.pending+restored.superseded).map{$0.envelope!.payload}),Set((journal.pending+journal.superseded).map{$0.envelope!.payload}))
    }
    func testReservedNegativeLaneCannotSignAPositive() async throws {
        let f=try load();var journal=CommunitySafetySubscriptionJournal()
        let (request,envelope)=try await subscriptionObservation(f,sequence:1,enabled:true)
        try journal.reserve(requestId:request.id,binding:String(repeating:"a",count:64),expectedPrevious:0,isRemoval:true)
        XCTAssertThrowsError(try journal.recordSigned(envelope,requestId:request.id));XCTAssertNil(journal.pending[0].envelope)
        journal.abandonUnsigned(request.id);XCTAssertEqual(journal.sequence,1)
    }

    func testPositiveEvidenceByteBudgetRetainsRoomForANegativeWithoutChangingOriginals() async throws {
        let f=try load();var journal=CommunitySafetySubscriptionJournal(),full=false
        for _ in 1...16 {
            let (request,envelope)=try await subscriptionObservation(f,sequence:journal.sequence+1,enabled:true,tokenCharacters:18_000)
            do {
                try journal.reserve(requestId:request.id,binding:String(repeating:"a",count:64),expectedPrevious:journal.sequence)
                try journal.recordSigned(envelope,requestId:request.id)
            } catch ScreenCommunityError.service("SUBSCRIPTION_EVIDENCE_FULL") { full=true;break }
        }
        XCTAssertTrue(full)
        let originals=journal.pending.compactMap(\.envelope).map(\.payload)
        let (removal,envelope)=try await subscriptionObservation(f,sequence:journal.sequence+1,enabled:false)
        try journal.reserve(requestId:removal.id,binding:String(repeating:"b",count:64),expectedPrevious:journal.sequence,isRemoval:true)
        try journal.recordSigned(envelope,requestId:removal.id)
        XCTAssertEqual(journal.pending.filter{!$0.isRemoval}.compactMap(\.envelope).map(\.payload),originals)
        XCTAssertEqual(journal.pending.last?.envelope?.payload,envelope.payload)
        XCTAssertLessThan(try JSONEncoder().encode(journal).count,256_000)
    }

}
#endif
