import Foundation
#if !CORE_CHECKS
@testable import ComputerUseControlCore
import ComputerUseApproval
#endif

struct ScopeProtocolChecks {
    static func testProtectedTargets() throws {
        try check(ScopedProtectedTargets.refuses(bundleId: nil), "unidentified targets are refused")
        try check(ScopedProtectedTargets.refuses(bundleId: "com.intenet.agentstozbycs.control"), "Control is protected")
        try check(ScopedProtectedTargets.refuses(bundleId: "com.apple.SecurityAgent"), "OS authentication is protected")
        try check(ScopedProtectedTargets.refuses(bundleId: "com.apple.systempreferences"), "OS permission settings are protected")
        try check(!ScopedProtectedTargets.refuses(bundleId: "com.stablyai.orca"), "v2 can admit Orca subject to other guards")
        try check(!ScopedProtectedTargets.refuses(bundleId: "com.nousresearch.hermes"), "v2 can admit Hermes subject to other guards")
        for prompt in ["com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent", "com.apple.LocalAuthentication.UIAgent",
                       "com.apple.authorizationhost", "com.apple.SecurityAgentHelper.arm64", "com.apple.loginwindow"] {
            try check(ScopedProtectedTargets.refuses(bundleId: prompt), "\(prompt) is never a target")
            try check(ScopedProtectedTargets.blocksWhileVisible(bundleId: prompt), "a visible \(prompt) window blocks everything")
        }
        try check(ScopedProtectedTargets.blocksWhileVisible(bundleId: nil), "an unidentified owner blocks")
        try check(!ScopedProtectedTargets.blocksWhileVisible(bundleId: "com.intenet.agentstozbycs"),
                  "an ordinary AgentsToZ window behind the target is excluded from capture, not a global block")
        try check(!ScopedProtectedTargets.blocksWhileVisible(bundleId: "com.apple.dock"), "the Dock is not a security surface")
    }
    /// Both Swift lists equal the golden file that src/computerUseProtocol.ts and src/computerUseScopeProtocol.ts are
    /// compared with too (tests/computer-use-scope.test.ts), so a list changed on one side alone fails on both.
    static func testProtectedTargetsMatchGolden(fixturePath: String) throws {
        let url = URL(fileURLWithPath: fixturePath).deletingLastPathComponent().appendingPathComponent("protected-targets.json")
        guard let golden = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
              let scope = golden["scope"] as? [String: Any], let window = golden["window"] as? [String: Any] else {
            throw CheckFailure(description: "protected-targets.json is unreadable")
        }
        func list(_ section: [String: Any], _ key: String, lower: Bool = true) throws -> Set<String> {
            guard let values = section[key] as? [String], !values.isEmpty, Set(values).count == values.count else {
                throw CheckFailure(description: "\(key) is not a unique, non-empty string list")
            }
            return Set(values.map { lower ? $0.lowercased() : $0 })
        }
        let lowered = { (values: [String]) in Set(values.map { $0.lowercased() }) }
        try check(ScopedProtectedTargets.bundles == list(scope, "bundles"), "scope bundles equal the golden list")
        try check(ScopedProtectedTargets.securitySurfaces == list(scope, "securitySurfaces"), "scope security surfaces equal the golden list")
        try check(Set(ScopedProtectedTargets.prefixes) == list(scope, "prefixes"), "scope prefixes equal the golden list")
        try check(lowered(Array(RefusedTargets.bundles)) == list(window, "bundles"), "window bundles equal the golden list")
        try check(RefusedTargets.bundles.count == lowered(Array(RefusedTargets.bundles)).count, "window bundles differ by more than case")
        try check(lowered(RefusedTargets.prefixes) == list(window, "prefixes"), "window prefixes equal the golden list")
        try check(RefusedTargets.teams == list(window, "teams", lower: false), "window teams equal the golden list")
        for bundle in ScopedProtectedTargets.bundles.union(ScopedProtectedTargets.securitySurfaces) {
            try check(RefusedTargets.refuses(bundle: bundle), "window mode also refuses \(bundle)")
            try check(ScopedProtectedTargets.refuses(bundleId: bundle), "\(bundle) is refused by the scope")
        }
        for prefix in ScopedProtectedTargets.prefixes {
            try check(RefusedTargets.refuses(bundle: prefix + "x"), "window mode also refuses the prefix \(prefix)")
        }
    }
    static func testStrictV2Shapes() throws {
        let caller: [String: Any] = ["sessionId": "session_1", "lane": "leader", "generation": String(repeating: "a", count: 32)]
        let app: [String: Any] = ["bundleId": "com.example.Editor", "teamId": "ABCDE12345",
                                  "codeHash": String(repeating: "b", count: 40), "pid": 42, "processStart": "1000"]
        let application: [String: Any] = ["kind": "application", "application": app]
        let desktop: [String: Any] = ["kind": "desktop"]
        let approval = String(repeating: "c", count: 64), grant = String(repeating: "d", count: 32)
        let base: [String: Any] = ["grant": grant, "caller": caller, "requestId": "request_123", "snapshotId": "snap-1"]
        func merged(_ extra: [String: Any]) -> [String: Any] { base.merging(extra) { _, b in b } }
        let requests: [String: [String: Any]] = [
            "scope-status": [:], "scope-request-approval": ["approvalId": approval, "scope": desktop, "caller": caller, "label": "test", "expiresAt": 1000],
            "scope-approval-status": ["approvalId": approval, "caller": caller],
            "scope-open-grant": ["approvalId": approval, "scope": application, "caller": caller],
            "scope-observe": ["grant": grant, "caller": caller],
            "scope-capture": ["grant": grant, "caller": caller, "snapshotId": "snap-1", "displayId": "display-1"],
            "scope-click": merged(["displayId": "display-1", "x": 12.5, "y": 1, "button": "left", "clickCount": 2]),
            "scope-type-text": merged(["text": "검증"]), "scope-key": merged(["key": "Enter", "modifiers": ["cmd", "shift"]]),
            "scope-scroll": merged(["displayId": "display-1", "x": 0, "y": 1, "deltaX": -1200, "deltaY": 1200]),
            "scope-drag": merged(["displayId": "display-1", "x": 0, "y": 1, "endX": 50, "endY": 50]),
            "scope-focus-app": merged(["applicationId": "app-1"]),
            "scope-receipt": ["grant": grant, "caller": caller, "requestId": "request_123"],
            "scope-revoke": ["grant": grant, "caller": caller], "scope-revoke-session": ["sessionId": "session_1"],
            "scope-disconnect-owner": [:], "scope-standing-off": [:]]
        try check(Set(requests.keys) == ScopeControlRequest.agentOperations, "all supported agent shapes have fixtures")
        func decode(_ op: String, _ fields: [String: Any], channel: String = "agent", version: Any = 2) throws -> ScopeControlRequest {
            let envelope = fields.merging(["v": version, "channel": channel, "op": op]) { _, b in b }
            return try ScopeControlRequest.decode(JSONSerialization.data(withJSONObject: envelope))
        }
        for (op, fields) in requests { let decoded = try decode(op, fields); try check(decoded.operation == op, "valid v2 shape \(op)") }
        let catalog = try decode("scope-catalog", [:], channel: "management")
        try check(catalog.operation == "scope-catalog", "management catalog")
        try expectCode("invalid-request") { _ = try decode("scope-catalog", [:]) }
        try expectCode("invalid-request") { _ = try decode("scope-observe", requests["scope-observe"]!, channel: "management") }
        try expectCode("invalid-request") { _ = try decode("scope-status", [:], version: 1) }
        try expectCode("invalid-request") { _ = try decode("scope-status", [:], version: true) }
        try expectCode("invalid-request") { _ = try decode("scope-status", ["extra": true]) }
        try expectCode("invalid-request") { _ = try decode("scope-open-grant", ["approvalId": approval, "scope": ["kind": "desktop", "pid": 42], "caller": caller]) }
        try expectCode("invalid-request") { _ = try decode("scope-click", merged(["displayId": "display-1", "x": -1, "y": 1, "button": "left", "clickCount": 1])) }
        try expectCode("invalid-request") { _ = try decode("scope-key", merged(["key": "Enter", "modifiers": ["cmd", "cmd"]])) }
        try expectCode("invalid-request") { _ = try decode("scope-scroll", merged(["displayId": "display-1", "x": 1, "y": 1, "deltaX": 1201, "deltaY": 0])) }
        try expectCode("invalid-request") { _ = try decode("scope-type-text", merged(["text": String(repeating: "x", count: 4001)])) }
        try expectCode("invalid-request") { _ = try decode("scope-type-text", merged(["text": "a\u{0}b"])) }
        // Turning the standing allowance off carries nothing; nothing in the protocol turns it on.
        try expectCode("invalid-request") { _ = try decode("scope-standing-off", ["since": 1]) }
        try check(!ScopeControlRequest.shapes.keys.contains { $0.contains("standing") && $0 != "scope-standing-off" },
                  "no operation turns the standing allowance on")
    }
    /// The allowance's key label is the only record of it: exact, desktop only, no leading zero or overflow.
    static func testStandingAllowanceLabel() throws {
        let on = StandingAllowance(since: 1_793_400_000_000)
        try check(on.label == "agentstoz-standing scope=desktop since=1793400000000", "label format")
        try check(StandingAllowance.parse(on.label) == on, "label round trip")
        for bad in ["", "agentstoz-standing scope=desktop since=", "agentstoz-standing scope=desktop since=0123",
                    "agentstoz-standing scope=application since=1", "agentstoz-standing scope=desktop since=1x",
                    "agentstoz-standing scope=desktop since=99999999999999999", "agentstoz-standing scope=desktop since=-1"] {
            try check(StandingAllowance.parse(bad) == nil, "label \(bad) is refused")
        }
        try check(StandingAllowance.covers(.desktop), "desktop is covered")
        let app = ScopeApplicationIdentity(bundleId: "com.example.app", teamId: "", codeHash: String(repeating: "a", count: 40),
                                           pid: 42, processStart: "1")
        try check(!StandingAllowance.covers(.application(app)), "an application scope always asks the person")
    }
}
