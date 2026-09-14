import Darwin
import Foundation
import RuntimeBrokerProtocol

private enum BrokerExit: Int32 {
    case invalidInvocation = 64
    case unsupportedPlatform = 69
    case rootRequired = 77
    case launchdRequired = 78
    case productionIdentityUnavailable = 79
    case selfSignatureRejected = 80
}

private func fail(_ message: StaticString, _ code: BrokerExit) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(code.rawValue)
}

private final class RuntimeBrokerProbeService: NSObject, RuntimeBrokerXPCProtocol {
    private let fixtureQueue = DispatchQueue(
        label: "com.intenet.agentstozbycs.runtime-broker.identity-fixture"
    )

    func probe(_ challenge: NSData, withReply reply: @escaping (NSData) -> Void) {
        guard challenge.length == RuntimeBrokerContract.challengeByteCount else {
            reply(NSData())
            return
        }
        reply(NSData(data: challenge as Data))
    }

    func runDedicatedIdentityFixture(
        _ challenge: NSData,
        withReply reply: @escaping (NSData) -> Void
    ) {
        let request = challenge as Data
        guard request.count == RuntimeBrokerContract.challengeByteCount else {
            reply(NSData())
            return
        }
        fixtureQueue.async {
            guard let proof = RuntimeDedicatedIdentityFixture.run(challenge: request) else {
                reply(NSData())
                return
            }
            reply(NSData(data: proof))
        }
    }

    func provisionDedicatedIdentity(
        _ challenge: NSData,
        withReply reply: @escaping (NSData) -> Void
    ) {
        let request = challenge as Data
        guard request.count == RuntimeBrokerContract.challengeByteCount else {
            reply(NSData())
            return
        }
        fixtureQueue.async {
            guard let proof = RuntimeDedicatedAccountProvisioner.provision(challenge: request) else {
                reply(NSData())
                return
            }
            reply(NSData(data: proof))
        }
    }
}

private final class RuntimeBrokerListenerDelegate: NSObject, NSXPCListenerDelegate {
    func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection connection: NSXPCConnection
    ) -> Bool {
        guard connection.processIdentifier > 1 else {
            return false
        }
        connection.exportedInterface = NSXPCInterface(with: RuntimeBrokerXPCProtocol.self)
        connection.exportedObject = RuntimeBrokerProbeService()
        connection.resume()
        return true
    }
}

@main
private struct RuntimeBrokerMain {
    static func main() {
        guard CommandLine.arguments.count == 1 else {
            fail("runtime-broker: invalid invocation", .invalidInvocation)
        }
        guard #available(macOS 26.0, *) else {
            fail("runtime-broker: unsupported platform", .unsupportedPlatform)
        }
        guard geteuid() == 0, getegid() == 0 else {
            fail("runtime-broker: root launch daemon required", .rootRequired)
        }
        guard getppid() == 1 else {
            fail("runtime-broker: launchd parent required", .launchdRequired)
        }
        guard let teamIdentifier =
            RuntimeBrokerSecurityRequirements.validatedProductionTeamIdentifier() else {
            fail("runtime-broker: production identity unavailable", .productionIdentityUnavailable)
        }
        guard RuntimeBrokerSecurityRequirements.currentProcessSatisfiesBrokerRequirement(
            teamIdentifier: teamIdentifier
        ) else {
            fail("runtime-broker: self signature rejected", .selfSignatureRejected)
        }

        _ = umask(0o077)
        let delegate = RuntimeBrokerListenerDelegate()
        let listener = NSXPCListener(
            machServiceName: RuntimeBrokerContract.brokerIdentifier
        )
        listener.delegate = delegate
        listener.setConnectionCodeSigningRequirement(
            RuntimeBrokerSecurityRequirements.clientRequirement(
                teamIdentifier: teamIdentifier
            )
        )
        listener.activate()
        withExtendedLifetime(delegate) {
            dispatchMain()
        }
    }
}
