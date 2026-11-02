import Foundation
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// SR-26 and SR-29 (ScreenInputOrigin.swift): only this Mac's hardware reaches B or runs a control. Every vector in
// Tests/InputOriginContract/vectors.json runs here; tests/screen-input-origin-sync.test.ts holds the same file's rules
// to the Control bar's (ControlBarRules.swift) without either package depending on the other.

private struct OriginVectors {
    let json: [String: Any]
    let ownPid: Int64
    let screenPid: Int64?
    let posters: [String: ScreenInputPoster]

    init() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "InputOriginContract").appending(path: "vectors.json")
        guard let data = try? Data(contentsOf: url), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let process = json["process"] as? [String: Any], let posters = json["posters"] as? [String: [String: Any]] else {
            throw CheckFailure(description: "InputOriginContract/vectors.json unreadable")
        }
        self.json = json
        ownPid = try originInt(process["ownPid"], "process.ownPid")
        screenPid = try originInt(process["screenPid"], "process.screenPid")
        self.posters = try posters.mapValues { p in
            guard let identifier = p["identifier"] as? String, let apple = p["apple"] as? Bool else {
                throw CheckFailure(description: "vectors: poster without identifier or apple")
            }
            return ScreenInputPoster(identifier: identifier, team: p["team"] as? String, apple: apple)
        }
    }

    func list(_ name: String) throws -> [[String: Any]] {
        guard let list = json[name] as? [[String: Any]], !list.isEmpty else { throw CheckFailure(description: "vectors: \(name) missing or empty") }
        return list
    }

    func poster(_ v: [String: Any]) throws -> ScreenInputPoster? {
        guard let name = v["poster"] as? String else { return nil }
        guard let poster = posters[name] else { throw CheckFailure(description: "vectors: unknown poster \(name)") }
        return poster
    }

    /// A vector may say Screen is not running here (`"screenPid": null`).
    func screenPid(_ v: [String: Any]) throws -> Int64? {
        guard v.keys.contains("screenPid") else { return screenPid }
        return v["screenPid"] is NSNull ? nil : try originInt(v["screenPid"], "screenPid")
    }

    func event(_ v: [String: Any]) throws -> ScreenInputEvent? {
        guard let e = v["event"] as? [String: Any] else {
            guard v["event"] is NSNull else { throw CheckFailure(description: "vectors: event must be an object or null") }
            return nil
        }
        guard let kindName = e["kind"] as? String, let kind = ScreenInputEvent.Kind(rawValue: kindName),
              let age = e["ageSeconds"] as? NSNumber else { throw CheckFailure(description: "vectors: malformed event \(e)") }
        return ScreenInputEvent(kind: kind, ageSeconds: age.doubleValue, sourcePid: try originInt(e["sourcePid"], "sourcePid"),
                                keyboardType: try originInt(e["keyboardType"], "keyboardType"),
                                sourceState: try originInt(e["sourceState"], "sourceState"), poster: try poster(e))
    }
}

private func originInt(_ value: Any?, _ what: String) throws -> Int64 {
    guard let number = value as? NSNumber else { throw CheckFailure(description: "vectors: \(what) is not a number") }
    return number.int64Value
}

/// "accept" forwards or runs the control; anything else must name a refusal this build knows.
private func expected(_ v: [String: Any]) throws -> ScreenInputRefusal? {
    guard let code = v["expect"] as? String else { throw CheckFailure(description: "vectors: \(v["case"] ?? "?") has no expect") }
    if code == "accept" { return nil }
    guard let refusal = ScreenInputRefusal(rawValue: code) else { throw CheckFailure(description: "vectors: unknown refusal \(code)") }
    return refusal
}

private func verdict(_ refusal: ScreenInputRefusal?) -> String { refusal?.rawValue ?? "accept" }

/// `humanClick` and `humanKey` as values: (event, inControl, ownPid, screenPid, calibration).
private typealias ActuationJudge = (ScreenInputEvent?, Bool, Int64, Int64?, ScreenInputCalibration) -> ScreenInputRefusal?

