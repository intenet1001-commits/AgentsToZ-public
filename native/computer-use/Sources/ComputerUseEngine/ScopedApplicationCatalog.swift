import AppKit
import ComputerUseApproval
import ComputerUseControlCore
import Foundation

/// Read-only identities for the person's application picker. It does not authorize control or launch an app.
public enum ScopedApplicationCatalog {
    @MainActor public static func identity(pid: Int32) throws -> ScopeApplicationIdentity {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.activationPolicy == .regular, let bundle = app.bundleIdentifier,
              !ScopedProtectedTargets.refuses(bundleId: bundle), let start = ProcessGeneration.start(pid) else {
            throw ControlError.refuse("target-unavailable")
        }
        let signature = try ComputerUseEngine.signature(pid)
        let identity = ScopeApplicationIdentity(bundleId: bundle, teamId: signature.team, codeHash: signature.hash,
                                                pid: pid, processStart: String(start))
        guard ComputerUseScopeApproval.validApplication(identity), ProcessGeneration.start(pid) == start,
              !app.isTerminated else { throw ControlError.refuse("identity-unavailable") }
        return identity
    }
    @MainActor public static func list(limit: Int = 100) -> [[String: Any]] {
        let maxCount = max(0, min(100, limit))
        var entries: [[String: Any]] = []
        for app in NSWorkspace.shared.runningApplications where entries.count < maxCount {
            guard let identity = try? identity(pid: app.processIdentifier) else { continue }
            entries.append(["name": String((app.localizedName ?? identity.bundleId).prefix(100)),
                            "application": ["bundleId": identity.bundleId, "teamId": identity.teamId,
                                            "codeHash": identity.codeHash, "pid": identity.pid,
                                            "processStart": identity.processStart]])
        }
        return entries
    }
}
