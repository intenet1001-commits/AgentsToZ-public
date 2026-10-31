#if !CORE_CHECKS
import Foundation
import Security
import XCTest
import ComputerUseApproval

final class ScopeApprovalChecks: XCTestCase {
    private let caller = ScopeApprovalCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "b", count: 32))
    private let owner = ScopeApprovalOwner(pid: 42, start: "1000")
    private let application = ScopeApplicationIdentity(bundleId: "com.example.Test", teamId: "ABCDE12345",
        codeHash: String(repeating: "c", count: 40), pid: 123, processStart: "456789")

    private func payload(_ scope: ScopeApprovalScope = .desktop, permissions: [String] = ComputerUseScopeApproval.permissions,
                         caller: ScopeApprovalCaller? = nil, owner: ScopeApprovalOwner? = nil,
                         issuedAt: Int64 = 100_000, expiresAt: Int64 = 160_000) -> ScopeApprovalPayload {
        ScopeApprovalPayload(approvalId: String(repeating: "a", count: 64), scope: scope, permissions: permissions,
            caller: caller ?? self.caller, owner: owner ?? self.owner, issuedAt: issuedAt, expiresAt: expiresAt)
    }
    private func expected(kind: String, bundle: String, team: String, code: String, pid: String, start: String) -> Data {
        Data((["agentstoz-computer-use-scope/v2", "approval=" + String(repeating: "a", count: 64), "scope=" + kind,
               "bundle=" + bundle, "team=" + team, "code=" + code, "pid=" + pid, "start=" + start,
               "permissions=screen,pointer,keyboard", "session=session_1", "lane=leader",
               "generation=" + String(repeating: "b", count: 32), "owner-pid=42", "owner-start=1000",
               "issued=100000", "expires=160000"].joined(separator: "\n") + "\n").utf8)
    }
    func testDesktopAndApplicationGoldenBytes() throws {
        XCTAssertEqual(try ComputerUseScopeApproval.bytes(payload()),
                       expected(kind: "desktop", bundle: "-", team: "-", code: "-", pid: "-", start: "-"))
        XCTAssertEqual(try ComputerUseScopeApproval.bytes(payload(.application(application))),
                       expected(kind: "application", bundle: "com.example.Test", team: "ABCDE12345",
                                code: String(repeating: "c", count: 40), pid: "123", start: "456789"))
        let bytes = try JSONEncoder().encode(ScopeApprovalScope.application(application))
        XCTAssertEqual(try JSONDecoder().decode(ScopeApprovalScope.self, from: bytes), .application(application))
        XCTAssertThrowsError(try JSONDecoder().decode(ScopeApprovalScope.self,
            from: Data("{\"kind\":\"desktop\",\"application\":{}}".utf8)))
        XCTAssertThrowsError(try JSONDecoder().decode(ScopeApprovalScope.self,
            from: Data("{\"kind\":\"desktop\",\"extra\":true}".utf8)))
        let invalidNested = "{\"kind\":\"application\",\"application\":{\"bundleId\":\"com.x\",\"teamId\":\"\",\"codeHash\":\"" + String(repeating: "a", count: 40) + "\",\"pid\":1,\"processStart\":\"1\",\"extra\":true}}"
        XCTAssertThrowsError(try JSONDecoder().decode(ScopeApprovalScope.self, from: Data(invalidNested.utf8)))
    }
    func testSignatureBindsScopePermissionsCallerOwnerAndExpiry() throws {
        // Public test-only P-256 scalar 1 and its standard generator point; no keychain or production key.
        let testKeyHex = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
            "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" + String(repeating: "0", count: 63) + "1"
        let keyBytes = Data(stride(from: 0, to: testKeyHex.count, by: 2).map { offset in
            let a = testKeyHex.index(testKeyHex.startIndex, offsetBy: offset), b = testKeyHex.index(a, offsetBy: 2)
            return UInt8(testKeyHex[a..<b], radix: 16)!
        })
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeyClass as String: kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits as String: 256]
        var error: Unmanaged<CFError>?
        let key = try XCTUnwrap(SecKeyCreateWithData(keyBytes as CFData, attributes as CFDictionary, &error))
        let publicKey = try XCTUnwrap(SecKeyCopyPublicKey(key))
        let original = payload(.application(application))
        let signature = try ComputerUseScopeApproval.sign(original, with: key)
        XCTAssertTrue(ComputerUseScopeApproval.verify(original, signature: signature, publicKey: publicKey))
        let changed: [ScopeApprovalPayload] = [
            payload(),
            payload(.application(application), caller: ScopeApprovalCaller(sessionId: "session_1", lane: "leader", generation: String(repeating: "d", count: 32))),
            payload(.application(application), owner: ScopeApprovalOwner(pid: 43, start: "1000")),
            payload(.application(application), owner: ScopeApprovalOwner(pid: 42, start: "1001")),
            payload(.application(application), expiresAt: 160_001),
            payload(.application(ScopeApplicationIdentity(bundleId: application.bundleId, teamId: application.teamId,
                codeHash: application.codeHash, pid: application.pid, processStart: "456790"))),
            payload(.application(application), permissions: ["screen", "keyboard", "pointer"]),
        ]
        for entry in changed { XCTAssertFalse(ComputerUseScopeApproval.verify(entry, signature: signature, publicKey: publicKey)) }
    }
    func testRejectsMalformedUnboundedOrAmbiguousValues() throws {
        XCTAssertThrowsError(try ComputerUseScopeApproval.bytes(payload(permissions: [])))
        XCTAssertThrowsError(try ComputerUseScopeApproval.bytes(payload(owner: ScopeApprovalOwner(pid: 1, start: "01"))))
        XCTAssertThrowsError(try ComputerUseScopeApproval.bytes(payload(caller: ScopeApprovalCaller(sessionId: "session_1", lane: "leader\nowner-pid=1", generation: String(repeating: "b", count: 32)))))
        XCTAssertThrowsError(try ComputerUseScopeApproval.bytes(payload(issuedAt: 100_000, expiresAt: 710_001)))
        XCTAssertThrowsError(try ComputerUseScopeApproval.bytes(payload(issuedAt: 100_000, expiresAt: 100_000)))
        XCTAssertNoThrow(try ComputerUseScopeApproval.bytes(payload(issuedAt: 100_000, expiresAt: 710_000)))
        XCTAssertFalse(ComputerUseScopeApproval.validApplication(ScopeApplicationIdentity(bundleId: "com.x", teamId: "bad", codeHash: String(repeating: "a", count: 40), pid: 1, processStart: "1")))
        XCTAssertFalse(ComputerUseScopeApproval.validApplication(ScopeApplicationIdentity(bundleId: "com.x\nteam=evil", teamId: "", codeHash: String(repeating: "a", count: 40), pid: 1, processStart: "1")))
    }
}
#endif
