#if os(macOS)
import CoreGraphics
import Foundation
import os
import ScreenControlCore
@testable import ScreenHost
import XCTest

// The floating session bar (DESIGN mac-to-mac 「부록 A」): its words and buttons for every session state, whose click may
// hand remote input back, how its hold reaches the session's input receiver, and where it opens. Nothing here opens a
// window, reads the keychain, captures the screen, posts an event or listens on a port: the view's offscreen render is
// a separate step of scripts/check-screen-control.ts.
final class ScreenSessionBarTests: XCTestCase {
    private func state(_ access: ScreenSessionAccess, model: String = "iPhone16,2", name: String = "민수 폰",
                       elapsed: TimeInterval = 12 * 60 + 30,
                       limit: ScreenSessionLimit? = ScreenSessionLimit(kind: .idle, remaining: 48 * 60)) -> ScreenSessionBarState {
        ScreenSessionBarState(kind: ScreenDeviceKind(model: model), name: name, access: access, elapsed: elapsed, limit: limit,
                              hotKey: "⌃⌥⌘.")
    }

    func testDeviceKindComesFromTheRegisteredModel() {
        for model in ["iPhone16,2", "iPhone", "iPod9,1"] { XCTAssertEqual(ScreenDeviceKind(model: model), .iPhone, model) }
        for model in ["iPad14,1", "iPad"] { XCTAssertEqual(ScreenDeviceKind(model: model), .iPad, model) }
        // Once a Mac controller session reaches the service with its Mac's model (not yet), the bar shows a Mac unchanged.
        for model in ["Mac14,2", "MacBookPro18,3", "MacBookAir10,1", "Macmini9,1", "MacPro7,1", "iMac21,1", "VirtualMac2,1"] {
            XCTAssertEqual(ScreenDeviceKind(model: model), .mac, model)
        }
        for model in ["", "Watch7,1", "RealityDevice14,1"] { XCTAssertEqual(ScreenDeviceKind(model: model), .other, model) }
        XCTAssertEqual(ScreenDeviceKind.allCases.map(\.label), ["iPhone", "iPad", "Mac", "기기"])
        XCTAssertEqual(ScreenDeviceKind.allCases.map(\.symbol), ["iphone", "ipad", "desktopcomputer", "display"])
    }

