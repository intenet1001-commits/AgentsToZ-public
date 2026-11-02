#if !CORE_CHECKS
import CryptoKit
import Foundation
import XCTest
@testable import ScreenControlCore

struct RelayFixtureInfo: Decodable, Sendable {
    struct Device: Decodable, Sendable {
        let id: String, kind: String, enrollment: String, hostPublicKey: String, operationPublicKey: String
        let hostPrivateDER: String, operationPrivateDER: String
        let sessionID: String?, sessionPublicKey: String?, sessionPrivateDER: String?
    }
    let origin: URL, issuer: String, profile: String, community: String, websocket: URL, ticketURL: URL
    let devices: [Device]
    var authority: ScreenCommunityAuthority {
        get throws { try ScreenCommunityAuthority(origin: origin,
            issuer: P256.Signing.PublicKey(x963Representation: ScreenCommunityRequest.decodeBase64(issuer, max: 87)), profileID: profile) }
    }
    func tickets(device: Device, role: CommunityRelayRole, connection: String) async throws -> CommunityRelayTicket {
        try await access(device: device, role: role, connection: connection).ticket
    }
    func access(device: Device, role: CommunityRelayRole, connection: String = UUID().uuidString.lowercased()) async throws
        -> (authorization: CommunityAuthorization, session: CommunityUseSession?, ticket: CommunityRelayTicket) {
        struct Result: Decodable { let authorization: ScreenCommunityEnvelope, ticket: ScreenCommunityEnvelope, session: ScreenCommunityEnvelope? }
        guard ticketURL.scheme == "http", ticketURL.host == "127.0.0.1", let port = ticketURL.port,
              ![3001, 52741, 4723].contains(port) else { throw TransportError.badFrame }
        let session = URLSession(configuration: .ephemeral); defer { session.invalidateAndCancel() }
        var request = URLRequest(url: ticketURL); request.httpMethod = "POST"
        request.httpBody = try JSONSerialization.data(withJSONObject: ["deviceId": device.id, "role": role.rawValue, "connectionId": connection])
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 20_000 else { throw TransportError.badFrame }
        let result = try JSONDecoder().decode(Result.self, from: data)
        let auth = try CommunityAccessReply.verify(result.authorization, authority: authority).authorization(authority: authority)
        let use = try result.session.map { try CommunityAccessReply.verify($0, authority: authority).session(for: auth) }
        return (auth, use, try CommunityAccessReply.verify(result.ticket, authority: authority).relayTicket(for: auth, session: use, connectionId: connection, purpose: .screen, role: role))
    }
}
struct NativeRelayFixtureSigner: TranscriptSigner {
    let key: P256.Signing.PrivateKey
    init(_ der: String) throws { key = try P256.Signing.PrivateKey(derRepresentation: XCTUnwrap(Data(base64Encoded: der))) }
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}
actor NativeRelayIncoming {
    private var streams: [CommunityRelayFrameTransport] = []
    private var waiter: CheckedContinuation<CommunityRelayFrameTransport, Never>?
    func add(_ transport: CommunityRelayFrameTransport) {
        if let waiter { self.waiter = nil; waiter.resume(returning: transport) } else { streams.append(transport) }
    }
    func next() async -> CommunityRelayFrameTransport {
        if !streams.isEmpty { return streams.removeFirst() }
        return await withCheckedContinuation { waiter = $0 }
    }
}

