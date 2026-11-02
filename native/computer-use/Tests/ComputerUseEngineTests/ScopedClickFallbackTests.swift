import XCTest
import ComputerUseControlCore
@testable import ComputerUseEngine

final class ScopedClickFallbackTests: XCTestCase {
    func testAXOnlyNeverInvokesPointerAndReturnsRefusal() {
        var pointerCalls = 0
        let result = ScopedClickFallback.perform(accessibilityOnly: true) { pointerCalls += 1; return .confirmed }
        XCTAssertEqual(result, .refused("ax-target-unavailable")); XCTAssertEqual(pointerCalls, 0)
        let normal = ScopedClickFallback.perform(accessibilityOnly: false) { pointerCalls += 1; return .confirmed }
        XCTAssertEqual(normal, .confirmed); XCTAssertEqual(pointerCalls, 1)
    }
}
