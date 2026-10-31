import Foundation
import Security

/// v2 uses an application process generation rather than inventing a window for desktop-wide control.
public struct ScopeApplicationIdentity: Codable, Equatable, Hashable, Sendable {
    public let bundleId: String
    public let teamId: String
    public let codeHash: String
    public let pid: Int32
    public let processStart: String
    public init(bundleId: String, teamId: String, codeHash: String, pid: Int32, processStart: String) {
        self.bundleId = bundleId; self.teamId = teamId; self.codeHash = codeHash
        self.pid = pid; self.processStart = processStart
    }
    private enum Keys: String, CodingKey { case bundleId, teamId, codeHash, pid, processStart }
    public init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: ScopeCodingKey.self)
        guard Set(raw.allKeys.map(\.stringValue)) == ["bundleId", "teamId", "codeHash", "pid", "processStart"] else {
            throw ApprovalError.invalidPayload
        }
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(bundleId: try c.decode(String.self, forKey: .bundleId), teamId: try c.decode(String.self, forKey: .teamId),
                  codeHash: try c.decode(String.self, forKey: .codeHash), pid: try c.decode(Int32.self, forKey: .pid),
                  processStart: try c.decode(String.self, forKey: .processStart))
        guard ComputerUseScopeApproval.validApplication(self) else { throw ApprovalError.invalidPayload }
    }
    public func encode(to encoder: Encoder) throws {
        guard ComputerUseScopeApproval.validApplication(self) else { throw ApprovalError.invalidPayload }
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(bundleId, forKey: .bundleId); try c.encode(teamId, forKey: .teamId)
        try c.encode(codeHash, forKey: .codeHash); try c.encode(pid, forKey: .pid); try c.encode(processStart, forKey: .processStart)
    }
}

private struct ScopeCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// Encoded exactly as `{kind:"desktop"}` or `{kind:"application",application:{...}}`.
public enum ScopeApprovalScope: Equatable, Hashable, Sendable, Codable {
    case desktop
    case application(ScopeApplicationIdentity)

    private enum Keys: String, CodingKey { case kind, application }
    public init(from decoder: Decoder) throws {
        let raw = try decoder.container(keyedBy: ScopeCodingKey.self)
        let keys = Set(raw.allKeys.map(\.stringValue))
        let c = try decoder.container(keyedBy: Keys.self)
        let kind = try c.decode(String.self, forKey: .kind)
        if kind == "desktop", keys == ["kind"] { self = .desktop; return }
        if kind == "application", keys == ["kind", "application"] {
            let application = try c.decode(ScopeApplicationIdentity.self, forKey: .application)
            guard ComputerUseScopeApproval.validApplication(application) else { throw ApprovalError.invalidPayload }
            self = .application(application); return
        }
        throw ApprovalError.invalidPayload
    }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case .desktop: try c.encode("desktop", forKey: .kind)
        case .application(let application):
            guard ComputerUseScopeApproval.validApplication(application) else { throw ApprovalError.invalidPayload }
            try c.encode("application", forKey: .kind); try c.encode(application, forKey: .application)
        }
    }
}

public struct ScopeApprovalCaller: Codable, Equatable, Sendable {
    public let sessionId: String
    public let lane: String
    public let generation: String
    public init(sessionId: String, lane: String, generation: String) {
        self.sessionId = sessionId; self.lane = lane; self.generation = generation
    }
}

/// Owner start is the kernel's process start in decimal microseconds, not a path or a user-provided identity.
public struct ScopeApprovalOwner: Codable, Equatable, Sendable {
    public let pid: Int32
    public let start: String
    public init(pid: Int32, start: String) { self.pid = pid; self.start = start }
}

public struct ScopeApprovalPayload: Codable, Equatable, Sendable {
    public let version: Int
    public let approvalId: String
    public let scope: ScopeApprovalScope
    public let permissions: [String]
    public let caller: ScopeApprovalCaller
    public let owner: ScopeApprovalOwner
    public let issuedAt: Int64
    public let expiresAt: Int64
    public init(version: Int = 2, approvalId: String, scope: ScopeApprovalScope,
                permissions: [String] = ComputerUseScopeApproval.permissions,
                caller: ScopeApprovalCaller, owner: ScopeApprovalOwner, issuedAt: Int64, expiresAt: Int64) {
        self.version = version; self.approvalId = approvalId; self.scope = scope; self.permissions = permissions
        self.caller = caller; self.owner = owner; self.issuedAt = issuedAt; self.expiresAt = expiresAt
    }
}

