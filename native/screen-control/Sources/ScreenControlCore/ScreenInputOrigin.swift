import Foundation

// Which input counts as the person in front of this Mac (docs/design/mac-to-mac-2026-11-01/DESIGN.md SR-26, SR-29,
// S-M3). Pure: the caller passes in what it read from `NSEvent.cgEvent`; nothing here reads an event, a process or a key.
//
// The hardware rule is the Control bar's (native/computer-use ComputerUseControlCore/ControlBarRules.swift,
// `ControlBarClick`): an event the HID system produced carries no posting process (pid 0, measured on 1호), and a click
// ran a control only when it is a mouse-up inside that control no older than one second. The two packages do not
// depend on each other: Tests/InputOriginContract/vectors.json and tests/screen-input-origin-sync.test.ts keep the
// constants equal.
//
// Unlike the Control bar, a remote desktop that posts with its own pid is never accepted here. A person who reached this
// Mac through one cannot pass the biometric check every connection asks for (DESIGN F6), and B's privilege-raising
// controls refuse Jump and screen sharing by decision (F7). The poster's identity only chooses the message.
//
// pid 0 itself is a premise S-M3 has not measured (DESIGN 13절). Until it does, three sources that might also read as
// pid 0 pass like hardware: a virtual HID device, a program that writes 0 into `eventSourceUnixProcessID` before
// posting, and a remote desktop (Jump, Apple screen sharing) that posts without its own pid. Tests/InputOriginContract/
// vectors.json records each as an unmeasured `premise` with its residual risk; control stays off by build until then.

/// The signing identity of the process that posted an event, as the caller verified it (Security framework, strict
/// validation). Names a refusal; nothing here accepts an event because of who posted it.
public struct ScreenInputPoster: Equatable, Sendable {
    public let identifier: String
    public let team: String?
    /// Anchored to Apple's own certificate.
    public let apple: Bool
    public init(identifier: String, team: String?, apple: Bool) { self.identifier = identifier; self.team = team; self.apple = apple }
}

/// One event as the caller read it. `ageSeconds` is `ProcessInfo.systemUptime - event.timestamp`.
public struct ScreenInputEvent: Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable { case leftMouseDown, leftMouseUp, keyDown, keyUp, other }
    public let kind: Kind
    public let ageSeconds: Double
    /// `eventSourceUnixProcessID`.
    public let sourcePid: Int64
    /// `keyboardEventKeyboardType`, whatever the field reads for this kind of event.
    public let keyboardType: Int64
    /// `eventSourceStateID`.
    public let sourceState: Int64
    public let poster: ScreenInputPoster?

    public init(kind: Kind, ageSeconds: Double, sourcePid: Int64, keyboardType: Int64, sourceState: Int64, poster: ScreenInputPoster? = nil) {
        self.kind = kind; self.ageSeconds = ageSeconds; self.sourcePid = sourcePid
        self.keyboardType = keyboardType; self.sourceState = sourceState; self.poster = poster
    }
}

/// Why an event was not the person's. The raw value is the log and vector code.
public enum ScreenInputRefusal: String, Sendable, CaseIterable {
    /// An accessibility action (AXPress) or a programmatic call: no event ran the control.
    case noCurrentEvent = "no-current-event"
    /// Not a mouse-up (click) or key-down (key) on this control.
    case notTheControl = "not-the-control"
    /// Older than `freshSeconds`, or from the future: not the event that ran the control.
    case staleEvent = "stale-event"
    case ownEvent = "own-event"
    /// Posted by AgentsToZ Screen on this Mac: another device's remote input, never this Mac's person.
    case screenInjection = "screen-injection"
    /// A verified remote desktop agent. Refused like any program; named so the message can say why.
    case remoteDesktop = "remote-desktop"
    /// Any other program, or a poster that could not be verified.
    case synthetic = "synthetic"
    /// pid 0, but an `eventSourceStateID` the S-M3 calibration does not see from hardware.
    case unexpectedSourceState = "unexpected-source-state"
    /// pid 0, but a keyboard type the S-M3 calibration saw only from a virtual HID device.
    case virtualDevice = "virtual-device"
}

/// What S-M3 measured beyond pid 0 (DESIGN 13절). Until it runs, pid 0 alone decides, and the sources that might also
/// read as pid 0 (a virtual HID device such as DriverKit, Karabiner or a Korean relay tool; a program that writes pid 0;
/// a remote desktop without its own pid) are residual risks (DESIGN 11절, H9).
/// A calibration can only narrow pid 0; it never accepts an event that has a posting process.
///
/// Other modules (Screen, the Viewer, the iOS app) reach only `current`: the initializer and `uncalibrated` are internal,
/// so nothing outside this module can make a `.passed` value to turn control on, or pass a rule wider than the shipped one.
public struct ScreenInputCalibration: Equatable, Sendable {
    public enum Status: String, Sendable, CaseIterable { case unmeasured, passed, failed }
    public let status: Status
    /// When set, a pid-0 event must carry one of these `eventSourceStateID` values.
    public let hardwareSourceStates: Set<Int64>?
    /// `keyboardEventKeyboardType` values S-M3 saw only from virtual devices; refused even at pid 0.
    public let virtualKeyboardTypes: Set<Int64>

    init(status: Status, hardwareSourceStates: Set<Int64>?, virtualKeyboardTypes: Set<Int64>) {
        self.status = status; self.hardwareSourceStates = hardwareSourceStates; self.virtualKeyboardTypes = virtualKeyboardTypes
    }

