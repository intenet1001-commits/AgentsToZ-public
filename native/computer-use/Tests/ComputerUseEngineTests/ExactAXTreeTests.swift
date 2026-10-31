import XCTest
import ComputerUseControlCore
@testable import ComputerUseEngine

@MainActor
private final class FakeAX: ExactAXDriver {
    struct Node {
        var role = "AXTextField"
        var subrole: ExactAXString = .absent
        var label = "ordinary"
        var value = "before"
        var enabled = true
        var settable = true
        var window = 0
        var children: [Int] = []
    }
    var nodes: [Int: Node] = [0: Node(role: "AXWindow", label: "test", value: "", settable: false, children: [1]), 1: Node()]
    var root = 0
    var reads: [(Int, String)] = []
    var writes: [(Int, String)] = []
    var presses: [Int] = []
    var afterRead: ((Int, String) -> Void)?
    var accepted = true
    var windowFailure = false
    var hit: Int? = 1
    var actionsAllowed = true
    func window() throws -> Int { if windowFailure { throw ControlError("window-not-exact") }; return root }
    func belongs(_ element: Int, to window: Int) -> Bool { nodes[element]?.window == window }
    func string(_ name: String, of element: Int) -> ExactAXString {
        reads.append((element, name))
        guard let node = nodes[element] else { return .failed }
        let result: ExactAXString
        switch name {
        case "AXRole": result = .value(node.role)
        case "AXSubrole": result = node.subrole
        case "AXTitle": result = .value(node.label)
        case "AXValue": result = .value(node.value)
        default: result = .absent
        }
        afterRead?(element, name)
        return result
    }
    func enabled(_ element: Int) -> Bool { nodes[element]?.enabled == true }
    func settable(_ element: Int) -> Bool { nodes[element]?.settable == true }
    func children(_ element: Int, limit: Int) -> (elements: [Int], truncated: Bool) {
        let children = nodes[element]?.children ?? []
        return (Array(children.prefix(limit)), children.count > limit)
    }
    func allowsActions(in window: Int) -> Bool { actionsAllowed }
    func supportsPress(_ element: Int) -> Bool { true }
    func hitTest(x: Double, y: Double, window: Int) -> Int? { hit }
    func setValue(_ value: String, of element: Int) -> Bool {
        writes.append((element, value)); if accepted { nodes[element]?.value = value }; return accepted
    }
    func press(_ element: Int) -> Bool { presses.append(element); nodes[element]?.value = "pressed"; return accepted }
}

