import Foundation

public struct CommunityMobileControlRequest: Sendable {
    public enum Mode: String, Sendable { case query, effect, receipt, consumed }
    public let requestID: String, mode: Mode, operation: CommunityMobileControlOperation?
    private let command: Data?, resultDigest: String?
    public static func capabilities(purpose: CommunityMobileControlPurpose, requestID: String = UUID().uuidString.lowercased()) throws -> Self {
        try make(mode: .query, purpose: purpose, command: CommunityMobileControlBytes.json(["op":"capabilities"]), requestID: requestID)
    }
    public static func query(purpose: CommunityMobileControlPurpose, command: Data, requestID: String = UUID().uuidString.lowercased()) throws -> Self {
        try make(mode: .query, purpose: purpose, command: command, requestID: requestID)
    }
    public static func effect(purpose: CommunityMobileControlPurpose, operation: CommunityMobileControlOperation, command: Data, requestID: String = UUID().uuidString.lowercased()) throws -> Self {
        try operation.validate(); return try make(mode: .effect, purpose: purpose, command: command, requestID: requestID, operation: operation)
    }
    public static func receipt(operation: CommunityMobileControlOperation, requestID: String = UUID().uuidString.lowercased()) throws -> Self {
        try operation.validate(); guard CommunityMobileControlBytes.id(requestID) else { throw ScreenCommunityError.malformed }
        return Self(requestID: requestID, mode: .receipt, operation: operation, command: nil, resultDigest: nil)
    }
    /// Call only after the typed upper consumer has durably accepted this exact authenticated result.
    public static func consumed(operation: CommunityMobileControlOperation, resultDigest: String, requestID: String = UUID().uuidString.lowercased()) throws -> Self {
        try operation.validate(); guard CommunityMobileControlBytes.id(requestID), resultDigest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
        return Self(requestID: requestID, mode: .consumed, operation: operation, command: nil, resultDigest: resultDigest)
    }
    private static func make(mode: Mode, purpose: CommunityMobileControlPurpose, command: Data, requestID: String, operation: CommunityMobileControlOperation? = nil) throws -> Self {
        let value = try CommunityMobileControlJSON.object(command, maximum: 20_000)
        let kind: String = switch purpose { case .agent: "agent"; case .teams: "teams"; case .agentSettings: "agent-settings"; case .browser: "browser" }
        let capabilities = mode == .query && Set(value.keys) == ["op"] && value["op"] as? String == "capabilities"
        guard CommunityMobileControlBytes.id(requestID), capabilities || value["kind"] as? String == kind,
              let op = value["op"] as? String, op.range(of: "^[a-z][a-z0-9-]{0,47}$", options: .regularExpression) != nil else { throw ScreenCommunityError.malformed }
        // Purpose-specific command fields are additionally decoded by the actual consumer's strict union.
        return Self(requestID: requestID, mode: mode, operation: operation, command: command, resultDigest: nil)
    }
    public var encoded: Data { get throws {
        var value: [String: Any] = ["v":1,"kind":"request","mode":mode.rawValue,"requestId":requestID]
        if let operation { value["operationId"] = operation.operationId; value["createdAt"] = operation.createdAt }
        if let command { value["command"] = try CommunityMobileControlJSON.object(command, maximum: 20_000) }
        if let resultDigest { value["resultDigest"] = resultDigest }
        let bytes = try CommunityMobileControlBytes.json(value)
        guard bytes.count <= 24_000 else { throw ScreenCommunityError.malformed }; return bytes
    } }
}

public struct CommunityMobileControlResponse: Sendable {
    public let requestID: String, result: Data, resultDigest: String
    public static func decode(_ data: Data, expectedRequestID: String) throws -> Self {
        let value = try CommunityMobileControlJSON.object(data, maximum: 24_000)
        guard Set(value.keys) == ["v","kind","requestId","result","resultDigest"], try AccessValue.integer(value["v"] as Any) == 1,
              value["kind"] as? String == "response", value["requestId"] as? String == expectedRequestID,
              let encoded = value["result"] as? String, let digest = value["resultDigest"] as? String,
              digest.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw ScreenCommunityError.wrongRequest }
        let bytes = try ScreenCommunityRequest.decodeBase64(encoded, max: 21_334)
        guard bytes.count <= 16_000, ScreenCommunityRequest.base64(bytes) == encoded,
              CommunityMobileControlBytes.hex(CommunityMobileControlBytes.hash(bytes)) == digest else { throw ScreenCommunityError.invalidSignature }
        _ = try CommunityMobileControlJSON.object(bytes, maximum: 16_000)
        return Self(requestID: expectedRequestID, result: bytes, resultDigest: digest)
    }
}
