import Foundation
import Security

/// The human approval contract shared with src/computerUseApproval.ts. The separately signed computer-use helper
/// resolves the target itself, shows its own confirmation, and signs these bytes with a key that needs the person's
/// presence. Nothing here shows UI or proves that a person approved: the installed, signed helper does.
public struct ApprovalTarget: Codable, Equatable, Sendable {
    public let bundleId: String
    public let teamId: String
    public let codeHash: String
    public let pid: Int32
    public let processStart: String
    public let windowId: UInt32
    public init(bundleId: String, teamId: String, codeHash: String, pid: Int32, processStart: String, windowId: UInt32) {
        self.bundleId = bundleId; self.teamId = teamId; self.codeHash = codeHash
        self.pid = pid; self.processStart = processStart; self.windowId = windowId
    }
}
public struct ApprovalCaller: Codable, Equatable, Sendable {
    public let sessionId: String
    public let lane: String
    public init(sessionId: String, lane: String) { self.sessionId = sessionId; self.lane = lane }
}
public struct ApprovalPayload: Codable, Equatable, Sendable {
    public let approvalId: String
    public let target: ApprovalTarget
    public let caller: ApprovalCaller
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(approvalId: String, target: ApprovalTarget, caller: ApprovalCaller, issuedAt: Int64, expiresAt: Int64) {
        self.approvalId = approvalId; self.target = target; self.caller = caller
        self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}
public enum ApprovalError: Error, Equatable { case invalidPayload, signing, publicKey, secureEnclave }

/// Code-signing requirements for the helper connection, enforced in both directions: the AgentsToZ client accepts
/// only the helper, and the helper accepts only the AgentsToZ app (XPC `setCodeSigningRequirement` on each side).
/// Team-anchored with exact identifiers; same-user processes cannot satisfy them without the team's signing key.
/// Same Developer ID form as the runtime broker's pinned requirement (`src-tauri/native/macos-runtime/ClientBridge`).
public enum HelperSigning {
    public static let team = "DA8QKAQ2C9"
    /// The separately signed sibling app that owns the engine, its own LaunchAgent and the Accessibility permission.
    /// It is installed beside AgentsToZ_byCS.app like AgentsToZ Screen.app, never inside it: SMAppService manages only
    /// helpers inside the registering app's own main bundle, so an embedded helper would belong to the main app again.
    /// Fixed with the leader: `AgentsToZ Control.app` (native/computer-use/CONTRACT.md).
    public static let helperIdentifier = "com.intenet.agentstozbycs.control"
    public static let appIdentifier = "com.intenet.agentstozbycs"
    /// Release builds require a Developer ID certificate of the team; `developerIDOnly: false` is for local
    /// development builds signed with the same team's development certificate only.
    public static func requirement(identifier: String, team: String = HelperSigning.team, developerIDOnly: Bool = true) -> String {
        let developerID = developerIDOnly
            ? " and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
            : ""
        return "anchor apple generic\(developerID) and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
    }
    /// Read-only static check of an installed bundle against a requirement, for installation verification.
    public static func bundle(at url: URL, satisfies requirement: String) -> Bool {
        var code: SecStaticCode?
        var req: SecRequirement?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
              SecRequirementCreateWithString(requirement as CFString, [], &req) == errSecSuccess, let req else { return false }
        return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), req) == errSecSuccess
    }
}