/// Exact signed bytes for scoped approval. This separate domain never changes or accepts a v1 window approval.
public enum ComputerUseScopeApproval {
    public static let domain = "agentstoz-computer-use-scope/v2"
    public static let permissions = ["screen", "pointer", "keyboard"]
    /// Bounds the signed approval's own window: `expires` is the request deadline (ControlLimits.approvalMs, 10 min,
    /// plus 5 s skew) by which the grant must open; 10 s of margin over that. The opened grant's lifetime is Control's
    /// (ControlLimits.scopeGrantMs) and is not part of these bytes. Mirrored in src/computerUseScopeApproval.ts.
    public static let maxGrantMs: Int64 = 610_000
    private static let lowerHex = "0123456789abcdef"
    private static let digits = "0123456789"
    private static let upperDigits = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    private static let alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    private static let maxSafeInteger: Int64 = 9_007_199_254_740_991
    private static func only(_ value: String, _ allowed: String, _ minimum: Int, _ maximum: Int) -> Bool {
        value.utf8.count >= minimum && value.utf8.count <= maximum &&
            value.unicodeScalars.allSatisfy { allowed.unicodeScalars.contains($0) }
    }
    private static func start(_ value: String) -> Bool {
        only(value, digits, 1, 20) && value.first != "0"
    }
    public static func validApplication(_ application: ScopeApplicationIdentity) -> Bool {
        only(application.bundleId, alnum + ".-", 1, 200) &&
            (application.teamId.isEmpty || only(application.teamId, upperDigits, 10, 10)) &&
            only(application.codeHash, lowerHex, 40, 64) && application.pid > 0 && start(application.processStart)
    }
    public static func validScope(_ scope: ScopeApprovalScope) -> Bool {
        switch scope {
        case .desktop: return true
        case .application(let application): return validApplication(application)
        }
    }
    public static func validCaller(_ caller: ScopeApprovalCaller) -> Bool {
        only(caller.sessionId, alnum + "_-", 8, 160) && only(caller.lane, alnum + "_-", 1, 64) &&
            only(caller.generation, lowerHex, 32, 32)
    }
    public static func validOwner(_ owner: ScopeApprovalOwner) -> Bool { owner.pid > 0 && start(owner.start) }
    public static func bytes(_ payload: ScopeApprovalPayload) throws -> Data {
        guard payload.version == 2, only(payload.approvalId, lowerHex, 64, 64),
              validScope(payload.scope), payload.permissions == permissions,
              validCaller(payload.caller), validOwner(payload.owner), payload.issuedAt >= 0,
              payload.issuedAt <= maxSafeInteger, payload.expiresAt <= maxSafeInteger,
              payload.expiresAt > payload.issuedAt, payload.expiresAt - payload.issuedAt <= maxGrantMs else {
            throw ApprovalError.invalidPayload
        }
        let kind: String, bundle: String, team: String, code: String, pid: String, processStart: String
        switch payload.scope {
        case .desktop:
            kind = "desktop"; bundle = "-"; team = "-"; code = "-"; pid = "-"; processStart = "-"
        case .application(let application):
            kind = "application"; bundle = application.bundleId; team = application.teamId; code = application.codeHash
            pid = String(application.pid); processStart = application.processStart
        }
        let c = payload.caller, o = payload.owner
        let lines = [domain, "approval=\(payload.approvalId)", "scope=\(kind)", "bundle=\(bundle)", "team=\(team)",
                     "code=\(code)", "pid=\(pid)", "start=\(processStart)", "permissions=screen,pointer,keyboard",
                     "session=\(c.sessionId)", "lane=\(c.lane)", "generation=\(c.generation)", "owner-pid=\(o.pid)",
                     "owner-start=\(o.start)", "issued=\(payload.issuedAt)", "expires=\(payload.expiresAt)"]
        return Data((lines.joined(separator: "\n") + "\n").utf8)
    }
    /// P-256/SHA-256 DER; a production caller supplies the same user-presence-gated Secure Enclave key as v1.
    public static func sign(_ payload: ScopeApprovalPayload, with key: SecKey) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256,
                                                     try bytes(payload) as CFData, &error) as Data? else {
            throw ApprovalError.signing
        }
        return signature
    }
    public static func verify(_ payload: ScopeApprovalPayload, signature: Data, publicKey: SecKey) -> Bool {
        guard let message = try? bytes(payload) else { return false }
        var error: Unmanaged<CFError>?
        return SecKeyVerifySignature(publicKey, .ecdsaSignatureMessageX962SHA256, message as CFData,
                                     signature as CFData, &error)
    }
}
