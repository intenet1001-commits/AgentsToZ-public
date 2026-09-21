import Darwin
import Foundation
import RuntimeBrokerProtocol

private func runContractTests() throws -> Bool {
    guard RuntimeBrokerBuildIdentity.productionTeamIdentifier == nil,
          RuntimeBrokerSecurityRequirements.validatedProductionTeamIdentifier() == nil else {
        return false
    }

    let team = "9Z9Z9Z9Z9Y"
    let clientRequirement = RuntimeBrokerSecurityRequirements.clientRequirement(
        teamIdentifier: team
    )
    let brokerRequirement = RuntimeBrokerSecurityRequirements.brokerRequirement(
        teamIdentifier: team
    )
    guard clientRequirement == "anchor apple generic" +
        " and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
        " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
        " and certificate leaf[subject.OU] = \"9Z9Z9Z9Z9Y\"" +
        " and identifier \"com.intenet.agentstozbycs\"" +
        " and entitlement[\"com.intenet.agentstozbycs.runtime-broker.client\"] = \"client-v1\"",
          brokerRequirement == "anchor apple generic" +
        " and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
        " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists" +
        " and certificate leaf[subject.OU] = \"9Z9Z9Z9Z9Y\"" +
        " and identifier \"com.intenet.agentstozbycs.runtime-broker\"" +
        " and entitlement[\"com.intenet.agentstozbycs.runtime-broker.service\"] = \"service-v1\"" else {
        return false
    }

    let challenge = Data(repeating: 0xA5, count: RuntimeBrokerContract.challengeByteCount)
    let request = try RuntimeBrokerFixtureRequest(challenge: challenge)
    let encodedRequest = try RuntimeBrokerFixtureEnvelope.encodeRequest(request)
    guard try RuntimeBrokerFixtureEnvelope.decodeRequest(encodedRequest) == request else {
        return false
    }

    let encodedResponse = try RuntimeBrokerFixtureEnvelope.encodeResponse(
        request: request,
        effectiveUserIdentifier: 501,
        effectiveGroupIdentifier: 20
    )
    let response = try RuntimeBrokerFixtureEnvelope.decodeResponse(encodedResponse)
    guard response.challenge == challenge,
          response.effectiveUserIdentifier == 501,
          response.effectiveGroupIdentifier == 20 else {
        return false
    }

    let encodedChallenge = challenge.base64EncodedString()
    let unknownKey = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1,
        "kind": "agentstoz-runtime-broker-fixture-request",
        "protocol": RuntimeBrokerContract.fixtureProtocol,
        "challenge": encodedChallenge,
        "extra": "rejected",
    ])
    do {
        _ = try RuntimeBrokerFixtureEnvelope.decodeRequest(unknownKey)
        return false
    } catch {}

    let nonCanonicalRequest = Data("{ \"challenge\":\"\(encodedChallenge)\",\"kind\":\"agentstoz-runtime-broker-fixture-request\",\"protocol\":\"bounded-stdio-challenge-v1\",\"schemaVersion\":1}".utf8)
    do {
        _ = try RuntimeBrokerFixtureEnvelope.decodeRequest(nonCanonicalRequest)
        return false
    } catch {}

    let booleanVersion = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": true,
        "kind": "agentstoz-runtime-broker-fixture-request",
        "protocol": RuntimeBrokerContract.fixtureProtocol,
        "challenge": encodedChallenge,
    ])
    do {
        _ = try RuntimeBrokerFixtureEnvelope.decodeRequest(booleanVersion)
        return false
    } catch {}

    let proofData = try RuntimeBrokerFixtureEnvelope.encodePublicProof()
    guard let proof = try JSONSerialization.jsonObject(with: proofData) as? [String: Any],
          proof["result"] as? String == "passed",
          proof["mode"] as? String == "development-same-uid",
          proof["serviceRegistered"] as? Bool == false,
          proof["accountCreated"] as? Bool == false,
          proof["containerInvoked"] as? Bool == false,
          proof["authoritative"] as? Bool == false,
          proof["reusable"] as? Bool == false,
          proof["ready"] as? Bool == false else {
        return false
    }
    return true
}

@main
private struct RuntimeBrokerProtocolSelfTestMain {
    static func main() {
        do {
            guard try runContractTests() else {
                FileHandle.standardError.write(Data("runtime-protocol-self-test: rejected\n".utf8))
                exit(1)
            }
            FileHandle.standardOutput.write(Data("runtime-protocol-self-test: passed\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("runtime-protocol-self-test: failed\n".utf8))
            exit(1)
        }
    }
}