    func testEachSessionStateHasItsWordsAndButtons() {
        let flowing = ScreenSessionBarText.present(state(.control(.flowing)))
        XCTAssertEqual(flowing.title, "iPhone ‘민수 폰’ · 조작 중")
        XCTAssertEqual(flowing.detail, "12분째 · 입력이 없으면 48분 뒤 끝남")
        XCTAssertEqual(flowing.actions, [.takeOver, .viewOnly, .end])
        XCTAssertEqual(flowing.tone, .controlling)
        XCTAssertFalse(flowing.notice)
        XCTAssertEqual(flowing.symbol, "iphone")
        XCTAssertEqual(flowing.hotKey, "⌃⌥⌘.")

        // Local input wins: the person at this Mac is using it, and the bar says so in those words.
        let local = ScreenSessionBarText.present(state(.control(.localActivity)))
        XCTAssertEqual(local.title, "iPhone ‘민수 폰’ · 조작 중")
        XCTAssertEqual(local.detail, "이 Mac에서 조작 중 — 원격 입력 멈춤 · 12분째")
        XCTAssertTrue(local.notice)
        XCTAssertEqual(local.tone, .holding)
        XCTAssertEqual(local.actions, [.takeOver, .viewOnly, .end])

        let held = ScreenSessionBarText.present(state(.control(.heldAtMac)))
        XCTAssertEqual(held.title, "iPhone ‘민수 폰’ · 원격 입력 멈춤")
        XCTAssertEqual(held.detail, "직접 하는 중 · 다시 넘기기는 이 Mac에서만 · 12분째")
        XCTAssertEqual(held.actions, [.handBack, .viewOnly, .end])
        XCTAssertEqual(held.tone, .holding)

        let secure = ScreenSessionBarText.present(state(.control(.secureInput)))
        XCTAssertEqual(secure.detail, "보안 입력 중 — 원격 입력 멈춤 · 12분째")
        XCTAssertEqual(secure.tone, .warning)
        XCTAssertTrue(secure.notice)

        let watching = ScreenSessionBarText.present(state(.view(.session), model: "iPad14,1", name: "거실 패드"))
        XCTAssertEqual(watching.title, "iPad ‘거실 패드’ · 보는 중")
        XCTAssertEqual(watching.detail, "12분째 · 입력이 없으면 48분 뒤 끝남")
        XCTAssertEqual(watching.actions, [.end], "nothing to lower or take over while it only watches")
        XCTAssertEqual(watching.tone, .watching)
        XCTAssertEqual(watching.symbol, "ipad")

        let lowered = ScreenSessionBarText.present(state(.view(.lowered)))
        XCTAssertEqual(lowered.title, "iPhone ‘민수 폰’ · 보는 중")
        XCTAssertEqual(lowered.detail, "보기만으로 바꿈 · 12분째 · 입력이 없으면 48분 뒤 끝남")
        XCTAssertEqual(lowered.actions, [.end])

        let lost = ScreenSessionBarText.present(state(.view(.protectionLost)))
        XCTAssertEqual(lost.detail, "입력 보호가 멈춰 보기만 · 다시 연결하면 조작")
        XCTAssertEqual(lost.tone, .warning)
        XCTAssertTrue(lost.notice)
        XCTAssertEqual(lost.actions, [.end])

        // A Mac controller session: its kind from its model, its name not repeated, and its 8-hour maximum.
        let mac = ScreenSessionBarText.present(state(.control(.flowing), model: "Mac14,2", name: "사무실 Mac", elapsed: 48 * 60,
                                                     limit: ScreenSessionLimit(kind: .maximum, remaining: 7 * 3600 + 12 * 60)))
        XCTAssertEqual(mac.title, "‘사무실 Mac’ · 조작 중")
        XCTAssertEqual(mac.detail, "48분째 · 7시간 12분 뒤 끝남")
        XCTAssertEqual(mac.symbol, "desktopcomputer")

        // Before the stream runs there is no limit to show yet.
        XCTAssertEqual(ScreenSessionBarText.present(state(.control(.flowing), elapsed: 5, limit: nil)).detail, "방금 연결")
    }

    func testARefusedHandBackSaysWhyAndKeepsTheButtons() {
        let held = state(.control(.heldAtMac))
        let refused = ScreenSessionBarText.present(held, notice: .handBackRefused(.otherProcess))
        XCTAssertEqual(refused.title, "사람의 클릭으로 확인되지 않았습니다")
        XCTAssertEqual(refused.detail, "넘기지 않았습니다 · 이 Mac 앞에서 직접 눌러 주세요")
        XCTAssertTrue(refused.notice)
        XCTAssertEqual(refused.actions, [.handBack, .viewOnly, .end])
        let remote = ScreenSessionBarText.present(held, notice: .handBackRefused(.remoteDesktop))
        XCTAssertEqual(remote.title, "이 Mac 앞에서 눌러야 합니다")
        XCTAssertEqual(remote.detail, "원격 데스크톱으로는 다시 넘길 수 없습니다")
        let double = ScreenSessionBarText.present(held, notice: .handBackRefused(.repeatedClick))
        XCTAssertEqual(double.title, "다시 넘기지 않았습니다")
        XCTAssertEqual(double.detail, "두 번 누름은 받지 않습니다 · 한 번만 눌러 주세요")
        XCTAssertTrue(double.notice)
        for refusal in ScreenSessionBarClick.Refusal.allCases where refusal != .remoteDesktop && refusal != .repeatedClick {
            XCTAssertEqual(ScreenSessionBarText.present(held, notice: .handBackRefused(refusal)).title, "사람의 클릭으로 확인되지 않았습니다",
                           refusal.rawValue)
        }
    }

