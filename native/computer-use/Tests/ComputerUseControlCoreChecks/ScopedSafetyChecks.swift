import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

struct ScopedSafetyChecks {
    static func testUnknownEvidenceFailsClosed() throws {
        let target = ScopeApplicationIdentity(bundleId: "com.stablyai.orca", teamId: "", codeHash: String(repeating: "a", count: 40), pid: 7, processStart: "9")
        let okay = ScopedSafetyEvidence(grantValid: true, accessibility: true, screenRecording: true, screenUnlocked: true,
            secureInputDisabled: true, humanIdle: true, protectedSurfaceAbsent: true, allRelevantSurfacesIdentified: true,
            observationCurrent: true, displayLayoutUnchanged: true, capturedDisplayMatches: true,
            foregroundMatchesObservation: true, target: target)
        try ScopedSafety.require(okay, scope: .application(target), coordinates: true, keyboard: true)
        var unknown = okay; unknown.screenUnlocked = nil
        try expectCode("secure-state-unavailable", notDispatched: true) { try ScopedSafety.require(unknown, scope: .desktop, coordinates: true, keyboard: false) }
        var overlay = okay; overlay.allRelevantSurfacesIdentified = nil
        try expectCode("protected-surface-or-unavailable", notDispatched: true) { try ScopedSafety.require(overlay, scope: .desktop, coordinates: true, keyboard: false) }
        var takeover = okay; takeover.humanIdle = false
        try expectCode("human-active-or-unavailable", notDispatched: true) { try ScopedSafety.require(takeover, scope: .desktop, coordinates: true, keyboard: false) }
        var stale = okay; stale.displayLayoutUnchanged = false
        try expectCode("stale-observation", notDispatched: true) { try ScopedSafety.require(stale, scope: .desktop, coordinates: true, keyboard: false) }
        var mismatch = okay; mismatch.capturedDisplayMatches = false
        try expectCode("capture-required", notDispatched: true) { try ScopedSafety.require(mismatch, scope: .desktop, coordinates: true, keyboard: false) }
        let replaced = ScopeApplicationIdentity(bundleId: target.bundleId, teamId: target.teamId, codeHash: target.codeHash, pid: target.pid, processStart: "10")
        try expectCode("target-changed", notDispatched: true) { try ScopedSafety.require(okay, scope: .application(replaced), coordinates: true, keyboard: true) }
        var protected = okay
        protected.target = ScopeApplicationIdentity(bundleId: "com.apple.SecurityAgent", teamId: "", codeHash: String(repeating: "a", count: 40), pid: 7, processStart: "9")
        try expectCode("target-unavailable", notDispatched: true) { try ScopedSafety.require(protected, scope: .desktop, coordinates: true, keyboard: false) }
    }
}