/// The unmeasured premises a vector's verdict may rest on (DESIGN 13절 S-M3): a source other than the HID system that
/// might read as pid 0. vectors.json `fields` describes them.
private let s3Premises: Set<String> = ["virtual-hid-pid-0", "synthetic-pid-0", "remote-desktop-pid-0"]

/// A calibration that is not a measurement: it only exercises how a recorded S-M3 result would narrow pid 0.
private let exampleCalibration = ScreenInputCalibration(status: .passed, hardwareSourceStates: [1], virtualKeyboardTypes: [77])

extension ScreenControlChecks {
    static var inputOriginChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("input origin: rules and calibration match the shared vectors", { $0.testInputOriginRulesMatchTheVectors }),
        ("input origin: every vector holds", { $0.testInputOriginVectorsHold }),
        ("input origin: pid 0 alone decides until S-M3, control stays off", { $0.testPidZeroAloneDecidesUntilCalibrated }),
        ("input origin: a calibration only narrows pid 0", { $0.testCalibrationOnlyNarrowsPidZero }),
        ("input origin: a remote desktop that posts with its own pid is refused and named", { $0.testRemoteDesktopWithItsOwnPidIsRefused }),
        ("input origin: click and key actuation boundaries", { $0.testHumanActuationBoundaries }),
        ("input probe: incomplete data never certifies a calibration", { $0.testProbeIncomplete }),
        ("input probe: pid-zero lookalikes remain ambiguous across event kinds", { $0.testProbeAmbiguity }),
        ("input probe: a full diagnostic still requires human review", { $0.testProbeReviewOnly }),
        ("input probe: metadata aggregation is bounded", { $0.testProbeBounded }),
        ("input probe: unavailable events stay explicit", { $0.testProbeUnavailable }),
    ] }

    func testInputOriginRulesMatchTheVectors() throws {
        let vectors = try OriginVectors()
        try check(vectors.json["format"] as? Int == 1, "vector format 1")
        guard let rules = vectors.json["rules"] as? [String: Any], let calibration = vectors.json["calibration"] as? [String: Any] else {
            throw CheckFailure(description: "vectors: rules or calibration missing")
        }
        try check(try originInt(rules["hardwareSourcePid"], "hardwareSourcePid") == ScreenInputOrigin.hardwareSourcePid, "hardware pid")
        try check((rules["freshSeconds"] as? NSNumber)?.doubleValue == ScreenInputOrigin.freshSeconds, "fresh seconds")
        try check(Set(rules["appleRemoteDesktop"] as? [String] ?? []) == ScreenInputOrigin.appleRemoteDesktop, "Apple remote desktop names")
        let teams = (rules["teamRemoteDesktop"] as? [String: [String]] ?? [:]).mapValues(Set.init)
        try check(teams == ScreenInputOrigin.teamRemoteDesktop, "team remote desktop names")

        // The shipped calibration and the vectors' calibration are one record: recording S-M3 changes both. The measurement
        // itself goes to SPIKES.md (DESIGN 13절, wp-spikes), which this check does not read.
        let current = ScreenInputCalibration.current
        try check(calibration["status"] as? String == current.status.rawValue, "calibration status")
        let states = calibration["hardwareSourceStates"]
        if let set = current.hardwareSourceStates {
            try check(Set((states as? [NSNumber] ?? []).map(\.int64Value)) == set && !(states is NSNull), "hardware source states")
        } else {
            try check(states is NSNull, "no hardware source states until S-M3")
        }
        try check(Set((calibration["virtualKeyboardTypes"] as? [NSNumber] ?? []).map(\.int64Value)) == current.virtualKeyboardTypes,
                  "virtual keyboard types")
    }

    func testInputOriginVectorsHold() throws {
        let vectors = try OriginVectors()
        var failures: [String] = []
        var cases = Set<String>()
        var premises: [String: Set<String>] = [:]
        func record(_ list: String, _ v: [String: Any], _ got: ScreenInputRefusal?) throws {
            let name = v["case"] as? String ?? "?"
            if !cases.insert("\(list)/\(name)").inserted { failures.append("\(list)/\(name): duplicate case") }
            let want = try expected(v)
            if got != want { failures.append("\(list)/\(name): expected \(verdict(want)), got \(verdict(got))") }
            // An accepted vector is hardware by definition: no remote desktop or program path through any function.
            if want == nil {
                let pid: Int64? = try list == "forward" ? originInt(v["sourcePid"], "sourcePid") : vectors.event(v)?.sourcePid
                if pid != ScreenInputOrigin.hardwareSourcePid { failures.append("\(list)/\(name): accepted without pid 0") }
            }
            // A verdict that rests on an S-M3 premise names it. One that still passes is a recorded residual risk; one that
            // S-M3 told apart is measured.
            if let premise = v["premise"] as? String {
                premises[list, default: []].insert(premise)
                let measured = v["measured"] as? Bool
                if !s3Premises.contains(premise) { failures.append("\(list)/\(name): unknown premise \(premise)") }
                if measured == nil { failures.append("\(list)/\(name): premise without measured") }
                if want == nil, (v["residualRisk"] as? String)?.hasPrefix("\(premise): ") != true {
                    failures.append("\(list)/\(name): accepted on premise \(premise) without its residualRisk")
                }
                if want != nil, measured != true { failures.append("\(list)/\(name): refused on a premise must be measured") }
                if ScreenInputCalibration.current.status == .unmeasured, measured == true { failures.append("\(list)/\(name): measured before S-M3") }
            } else if v["measured"] != nil || v["residualRisk"] != nil || v["device"] != nil {
                failures.append("\(list)/\(name): measured, residualRisk or device without a premise")
            }
        }
        for v in try vectors.list("forward") {
            try record("forward", v, ScreenInputOrigin.forward(
                sourcePid: try originInt(v["sourcePid"], "sourcePid"), ownPid: vectors.ownPid, screenPid: try vectors.screenPid(v),
                keyboardType: try originInt(v["keyboardType"], "keyboardType"), sourceState: try originInt(v["sourceState"], "sourceState"),
                poster: try vectors.poster(v)))
        }
        let judges: [(String, ActuationJudge)] = [("humanClick", ScreenInputOrigin.humanClick), ("humanKey", ScreenInputOrigin.humanKey)]
        for (list, decide) in judges {
            for v in try vectors.list(list) {
                guard let inControl = v["inControl"] as? Bool else { throw CheckFailure(description: "vectors: \(list) without inControl") }
                try record(list, v, decide(try vectors.event(v), inControl, vectors.ownPid, try vectors.screenPid(v), .current))
            }
        }
        // Until S-M3 runs, every source it is to measure stays on record in each judgement, not only the virtual HID devices.
        if ScreenInputCalibration.current.status == .unmeasured {
            for list in ["forward", "humanClick", "humanKey"] where premises[list, default: []] != s3Premises {
                failures.append("\(list): premises on record \(premises[list, default: []].sorted()), S-M3 measures \(s3Premises.sorted())")
            }
        }
        try check(failures.isEmpty, failures.joined(separator: "; "))
    }

    func testPidZeroAloneDecidesUntilCalibrated() throws {
        let uncalibrated = ScreenInputCalibration.uncalibrated
        for keyboardType: Int64 in [-1, 0, 40, 41, 42, 58, 77, 0xFFFF, .max] {
            for sourceState: Int64 in [-1, 0, 1, 2, 99] {
                try check(ScreenInputOrigin.forward(sourcePid: 0, ownPid: 4100, screenPid: 4200, keyboardType: keyboardType,
                                                    sourceState: sourceState, calibration: uncalibrated) == nil,
                          "pid 0 forwards whatever kt=\(keyboardType) ss=\(sourceState) read")
                try check(ScreenInputOrigin.forward(sourcePid: 4321, ownPid: 4100, screenPid: 4200, keyboardType: keyboardType,
                                                    sourceState: sourceState, calibration: uncalibrated) == .synthetic,
                          "a posting process never forwards whatever the fields read")
            }
        }
        try check(!uncalibrated.allowsControl, "control stays off until S-M3 passes")
        try check(!ScreenInputCalibration(status: .failed, hardwareSourceStates: nil, virtualKeyboardTypes: []).allowsControl,
                  "a failed S-M3 does not turn control on (D-10 asks the person)")
        try check(ScreenInputCalibration.current.allowsControl == (ScreenInputCalibration.current.status == .passed),
                  "the control build flag is exactly the S-M3 result")
    }

    func testCalibrationOnlyNarrowsPidZero() throws {
        let c = exampleCalibration
        try check(ScreenInputOrigin.forward(sourcePid: 0, ownPid: 1, screenPid: 2, keyboardType: 40, sourceState: 1, calibration: c) == nil,
                  "hardware as the calibration saw it")
        try check(ScreenInputOrigin.forward(sourcePid: 0, ownPid: 1, screenPid: 2, keyboardType: 40, sourceState: 0, calibration: c) == .unexpectedSourceState,
                  "pid 0 from another source state")
        try check(ScreenInputOrigin.forward(sourcePid: 0, ownPid: 1, screenPid: 2, keyboardType: 77, sourceState: 1, calibration: c) == .virtualDevice,
                  "pid 0 from a virtual keyboard type")
        let click = ScreenInputEvent(kind: .leftMouseUp, ageSeconds: 0.1, sourcePid: 0, keyboardType: 0, sourceState: 0)
        try check(ScreenInputOrigin.humanClick(click, inControl: true, ownPid: 1, screenPid: 2, calibration: c) == .unexpectedSourceState,
                  "the click and key judgements use the same calibration")
        let key = ScreenInputEvent(kind: .keyDown, ageSeconds: 0.1, sourcePid: 0, keyboardType: 77, sourceState: 1)
        try check(ScreenInputOrigin.humanKey(key, inControl: true, ownPid: 1, screenPid: 2, calibration: c) == .virtualDevice, "and the key one")

        // Over every combination: whatever the uncalibrated rule refuses, a calibration refuses too, the same way for a
        // posting process; and nothing but pid 0 is ever forwarded.
        let posters: [ScreenInputPoster?] = [nil, ScreenInputPoster(identifier: "com.p5sys.jump.connect", team: "2HCKV38EEC", apple: false),
                                             ScreenInputPoster(identifier: "com.openai.codex", team: "AAAAAAAAAA", apple: false)]
        for pid: Int64 in [0, 1, 2, 600, 5300, -1, .max] {
            for keyboardType: Int64 in [0, 40, 77] {
                for sourceState: Int64 in [-1, 0, 1] {
                    for poster in posters {
                        let plain = ScreenInputOrigin.forward(sourcePid: pid, ownPid: 1, screenPid: 2, keyboardType: keyboardType,
                                                              sourceState: sourceState, poster: poster, calibration: .uncalibrated)
                        let narrow = ScreenInputOrigin.forward(sourcePid: pid, ownPid: 1, screenPid: 2, keyboardType: keyboardType,
                                                               sourceState: sourceState, poster: poster, calibration: c)
                        try check(plain == nil || narrow == plain, "pid \(pid): a calibration never changes a refusal")
                        try check(narrow == nil ? pid == 0 : true, "pid \(pid): only pid 0 forwards")
                    }
                }
            }
        }
    }

    /// The premise is that a remote desktop posts with its own pid, as `remoteDesktop` vectors do. One that arrives as
    /// pid 0 carries no process to name and passes like hardware: vectors.json records that as the remote-desktop-pid-0
    /// premise until S-M3 measures it.
    func testRemoteDesktopWithItsOwnPidIsRefused() throws {
        var remote = ScreenInputOrigin.appleRemoteDesktop.map { ScreenInputPoster(identifier: $0, team: nil, apple: true) }
        for (team, identifiers) in ScreenInputOrigin.teamRemoteDesktop {
            remote += identifiers.map { ScreenInputPoster(identifier: $0, team: team, apple: false) }
        }
        try check(remote.count == 5, "the Control bar's four Apple names and Jump Desktop Connect")
        for poster in remote {
            try check(ScreenInputOrigin.isRemoteDesktop(poster), "\(poster.identifier) is a remote desktop")
            try check(ScreenInputOrigin.forward(sourcePid: 600, ownPid: 1, screenPid: 2, keyboardType: 40, sourceState: 1, poster: poster) == .remoteDesktop,
                      "\(poster.identifier) input is dropped and named")
            let click = ScreenInputEvent(kind: .leftMouseUp, ageSeconds: 0.05, sourcePid: 600, keyboardType: 0, sourceState: 1, poster: poster)
            let key = ScreenInputEvent(kind: .keyDown, ageSeconds: 0.05, sourcePid: 600, keyboardType: 40, sourceState: 1, poster: poster)
            try check(ScreenInputOrigin.humanClick(click, inControl: true, ownPid: 1, screenPid: 2) == .remoteDesktop, "\(poster.identifier) click refused")
            try check(ScreenInputOrigin.humanKey(key, inControl: true, ownPid: 1, screenPid: 2) == .remoteDesktop, "\(poster.identifier) key refused")
        }
        try check(!ScreenInputOrigin.isRemoteDesktop(ScreenInputPoster(identifier: "com.apple.screensharing.agent", team: nil, apple: false)),
                  "an Apple name without Apple's anchor is not")
        try check(!ScreenInputOrigin.isRemoteDesktop(ScreenInputPoster(identifier: "com.p5sys.jump.connect", team: nil, apple: false)),
                  "Jump's name without its team is not")
        try check(!ScreenInputOrigin.isRemoteDesktop(ScreenInputPoster(identifier: "com.p5sys.jump.connect", team: "2HCKV38EEC", apple: true)),
                  "an Apple-anchored poster is judged by Apple's list only")
        // The poster names a refusal; it can never rescue an event this Mac's Screen or Viewer posted.
        let jump = remote.last!
        try check(ScreenInputOrigin.forward(sourcePid: 1, ownPid: 1, screenPid: 2, keyboardType: 40, sourceState: 1, poster: jump) == .ownEvent, "own first")
        try check(ScreenInputOrigin.forward(sourcePid: 2, ownPid: 1, screenPid: 2, keyboardType: 40, sourceState: 1, poster: jump) == .screenInjection,
                  "Screen's injection first")
        try check(ScreenInputOriginText.notInFront.contains("원격 데스크톱") && ScreenInputOriginText.droppedInput.contains("다른 프로그램"),
                  "the two refusal sentences (DESIGN 12절)")
    }

    func testHumanActuationBoundaries() throws {
        let judges: [(ScreenInputEvent.Kind, ActuationJudge)] = [(.leftMouseUp, ScreenInputOrigin.humanClick), (.keyDown, ScreenInputOrigin.humanKey)]
        for (kind, decide) in judges {
            func at(_ age: Double) -> ScreenInputRefusal? {
                decide(ScreenInputEvent(kind: kind, ageSeconds: age, sourcePid: 0, keyboardType: 40, sourceState: 1), true, 1, 2, .uncalibrated)
            }
            try check(at(0) == nil && at(-0.0) == nil && at(ScreenInputOrigin.freshSeconds) == nil, "\(kind): fresh through one second inclusive")
            for age in [ScreenInputOrigin.freshSeconds.nextUp, 60, -.leastNonzeroMagnitude, -1, .nan, .infinity, -.infinity] {
                try check(at(age) == .staleEvent, "\(kind): age \(age) is not the event that ran the control")
            }
            for other in ScreenInputEvent.Kind.allCases where other != kind {
                let event = ScreenInputEvent(kind: other, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1)
                try check(decide(event, true, 1, 2, .uncalibrated) == .notTheControl, "\(kind): a \(other) does not run the control")
            }
            let fresh = ScreenInputEvent(kind: kind, ageSeconds: 0.05, sourcePid: 0, keyboardType: 40, sourceState: 1)
            try check(decide(fresh, false, 1, 2, .uncalibrated) == .notTheControl, "\(kind): outside the control")
            try check(decide(nil, true, 1, 2, .uncalibrated) == .noCurrentEvent && decide(nil, false, 1, 2, .uncalibrated) == .noCurrentEvent,
                      "\(kind): an AX action has no current event")
            // A stale hardware event outside the control is still "not the control": the first failing rule names it.
            let strayOld = ScreenInputEvent(kind: kind, ageSeconds: 9, sourcePid: 5300, keyboardType: 40, sourceState: 1)
            try check(decide(strayOld, false, 1, 2, .uncalibrated) == .notTheControl, "\(kind): placement is judged before age")
            try check(decide(strayOld, true, 1, 2, .uncalibrated) == .staleEvent, "\(kind): age before origin")
        }
    }

    private func probeEvent(pid: Int64 = 0, type: Int64 = 40, state: Int64 = 1,
                            kind: ScreenInputEvent.Kind = .keyDown) -> ScreenInputEvent {
        ScreenInputEvent(kind: kind, ageSeconds: 0, sourcePid: pid, keyboardType: type, sourceState: state)
    }

    func testProbeIncomplete() throws {
        let calibration = ScreenInputCalibration.current
        var probe = InputOriginProbe()
        try check(probe.report.assessment == "incomplete" && !probe.report.certifiesCalibration, "empty data is incomplete")
        probe.record(source: .hardwareKeyboard, event: probeEvent())
        try check(probe.report.missingSources.count == InputOriginProbe.Source.allCases.count - 1, "missing sources are explicit")
        try check(ScreenInputCalibration.current == calibration, "a diagnostic cannot change shipped calibration")
    }

    func testProbeAmbiguity() throws {
        var probe = InputOriginProbe()
        probe.record(source: .hardwareKeyboard, event: probeEvent())
        probe.record(source: .virtualHID, event: probeEvent(kind: .keyUp))
        probe.record(source: .jumpDesktop, event: probeEvent(kind: .other))
        try check(probe.report.assessment == "ambiguous", "same pid-zero fields cannot prove different origins")
        try check(Set(probe.report.ambiguousSources) == [.virtualHID, .jumpDesktop], "event kind does not hide a collision")
        probe.record(source: .hardwarePointer, event: probeEvent(pid: 900))
        try check(probe.report.ambiguousSources.contains(.hardwarePointer), "hardware label with a process pid is suspect")
    }

    func testProbeReviewOnly() throws {
        var probe = InputOriginProbe()
        for source in InputOriginProbe.Source.allCases {
            probe.record(source: source, event: probeEvent(pid: source == .hardwareKeyboard || source == .hardwarePointer ? 0 : 900))
        }
        let report = probe.report
        try check(report.assessment == "needs-human-review" && !report.certifiesCalibration, "complete labels are not hardware attestation")
        let data = try JSONEncoder().encode(report)
        let keys = Set((try JSONSerialization.jsonObject(with: data) as! [String: Any]).keys)
        try check(keys == ["format", "purpose", "certifiesCalibration", "assessment", "missingSources", "ambiguousSources",
                           "unavailableEvents", "droppedEvents", "truncated", "samples"], "closed diagnostic output")
        let rows = (try JSONSerialization.jsonObject(with: data) as! [String: Any])["samples"] as! [[String: Any]]
        try check(rows.allSatisfy { Set($0.keys) == ["source", "kind", "sourcePid", "keyboardType", "sourceState", "count"] },
                  "no character, key code, coordinate, poster, timestamp or payload fields")
    }

    func testProbeBounded() throws {
        var probe = InputOriginProbe()
        for i in 0..<(InputOriginProbe.maximumSamples + 20) {
            probe.record(source: .syntheticProcess, event: probeEvent(pid: Int64(i + 1)))
        }
        try check(probe.report.samples.count == InputOriginProbe.maximumSamples && probe.report.droppedEvents == 20, "bounded distinct metadata")
        for _ in 0..<(InputOriginProbe.maximumEvents * 2) { probe.record(source: .syntheticProcess, event: probeEvent(pid: 1)) }
        try check(probe.report.samples.reduce(0) { $0 + $1.count } <= InputOriginProbe.maximumEvents, "event aggregation is bounded too")
        try check(probe.report.truncated && probe.report.assessment == "incomplete", "truncated samples never become complete")
        try check(probe.report.droppedEvents <= InputOriginProbe.maximumEvents, "drop counter saturates")
    }

    func testProbeUnavailable() throws {
        var probe = InputOriginProbe()
        probe.record(source: .syntheticProcess, event: nil)
        try check(probe.report.unavailableEvents == 1 && probe.report.samples.isEmpty, "no CGEvent means unknown, not rejected")
        try check(probe.report.missingSources.contains(.syntheticProcess), "absence is not a successful synthetic-input check")
    }
}
