import XCTest
import Carbon
import CoreGraphics
import ApplicationServices
import ComputerUseControlCore
@testable import ComputerUseEngine

@MainActor private final class FixtureEventSink: ScopedEventSink {
    var events: [CGEvent] = []
    func post(_ event: CGEvent) { events.append(event) }
}

final class ScopedEventDispatcherTests: XCTestCase {
    private func requireEventSource() throws {
        if CGEventSource(stateID: .privateState) == nil {
            throw XCTSkip("CoreGraphics does not allow event construction in this test sandbox; fake sink never posts events")
        }
    }
    @MainActor func testDisplayCoordinatesHandleNegativeOriginsAndRejectEdges() {
        let display = CGRect(x: -1920, y: -300, width: 1920, height: 1080)
        XCTAssertEqual(ScopedEventDispatcher.point(display: display, x: 20, y: 30), CGPoint(x: -1900, y: -270))
        XCTAssertNil(ScopedEventDispatcher.point(display: display, x: -1, y: 30))
        XCTAssertNil(ScopedEventDispatcher.point(display: display, x: 1920, y: 30))
        XCTAssertNil(ScopedEventDispatcher.point(display: display, x: 30, y: .nan))
    }
    @MainActor func testSessionInjectionPostsBalancedEventsAtTheSelectedTap() throws {
        try requireEventSource()
        var posted: [CGEventType] = [], locations: [CGEventTapLocation] = []
        let sink = ScopedSessionEventSink { event, location in
            posted.append(event.type); locations.append(location)
        }
        // A fake sink proves the selected tap and balanced event sequence, not real HID attribution.
        let dispatcher = ScopedEventDispatcher(sink: sink) {}
        XCTAssertEqual(dispatcher.click(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 10, y: 10,
                                        right: false, count: 1), .dispatchedUnverified)
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp])
        XCTAssertEqual(locations, [.cgSessionEventTap, .cgSessionEventTap])
    }
    @MainActor func testChecksAreToldWhenTheActionAlreadyPostedItsOwnInput() throws {
        try requireEventSource()
        // 1호 2026-10-31: the HID idle age fell to 15 ms at 25 ms after our own key event with every counter unchanged.
        // Only the first check of an action may read the idle age as the person's; every later one is told it posted.
        var seen: [Bool] = []
        let typing = ScopedEventDispatcher(sink: FixtureEventSink(), validate: { afterPost in seen.append(afterPost) })
        XCTAssertEqual(typing.typeText(String(repeating: "가", count: 25)), .dispatchedUnverified)
        XCTAssertEqual(seen, [false, true, true, true])
        seen = []
        let keys = ScopedEventDispatcher(sink: FixtureEventSink(), validate: { afterPost in seen.append(afterPost) })
        XCTAssertEqual(keys.key("s", modifiers: ["cmd"]), .dispatchedUnverified)
        XCTAssertEqual(seen, [false, true, true])
        seen = []
        let refused = ScopedEventDispatcher(sink: FixtureEventSink(), validate: { afterPost in
            seen.append(afterPost); throw ControlError.refuse("human-active-idle")
        })
        XCTAssertEqual(refused.click(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 1, y: 1, right: false, count: 1), .refused("guard-refused"))
        XCTAssertEqual(seen, [false])
    }
    @MainActor func testBackgroundKeysGoToTheTargetProcessOnly() throws {
        try requireEventSource()
        var delivered: [(Int64, pid_t)] = []
        let sink = ScopedProcessEventSink(pid: 4242) { event, pid in delivered.append((event.getIntegerValueField(.keyboardEventKeycode), pid)) }
        let dispatcher = ScopedEventDispatcher(sink: sink) {}
        XCTAssertEqual(dispatcher.key("Enter", modifiers: ["shift"]), .dispatchedUnverified)
        XCTAssertEqual(delivered.map(\.0), [Int64(kVK_Shift), Int64(kVK_Return), Int64(kVK_Return), Int64(kVK_Shift)])
        XCTAssertEqual(Set(delivered.map(\.1)), [4242])
    }
    @MainActor func testAnAccessibilityCallThatTimedOutIsUnknownNotRefused() {
        XCTAssertEqual(ScopedAccessibilityInput.outcome(.success), .dispatchedUnverified)
        XCTAssertEqual(ScopedAccessibilityInput.outcome(.cannotComplete), .unknown)
        for error in [AXError.actionUnsupported, .attributeUnsupported, .illegalArgument, .invalidUIElement, .notImplemented] {
            XCTAssertEqual(ScopedAccessibilityInput.outcome(error), .refused("background-action-failed"))
        }
    }
    @MainActor func testSessionInjectionStillStopsAndReleasesWhenHardwareInputChanges() throws {
        try requireEventSource()
        var hardwareCounter = 10, posted: [CGEventType] = []
        let before = hardwareCounter
        let sink = ScopedSessionEventSink { event, _ in
            posted.append(event.type)
            if event.type == .leftMouseDown { hardwareCounter += 1 } // concurrent physical input
        }
        let dispatcher = ScopedEventDispatcher(sink: sink) {
            if hardwareCounter != before { throw ControlError.refuse("human-active") }
        }
        XCTAssertEqual(dispatcher.click(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 10, y: 10,
                                        right: false, count: 1), .humanTakeover)
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp])
    }
    @MainActor func testClickAlwaysReleasesAfterHumanTakeover() throws {
        try requireEventSource()
        let sink = FixtureEventSink(); var calls = 0
        let dispatcher = ScopedEventDispatcher(sink: sink) {
            calls += 1; if calls == 2 { throw ControlError.refuse("human-active") }
        }
        let outcome = dispatcher.click(display: CGRect(x: -100, y: 0, width: 100, height: 100), x: 10, y: 10, right: false, count: 1)
        XCTAssertEqual(outcome, .humanTakeover)
        XCTAssertEqual(sink.events.map(\.type), [.leftMouseDown, .leftMouseUp])
    }
    @MainActor func testRefusalBeforeDispatchPostsNothing() throws {
        try requireEventSource()
        let sink = FixtureEventSink()
        let dispatcher = ScopedEventDispatcher(sink: sink) { throw ControlError.refuse("secure-input") }
        XCTAssertEqual(dispatcher.click(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 10, y: 10, right: true, count: 1), .refused("guard-refused"))
        XCTAssertTrue(sink.events.isEmpty)
    }
    @MainActor func testUnicodeAndDoubleClickPostBalancedPairsToFakeSink() throws {
        try requireEventSource()
        let sink = FixtureEventSink(), display = CGRect(x: -500, y: 0, width: 500, height: 500)
        let dispatcher = ScopedEventDispatcher(sink: sink) {}
        XCTAssertEqual(dispatcher.typeText("한글🙂👨‍👩‍👧"), .dispatchedUnverified)
        XCTAssertEqual(sink.events.map(\.type), [.keyDown, .keyUp])
        sink.events.removeAll()
        XCTAssertEqual(dispatcher.click(display: display, x: 12, y: 22, right: false, count: 2), .dispatchedUnverified)
        XCTAssertEqual(sink.events.map(\.type), [.leftMouseDown, .leftMouseUp, .leftMouseDown, .leftMouseUp])
        XCTAssertEqual(sink.events.map { $0.getIntegerValueField(.mouseEventClickState) }, [1, 1, 2, 2])
        XCTAssertTrue(sink.events.allSatisfy { $0.getIntegerValueField(.eventSourceUserData) == ScopedEventDispatcher.syntheticTag })
        XCTAssertEqual(sink.events[0].location, CGPoint(x: -488, y: 22))
    }
    @MainActor func testInvalidKeyboardOrScrollPostsNothing() throws {
        try requireEventSource()
        let sink = FixtureEventSink(), display = CGRect(x: 0, y: 0, width: 100, height: 100)
        let dispatcher = ScopedEventDispatcher(sink: sink) {}
        XCTAssertEqual(dispatcher.key("Enter", modifiers: ["cmd", "cmd"]), .refused("invalid-request"))
        XCTAssertEqual(dispatcher.scroll(display: display, x: 1, y: 1, deltaX: 1201, deltaY: 0), .refused("event-unavailable"))
        XCTAssertTrue(sink.events.isEmpty)
    }
    @MainActor func testKeyboardReleasesEveryPressedKeyInReverseOrder() throws {
        try requireEventSource()
        let sink = FixtureEventSink(); var calls = 0
        let dispatcher = ScopedEventDispatcher(sink: sink) {
            calls += 1; if calls == 3 { throw ControlError.refuse("human-active") }
        }
        XCTAssertEqual(dispatcher.key("a", modifiers: ["cmd", "shift"]), .humanTakeover)
        XCTAssertEqual(sink.events.count, 4)
        XCTAssertEqual(sink.events.map { $0.getIntegerValueField(.keyboardEventKeycode) },
                       [Int64(kVK_Command), Int64(kVK_Shift), Int64(kVK_Shift), Int64(kVK_Command)])
    }
    @MainActor func testDragReleasesMouseWhenGuardChanges() async throws {
        try requireEventSource()
        let sink = FixtureEventSink(); var calls = 0
        let dispatcher = ScopedEventDispatcher(sink: sink) {
            calls += 1; if calls == 2 { throw ControlError.refuse("human-active") }
        }
        let outcome = await dispatcher.drag(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 1, y: 1, endX: 50, endY: 50, validatePoint: { _ in })
        XCTAssertEqual(outcome, .humanTakeover)
        XCTAssertEqual(sink.events.map(\.type), [.leftMouseDown, .leftMouseUp])
    }
    /// A modelled OS, never the real one: `attribute` decides what a posted event does to the HID idle clock and counters.
    /// Times are binary fractions so millisecond floors are exact.
    /// These checks prove where the probe reads and that it changes nothing; real attribution stays a device question.
    @MainActor private final class ModelOS {
        var now: TimeInterval = 100, lastInput: TimeInterval = 95
        var counters = [UInt32](repeating: 7, count: ScopedGuardSample.counterNames.count)
        let observed: [UInt32]
        var posted: [CGEventType] = []
        let attribute: (ModelOS, CGEvent) -> Void
        init(attribute: @escaping (ModelOS, CGEvent) -> Void) { observed = counters; self.attribute = attribute }
        func sink() -> ScopedSessionEventSink {
            ScopedSessionEventSink { [self] event, _ in posted.append(event.type); attribute(self, event); now += 0.25 }
        }
        func probe() -> ScopedGuardProbe {
            ScopedGuardProbe(observed: observed, read: { [self] in .init(idleSeconds: now - lastInput, counters: counters) },
                             clock: { [self] in now })
        }
        // The production checks with their real threshold and exact counter equality.
        func guardChecks() throws {
            try ScopedOSGuard.requireIdleInputAge(now - lastInput)
            try ScopedOSGuard.requireSamePhysicalCounters(counters.map(String.init).joined(separator: ","),
                                                          observed: observed.map(String.init).joined(separator: ","))
        }
    }
    @MainActor func testGuardProbeRecordsIdleAndCountersAroundAClickWithoutChangingItsOutcome() throws {
        try requireEventSource()
        let display = CGRect(x: 0, y: 0, width: 100, height: 100)
        // `atOrAfterPost`: the last HID-clock event is no older than the post start (idleMs <= sincePostMs).
        let models: [(String, (ModelOS, CGEvent) -> Void, MutationResult, Int, [String: Int], Bool)] = [
            ("own event counted as HID input", { os, event in
                if event.type == .leftMouseDown { os.lastInput = os.now; os.counters[4] += 1 } }, .humanTakeover, 250, ["leftMouseDown": 1], true),
            ("other pointer input right after the event", { os, event in
                if event.type == .leftMouseDown { os.lastInput = os.now + 0.125; os.counters[3] += 3 } }, .humanTakeover, 125, ["mouseMoved": 3], true),
            ("other pointer input between the guard and the event", { os, event in
                if event.type == .leftMouseDown { os.lastInput = os.now - 0.125; os.counters[3] += 1 } }, .humanTakeover, 375, ["mouseMoved": 1], false),
            ("own event not counted", { _, _ in }, .dispatchedUnverified, 5_250, [:], false)]
        for (name, attribute, expected, afterIdle, changes, atOrAfterPost) in models {
            let withProbe = ModelOS(attribute: attribute), probe = withProbe.probe()
            let outcome = ScopedEventDispatcher(sink: withProbe.sink(), probe: probe) { try withProbe.guardChecks() }
                .click(display: display, x: 10, y: 10, right: false, count: 1)
            let plain = ModelOS(attribute: attribute)
            XCTAssertEqual(ScopedEventDispatcher(sink: plain.sink()) { try plain.guardChecks() }
                .click(display: display, x: 10, y: 10, right: false, count: 1), outcome, name)
            XCTAssertEqual(outcome, expected, name)
            XCTAssertEqual(withProbe.posted, [.leftMouseDown, .leftMouseUp], name)
            XCTAssertEqual(withProbe.posted, plain.posted, "the probe changes no event: \(name)")
            let samples = try XCTUnwrap(probe.samples, name)
            XCTAssertEqual(samples.before, ScopedGuardSample(idleSeconds: 5, sincePostSeconds: nil, counters: withProbe.observed,
                                                             observed: withProbe.observed), name)
            XCTAssertEqual(samples.after?.idleMs, afterIdle, name)
            XCTAssertEqual(samples.after?.sincePostMs, 250, "measured from just before the event: \(name)")
            XCTAssertEqual(samples.after?.counterChanges, changes, name)
            let after = try XCTUnwrap(samples.after, name)
            XCTAssertEqual(after.idleMs <= (after.sincePostMs ?? -1), atOrAfterPost, name)
            XCTAssertEqual(samples.refusal, expected == .humanTakeover ? samples.after : nil, name)
        }
    }
    @MainActor func testGuardProbeReadsOnlyTheRefusalWhenNothingWasPosted() throws {
        try requireEventSource()
        let os = ModelOS { _, _ in }
        os.lastInput = os.now - 0.375
        let probe = os.probe()
        XCTAssertEqual(ScopedEventDispatcher(sink: os.sink(), probe: probe) { try os.guardChecks() }
            .click(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 10, y: 10, right: false, count: 1), .refused("guard-refused"))
        XCTAssertTrue(os.posted.isEmpty)
        let samples = try XCTUnwrap(probe.samples)
        XCTAssertNil(samples.before); XCTAssertNil(samples.after)
        XCTAssertEqual(samples.refusal, ScopedGuardSample(idleSeconds: 0.375, sincePostSeconds: nil, counters: os.counters, observed: os.observed))
        XCTAssertEqual(samples.refusal?.idleMs, 375)
        XCTAssertNil(ScopedGuardProbe(observed: nil, read: { .init(idleSeconds: 9, counters: nil) }, clock: { 0 }).samples,
                     "an action that reached no guard carries no readings")
    }
    @MainActor func testGuardProbeKeepsTheLastGuardForKeysAndDragsAndStillReleases() async throws {
        try requireEventSource()
        // Every posted event counts under its own type, whatever type CoreGraphics gives a modifier key.
        let keys = ModelOS { os, event in
            if let index = ScopedOSGuard.physicalEventTypes.firstIndex(of: event.type) { os.counters[index] += 1 }
        }
        var calls = 0
        let keyProbe = keys.probe()
        XCTAssertEqual(ScopedEventDispatcher(sink: keys.sink(), probe: keyProbe) {
            calls += 1; try keys.guardChecks()
        }.key("a", modifiers: ["cmd"]), .humanTakeover)
        XCTAssertEqual(calls, 2, "the first guard after an event refuses")
        XCTAssertEqual(keys.posted.count, 2, "the pressed modifier and its release")
        let first = try XCTUnwrap(ScopedOSGuard.physicalEventTypes.firstIndex(of: try XCTUnwrap(keys.posted.first)))
        XCTAssertEqual(keyProbe.samples?.after?.counterChanges, [ScopedGuardSample.counterNames[first]: 1])
        XCTAssertEqual(keyProbe.samples?.refusal, keyProbe.samples?.after)

        let drag = ModelOS { _, _ in }
        var checked = 0
        let dragProbe = drag.probe()
        let outcome = await ScopedEventDispatcher(sink: drag.sink(), probe: dragProbe) { try drag.guardChecks() }
            .drag(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 1, y: 1, endX: 50, endY: 50, validatePoint: { _ in
                checked += 1; if checked == 3 { throw ControlError.refuse("protected-target") }
            })
        XCTAssertEqual(outcome, .humanTakeover)
        XCTAssertEqual(drag.posted, [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
        let samples = try XCTUnwrap(dragProbe.samples)
        XCTAssertEqual(samples.before?.sincePostMs, nil)
        XCTAssertEqual(samples.after?.sincePostMs, 250, "the last guard after the drag movement")
        XCTAssertEqual(samples.refusal?.sincePostMs, 250)
        XCTAssertEqual(samples.after?.counterChanges, [:])
    }
    @MainActor func testDragChecksEachTopmostPointBeforePosting() async throws {
        try requireEventSource()
        let sink = FixtureEventSink(); var checked = 0
        let dispatcher = ScopedEventDispatcher(sink: sink) {}
        let outcome = await dispatcher.drag(display: CGRect(x: 0, y: 0, width: 100, height: 100), x: 1, y: 1,
                                            endX: 50, endY: 50, validatePoint: { _ in
            checked += 1; if checked == 2 { throw ControlError.refuse("protected-target") }
        })
        XCTAssertEqual(outcome, .humanTakeover)
        XCTAssertEqual(sink.events.map(\.type), [.leftMouseDown, .leftMouseUp])
    }
}