final class ExactAXTreeTests: XCTestCase {
    @MainActor func testCoordinatePressRequiresTheSameObservedObjectUntilDispatch() throws {
        let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"
        let tree = ExactAXTree(driver: driver)
        _ = try tree.observe()
        let id = try tree.coordinateElement(x: 10, y: 10)
        XCTAssertThrowsError(try tree.perform("press", element: id, value: nil, coordinate: (10, 10)) {
            driver.hit = 0
        })
        XCTAssertTrue(driver.presses.isEmpty)
        driver.hit = 1
        _ = try tree.observe()
        let again = try tree.coordinateElement(x: 10, y: 10)
        _ = try tree.perform("press", element: again, value: nil, coordinate: (10, 10), beforeDispatch: {})
        XCTAssertEqual(driver.presses, [1])
    }
    @MainActor func testCoordinateLabelAndImageSelectTheirObservedButton() throws {
        for role in ["AXStaticText", "AXImage"] {
            let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"; driver.nodes[1]?.children = [2]
            driver.nodes[2] = FakeAX.Node(role: role, settable: false); driver.hit = 2
            let tree = ExactAXTree(driver: driver)
            _ = try tree.observe()
            let id = try tree.coordinateElement(x: 10, y: 10)
            _ = try tree.perform("press", element: id, value: nil, coordinate: (10, 10), beforeDispatch: {})
            XCTAssertEqual(driver.presses, [1])
        }
    }
    @MainActor func testCoordinateAncestorNeverSubstitutesReparentedSecureOrChangedHit() throws {
        for change in ["reparent", "secure", "hit", "label"] {
            let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"; driver.nodes[1]?.children = [2, 3]
            driver.nodes[2] = FakeAX.Node(role: "AXStaticText", settable: false)
            driver.nodes[3] = FakeAX.Node(role: "AXStaticText", settable: false); driver.hit = 2
            let tree = ExactAXTree(driver: driver)
            _ = try tree.observe()
            let id = try tree.coordinateElement(x: 10, y: 10)
            XCTAssertThrowsError(try tree.perform("press", element: id, value: nil, coordinate: (10, 10)) {
                switch change {
                case "reparent": driver.nodes[1]?.children = [3]
                case "secure": driver.nodes[2]?.subrole = .value("AXSecureTextField")
                case "hit": driver.hit = 3
                default: driver.nodes[2]?.label = "different action"
                }
            }) { error in XCTAssertEqual((error as? ControlError)?.notDispatched, true) }
            XCTAssertTrue(driver.presses.isEmpty)
        }
    }
    @MainActor func testCoordinateDoesNotClimbOutOfInteractiveFieldsOrCanvas() throws {
        for role in ["AXTextField", "AXTextArea", "AXUnknown"] {
            let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"; driver.nodes[1]?.children = [2]
            driver.nodes[2] = FakeAX.Node(role: role); driver.hit = 2
            let tree = ExactAXTree(driver: driver); _ = try tree.observe()
            XCTAssertThrowsError(try tree.coordinateElement(x: 10, y: 10))
            XCTAssertTrue(driver.presses.isEmpty)
        }
    }
    @MainActor func testProtectedWindowIsRefusedBeforeReadingObservationText() throws {
        let driver = FakeAX(); driver.actionsAllowed = false
        XCTAssertThrowsError(try ExactAXTree(driver: driver).observe())
        XCTAssertTrue(driver.reads.isEmpty)
    }
    @MainActor func testModalOrSheetBeforeOrDuringDispatchRefusesOrdinaryInput() throws {
        for late in [false, true] {
            let driver = FakeAX()
            let bound = ExactAXTree(driver: driver)
            let field = try XCTUnwrap(try bound.observe().elements.first { $0["role"] as? String == "AXTextField" })
            if !late { driver.actionsAllowed = false }
            XCTAssertThrowsError(try bound.perform("set-value", element: field["id"] as! String, value: "after") {
                driver.actionsAllowed = false
            }) { error in XCTAssertEqual((error as? ControlError)?.notDispatched, true) }
            XCTAssertTrue(driver.writes.isEmpty)
        }
    }
    @MainActor func testCoordinateRefusesUnobservedOrInvalidHit() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        _ = try tree.observe()
        driver.hit = 3
        XCTAssertThrowsError(try tree.coordinateElement(x: 5, y: 5))
        XCTAssertThrowsError(try tree.coordinateElement(x: .nan, y: 5))
        XCTAssertTrue(driver.presses.isEmpty)
    }
    /// Selecting by coordinate sends nothing, so a window that cannot be read then (closed, AX timeout, the
    /// window-list deadline) is a refusal. Reporting it as possibly sent would stop the grant as outcome-unknown
    /// and hold the app for a person's review although no AXPress ever left.
    @MainActor func testCoordinateWindowReadFailureIsARefusalNotAnUnknownOutcome() throws {
        let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"
        let tree = ExactAXTree(driver: driver)
        _ = try tree.observe()
        driver.windowFailure = true
        XCTAssertThrowsError(try tree.coordinateElement(x: 10, y: 10)) { error in
            let failure = error as? ControlError
            XCTAssertEqual(failure?.notDispatched, true)
            XCTAssertEqual(failure?.code, "window-not-exact")
        }
        XCTAssertTrue(driver.presses.isEmpty)
    }
    @MainActor func testVerifiedAbsentSubroleRestoresOrdinaryInput() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        let result = try tree.observe()
        let field = try XCTUnwrap(result.elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertEqual(field["settable"] as? Bool, true)
        let answer = try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {})
        XCTAssertEqual(driver.writes.count, 1); XCTAssertEqual(driver.writes.first?.0, 1)
        XCTAssertEqual(answer["state"], "confirmed_change")
    }
    @MainActor func testSecureFieldIsRejectedBeforeAnyTextAndItsSubtreeIsNotVisited() throws {
        let driver = FakeAX(); driver.nodes[1]?.subrole = .value("AXSecureTextField")
        driver.nodes[1]?.children = [2]; driver.nodes[2] = FakeAX.Node(value: "private")
        let result = try ExactAXTree(driver: driver).observe()
        XCTAssertTrue(result.truncated)
        XCTAssertFalse(driver.reads.contains { $0.0 == 1 && ["AXValue", "AXTitle", "AXDescription"].contains($0.1) })
        XCTAssertFalse(driver.reads.contains { $0.0 == 2 })
    }
    @MainActor func testProtectedDialogSubtreeNeverReadsItsLabelsOrChildren() throws {
        for role in ["AXSheet", "AXDialog", "AXSystemDialog", "AXAlert"] {
            let driver = FakeAX(); driver.nodes[1]?.role = role; driver.nodes[1]?.children = [2]
            driver.nodes[2] = FakeAX.Node(value: "private dialog text")
            let result = try ExactAXTree(driver: driver).observe()
            XCTAssertTrue(result.truncated)
            XCTAssertFalse(driver.reads.contains { $0.0 == 1 && ["AXTitle", "AXValue"].contains($0.1) })
            XCTAssertFalse(driver.reads.contains { $0.0 == 2 })
        }
    }
    @MainActor func testFailedSubroleReadIsNotTreatedAsAbsence() throws {
        let driver = FakeAX(); driver.nodes[1]?.subrole = .failed
        let result = try ExactAXTree(driver: driver).observe()
        XCTAssertEqual(result.elements.count, 1); XCTAssertTrue(result.truncated)
        XCTAssertFalse(driver.reads.contains { $0 == (1, "AXValue") })
    }
    @MainActor func testSameLabelInAnotherWindowNeverSubstitutesTheOriginalElement() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        let field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        driver.nodes[1]?.window = 2; driver.nodes[2] = FakeAX.Node()
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {}))
        XCTAssertTrue(driver.writes.isEmpty)
    }
    @MainActor func testFieldBecomingSecureAfterObservationNeverReceivesInputOrValueRead() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        let field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        driver.nodes[1]?.subrole = .value("AXSecureTextField"); driver.reads.removeAll()
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {}))
        XCTAssertTrue(driver.writes.isEmpty); XCTAssertFalse(driver.reads.contains { $0 == (1, "AXValue") })
    }
    @MainActor func testHostRevocationAndLastMomentSecurityChangePrecedeDispatch() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        var field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: { throw ControlError.refuse("worker-halted") }))
        field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: { driver.nodes[1]?.subrole = .value("AXSecureTextField") }))
        XCTAssertTrue(driver.writes.isEmpty)
    }
    @MainActor func testTextAreaIsWritableAndObservationIsSingleUse() throws {
        let driver = FakeAX(); driver.nodes[1]?.role = "AXTextArea"
        let tree = ExactAXTree(driver: driver)
        let field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextArea" })
        _ = try tree.perform("set-value", element: field["id"] as! String, value: "line one\nline two", beforeDispatch: {})
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "twice", beforeDispatch: {}))
        XCTAssertEqual(driver.writes.count, 1)
    }
    @MainActor func testDispatchFailureIsUnknownAndNeverRetried() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        let field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        driver.accepted = false
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {})) { error in
            XCTAssertEqual((error as? ControlError)?.notDispatched, false)
        }
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "again", beforeDispatch: {}))
        XCTAssertEqual(driver.writes.count, 1)
    }
    @MainActor func testChangedValueAndLateDisabledOrReadOnlyFieldAreRefusedBeforeInput() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        var field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        driver.nodes[1]?.value = "human edit"
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {}))
        for attribute in ["enabled", "settable"] {
            driver.nodes[1]?.enabled = true; driver.nodes[1]?.settable = true
            field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
            XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {
                if attribute == "enabled" { driver.nodes[1]?.enabled = false } else { driver.nodes[1]?.settable = false }
            }))
        }
        XCTAssertTrue(driver.writes.isEmpty)
    }
    @MainActor func testWindowReadFailureBeforeDispatchIsARefusal() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        let field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        driver.windowFailure = true
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {})) { error in
            XCTAssertEqual((error as? ControlError)?.notDispatched, true)
        }
        XCTAssertTrue(driver.writes.isEmpty)
    }
    @MainActor func testLongValuesStayBoundedButEditsOutsideTheExcerptAreDetected() throws {
        let driver = FakeAX(), tree = ExactAXTree(driver: driver)
        driver.nodes[1]?.value = String(repeating: "a", count: 1500) + "before"
        var field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertEqual((field["value"] as? String)?.count, 1000)
        driver.nodes[1]?.value = String(repeating: "a", count: 1500) + "human edit"
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: "after", beforeDispatch: {}))
        XCTAssertTrue(driver.writes.isEmpty)
        field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        let long = String(repeating: "a", count: 2000)
        let result = try tree.perform("set-value", element: field["id"] as! String, value: long, beforeDispatch: {})
        XCTAssertEqual(result["state"], "confirmed_change")
        field = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertThrowsError(try tree.perform("set-value", element: field["id"] as! String, value: String(repeating: "한", count: 1400), beforeDispatch: {}))
        XCTAssertEqual(driver.writes.count, 1)
    }
    @MainActor func testButtonPressUsesTheObservedObjectAndConfirmsVisibleChange() throws {
        let driver = FakeAX(); driver.nodes[1]?.role = "AXButton"; driver.nodes[1]?.settable = false
        let tree = ExactAXTree(driver: driver)
        let button = try XCTUnwrap(try tree.observe().elements.first { $0["role"] as? String == "AXButton" })
        let result = try tree.perform("press", element: button["id"] as! String, value: nil, beforeDispatch: {})
        XCTAssertEqual(driver.presses, [1]); XCTAssertEqual(result["state"], "confirmed_change")
    }
    @MainActor func testCyclesDepthChildrenAndTimeAreBounded() throws {
        let driver = FakeAX(); driver.nodes[1]?.children = [0, 1, 2]
        driver.nodes[2] = FakeAX.Node()
        var tick: TimeInterval = 0
        let tree = ExactAXTree(driver: driver, childLimit: 1, timeLimit: 2, now: { tick += 0.1; return tick })
        let result = try tree.observe()
        XCTAssertLessThanOrEqual(result.elements.count, 2); XCTAssertTrue(result.truncated)
        let timed = ExactAXTree(driver: driver, timeLimit: 0, now: { 0 })
        XCTAssertTrue(try timed.observe().truncated)
    }
    @MainActor func testEmojiAndCombiningSequencesRespectHostUTF16Bounds() throws {
        let driver = FakeAX()
        driver.nodes[1]?.label = String(repeating: "👩🏽‍💻", count: 240)
        driver.nodes[1]?.value = String(repeating: "👩🏽‍💻", count: 1000)
        var field = try XCTUnwrap(try ExactAXTree(driver: driver).observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertLessThanOrEqual((field["label"] as! String).utf16.count, 240)
        XCTAssertLessThanOrEqual((field["value"] as! String).utf16.count, 1000)
        XCTAssertTrue((field["value"] as! String).allSatisfy { $0 == "👩🏽‍💻" })
        driver.nodes[1]?.value = "a" + String(repeating: "\u{301}", count: 5000)
        field = try XCTUnwrap(try ExactAXTree(driver: driver).observe().elements.first { $0["role"] as? String == "AXTextField" })
        XCTAssertEqual(field["value"] as? String, "")
    }
    @MainActor func testJSONPayloadBudgetOmitsElementsAndMarksIncomplete() throws {
        let driver = FakeAX()
        driver.nodes[0]?.children = Array(1...30)
        for id in 1...30 { driver.nodes[id] = FakeAX.Node(value: String(repeating: "한", count: 1000)) }
        let observation = try ExactAXTree(driver: driver, responseByteLimit: 5000).observe()
        XCTAssertTrue(observation.truncated)
        XCTAssertGreaterThan(observation.elements.count, 1)
        XCTAssertLessThan(try JSONSerialization.data(withJSONObject: observation.elements).count, 5000)
    }
}