    static let uncalibrated = ScreenInputCalibration(status: .unmeasured, hardwareSourceStates: nil, virtualKeyboardTypes: [])
    /// The rule this build ships. Recording an S-M3 result changes this value and the `calibration` block of
    /// Tests/InputOriginContract/vectors.json together, and rewrites the vectors that carry a `premise`.
    /// InputOriginChecks fails when this value and that block disagree. The measurement itself is recorded where DESIGN
    /// 13절 and wp-spikes / wp-integration put it (docs/design/mac-to-mac-2026-11-01/SPIKES.md, not written yet); no
    /// check reads that file, so keeping it in step is the recorder's job.
    public static let current = uncalibrated

    /// The control build flag (DESIGN 9절): control sessions and the 「조작」 choice exist only after S-M3 passes.
    /// A failure goes to the person (D-10); until then every controller session is view-only by build.
    public var allowsControl: Bool { status == .passed }
}

public enum ScreenInputOrigin {
    /// `eventSourceUnixProcessID` of an event the HID system produced (Control bar rule, 1호).
    public static let hardwareSourcePid: Int64 = 0
    /// A click or key older than this is not the one that ran the control (Control bar rule).
    public static let freshSeconds = 1.0
    /// The Control bar's remote desktop identities. Here they only name a refusal.
    public static let appleRemoteDesktop: Set<String> = ["com.apple.screensharing.agent", "com.apple.screensharing.daemon",
                                                         "com.apple.AppleVNCServer", "com.apple.RemoteDesktopAgent"]
    /// Team ID → identifiers (Jump Desktop Connect).
    public static let teamRemoteDesktop: [String: Set<String>] = ["2HCKV38EEC": ["com.p5sys.jump.connect"]]

    public static func isRemoteDesktop(_ poster: ScreenInputPoster) -> Bool {
        if poster.apple { return appleRemoteDesktop.contains(poster.identifier) }
        guard let team = poster.team else { return false }
        return teamRemoteDesktop[team]?.contains(poster.identifier) == true
    }

    /// Whether the Viewer may send this event to B (SR-26). nil forwards; anything else is dropped.
    /// `screenPid` is AgentsToZ Screen's pid on this Mac when it runs; `poster` only names a refusal.
    public static func forward(sourcePid: Int64, ownPid: Int64, screenPid: Int64?, keyboardType: Int64, sourceState: Int64,
                               poster: ScreenInputPoster? = nil, calibration: ScreenInputCalibration = .current) -> ScreenInputRefusal? {
        if sourcePid == hardwareSourcePid {
            if let states = calibration.hardwareSourceStates, !states.contains(sourceState) { return .unexpectedSourceState }
            if calibration.virtualKeyboardTypes.contains(keyboardType) { return .virtualDevice }
            return nil
        }
        if sourcePid == ownPid { return .ownEvent }
        if let screenPid, sourcePid == screenPid { return .screenInjection }
        if let poster, isRemoteDesktop(poster) { return .remoteDesktop }
        return .synthetic
    }

    /// Whether the click that ran a control was the person's (SR-29): the current event is a hardware left mouse-up
    /// inside that control, no older than `freshSeconds`. `event` is nil when no event ran it (an AX action).
    public static func humanClick(_ event: ScreenInputEvent?, inControl: Bool, ownPid: Int64, screenPid: Int64?,
                                  calibration: ScreenInputCalibration = .current) -> ScreenInputRefusal? {
        actuation(event, by: .leftMouseUp, inControl: inControl, ownPid: ownPid, screenPid: screenPid, calibration: calibration)
    }

    /// Whether the key that ran a control (Return, Space, a key equivalent) was the person's (SR-29): a hardware
    /// key-down delivered to that control, no older than `freshSeconds`.
    public static func humanKey(_ event: ScreenInputEvent?, inControl: Bool, ownPid: Int64, screenPid: Int64?,
                                calibration: ScreenInputCalibration = .current) -> ScreenInputRefusal? {
        actuation(event, by: .keyDown, inControl: inControl, ownPid: ownPid, screenPid: screenPid, calibration: calibration)
    }

    private static func actuation(_ event: ScreenInputEvent?, by kind: ScreenInputEvent.Kind, inControl: Bool, ownPid: Int64,
                                  screenPid: Int64?, calibration: ScreenInputCalibration) -> ScreenInputRefusal? {
        guard let event else { return .noCurrentEvent }
        guard event.kind == kind, inControl else { return .notTheControl }
        guard event.ageSeconds >= 0, event.ageSeconds <= freshSeconds else { return .staleEvent }
        return forward(sourcePid: event.sourcePid, ownPid: ownPid, screenPid: screenPid, keyboardType: event.keyboardType,
                       sourceState: event.sourceState, poster: event.poster, calibration: calibration)
    }
}

/// The wording for refused input (DESIGN 5.1, 12절), one language as everywhere in the Viewer and Screen.
public enum ScreenInputOriginText {
    /// A control pressed by anything but this Mac's hardware.
    public static let notInFront = "이 Mac 앞에서 눌러야 합니다 · 원격 데스크톱으로는 쓸 수 없습니다"
    /// Shown once per session, the first time forwarded input is dropped.
    public static let droppedInput = "다른 프로그램이 넣은 입력은 보내지 않습니다"
}
