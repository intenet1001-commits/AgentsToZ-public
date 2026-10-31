import Foundation

/// The v2 scope intentionally permits agent apps and terminals. Privileged AgentsToZ and OS security surfaces remain
/// excluded; a nil or unverifiable bundle must be refused by the caller rather than treated as an ordinary app.
/// One golden list (Tests/ControlContract/protected-targets.json) is compared with this file and with
/// src/computerUseScopeProtocol.ts, so neither side can drift. Bundle IDs were read from the installed apps and their
/// code signatures on macOS 26.7 (2026-10-29), not guessed.
public enum ScopedProtectedTargets {
    /// Never a target or a capture subject. A window of one of these above layer 0 blocks capture and input.
    static let bundles: Set<String> = [
        "com.intenet.agentstozbycs", "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.windowserver"]
    /// OS authentication, consent and security prompts. Any visible window of one, at any layer and on any display,
    /// blocks capture and input, not only when it is the window under the point.
    static let securitySurfaces: Set<String> = [
        "com.apple.loginwindow", "com.apple.passwords", "com.apple.securityagent", "com.apple.securityagenthelper.arm64",
        "com.apple.securityagenthelper.x86_64", "com.apple.authorizationhost",
        // TCC and other CFUserNotification consent alerts; Gatekeeper/quarantine prompts (CoreServicesUIAgent);
        // the Touch ID / password sheet (coreautha) and LocalAuthentication's remote view service.
        "com.apple.usernotificationcenter", "com.apple.coreservices.uiagent", "com.apple.localauthentication.uiagent",
        "com.apple.localauthenticationremoteservice",
        // Certificate trust, iCloud Keychain escrow and keychain-circle approval prompts.
        "com.apple.certificateassistant", "com.apple.escrowsecurityalert", "com.apple.security.keychain-circle-notification"]
    static let prefixes = ["com.intenet.agentstozbycs.", "com.apple.securityagent"]
    public static func refuses(bundleId: String?) -> Bool {
        guard let bundleId, !bundleId.isEmpty else { return true }
        let lower = bundleId.lowercased()
        return bundles.contains(lower) || securitySurfaces.contains(lower) || prefixes.contains { lower.hasPrefix($0) }
    }
    /// Whether a visible window of this owner blocks everything wherever it is. An unidentified owner does.
    public static func blocksWhileVisible(bundleId: String?) -> Bool {
        guard let bundleId, !bundleId.isEmpty else { return true }
        let lower = bundleId.lowercased()
        return securitySurfaces.contains(lower) || lower.hasPrefix("com.apple.securityagent")
    }
}
