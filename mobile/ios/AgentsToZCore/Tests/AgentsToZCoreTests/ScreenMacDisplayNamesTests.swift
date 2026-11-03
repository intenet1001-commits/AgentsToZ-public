#if !CORE_CHECKS
@testable import AgentsToZCore
#endif

struct ScreenMacDisplayNamesChecks {
    func runAll() throws {
        try testAliasesAreIsolatedByFingerprintAndCanBeRestored()
        try testInvalidNamesAndDamagedStoreDoNotOverwrite()
    }

    func testAliasesAreIsolatedByFingerprintAndCanBeRestored() throws {
        let first = try ScreenMacDisplayNames.updating(json: "{}", id: "a", name: " 작업용 Mac ")
        let second = try ScreenMacDisplayNames.updating(json: first, id: "b", name: "집 Mac")
        try checkEqual(ScreenMacDisplayNames.displayName(json: second, id: "a", fallback: "원래"), "작업용 Mac")
        try checkEqual(ScreenMacDisplayNames.displayName(json: second, id: "b", fallback: "원래"), "집 Mac")
        let restored = try ScreenMacDisplayNames.updating(json: second, id: "a", name: nil)
        try checkEqual(ScreenMacDisplayNames.displayName(json: restored, id: "a", fallback: "원래"), "원래")
        try checkEqual(ScreenMacDisplayNames.displayName(json: restored, id: "b", fallback: "원래"), "집 Mac")
    }

    func testInvalidNamesAndDamagedStoreDoNotOverwrite() throws {
        for name in ["   ", "줄\n바꿈", "\n앞", "뒤\n", String(repeating: "a", count: 65)] {
            try checkThrows(ScreenMacDisplayNames.updating(json: "{}", id: "a", name: name))
        }
        try checkThrows(ScreenMacDisplayNames.updating(json: "{broken", id: "a", name: "Mac"))
        try checkEqual(ScreenMacDisplayNames.displayName(json: "{broken", id: "a", fallback: "Mac"), "Mac")
    }
}

#if !CORE_CHECKS
import XCTest
final class ScreenMacDisplayNamesTests: XCTestCase {
    func testScreenMacDisplayNames() throws { try ScreenMacDisplayNamesChecks().runAll() }
}
#endif
