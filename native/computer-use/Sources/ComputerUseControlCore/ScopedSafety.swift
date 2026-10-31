import Foundation
#if !CORE_CHECKS
import ComputerUseApproval
#endif

/// All signals are required evidence. Nil means unverified, not a safe default.
/// This pure gate does not inspect the OS, capture pixels or dispatch input.
public struct ScopedSafetyEvidence {
    public var grantValid: Bool?
    public var accessibility: Bool?
    public var screenRecording: Bool?
    public var screenUnlocked: Bool?
    public var secureInputDisabled: Bool?
    public var humanIdle: Bool?
    public var protectedSurfaceAbsent: Bool?
    public var allRelevantSurfacesIdentified: Bool?
    public var observationCurrent: Bool?
    public var displayLayoutUnchanged: Bool?
    public var capturedDisplayMatches: Bool?
    public var foregroundMatchesObservation: Bool?
    public var target: ScopeApplicationIdentity?
    public init(grantValid: Bool?, accessibility: Bool?, screenRecording: Bool?, screenUnlocked: Bool?,
                secureInputDisabled: Bool?, humanIdle: Bool?, protectedSurfaceAbsent: Bool?,
                allRelevantSurfacesIdentified: Bool?, observationCurrent: Bool?, displayLayoutUnchanged: Bool?,
                capturedDisplayMatches: Bool?, foregroundMatchesObservation: Bool?, target: ScopeApplicationIdentity?) {
        self.grantValid = grantValid; self.accessibility = accessibility; self.screenRecording = screenRecording
        self.screenUnlocked = screenUnlocked; self.secureInputDisabled = secureInputDisabled; self.humanIdle = humanIdle
        self.protectedSurfaceAbsent = protectedSurfaceAbsent; self.allRelevantSurfacesIdentified = allRelevantSurfacesIdentified
        self.observationCurrent = observationCurrent; self.displayLayoutUnchanged = displayLayoutUnchanged
        self.capturedDisplayMatches = capturedDisplayMatches; self.foregroundMatchesObservation = foregroundMatchesObservation
        self.target = target
    }
}

public enum ScopedSafety {
    /// The caller must independently collect fresh OS evidence at every dispatch boundary and after each await.
    /// A passing gate is not proof that an OS action occurred and does not itself authorize a grant.
    public static func require(_ evidence: ScopedSafetyEvidence, scope: ScopeApprovalScope,
                               coordinates: Bool, keyboard: Bool) throws {
        guard evidence.grantValid == true else { throw ControlError.refuse("grant-unknown") }
        guard evidence.accessibility == true, evidence.screenRecording == true else { throw ControlError.refuse("permission-unavailable") }
        guard evidence.screenUnlocked == true, evidence.secureInputDisabled == true else { throw ControlError.refuse("secure-state-unavailable") }
        guard evidence.humanIdle == true else { throw ControlError.refuse("human-active-or-unavailable") }
        guard evidence.protectedSurfaceAbsent == true, evidence.allRelevantSurfacesIdentified == true else {
            throw ControlError.refuse("protected-surface-or-unavailable")
        }
        guard evidence.observationCurrent == true, evidence.displayLayoutUnchanged == true else { throw ControlError.refuse("stale-observation") }
        if coordinates, evidence.capturedDisplayMatches != true { throw ControlError.refuse("capture-required") }
        if keyboard, evidence.foregroundMatchesObservation != true { throw ControlError.refuse("target-changed") }
        guard let target = evidence.target, ComputerUseScopeApproval.validApplication(target),
              !ScopedProtectedTargets.refuses(bundleId: target.bundleId) else { throw ControlError.refuse("target-unavailable") }
        if case .application(let selected) = scope, selected != target { throw ControlError.refuse("target-changed") }
    }
}
