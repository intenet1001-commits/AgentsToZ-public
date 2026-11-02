#if DEBUG && !CORE_CHECKS
import CryptoKit
import Foundation
import XCTest
@testable import ScreenControlCore

/// Actual URLSession/HTTP/WebSocket -> local workerd/SQLite relay -> actual TS receiving Host.
/// The issuer/RAM/Native keys and count consumer are public software fixtures, never production identities.
private final class MobileControlSocketFixture: @unchecked Sendable {
    struct Endpoints: Decodable { let fixtureReady: Bool; let origin,relay,metadata,ticket,state: String }
    struct Authority: Decodable { let origin,issuerPublicKey,profileId: String }
    struct Metadata: Decodable {
        let fixtureOnly: Bool, authority: Authority
        let receiverAuthorization,mobileAuthorization,mobileUseSession: ScreenCommunityEnvelope
        let receiverDeviceId,mobileDeviceId: String
        let mobileUseScalar,hostControlScalar: Int
    }
    private let process: Process, directory: URL
    let endpoints: Endpoints
    let session: URLSession
    private let gate = NSLock()
    private var allowed = true
    private init(process: Process,directory: URL,endpoints: Endpoints) {
        self.process = process; self.directory = directory; self.endpoints = endpoints
        let configuration = URLSessionConfiguration.ephemeral; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        session = URLSession(configuration:configuration)
    }
    static func start() async throws -> MobileControlSocketFixture {
        let root = URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = ProcessInfo.processInfo.environment["AGENTSTOZ_MOBILE_HOST_FIXTURE"] ?? root.appendingPathComponent("cloud/screen-community/tests/mobile-main-fixture.mjs").path
        guard FileManager.default.fileExists(atPath:script) else { throw XCTSkip("TS receiving-host fixture is not in this source snapshot; an explicit isolated fixture source may be supplied") }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("agentstoz-mobile-socket-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:temporary,withIntermediateDirectories:true)
        let output = temporary.appendingPathComponent("fixture.log"); FileManager.default.createFile(atPath:output.path,contents:Data())
        let log = try FileHandle(forWritingTo:output), process = Process()
        process.executableURL = URL(fileURLWithPath:"/usr/bin/env"); process.arguments = ["bun",script,"--serve"]
        process.currentDirectoryURL = URL(fileURLWithPath:script).deletingLastPathComponent()
        process.environment = ["PATH":ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin","HOME":temporary.path,"TMPDIR":temporary.path]
        process.standardOutput = log; process.standardError = log
        do {
            try process.run(); let deadline = ContinuousClock.now.advanced(by:.seconds(30))
            while ContinuousClock.now < deadline {
                let bytes = try Data(contentsOf:output)
                if let text = String(data:bytes,encoding:.utf8) {
                    for line in text.split(separator:"\n") {
                        if let endpoints = try? JSONDecoder().decode(Endpoints.self,from:Data(line.utf8)), endpoints.fixtureReady {
                            guard let origin = URL(string:endpoints.origin), origin.scheme == "http", origin.host == "127.0.0.1", let port = origin.port, ![3001,52741,4723].contains(port),
                                  endpoints.relay == endpoints.origin.replacingOccurrences(of:"http:",with:"ws:")+"/relay",
                                  endpoints.metadata == endpoints.origin+"/fixture/metadata", endpoints.ticket == endpoints.origin+"/fixture/ticket", endpoints.state == endpoints.origin+"/fixture/state" else { throw ScreenCommunityError.malformed }
                            try log.close(); return .init(process:process,directory:temporary,endpoints:endpoints)
                        }
                    }
                }
                guard process.isRunning else { throw ScreenCommunityError.service("SOFTWARE_FIXTURE_FAILED") }
                try await Task.sleep(for:.milliseconds(50))
            }
            throw TransportError.timedOut
        } catch { if process.isRunning { process.terminate() }; try? log.close(); throw error }
    }
    func check() throws { try gate.withLock { guard allowed else { throw ScreenCommunityError.service("SESSION_EXPIRED") } } }
    func block() { gate.withLock { allowed = false } }
    func fetch(_ url: String,body: Data? = nil) async throws -> Data {
        guard url.hasPrefix(endpoints.origin+"/fixture/") else { throw ScreenCommunityError.malformed }
        var request = URLRequest(url:URL(string:url)!); request.timeoutInterval = 10
        if let body { request.httpMethod = "POST"; request.httpBody = body; request.setValue("application/json",forHTTPHeaderField:"Content-Type") }
        let (bytes,response) = try await session.data(for:request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, bytes.count <= 40_000 else { throw ScreenCommunityError.malformed }; return bytes
    }
    func context(_ purpose: CommunityMobileControlPurpose) async throws -> CommunityMobileControlContext {
        try check(); let metadata = try JSONDecoder().decode(Metadata.self,from:await fetch(endpoints.metadata))
        guard metadata.fixtureOnly, metadata.mobileUseScalar == 3, metadata.hostControlScalar == 4 else { throw ScreenCommunityError.malformed }
        let pin = metadata.authority
        let authority = try ScreenCommunityAuthority(origin:URL(string:pin.origin)!,issuer:CommunityMobileControlBytes.key(pin.issuerPublicKey),profileID:pin.profileId)
        let mobile = try CommunityAccessReply.verify(metadata.mobileAuthorization,authority:authority).authorization(authority:authority)
        let receiver = try CommunityAccessReply.verify(metadata.receiverAuthorization,authority:authority).authorization(authority:authority)
        let use = try CommunityAccessReply.verify(metadata.mobileUseSession,authority:authority).session(for:mobile)
        guard metadata.mobileDeviceId == mobile.body.deviceId, metadata.receiverDeviceId == receiver.body.deviceId else { throw ScreenCommunityError.wrongCommunity }
        return try .init(authority:authority,mobile:mobile,session:use,receiver:receiver,purpose:purpose)
    }
    func ticket(_ purpose: CommunityMobileControlPurpose,connection: String) async throws -> CommunityRelayTicket {
        let current = try await context(purpose)
        let body = try CommunityMobileControlBytes.json(["connectionId":connection,"deviceId":current.mobile.body.deviceId,"purpose":purpose.rawValue])
        struct Reply: Decodable { let fixtureOnly: Bool; let ticket: ScreenCommunityEnvelope }
        let reply = try JSONDecoder().decode(Reply.self,from:await fetch(endpoints.ticket,body:body))
        guard reply.fixtureOnly, let alias = CommunityRelayPurpose(rawValue:purpose.rawValue) else { throw ScreenCommunityError.malformed }
        return try CommunityAccessReply.verify(reply.ticket,authority:current.authority).relayTicket(for:current.mobile,session:current.session,connectionId:connection,purpose:alias,role:.client)
    }
    func ramSigner(_ context: CommunityMobileControlContext) throws -> CommunityPurposeSigner {
        var scalar = Data(repeating:0,count:32); scalar[31] = 3
        let software = MobileSocketSoftwareSigner(key:try P256.Signing.PrivateKey(rawRepresentation:scalar))
        return try CommunityPurposeSigner(inner:software,authorization:context.mobile,session:context.session,capability:context.purpose.capability)
    }
    func stop() async {
        block(); session.invalidateAndCancel(); if process.isRunning { process.terminate() }
        let deadline = ContinuousClock.now.advanced(by:.seconds(5))
        while process.isRunning && ContinuousClock.now < deadline { try? await Task.sleep(for:.milliseconds(25)) }
        if !process.isRunning { try? FileManager.default.removeItem(at:directory) }
    }
}
private struct MobileSocketSoftwareSigner: TranscriptSigner {
    let key: P256.Signing.PrivateKey
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for:data) }
}
final class CommunityMobileControlSocketTests: XCTestCase {
    func testActualSwiftCarrierAndReceivingHostAcrossFourPurposes() async throws {
        let fixture = try await MobileControlSocketFixture.start()
        do {
            var effects = 0
            for purpose in CommunityMobileControlPurpose.allCases {
                let current = try await fixture.context(purpose)
                let relay = try CommunityRelayContext(communityID:current.mobile.body.communityId,enrollmentID:current.mobile.body.enrollmentId,deviceID:current.mobile.body.deviceId,publicKey:current.session.body.publicKey,role:.client,sessionID:current.session.body.sessionId)
                let carrier = try await CommunityMobileControlCarrier.openFixture(endpoint:URL(string:fixture.endpoints.relay)!,authority:current.authority,context:relay,purpose:purpose,
                    fence:{ try fixture.check() },ticketProvider:{ try await fixture.ticket(purpose,connection:$0) },proofSigner:{ proof in
                        let c = try await fixture.context(purpose); return try await proof.signed(by:fixture.ramSigner(c))
                    })
                let client = try await CommunityMobileControlClient.connect(context:current,wire:carrier,current:{ try await fixture.context(purpose) },signer:{ proof in
                    let c = try await fixture.context(purpose); try proof.validate(current:c)
                    var scalar = Data(repeating:0,count:32); scalar[31] = 3
                    return try P256.Signing.PrivateKey(rawRepresentation:scalar).signature(for:proof.bytes).rawRepresentation
                })
                let cap = try await client.request(.capabilities(purpose:purpose)), manifest = try CommunityMobileControlJSON.object(cap.result,maximum:16_000)
                XCTAssertEqual(manifest["outcome"] as? String,"capabilities"); XCTAssertEqual(manifest["purpose"] as? String,purpose.rawValue)
                let operation = try CommunityMobileControlOperation.make(), kind = purpose.rawValue.replacingOccurrences(of:"mobile-",with:"")
                let command = try CommunityMobileControlBytes.json(["kind":kind,"op":"count"])
                let backend = MobileSocketJournal(), journal = CommunityMobileControlJournal(backend:backend)
                let record = try journal.prepare(operation:operation,context:current,command:command)
                let done = try await client.request(.effect(purpose:purpose,operation:operation,command:command)); effects += 1
                let result = try CommunityMobileControlJSON.object(done.result,maximum:16_000)
                XCTAssertEqual(result["outcome"] as? String,"done"); XCTAssertEqual((result["count"] as? NSNumber)?.intValue,effects)
                let receipt = try await client.request(.receipt(operation:operation)); XCTAssertEqual(receipt.result,done.result); XCTAssertEqual(receipt.resultDigest,done.resultDigest)
                try journal.receive(record.id,ownerHash:record.ownerHash,response:done,terminal:true)
                XCTAssertEqual(try journal.records(ownerHash:record.ownerHash).first?.result,done.result)
                let consumed = try await client.request(.consumed(operation:operation,resultDigest:done.resultDigest))
                XCTAssertEqual(try CommunityMobileControlJSON.object(consumed.result,maximum:16_000)["outcome"] as? String,"consumed")
                try journal.markConsumed(record.id,ownerHash:record.ownerHash,resultDigest:done.resultDigest); await client.close()
            }
            let state = try CommunityMobileControlJSON.object(await fixture.fetch(fixture.endpoints.state),maximum:40_000)
            XCTAssertEqual((state["effects"] as? NSNumber)?.intValue,4)
            await fixture.stop()
        } catch { await fixture.stop(); throw error }
    }
}
private final class MobileSocketJournal: CommunityMobileControlJournalBackend, @unchecked Sendable {
    private let lock = NSLock(); private var value: Data?
    func read() throws -> Data? { lock.withLock { value } }
    func write(_ bytes: Data) throws { lock.withLock { value = bytes } }
}
#endif