    func testTimesRoundTowardTheSafeSide() {
        XCTAssertEqual(ScreenSessionBarText.elapsed(0), "방금 연결")
        XCTAssertEqual(ScreenSessionBarText.elapsed(59), "방금 연결")
        XCTAssertEqual(ScreenSessionBarText.elapsed(60), "1분째")
        XCTAssertEqual(ScreenSessionBarText.elapsed(3600), "1시간째")
        XCTAssertEqual(ScreenSessionBarText.elapsed(3900), "1시간 5분째")
        XCTAssertEqual(ScreenSessionBarText.elapsed(-5), "방금 연결")
        // Never less time than there is: minutes round up, the last minute counts seconds.
        XCTAssertEqual(ScreenSessionBarText.limit(.init(kind: .idle, remaining: 47 * 60 + 1)), "입력이 없으면 48분 뒤 끝남")
        XCTAssertEqual(ScreenSessionBarText.limit(.init(kind: .idle, remaining: 3600)), "입력이 없으면 1시간 뒤 끝남")
        XCTAssertEqual(ScreenSessionBarText.limit(.init(kind: .idle, remaining: 29.2)), "입력이 없으면 30초 뒤 끝남")
        XCTAssertEqual(ScreenSessionBarText.limit(.init(kind: .maximum, remaining: 8 * 3600)), "8시간 뒤 끝남")
        XCTAssertEqual(ScreenSessionBarText.limit(.init(kind: .maximum, remaining: -3)), "0초 뒤 끝남")

        let now = ContinuousClock.now
        XCTAssertEqual(ScreenSessionLimit(deadline: (now + .seconds(2880), .idle), now: now), .init(kind: .idle, remaining: 2880))
        XCTAssertEqual(ScreenSessionLimit(deadline: (now + .seconds(60), .timeLimit), now: now), .init(kind: .maximum, remaining: 60))
        XCTAssertEqual(ScreenSessionLimit(deadline: (now - .seconds(5), .idle), now: now).remaining, 0)
    }

    func testOnlyHandingBackNeedsAPersonAtThisMac() {
        // 끊기, 보기만 and 직접 하기 only take input away, so any click counts, the other side's own included.
        XCTAssertEqual(ScreenSessionBarAction.allCases.filter(\.needsPersonAtMac), [.handBack])
        XCTAssertEqual(ScreenSessionBarAction.allCases.map(\.label), ["직접 하기", "다시 넘기기", "보기만", "끊기"])
    }