final class CommunityRelaySocketChecks: XCTestCase {
    func testActualNativeWSSProofMultiplexOrderingFragmentationAndCancellation() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let script = root.appending(path: "cloud/screen-community/tests/native-relay-fixture.mjs")
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["bun", script.path]
        process.standardOutput = output; process.standardError = FileHandle.standardError
        try process.run()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        let data = output.fileHandleForReading.availableData
        let fixture = try JSONDecoder().decode(RelayFixtureInfo.self, from: data)
        let authority = try fixture.authority, firstHost = NativeRelayIncoming(), secondHost = NativeRelayIncoming()
        let clientDevice = fixture.devices[0], hostDevice = fixture.devices[1], anotherDevice = fixture.devices[2]
        func open(_ device: RelayFixtureInfo.Device, role: CommunityRelayRole, incoming: @escaping CommunityRelayMultiplexer.Incoming = { $0.cancel() }) async throws -> CommunityRelayMultiplexer {
            let signer = try NativeRelayFixtureSigner(role == .host ? device.hostPrivateDER : device.operationPrivateDER)
            let context = try CommunityRelayContext(communityID: fixture.community, enrollmentID: device.enrollment, deviceID: device.id,
                publicKey: role == .host ? device.hostPublicKey : device.operationPublicKey, role: role)
            return try await CommunityRelayMultiplexer.openFixture(endpoint: fixture.websocket, authority: authority, context: context,
                ticketProvider: { try await fixture.tickets(device: device, role: role, connection: $0) },
                proofSigner: { try await $0.signed(by: signer) }, incoming: incoming)
        }
        let host = try await open(hostDevice, role: .host, incoming: { await firstHost.add($0) })
        let another = try await open(anotherDevice, role: .host, incoming: { await secondHost.add($0) })
        let client = try await open(clientDevice, role: .client)
        defer { host.cancel(); another.cancel(); client.cancel() }
        let a = try await client.openChannel(to: hostDevice.id), b = try await client.openChannel(to: anotherDevice.id)
        try await a.send(Data("first host hello".utf8)); try await b.send(Data("second host hello".utf8))
        let receivedA = await firstHost.next(), receivedB = await secondHost.next()
        let helloA = try await receivedA.receive(), helloB = try await receivedB.receive()
        XCTAssertEqual(helloA, Data("first host hello".utf8)); XCTAssertEqual(helloB, Data("second host hello".utf8))
        XCTAssertEqual(receivedA.binding.peerDeviceID, clientDevice.id)
        XCTAssertEqual(receivedA.binding.peerConnectionID, a.binding.ownConnectionID)
        XCTAssertEqual(receivedA.channelID, a.channelID)
        try await receivedA.send(Data("host reply".utf8)); let reply = try await a.receive()
        XCTAssertEqual(reply, Data("host reply".utf8)); XCTAssertEqual(a.binding.peerConnectionID, receivedA.ownConnectionID)
        for index in 0..<12 {
            let frame = Data("ordered-\(index)".utf8); try await a.send(frame)
            let received = try await receivedA.receive(); XCTAssertEqual(received, frame)
        }
        a.setMaxFrame(CommunityRelayFragment.maximumFrame); receivedA.setMaxFrame(CommunityRelayFragment.maximumFrame)
        let large = Data(repeating: 0xa7, count: CommunityRelayFragment.maximumFrame)
        try await a.send(large); let receivedLarge = try await receivedA.receive(); XCTAssertEqual(receivedLarge, large)
        let offline = try await client.openChannel(to: UUID().uuidString.lowercased())
        do { try await offline.send(Data("offline peer".utf8)); XCTFail("Offline recipient accepted the frame") } catch { }
        try await b.send(Data("other host still works".utf8)); let stillWorks = try await receivedB.receive()
        XCTAssertEqual(stillWorks, Data("other host still works".utf8))
        // A wrong native private key cannot prove a freshly issued ticket or replace the live client.
        let wrongSigner = NativeRelayFixtureSignerForFailure(), clientContext = try CommunityRelayContext(communityID: fixture.community,
            enrollmentID: clientDevice.enrollment, deviceID: clientDevice.id, publicKey: clientDevice.operationPublicKey, role: .client)
        do {
            let bad = try await CommunityRelayMultiplexer.openFixture(endpoint: fixture.websocket, authority: authority, context: clientContext,
                ticketProvider: { try await fixture.tickets(device: clientDevice, role: .client, connection: $0) },
                proofSigner: { try await $0.signed(by: wrongSigner) })
            bad.cancel(); XCTFail("Wrong private key proved the ticket")
        } catch { }
        try await b.send(Data("live after wrong proof".utf8)); let live = try await receivedB.receive()
        XCTAssertEqual(live, Data("live after wrong proof".utf8))
        a.cancel()
        do { _ = try await receivedA.receive(); XCTFail("Explicit channel close did not reach the peer") } catch { }
        try await receivedB.send(Data("other channel survives close".utf8)); let surviving = try await b.receive()
        XCTAssertEqual(surviving, Data("other channel survives close".utf8))
        client.cancel()
        do { _ = try await receivedB.receive(); XCTFail("A disconnected peer left its virtual stream open") } catch { }
    }
}
private struct NativeRelayFixtureSignerForFailure: TranscriptSigner {
    let key = P256.Signing.PrivateKey()
    var publicKey: P256.Signing.PublicKey { key.publicKey }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
}
#endif