public enum ComputerUseApproval {
    public static let version = "agentstoz-computer-use-approval/v1"
    private static let lowerHex = "0123456789abcdef"
    private static let digits = "0123456789"
    private static let upperDigits = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    private static let alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    private static func only(_ value: String, _ allowed: String, _ min: Int, _ max: Int) -> Bool {
        value.utf8.count >= min && value.utf8.count <= max && value.unicodeScalars.allSatisfy { allowed.unicodeScalars.contains($0) }
    }
    /// The closed character sets shared with the TypeScript parsers (src/computerUseProtocol.ts).
    public static func validTarget(_ t: ApprovalTarget) -> Bool {
        only(t.bundleId, alnum + ".-", 1, 200) && (t.teamId.isEmpty || only(t.teamId, upperDigits, 10, 10))
            && only(t.codeHash, lowerHex, 40, 64) && t.pid > 0 && t.windowId > 0
            && only(t.processStart, digits, 1, 20) && t.processStart.first != "0"
    }
    public static func validCaller(_ c: ApprovalCaller) -> Bool {
        only(c.sessionId, alnum + "_-", 8, 160) && only(c.lane, alnum + "_-", 1, 64)
    }
    public static func lowerHexString(_ value: String, length: Int) -> Bool { only(value, lowerHex, length, length) }
    /// The exact signed bytes. Values are validated to the same closed character sets as the TypeScript parsers
    /// first, so no value can add, remove or split a line. Field order is fixed.
    public static func bytes(_ p: ApprovalPayload) throws -> Data {
        let t = p.target, c = p.caller
        guard only(p.approvalId, lowerHex, 64, 64), validTarget(t), validCaller(c),
              p.issuedAt >= 0, p.expiresAt > 0 else { throw ApprovalError.invalidPayload }
        let lines = [version, "approval=\(p.approvalId)", "bundle=\(t.bundleId)", "team=\(t.teamId)", "code=\(t.codeHash)",
                     "pid=\(t.pid)", "start=\(t.processStart)", "window=\(t.windowId)", "session=\(c.sessionId)",
                     "lane=\(c.lane)", "issued=\(p.issuedAt)", "expires=\(p.expiresAt)"]
        return Data((lines.joined(separator: "\n") + "\n").utf8)
    }
    /// ECDSA P-256 over SHA-256 in X9.62 DER, which the host verifies.
    public static func sign(_ p: ApprovalPayload, with key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, try bytes(p) as CFData, &error) as Data? else {
            throw ApprovalError.signing
        }
        return signature
    }
    /// The uncompressed X9.63 point (65 bytes) the host receives over the code-signing-verified helper connection.
    public static func publicPoint(of key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let pub = SecKeyCopyPublicKey(key), let data = SecKeyCopyExternalRepresentation(pub, &error) as Data?,
              data.count == 65, data.first == 4 else { throw ApprovalError.publicKey }
        return data
    }
    /// Production key: P-256 in the Secure Enclave, and every signature needs the person's presence (Touch ID or the
    /// login password). Requires the signed helper's keychain access group; the lab never calls this.
    public static func makeSecureEnclaveKey(tag: Data) throws -> SecKey {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage, .userPresence], &error) else {
            throw ApprovalError.secureEnclave
        }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
                                            kSecAttrApplicationTag as String: tag,
                                            kSecAttrAccessControl as String: access]]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw ApprovalError.secureEnclave }
        return key
    }
    /// The approval key for one human approval: the existing Secure Enclave key under `tag`, or a new one the first
    /// time. Only the person's final approve action calls this, after LocalAuthentication succeeded with `context`,
    /// which the key's presence requirement then reuses. Reading a request or the status never reaches the keychain.
    public static func approvalKey(tag: Data, authenticationContext context: AnyObject) throws -> SecKey {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecAttrApplicationTag as String: tag,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnRef as String: true,
            kSecUseAuthenticationContext as String: context]
        func lookup() throws -> SecKey? {
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let item, CFGetTypeID(item) == SecKeyGetTypeID() else { throw ApprovalError.secureEnclave }
            return (item as! SecKey) // type checked above
        }
        if let key = try lookup() { return key }
        _ = try makeSecureEnclaveKey(tag: tag)
        // Read it back through the authenticated context, so signing reuses the presence check just made.
        guard let key = try lookup() else { throw ApprovalError.secureEnclave }
        return key
    }
    /// Lab only: an in-memory software key, to check the byte format and signature without a signed helper.
    public static func makeEphemeralLabKey() throws -> SecKey {
        var error: Unmanaged<CFError>?
        let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                                         kSecAttrKeySizeInBits as String: 256, kSecAttrIsPermanent as String: false]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw ApprovalError.signing }
        return key
    }

    /// The standing allowance (상시 허용): a Secure Enclave P-256 key with no presence requirement, so Control can sign
    /// a desktop approval without asking again. Its existence is the allowance and deleting it ends it. Only Control's
    /// own window calls this, after LocalAuthentication succeeded; no other process can create or use a key in Control's
    /// keychain access group. `label` records when and for what it was made.
    public static func makeStandingKey(tag: Data, label: String) throws -> SecKey {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage], &error) else { throw ApprovalError.secureEnclave }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true,
            kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true,
                                            kSecAttrApplicationTag as String: tag,
                                            kSecAttrLabel as String: label,
                                            kSecAttrAccessControl as String: access]]
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw ApprovalError.secureEnclave }
        return key
    }
    /// The standing key and its label, or nil when there is none. Reading it asks for nothing.
    public static func standingKey(tag: Data) throws -> (key: SecKey, label: String)? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecAttrApplicationTag as String: tag,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnRef as String: true,
            kSecReturnAttributes as String: true]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let found = item as? [String: Any], let ref = found[kSecValueRef as String],
              CFGetTypeID(ref as CFTypeRef) == SecKeyGetTypeID() else { throw ApprovalError.secureEnclave }
        return ((ref as! SecKey), found[kSecAttrLabel as String] as? String ?? "") // type checked above
    }
    /// Ends the standing allowance. Nothing to delete is not an error.
    public static func deleteStandingKey(tag: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: tag,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecUseDataProtectionKeychain as String: true]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw ApprovalError.secureEnclave }
    }
}
