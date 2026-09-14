import CoreFoundation
import Foundation

public enum RuntimeBrokerFixtureEnvelopeError: Error, Equatable {
    case malformed
    case oversized
}

public struct RuntimeBrokerFixtureRequest: Equatable {
    public let challenge: Data

    public init(challenge: Data) throws {
        guard challenge.count == RuntimeBrokerContract.challengeByteCount else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        self.challenge = challenge
    }
}

public struct RuntimeBrokerFixtureResponse: Equatable {
    public let challenge: Data
    public let effectiveUserIdentifier: UInt32
    public let effectiveGroupIdentifier: UInt32
}

public enum RuntimeBrokerFixtureEnvelope {
    private static let requestKind = "agentstoz-runtime-broker-fixture-request"
    private static let responseKind = "agentstoz-runtime-worker-fixture-response"

    public static func encodeRequest(_ request: RuntimeBrokerFixtureRequest) throws -> Data {
        try encode([
            "schemaVersion": 1,
            "kind": requestKind,
            "protocol": RuntimeBrokerContract.fixtureProtocol,
            "challenge": request.challenge.base64EncodedString(),
        ])
    }

    public static func decodeRequest(_ data: Data) throws -> RuntimeBrokerFixtureRequest {
        let object = try decodeObject(
            data,
            exactKeys: ["schemaVersion", "kind", "protocol", "challenge"]
        )
        try requireHeader(object, kind: requestKind)
        let challenge = try requireChallenge(object["challenge"])
        let request = try RuntimeBrokerFixtureRequest(challenge: challenge)
        guard try encodeRequest(request) == data else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        return request
    }

    public static func encodeResponse(
        request: RuntimeBrokerFixtureRequest,
        effectiveUserIdentifier: UInt32,
        effectiveGroupIdentifier: UInt32
    ) throws -> Data {
        try encode([
            "schemaVersion": 1,
            "kind": responseKind,
            "protocol": RuntimeBrokerContract.fixtureProtocol,
            "challenge": request.challenge.base64EncodedString(),
            "effectiveUserIdentifier": effectiveUserIdentifier,
            "effectiveGroupIdentifier": effectiveGroupIdentifier,
        ])
    }

    public static func decodeResponse(_ data: Data) throws -> RuntimeBrokerFixtureResponse {
        let object = try decodeObject(
            data,
            exactKeys: [
                "schemaVersion",
                "kind",
                "protocol",
                "challenge",
                "effectiveUserIdentifier",
                "effectiveGroupIdentifier",
            ]
        )
        try requireHeader(object, kind: responseKind)
        let response = RuntimeBrokerFixtureResponse(
            challenge: try requireChallenge(object["challenge"]),
            effectiveUserIdentifier: try requireUInt32(object["effectiveUserIdentifier"]),
            effectiveGroupIdentifier: try requireUInt32(object["effectiveGroupIdentifier"])
        )
        let request = try RuntimeBrokerFixtureRequest(challenge: response.challenge)
        guard try encodeResponse(
            request: request,
            effectiveUserIdentifier: response.effectiveUserIdentifier,
            effectiveGroupIdentifier: response.effectiveGroupIdentifier
        ) == data else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        return response
    }

    public static func encodePublicProof() throws -> Data {
        try encode([
            "schemaVersion": 1,
            "kind": "macos-runtime-broker-harmless-fixture",
            "mode": "development-same-uid",
            "result": "passed",
            "protocol": RuntimeBrokerContract.fixtureProtocol,
            "workerIdentity": "same-effective-user-and-group-only",
            "serviceRegistered": false,
            "accountCreated": false,
            "containerInvoked": false,
            "authoritative": false,
            "reusable": false,
            "ready": false,
        ])
    }

    private static func encode(_ object: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= RuntimeBrokerContract.maximumWireBytes else {
            throw RuntimeBrokerFixtureEnvelopeError.oversized
        }
        return data
    }

    private static func decodeObject(
        _ data: Data,
        exactKeys: Set<String>
    ) throws -> [String: Any] {
        guard !data.isEmpty, data.count <= RuntimeBrokerContract.maximumWireBytes else {
            throw RuntimeBrokerFixtureEnvelopeError.oversized
        }
        let value = try JSONSerialization.jsonObject(with: data, options: [])
        guard let object = value as? [String: Any], Set(object.keys) == exactKeys else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        return object
    }

    private static func requireHeader(_ object: [String: Any], kind: String) throws {
        guard try requireUInt32(object["schemaVersion"]) == 1,
              object["kind"] as? String == kind,
              object["protocol"] as? String == RuntimeBrokerContract.fixtureProtocol else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
    }

    private static func requireChallenge(_ value: Any?) throws -> Data {
        guard let encoded = value as? String,
              let challenge = Data(base64Encoded: encoded),
              challenge.count == RuntimeBrokerContract.challengeByteCount,
              challenge.base64EncodedString() == encoded else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        return challenge
    }

    private static func requireUInt32(_ value: Any?) throws -> UInt32 {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              number.doubleValue >= 0,
              number.doubleValue <= Double(UInt32.max),
              number.doubleValue.rounded(.towardZero) == number.doubleValue else {
            throw RuntimeBrokerFixtureEnvelopeError.malformed
        }
        return number.uint32Value
    }
}
