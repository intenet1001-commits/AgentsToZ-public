#if os(macOS)
import CryptoKit
import Foundation
import XCTest
import ScreenControlCore
@testable import AgentsToZViewer

private final class CandidateMemoryBackend: ViewerTargetsBackend, @unchecked Sendable {
    var data: Data?
    var writes = 0
    var failure: String?
    func read() throws -> Data? {
        if failure == "read" { throw NSError(domain: "NSOSStatusErrorDomain", code: -25308) }
        return data
    }
    func write(_ bytes: Data) throws {
        writes += 1
        if failure == "before" { throw NSError(domain: "NSOSStatusErrorDomain", code: -25308) }
        data = bytes
        if failure == "after" { throw NSError(domain: "NSOSStatusErrorDomain", code: -25308) }
    }
}

/// All material and storage are software fixtures. No SE creation, Keychain, LA, Screen IPC or network.
@MainActor
final class ViewerCommunityBiometricPreparationChecks: XCTestCase {
    private func fixture() throws -> (CommunityBiometricKeyCandidate.Context, CommunityBiometricKeyCandidate.Material) {
        let context = CommunityBiometricKeyCandidate.Context(profileId: UUID().uuidString.lowercased(),
            deviceId: UUID().uuidString.lowercased(), hostPublicKey: P256.Signing.PrivateKey().publicKey.x963Representation)
        let material = try CommunityBiometricKeyCandidate.Material(wrappedBlob: Data("software-wrapped-fixture-only".utf8),
            publicKey: P256.Signing.PrivateKey().publicKey.x963Representation)
        return (context, material)
    }
    func testFreshCandidateCapturesPublicKeyWithoutReopeningAndRestartReusesExactBlob() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        var creates = 0, reopens = 0
        let first = ViewerCommunityBiometricPreparation(make: { creates += 1; return material }, reopen: { _ in
            reopens += 1; throw NSError(domain: "com.apple.LocalAuthentication", code: -1000)
        })
        let prepared = try XCTUnwrap(first.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true))
        XCTAssertEqual(creates, 1); XCTAssertEqual(reopens, 0); XCTAssertEqual(backend.writes, 1)
        XCTAssertEqual(prepared.keyBlob, material.wrappedBlob)
        XCTAssertEqual(try prepared.biometricCandidate?.checkedPublicKey(blob: prepared.keyBlob, context: context, boundViewerKey: material.publicKey), material.publicKey)
        let original = backend.data
        let restarted = ViewerCommunityBiometricPreparation(make: { XCTFail("Persisted candidate must not regenerate"); return material },
            reopen: { _ in XCTFail("Cached public metadata must not reopen a protected key"); return material.publicKey })
        let again = try XCTUnwrap(restarted.prepare(backend: backend, context: context, boundViewerKey: material.publicKey, name: "changed", create: true))
        XCTAssertEqual(again.keyBlob, material.wrappedBlob); XCTAssertEqual(again.displayName, "1호")
        XCTAssertEqual(backend.data, original); XCTAssertEqual(backend.writes, 1)
        XCTAssertNil(again.enrollment) // Provisioning metadata is not an accepted certificate or grant.
    }
    func testOldAccountBackfillsOnceWithoutReplacingItsKeyOrChangingItsName() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        let original = ViewerCommunityAccount.Account(keyBlob: material.wrappedBlob, displayName: "old", enrollment: nil)
        backend.data = try JSONEncoder().encode(original)
        let legacyJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: backend.data!) as? [String: Any])
        XCTAssertNil(legacyJSON["biometricCandidate"])
        var reopens = 0
        let prep = ViewerCommunityBiometricPreparation(make: { XCTFail("Never rotate an old account key"); return material },
            reopen: { blob in reopens += 1; XCTAssertEqual(blob, material.wrappedBlob); return material.publicKey })
        let updated = try XCTUnwrap(prep.prepare(backend: backend, context: context, boundViewerKey: material.publicKey, name: "new", create: true))
        XCTAssertEqual(updated.keyBlob, original.keyBlob); XCTAssertEqual(updated.displayName, original.displayName)
        XCTAssertNotNil(updated.biometricCandidate); XCTAssertEqual(reopens, 1)
        _ = try prep.prepare(backend: backend, context: context, boundViewerKey: material.publicKey, name: "new", create: true)
        XCTAssertEqual(reopens, 1)
    }
    func testOldReopenFailurePreservesOriginalBytesAndNeverCreatesReplacement() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        backend.data = try JSONEncoder().encode(ViewerCommunityAccount.Account(keyBlob: material.wrappedBlob, displayName: "old", enrollment: nil))
        let original = backend.data
        let prep = ViewerCommunityBiometricPreparation(make: { XCTFail("No replacement after a legacy reopen error"); return material }, reopen: { _ in
            throw CommunityBiometricPreparationError(stage: .storedPublicKeyReopen,
                underlying: NSError(domain: "com.apple.LocalAuthentication", code: -1000, userInfo: ["private": "never-display"]))
        })
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: context, boundViewerKey: material.publicKey, name: "old", create: true)) {
            XCTAssertEqual(($0 as? CommunityBiometricPreparationError)?.stage, .storedPublicKeyReopen)
            XCTAssertEqual(($0 as? CommunityBiometricPreparationError)?.code, -1000)
        }
        XCTAssertEqual(backend.data, original); XCTAssertEqual(backend.writes, 0)
    }
    func testUncertainWriteAfterApplyAndRestartReuseOriginalCandidate() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        backend.failure = "after"; var creates = 0
        let prep = ViewerCommunityBiometricPreparation(make: { creates += 1; return material }, reopen: { _ in XCTFail(); return material.publicKey })
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true)) {
            XCTAssertEqual(($0 as? CommunityBiometricPreparationError)?.stage, .accountPersist)
        }
        let persisted = try XCTUnwrap(backend.data)
        backend.failure = nil
        let restarted = ViewerCommunityBiometricPreparation(make: { XCTFail("An unknown storage outcome is not a new key request"); return material }, reopen: { _ in XCTFail(); return material.publicKey })
        _ = try restarted.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true)
        XCTAssertEqual(creates, 1); XCTAssertEqual(backend.data, persisted); XCTAssertEqual(backend.writes, 1)
        _ = try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true)
        XCTAssertFalse(prep.hasPendingCandidate); XCTAssertEqual(creates, 1)
    }
    func testUncertainWriteBeforeApplyRetriesSameRAMCandidateAndRejectsDifferentStoredKey() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        backend.failure = "before"; var creates = 0
        let prep = ViewerCommunityBiometricPreparation(make: { creates += 1; return material }, reopen: { _ in XCTFail(); return material.publicKey })
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true))
        XCTAssertTrue(prep.hasPendingCandidate); XCTAssertNil(backend.data)
        backend.failure = nil
        let ready = try XCTUnwrap(prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "different", create: true))
        XCTAssertEqual(creates, 1); XCTAssertEqual(ready.displayName, "1호"); XCTAssertEqual(ready.keyBlob, material.wrappedBlob)
        // A concurrent different private record must never be overwritten by the old retry.
        let otherBackend = CandidateMemoryBackend(); otherBackend.failure = "before"
        let pending = ViewerCommunityBiometricPreparation(make: { material }, reopen: { _ in material.publicKey })
        XCTAssertThrowsError(try pending.prepare(backend: otherBackend, context: context, boundViewerKey: nil, name: "original", create: true))
        let other = ViewerCommunityAccount.Account(keyBlob: Data("another-stored-key".utf8), displayName: "other", enrollment: nil)
        otherBackend.failure = nil; otherBackend.data = try JSONEncoder().encode(other)
        let bytes = otherBackend.data, writes = otherBackend.writes
        XCTAssertThrowsError(try pending.prepare(backend: otherBackend, context: context, boundViewerKey: nil, name: "original", create: true))
        XCTAssertEqual(otherBackend.data, bytes); XCTAssertEqual(otherBackend.writes, writes)
    }
    func testCachedBindingCannotMoveToAnotherDeviceOrBlobAndMissingReadyAccountDoesNotRegenerate() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        let prep = ViewerCommunityBiometricPreparation(make: { material }, reopen: { _ in XCTFail(); return material.publicKey })
        let account = try XCTUnwrap(prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true))
        let other = CommunityBiometricKeyCandidate.Context(profileId: context.profileId, deviceId: UUID().uuidString.lowercased(), hostPublicKey: context.hostPublicKey)
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: other, boundViewerKey: material.publicKey, name: "1호", create: true))
        XCTAssertThrowsError(try account.biometricCandidate?.checkedPublicKey(blob: Data("changed".utf8), context: context, boundViewerKey: material.publicKey))
        let empty = CandidateMemoryBackend()
        let missing = ViewerCommunityBiometricPreparation(make: { XCTFail("Ready key loss is not first installation"); return material }, reopen: { _ in XCTFail(); return material.publicKey })
        XCTAssertThrowsError(try missing.prepare(backend: empty, context: context, boundViewerKey: material.publicKey, name: "1호", create: true))
        XCTAssertNil(empty.data); XCTAssertEqual(empty.writes, 0)
    }
    func testBackgroundReadAndLockedStorageNeverCreateAndDiagnosticsExposeOnlyFixedStageDomainCode() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        let prep = ViewerCommunityBiometricPreparation(make: { XCTFail("Background read must not create"); return material }, reopen: { _ in XCTFail(); return material.publicKey })
        XCTAssertNil(try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: false))
        backend.failure = "read"
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true)) {
            XCTAssertEqual(($0 as? CommunityBiometricPreparationError)?.stage, .accountRead)
        }
        let fake = NSError(domain: "credential-value-must-not-display", code: -1000, userInfo: ["secret": "private"])
        let error = CommunityBiometricPreparationError(stage: .protectedKeyCreate, underlying: fake)
        XCTAssertEqual(error.domain, "native-key"); XCTAssertEqual(error.code, -1000)
        XCTAssertEqual(error.stage.rawValue, "protectedKeyCreate")
        XCTAssertFalse(String(describing: error).contains("private"))
    }
    func testProtectedCreationFailureRetainsItsExactStageAndCannotPersistOrBecomePendingAuthority() throws {
        let (context, material) = try fixture(), backend = CandidateMemoryBackend()
        let failure = CommunityBiometricPreparationError(stage: .protectedKeyCreate,
            underlying: NSError(domain: "com.apple.LocalAuthentication", code: -1000, userInfo: ["secret": "not-shown"]))
        let prep = ViewerCommunityBiometricPreparation(make: { throw failure }, reopen: { _ in XCTFail(); return material.publicKey })
        XCTAssertThrowsError(try prep.prepare(backend: backend, context: context, boundViewerKey: nil, name: "1호", create: true)) {
            XCTAssertEqual($0 as? CommunityBiometricPreparationError, failure)
        }
        XCTAssertNil(backend.data); XCTAssertEqual(backend.writes, 0); XCTAssertFalse(prep.hasPendingCandidate)
        XCTAssertThrowsError(try CommunityBiometricKeyCandidate.Material(wrappedBlob: material.wrappedBlob, publicKey: Data([0]))) {
            XCTAssertEqual(($0 as? CommunityBiometricPreparationError)?.stage, .createdPublicKeyCapture)
        }
    }
}
#endif
