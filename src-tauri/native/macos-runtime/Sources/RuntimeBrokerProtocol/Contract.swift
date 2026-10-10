import Foundation

public enum RuntimeBrokerContract {
    public static let brokerIdentifier = "com.intenet.agentstozbycs.runtime-broker"
    public static let applicationIdentifier = "com.intenet.agentstozbycs"
    public static let brokerExecutableName = brokerIdentifier
    public static let brokerFixtureExecutableName = "com.intenet.agentstozbycs.runtime-broker-fixture"
    public static let workerFixtureExecutableName = "com.intenet.agentstozbycs.runtime-worker-fixture"
    public static let dedicatedWorkerFixtureExecutableName = "com.intenet.agentstozbycs.runtime-dedicated-worker-fixture"
    public static let launchDaemonPropertyListName = "\(brokerIdentifier).plist"

    public static let clientEntitlement = "com.intenet.agentstozbycs.runtime-broker.client"
    public static let clientEntitlementValue = "client-v1"
    public static let serviceEntitlement = "com.intenet.agentstozbycs.runtime-broker.service"
    public static let serviceEntitlementValue = "service-v1"

    public static let developerIDApplicationOID = "1.2.840.113635.100.6.1.13"
    public static let developerIDIssuerOID = "1.2.840.113635.100.6.2.6"

    public static let fixtureFlag = "--harmless-self-test-v1"
    public static let workerFixtureFlag = "--harmless-worker-fixture-v1"
    public static let dedicatedWorkerFixtureFlag = "--harmless-dedicated-worker-fixture-v1"
    public static let fixtureProtocol = "bounded-stdio-challenge-v1"
    public static let challengeByteCount = 32
    public static let maximumWireBytes = 4_096
    public static let dedicatedAccountName = "_agentstoz"
    public static let dedicatedAccountHome = "/var/empty"
    public static let dedicatedAccountShell = "/usr/bin/false"
    public static let dedicatedIdentifierRange = 400...499
    public static let dedicatedAccountManifestPath = "/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/dedicated-account-v1.json"
    public static let dedicatedFixtureRoot = "/Library/Application Support/com.intenet.agentstozbycs/agent-runtime/fixtures"
    public static let dedicatedFixtureRequestPath = "\(dedicatedFixtureRoot)/dedicated-worker.request"
    public static let dedicatedFixtureStandardOutputPath = "\(dedicatedFixtureRoot)/dedicated-worker.stdout"
    public static let dedicatedFixtureStandardErrorPath = "\(dedicatedFixtureRoot)/dedicated-worker.stderr"
    public static let dedicatedWorkerFixtureServiceLabel = "com.intenet.agentstozbycs.runtime-dedicated-worker-fixture"
    public static let dedicatedWorkerFixturePlistPath = "/Applications/AgentsToZ_byCS.app/Contents/Library/LaunchServices/\(dedicatedWorkerFixtureServiceLabel).plist"
    public static let dedicatedWorkerFixtureExecutablePath = "/Applications/AgentsToZ_byCS.app/Contents/Library/LaunchServices/\(dedicatedWorkerFixtureExecutableName)"
}

/// This is generated into the native product from the real Developer ID team
/// before a production broker can be built. It intentionally has no
/// environment-variable, command-line, plist, or caller-provided fallback.
public enum RuntimeBrokerBuildIdentity {
    public static let productionTeamIdentifier: String? = nil
}

/// The first broker surface is deliberately probe-only. It cannot receive a
/// command, executable, path, environment, credential, or Apple Container
/// request.
@objc public protocol RuntimeBrokerXPCProtocol {
    func probe(_ challenge: NSData, withReply reply: @escaping (NSData) -> Void)
    func runDedicatedIdentityFixture(
        _ challenge: NSData,
        withReply reply: @escaping (NSData) -> Void
    )
    func provisionDedicatedIdentity(
        _ challenge: NSData,
        withReply reply: @escaping (NSData) -> Void
    )
}
