import ComputerUseApproval
import ComputerUseControlCore
import Foundation

/// The one XPC method, fixed with the main app's bridge (CONTRACT.md section 1): bounded JSON in, bounded JSON out.
/// There is no method to approve, sign, read keys, start processes or change settings: approvals happen only in
/// Control's own window.
@objc(AgentsToZControlXPC) protocol AgentsToZControlXPC {
    func request(_ data: Data, reply: @escaping @Sendable (Data) -> Void)
    /// Read-only process generation of this signed XPC peer, for cooperative UI activation only.
    func reviewIdentity(_ reply: @escaping @Sendable (Int32, UInt64) -> Void)
}

/// One accepted connection of the verified main app. Requests carry no identity: their owner is this connection's
/// main process generation, fixed when it was accepted and checked again for every request (ControlService.handle).
final class ControlEndpoint: NSObject, AgentsToZControlXPC, @unchecked Sendable {
    let owner: ControlOwner
    init(owner: ControlOwner) { self.owner = owner }
    func reviewIdentity(_ reply: @escaping @Sendable (Int32, UInt64) -> Void) {
        let pid = ProcessInfo.processInfo.processIdentifier
        guard let start = ProcessGeneration.start(pid), ProcessGeneration.alive(owner) else { reply(0, 0); return }
        reply(pid, start)
    }
    func request(_ data: Data, reply: @escaping @Sendable (Data) -> Void) {
        guard data.count <= ControlLimits.requestBytes else { reply(ControlResponse.failure(.invalid)); return }
        let owner = self.owner
        Task { @MainActor in reply(await ControlShared.service.handle(data, owner: owner)) }
    }
}

/// Listens on the LaunchAgent's Mach service. Only the AgentsToZ main app signed with the team's Developer ID passes
/// the connection requirement: a fixed string set once before `resume()`. A same-user process with another signature,
/// an ad-hoc copy, a CLI or an agent shell never reaches `request`. No path, executable or requirement comes from a
/// peer, and nothing is read from the environment or disk to decide who may connect.
final class ControlListener: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener = NSXPCListener(machServiceName: ControlContract.machService)

    static func start() -> ControlListener {
        let control = ControlListener()
        control.listener.setConnectionCodeSigningRequirement(HelperSigning.requirement(identifier: HelperSigning.appIdentifier))
        control.listener.delegate = control
        control.listener.resume()
        return control
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        // The process the system reports for this connection and that process's kernel start time: a restarted main
        // app or a reused PID is another owner and inherits nothing.
        guard let owner = ProcessGeneration.owner(connection.processIdentifier) else { return false }
        connection.exportedInterface = NSXPCInterface(with: AgentsToZControlXPC.self)
        connection.exportedObject = ControlEndpoint(owner: owner)
        // A closed or interrupted connection ends nothing: the main app's bridge connects per request. The owner's
        // grants end with its process, its sidecar channel (`disconnect-owner`) or their own expiry.
        connection.resume()
        return true
    }
}