    func testHandBackTakesOnlyAHardwareClickOnTheBar() {
        let marker = LocalInputMonitor.injectedEventMarker
        let own: Int64 = 7001
        func refusal(mouseUp: Bool = true, inBar: Bool = true, inControl: Bool = true, clicks: Int = 1, age: Double = 0.05,
                     pid: Int64 = 0, userData: Int64 = 0, poster: ScreenSessionBarPoster? = nil) -> ScreenSessionBarClick.Refusal? {
            ScreenSessionBarClick.handBackRefusal(isMouseUp: mouseUp, inBar: inBar, inControl: inControl, clickCount: clicks, ageSeconds: age,
                                                  sourcePid: pid, userData: userData, ownPid: own, injectionMarker: marker, poster: poster)
        }
        XCTAssertNotEqual(marker, 0, "a hardware event's user data can never pass for this app's marker")
        XCTAssertEqual(ScreenSessionBarClick.hardwareSourcePid, 0)
        XCTAssertNil(refusal(), "a single fresh mouse-up inside the pill that tracked it, with no posting process: a person's hand on this Mac")

        // The mouse-up must be inside the pill that ran, and that pill must have tracked the mouse-down itself. A person's
        // real click on 「직접 하기」 is still the current event for a moment, on the bar and fresh: an accessibility press on
        // 「다시 넘기기」 in that moment (osascript `click button`) reads it, but no pill tracked it, so it is refused.
        XCTAssertEqual(refusal(inControl: false), .notABarClick)
        XCTAssertEqual(refusal(inControl: false, age: 0.2), .notABarClick, "a fresh hardware mouse-up on the bar is not enough")
        // A double-click on 「직접 하기」: its second click lands on 「다시 넘기기」 in the same place and must not hand back.
        XCTAssertEqual(refusal(clicks: 2), .repeatedClick)
        XCTAssertEqual(refusal(clicks: 3), .repeatedClick)
        XCTAssertEqual(refusal(clicks: 0), .repeatedClick)
        XCTAssertEqual(refusal(clicks: 2, pid: 4242), .otherProcess, "a posted click is refused as a program first, whatever its count")
        XCTAssertEqual(refusal(clicks: 2, userData: marker), .screenInjected)

        // Remote input this app injected for the other side, whatever process it reads as.
        XCTAssertEqual(refusal(userData: marker), .screenInjected)
        XCTAssertEqual(refusal(pid: own, userData: marker), .screenInjected)
        XCTAssertEqual(refusal(pid: own), .ownProcess)
        // An AI, a script, a test tool: any posting process.
        XCTAssertEqual(refusal(pid: 4242), .otherProcess)
        XCTAssertEqual(refusal(pid: 4242, poster: .init(identifier: "com.openai.chat", team: "2DC432GLL2", apple: false)), .otherProcess)
        XCTAssertEqual(refusal(pid: 4242, poster: .init(identifier: "com.apple.osascript", team: nil, apple: true)), .otherProcess)
        // A remote desktop is refused too (SR-29), unlike the Control bar; the poster only chooses the words.
        XCTAssertEqual(refusal(pid: 311, poster: .init(identifier: "com.apple.screensharing.agent", team: nil, apple: true)), .remoteDesktop)
        XCTAssertEqual(refusal(pid: 311, poster: .init(identifier: "com.p5sys.jump.connect", team: "2HCKV38EEC", apple: false)), .remoteDesktop)
        XCTAssertEqual(refusal(pid: 311, poster: .init(identifier: "com.apple.screensharing.agent", team: "ABCDE12345", apple: false)),
                       .otherProcess, "an identifier claimed without Apple's anchor is only another process")
        // An accessibility press or a keyboard activation has no mouse-up on the bar.
        XCTAssertEqual(refusal(mouseUp: false), .notABarClick)
        XCTAssertEqual(refusal(inBar: false), .notABarClick)
        XCTAssertEqual(refusal(age: 1.5), .stale)
        XCTAssertEqual(refusal(age: -0.1), .stale)
    }

    func testTheHoldPausesAndLowersThroughTheSessionsOwnInputReceiver() throws {
        let hold = ScreenSessionInputHold()
        let injected = OSAllocatedUnfairLock(initialState: [InputEvent]())
        let receiver = InputReceiver(physicalInput: { hold.apply(PhysicalInputSnapshot(available: true)) },
                                     inject: { event in injected.withLock { $0.append(event) } })
        func access() -> ScreenSessionAccess { .of(canControl: true, hold: hold.mode, availability: hold.availability) }
        XCTAssertNil(hold.availability, "nothing to read before the stream runs")
        hold.attach(receiver)
        let start = ContinuousClock.now
        func at(_ ms: Int) -> ContinuousClock.Instant { start + .milliseconds(ms) }

        try receiver.receive(InputCodec.encode(.button(.left, isDown: true)), at: at(0))
        XCTAssertEqual(injected.withLock { $0 }, [.button(.left, isDown: true)])
        XCTAssertNil(receiver.checkLocalInput(at: at(10)))
        XCTAssertEqual(access(), .control(.flowing))

        // 직접 하기: the very next remote event is refused, what the other side held is let go, and the session's poll
        // tells the phone with the message it already knows (VideoPump sends remoteInputPaused for `.paused`).
        hold.pause()
        try receiver.receive(InputCodec.encode(.pointerMove(x: 0.5, y: 0.5)), at: at(100))
        XCTAssertEqual(injected.withLock { $0 }, [.button(.left, isDown: true), .button(.left, isDown: false)])
        XCTAssertEqual(receiver.checkLocalInput(at: at(200)), .paused)
        XCTAssertEqual(hold.availability, .localActivity)
        XCTAssertEqual(access(), .control(.heldAtMac))
        hold.pause()
        XCTAssertEqual(hold.mode, .paused)

        // 다시 넘기기 (its click already checked): remote input flows again at once.
        XCTAssertTrue(hold.resume())
        XCTAssertFalse(hold.resume(), "nothing left to hand back")
        XCTAssertEqual(receiver.checkLocalInput(at: at(300)), .resumed)
        try receiver.receive(InputCodec.encode(.pointerMove(x: 0.25, y: 0.75)), at: at(400))
        XCTAssertEqual(injected.withLock { $0.last }, .pointerMove(x: 0.25, y: 0.75))
        XCTAssertEqual(access(), .control(.flowing))

        // 보기만: for the rest of this session; neither 다시 넘기기 nor 직접 하기 undoes it.
        hold.lowerToView()
        XCTAssertFalse(hold.resume())
        hold.pause()
        XCTAssertEqual(hold.mode, .viewOnly)
        let count = injected.withLock { $0.count }
        try receiver.receive(InputCodec.encode(.key(code: 0, isDown: true, modifiers: [])), at: at(500))
        XCTAssertEqual(injected.withLock { $0.count }, count, "nothing injected once lowered to view")
        XCTAssertEqual(receiver.checkLocalInput(at: at(600)), .paused)
        XCTAssertEqual(hold.availability, .monitorUnavailable)
        XCTAssertEqual(access(), .view(.lowered))
        XCTAssertFalse(receiver.performControlInput(at: at(700)) { XCTFail("no keyboard or Spaces operation once lowered") })
    }

