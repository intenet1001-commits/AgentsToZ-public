#if os(macOS) && !CORE_CHECKS
import CryptoKit
import Foundation
import XCTest
@testable import ScreenControlCore
@testable import ScreenHost

private struct UnifiedPushFixture: Sendable {
    let issuer = P256.Signing.PrivateKey(), host = HostTestSigner(), client = HostTestSigner(), ram = HostTestSigner()
    let now = Date(), profile = UUID().uuidString.lowercased(), community = UUID().uuidString.lowercased()
    var authority: ScreenCommunityAuthority { try! .init(origin:URL(string:"https://fixture.workers.dev")!,issuer:issuer.publicKey,profileID:profile) }
    func reply(_ kind: String,_ body: [String:Any]) throws -> CommunityAccessReply {
        let at = Int64(now.timeIntervalSince1970 * 1000), bytes = try JSONSerialization.data(withJSONObject:[2,kind,UUID().uuidString.lowercased(),at,body])
        let envelope = ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try issuer.signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        return try .verify(envelope,authority:authority,now:now)
    }
    func authorization(kind: CommunityDeviceKind, name: String, receiving: Bool = false) throws -> CommunityAuthorization {
        let at = Int64(now.timeIntervalSince1970 * 1000), operation = receiving ? HostTestSigner():client
        let hostKey = receiving ? host.publicKey:HostTestSigner().publicKey
        let caps: [CommunityCapability] = receiving ? [.receiveView,.receiveControl]:[.screenView,.screenControl]
        return try reply("authorization",["version":1,"communityId":community,"profileId":profile,"enrollmentId":UUID().uuidString.lowercased(),"deviceId":UUID().uuidString.lowercased(),"deviceKind":kind.rawValue,"name":name,
            "hostPublicKey":ScreenCommunityRequest.base64(hostKey.x963Representation),"publicKey":ScreenCommunityRequest.base64(operation.publicKey.x963Representation),"biometricPublicKey":ScreenCommunityRequest.base64(HostTestSigner().publicKey.x963Representation),"controlKey":NSNull(),"agentDeviceId":NSNull(),"capabilities":caps.map(\.rawValue),"revision":1,"keyEpoch":1,"issuedAt":at,"expiresAt":at+90_000]).authorization(authority:authority,now:now)
    }
    func admission(kind: CommunityDeviceKind, name: String = "이름이 같은 실제 기기") async throws -> CommunityScreenAdmission {
        let receiver = try authorization(kind:.desktop,name:"받는 Mac",receiving:true), sender = try authorization(kind:kind,name:name)
        let use: CommunityUseSession?
        if kind == .mobile {
            let at = Int64(now.timeIntervalSince1970 * 1000)
            use = try reply("session",["version":1,"communityId":community,"enrollmentId":sender.body.enrollmentId,"sessionId":UUID().uuidString.lowercased(),"publicKey":ScreenCommunityRequest.base64(ram.publicKey.x963Representation),"capabilities":["screen.view","screen.control"],"revision":1,"sequence":0,"lastHumanAt":at,"idleExpiresAt":at+3_600_000,"issuedAt":at,"expiresAt":at+90_000]).session(for:sender,now:now)
        } else { use = nil }
        let binding = try CommunityScreenBinding(channelId:UUID().uuidString.lowercased(),clientConnectionId:UUID().uuidString.lowercased(),hostConnectionId:UUID().uuidString.lowercased())
        let signer = kind == .mobile ? ram:client
        let caller = try CommunityScreenClientHandshake(authority:authority,own:sender,session:use,target:receiver,signer:signer,channelId:binding.channelId,connectionId:binding.clientConnectionId,requestedControl:true,now:now)
        let receiverHandshake = try CommunityScreenHostHandshake(authority:authority,own:receiver,signer:host,replay:.init()) { actual,session in
            guard actual.body == sender.body, session?.body.sessionId == use?.body.sessionId else { throw HandshakeError.unknownDevice }
        }
        let answer = try await receiverHandshake.respond(caller.hello,binding:binding,now:now)
        let finished = try await caller.finish(answer.message,peerConnectionId:binding.hostConnectionId,now:now)
        _ = try await answer.pending.confirm(finished.message,now:now)
        return finished.admission
    }
    func phone(_ signer: HostTestSigner = .init(), at date: Date? = nil) throws -> RegisteredDevice {
        let record = try RegistrationRecord(macFingerprint:host.fingerprint,codeID:Data(repeating:9,count:RegistrationCode.idSize),devicePublicKey:signer.publicKey,deviceName:"주인 iPad",deviceModel:"iPad16,1")
        return .init(record:record,attestationKeyID:Data(repeating:1,count:32),at:date ?? now)
    }
}
private final class UnifiedPushRecorder: PushTransport, @unchecked Sendable {
    private let lock = NSLock(); private var bodies: [Data] = []
    var all: [Data] { lock.withLock { bodies } }
    func post(_ body: Data,to url: URL) async throws -> (status: Int,body: Data) { lock.withLock { bodies.append(body) }; return (200,Data("{}".utf8)) }
}
/// The existing normal profile's ControllerSessionTests filter also includes this class.
final class UnifiedControllerSessionTests: XCTestCase {
    @MainActor func testVerifiedDesktopAndMobileSessionsProjectTheirActualKeysIntoUnchangedH10Events() async throws {
        for kind in [CommunityDeviceKind.desktop,.mobile] {
            let f = UnifiedPushFixture(), admission = try await f.admission(kind:kind), phone = try f.phone()
            let notice = try XCTUnwrap(ScreenCommunityConnectionNotification(admission:admission,receivingKey:f.host.publicKey,at:f.now))
            let event = try XCTUnwrap(notice.event(macKey:f.host.publicKey,macName:"받는 Mac",devices:[phone,phone],at:f.now))
            XCTAssertEqual(event.kind,kind == .mobile ? .connected:.controllerConnected)
            XCTAssertEqual(event.actorID,kind == .mobile ? f.ram.fingerprint:f.client.fingerprint)
            XCTAssertEqual(event.actorName,admission.controller.body.name)
            XCTAssertEqual(event.recipients,[try XCTUnwrap(Data(hexPush:phone.id))])
            let signed = try await event.signed(by:f.host), pinned = try PinnedMac(publicKey:f.host.publicKey,fingerprint:f.host.fingerprint)
            XCTAssertEqual(ScreenEvent.open(signed,mac:pinned),event)
            XCTAssertEqual(try ScreenEvent.decode(signed.message),event,"same H10 wire and signature, no new server protocol")
        }
    }
    @MainActor func testDifferentHostExpiredAdmissionAndMissingOwnerPhonesCannotEmit() async throws {
        let f = UnifiedPushFixture(), admission = try await f.admission(kind:.desktop)
        XCTAssertNil(ScreenCommunityConnectionNotification(admission:admission,receivingKey:HostTestSigner().publicKey,at:f.now))
        XCTAssertNil(ScreenCommunityConnectionNotification(admission:admission,receivingKey:f.host.publicKey,at:f.now.addingTimeInterval(90)))
        let notice = try XCTUnwrap(ScreenCommunityConnectionNotification(admission:admission,receivingKey:f.host.publicKey,at:f.now))
        XCTAssertNil(notice.event(macKey:HostTestSigner().publicKey,macName:"Mac",devices:[try f.phone()],at:f.now))
        XCTAssertNil(notice.event(macKey:f.host.publicKey,macName:"Mac",devices:[],at:f.now))
        XCTAssertNil(notice.event(macKey:f.host.publicKey,macName:"Mac",devices:[try f.phone(at:f.now.addingTimeInterval(-RegistrationLifetime.unused-1))],at:f.now))
    }
    @MainActor func testLongCommunityNamesFitLegacyFieldsWithoutChangingTheAuthenticatedActor() async throws {
        let f = UnifiedPushFixture(), admission = try await f.admission(kind:.desktop,name:String(repeating:"가",count:40))
        let notice = try XCTUnwrap(ScreenCommunityConnectionNotification(admission:admission,receivingKey:f.host.publicKey,at:f.now))
        let event = try XCTUnwrap(notice.event(macKey:f.host.publicKey,macName:String(repeating:"Mac",count:30),devices:[try f.phone()],at:f.now))
        XCTAssertEqual(event.actorID,f.client.fingerprint); XCTAssertLessThanOrEqual(event.actorName.utf8.count,64)
        XCTAssertLessThanOrEqual(event.actorName.count,32); XCTAssertTrue(event.actorName.hasSuffix("…"))
        XCTAssertTrue(RegistrationInvite.isShowableName(event.macName)); XCTAssertEqual(try ScreenEvent.decode(event.encoded()),event)
    }
    @MainActor func testOneSignedNotificationIsSentWithoutCreatingLegacyRegistrationOrRetryingDelivery() async throws {
        let f = UnifiedPushFixture(), admission = try await f.admission(kind:.mobile), owner = try f.phone(), transport = UnifiedPushRecorder()
        let phones = [owner], original = phones
        let push = ScreenPush(client:ScreenPushClient(endpoint:PushEndpoint("https://fixture.invalid/screen-push"),transport:transport))
        push.adopt(identity:f.host); push.notify(admission,among:phones,at:f.now); push.notify(admission,among:phones,at:f.now)
        for _ in 0..<100 { if !transport.all.isEmpty { break }; try await Task.sleep(for:.milliseconds(5)) }
        XCTAssertEqual(transport.all.count,1); XCTAssertEqual(phones,original)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with:try XCTUnwrap(transport.all.first)) as? [String:String])
        XCTAssertEqual(body["type"],"notify")
        let bytes = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(body["message"]))), signature = try XCTUnwrap(Data(base64Encoded:try XCTUnwrap(body["signature"])))
        XCTAssertTrue(SignedPushMessage(message:bytes,signature:signature).isValid(for:f.host.publicKey))
        let event = try ScreenEvent.decode(bytes); XCTAssertEqual(event.actorID,f.ram.fingerprint); XCTAssertEqual(event.recipients,[owner.publicKey].compactMap { try? P256.Signing.PublicKey(x963Representation:$0) }.map(ScreenControlIdentity.fingerprint(of:)))
    }
}
private extension Data {
    init?(hexPush text: String) {
        guard text.count == 64 else { return nil }; var bytes = [UInt8](); var index = text.startIndex
        while index < text.endIndex { let next = text.index(index,offsetBy:2); guard let byte = UInt8(text[index..<next],radix:16) else { return nil }; bytes.append(byte); index = next }; self.init(bytes)
    }
}
#endif
