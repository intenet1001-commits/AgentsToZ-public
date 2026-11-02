#if !CORE_CHECKS
import XCTest
import CryptoKit
import Foundation
#if os(macOS)
import Darwin
#endif
@testable import ScreenControlCore

final class ScreenCommunityChecks: XCTestCase {
    struct Fixture: Decodable {
        let issuer: String, at: Int64, profile: String, device: String, host: String, viewer: String, request: String
        let certificate: ScreenCommunityEnvelope, directory: ScreenCommunityEnvelope, signedRequest: ScreenCommunityEnvelope
    }
    private func raw(_ s: String) -> Data {
        Data(base64Encoded: s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - s.count % 4) % 4))!
    }
    private func fixture() throws -> Fixture {
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "Fixtures/community-v1.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
    }
    func testWorkerP1363SignaturesVerifyInCryptoKitAndGiveOnlySignedMembership() throws {
        let f = try fixture(), now = Date(timeIntervalSince1970: Double(f.at) / 1000), issuer = try P256.Signing.PublicKey(x963Representation: raw(f.issuer))
        let response = try ScreenCommunityResponse.verify(f.certificate, issuer: issuer, expectedRequestID: f.request, now: now)
        let certificate = try response.certificate(profileID: f.profile, deviceID: f.device, hostKey: raw(f.host), viewerKey: raw(f.viewer), now: now)
        let lease = try ScreenCommunityResponse.verify(f.directory, issuer: issuer, expectedRequestID: f.request, now: now)
            .directory(for: certificate, now: now)
        XCTAssertEqual(lease.members.count, 2); XCTAssertEqual(lease.members[1].route, "192.168.219.115")
        XCTAssertEqual(lease.members[0].grant, .control); XCTAssertEqual(lease.members[1].grant, .view)
        XCTAssertTrue(lease.isCurrent(at: now)); XCTAssertFalse(lease.isCurrent(at: now.addingTimeInterval(90)))
    }
    func testIssuerRequestAndBothDeviceKeysAreMandatory() throws {
        let f = try fixture(), now = Date(timeIntervalSince1970: Double(f.at) / 1000), issuer = try P256.Signing.PublicKey(x963Representation: raw(f.issuer))
        XCTAssertThrowsError(try ScreenCommunityResponse.verify(f.certificate, issuer: P256.Signing.PrivateKey().publicKey, now: now))
        XCTAssertThrowsError(try ScreenCommunityResponse.verify(f.certificate, issuer: issuer, expectedRequestID: UUID().uuidString.lowercased(), now: now))
        let response = try ScreenCommunityResponse.verify(f.certificate, issuer: issuer, now: now)
        XCTAssertThrowsError(try response.certificate(profileID: f.profile, deviceID: f.device, hostKey: raw(f.host), viewerKey: raw(f.host), now: now))
        XCTAssertThrowsError(try response.certificate(profileID: UUID().uuidString.lowercased(), deviceID: f.device, hostKey: raw(f.host), viewerKey: raw(f.viewer), now: now))
    }
    func testLeaseExpiryRevisionRollbackAndStaleResponseAreRefused() throws {
        let f = try fixture(), now = Date(timeIntervalSince1970: Double(f.at) / 1000), issuer = try P256.Signing.PublicKey(x963Representation: raw(f.issuer))
        let cert = try ScreenCommunityResponse.verify(f.certificate, issuer: issuer, now: now)
            .certificate(profileID: f.profile, deviceID: f.device, hostKey: raw(f.host), viewerKey: raw(f.viewer), now: now)
        let response = try ScreenCommunityResponse.verify(f.directory, issuer: issuer, now: now)
        XCTAssertThrowsError(try response.directory(for: cert, now: now.addingTimeInterval(90)))
        XCTAssertThrowsError(try response.directory(for: cert, minimumRevision: 3, now: now))
        XCTAssertThrowsError(try ScreenCommunityResponse.verify(f.directory, issuer: issuer, expectedRequestID: f.request, now: now.addingTimeInterval(61)))
    }
    func testSignedEnvelopeCannotBeRetargetedOrReinterpretedAcrossDomains() throws {
        let f = try fixture(), now = Date(timeIntervalSince1970: Double(f.at) / 1000), issuer = try P256.Signing.PublicKey(x963Representation: raw(f.issuer))
        let altered = ScreenCommunityEnvelope(payload: f.directory.payload + "A", signature: f.directory.signature)
        XCTAssertThrowsError(try ScreenCommunityResponse.verify(altered, issuer: issuer, now: now))
        XCTAssertThrowsError(try ScreenCommunityResponse.verify(f.signedRequest, issuer: try P256.Signing.PublicKey(x963Representation: raw(f.host)), now: now))
        XCTAssertThrowsError(try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: Data("{\"payload\":\"a\",\"signature\":\"b\",\"issuer\":\"untrusted\"}".utf8)))
    }
    func testWorkerRequestUsesSameOpaqueTranscriptAndSeparateRequestDomain() throws {
        let f = try fixture(), host = try P256.Signing.PublicKey(x963Representation: raw(f.host))
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: raw(f.signedRequest.signature))
        let bytes = raw(f.signedRequest.payload)
        XCTAssertTrue(host.isValidSignature(sig, for: Data("agentstoz.screen-community.request/v1\0".utf8) + bytes))
        XCTAssertFalse(host.isValidSignature(sig, for: Data("agentstoz.screen-community.response/v1\0".utf8) + bytes))
    }
    func testRequestSigningPreservesExactOpaqueBytes() async throws {
        struct Signer: TranscriptSigner {
            let key = P256.Signing.PrivateKey()
            var publicKey: P256.Signing.PublicKey { key.publicKey }
            func signature(for data: Data) async throws -> P256.Signing.ECDSASignature { try key.signature(for: data) }
        }
        let request = try ScreenCommunityRequest(operation: .directory, actor: UUID().uuidString.lowercased(), arguments: [.string(UUID().uuidString.lowercased())])
        let signer = Signer(), signed = try await request.signed(by: signer)
        XCTAssertEqual(raw(signed.payload), request.bytes)
        XCTAssertTrue(signer.publicKey.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: raw(signed.signature)), for: request.transcript))
        do { _ = try await request.signed(by: signer, hostSigner: Signer()); XCTFail("only bootstrap has two proofs") } catch {}
    }
#if os(macOS)
    func testUnsignedSameUserProcessIsRejectedByAuditToken() throws {
        // Anonymous local socket pair only: never the installed helper socket or the person's keychain.
        var sockets: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &sockets), 0)
        defer { for fd in sockets { Darwin.close(fd) } }
        XCTAssertThrowsError(try ScreenCommunityPeerCheck.require(.screen, fd: sockets[0]))
        XCTAssertThrowsError(try ScreenCommunityPeerCheck.require(.viewer, fd: sockets[1]))
    }
    func testDeploymentFailsClosedBeforeProvisioningAndRejectsArbitraryOrigins() throws {
        XCTAssertNil(ScreenCommunityAuthority.configured)
        let issuer = P256.Signing.PrivateKey().publicKey, profile = UUID().uuidString.lowercased()
        for address in ["http://example.workers.dev", "https://untrusted.example", "https://example.workers.dev/other", "https://a:b@example.workers.dev"] {
            XCTAssertThrowsError(try ScreenCommunityAuthority(origin: URL(string: address)!, issuer: issuer, profileID: profile))
        }
    }
#endif
}

#endif