    /// Review F1: the other side reconnected (Face ID on the phone, nothing at this Mac) or connected from its other
    /// registered device, and the fresh session's hold started `.remote`, so 「직접 하기」 and 「보기만」 were undone without
    /// a hardware 「다시 넘기기」. ScreenService takes every session's hold from one `ScreenMacHold` (`begin()` in accept).
    func testTakingInputBackOutlastsTheSessionUntilAPersonHereHandsItBack() throws {
        var mac = ScreenMacHold()
        XCTAssertEqual(mac.begin().mode, .remote, "nothing held: a session starts with input flowing")

        // 직접 하기, then the same phone reconnects (`.replaced`) and another registered device connects after it.
        let first = mac.begin()
        mac.pause(first)
        XCTAssertEqual(first.mode, .paused)
        let reconnected = mac.begin()
        XCTAssertEqual(reconnected.mode, .paused, "reconnecting does not hand input back")
        XCTAssertEqual(mac.begin().mode, .paused, "nor does another registered device")

        // The reconnected session's receiver refuses the first remote event before injecting anything, and its poll tells
        // the phone with the message it already knows; the bar offers 다시 넘기기.
        let injected = OSAllocatedUnfairLock(initialState: [InputEvent]())
        let receiver = InputReceiver(physicalInput: { reconnected.apply(PhysicalInputSnapshot(available: true)) },
                                     inject: { event in injected.withLock { $0.append(event) } })
        reconnected.attach(receiver)
        let start = ContinuousClock.now
        try receiver.receive(InputCodec.encode(.button(.left, isDown: true)), at: start)
        try receiver.receive(InputCodec.encode(.text("rm -rf ~")), at: start + .milliseconds(10))
        XCTAssertEqual(injected.withLock { $0 }, [], "nothing reaches this Mac in a session that began held")
        XCTAssertEqual(receiver.checkLocalInput(at: start + .milliseconds(20)), .paused)
        XCTAssertTrue(receiver.heldAtMac, "the persistent explicit hold is distinct from ordinary local activity")
        XCTAssertEqual(ScreenSessionAccess.of(canControl: true, hold: reconnected.mode, availability: reconnected.availability),
                       .control(.heldAtMac))
        XCTAssertEqual(ScreenSessionBarText.present(state(.control(.heldAtMac))).actions.first, .handBack)

        // 다시 넘기기 with an accepted hardware click in that session: input flows, and later sessions start flowing.
        XCTAssertTrue(mac.resume(reconnected))
        XCTAssertEqual(reconnected.mode, .remote)
        XCTAssertEqual(mac.begin().mode, .remote)
        XCTAssertEqual(receiver.checkLocalInput(at: start + .milliseconds(30)), .resumed)
        XCTAssertFalse(receiver.heldAtMac)

        // 보기만 lowers its own session to view, and the next session from any device starts paused, not flowing.
        let lowered = mac.begin()
        mac.lowerToView(lowered)
        XCTAssertEqual(lowered.mode, .viewOnly)
        XCTAssertFalse(mac.resume(lowered), "nothing hands a lowered session back")
        XCTAssertTrue(mac.held, "a refused hand-back keeps this Mac holding its input")
        let next = mac.begin()
        XCTAssertEqual(next.mode, .paused)
        XCTAssertTrue(mac.resume(next))
        XCTAssertFalse(mac.held)

        // Turning screen control on again at this Mac (Touch ID or the password) starts over; turning on asks at this Mac.
        mac.pause(mac.begin())
        XCTAssertTrue(mac.held)
        mac.reset()
        XCTAssertEqual(mac.begin().mode, .remote)
    }

    func testTheBarReadsEverySessionState() {
        typealias Mode = ScreenSessionInputHold.Mode
        func of(_ canControl: Bool, _ hold: Mode?, _ availability: ScreenInputAvailability?) -> ScreenSessionAccess {
            .of(canControl: canControl, hold: hold, availability: availability)
        }
        XCTAssertEqual(of(false, .remote, nil), .view(.session))
        XCTAssertEqual(of(false, nil, nil), .view(.session))
        XCTAssertEqual(of(false, .viewOnly, .monitorUnavailable), .view(.lowered))
        XCTAssertEqual(of(true, .viewOnly, .monitorUnavailable), .view(.lowered))
        XCTAssertEqual(of(true, .remote, nil), .control(.flowing))
        XCTAssertEqual(of(true, .remote, .ready), .control(.flowing))
        XCTAssertEqual(of(true, .remote, .localActivity), .control(.localActivity))
        XCTAssertEqual(of(true, .remote, .secureInput), .control(.secureInput))
        XCTAssertEqual(of(true, .remote, .monitorUnavailable), .view(.protectionLost))
        XCTAssertEqual(of(true, .remote, .permissionsRequired), .view(.protectionLost))
        XCTAssertEqual(of(true, .paused, .localActivity), .control(.heldAtMac))
        XCTAssertEqual(of(true, .paused, .secureInput), .control(.heldAtMac))
        XCTAssertEqual(of(true, .paused, .monitorUnavailable), .view(.protectionLost), "protection lost outlasts a pause")
    }

    func testTheBarOpensWhereItWasLeftWhileThatIsOnAScreen() {
        let size = CGSize(width: 660, height: 52)
        let main = CGRect(x: 0, y: 80, width: 1512, height: 862)
        let side = CGRect(x: 1512, y: 0, width: 1920, height: 1055)
        XCTAssertEqual(ScreenSessionBarPlacement.origin(saved: nil, size: size, visibleFrames: [main, side]),
                       CGPoint(x: 426, y: 80 + 18 + 62), "bottom centre of the menu bar screen, above the Control bar's spot")
        XCTAssertEqual(ScreenSessionBarPlacement.origin(saved: CGPoint(x: 2000, y: 400), size: size, visibleFrames: [main, side]),
                       CGPoint(x: 2000, y: 400))
        XCTAssertEqual(ScreenSessionBarPlacement.origin(saved: CGPoint(x: 2000, y: 400), size: size, visibleFrames: [main]),
                       CGPoint(x: 426, y: 160), "a display that went away does not keep the bar off screen")
        XCTAssertEqual(ScreenSessionBarPlacement.origin(saved: CGPoint(x: 1400, y: 300), size: size, visibleFrames: [main, side]),
                       CGPoint(x: 426, y: 160), "half across two screens is not wholly on one")
        XCTAssertNil(ScreenSessionBarPlacement.origin(saved: nil, size: size, visibleFrames: []))
    }

    func testTheBarStaysInThePictureTheOtherSideSees() {
        // Capture leaves out only the viewer app, so AgentsToZ Screen's own bar is in the stream (부록 A 「캡처」).
        XCTAssertFalse(CaptureExclusion.excludes(bundleIdentifier: "com.intenet.agentstozbycs.screen"))
    }
}
#endif
