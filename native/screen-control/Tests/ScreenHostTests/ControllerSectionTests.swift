#if os(macOS)
import CryptoKit
import Foundation
@testable import ScreenControlCore
@testable import ScreenHost
import XCTest

// B's 「다른 Mac에서 이 Mac 보기」 section (docs/design/mac-to-mac-2026-11-01 5.2, 6.5, 6.6, 9절, 12절, SR-19, SR-21, SR-27,
// SR-29, SR-30) as `ControllerSectionModel` builds it: the switch, the list, the Mac watching now, the push gate's line,
// 「켜 두기」 and the quit buttons, the history, and the gate every raising button passes. Pure model checks, then the same
// section read from a service on the in-memory rig, then the window's store becoming the service's (wired by the app),
// then the app's sources: nothing here opens a window, reads the keychain, posts an event or asks for Touch ID.

final class ControllerSectionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_000_000)

    private func controller(_ key: P256.Signing.PrivateKey = P256.Signing.PrivateKey(), name: String = "1호 MacBook Pro",
                            model: String = "Mac16,7", grant: ScreenControllerGrant = .view, bound: Bool = true,
                            alias: String? = nil, at date: Date? = nil) throws -> RegisteredController {
        let enrollment: ControllerEnrollment = bound
            ? try JSONDecoder().decode(ControllerEnrollment.self, from: JSONSerialization.data(withJSONObject: [
                "method": "direct-sas", "attested": true, "attestationKeyID": Data(repeating: 4, count: 32).base64EncodedString()]))
            : try .directSAS(attestation: nil)
        var row = RegisteredController(publicKey: key.publicKey, name: name, model: model, grant: grant, enrollment: enrollment, at: date ?? now)
        row.alias = alias
        return row
    }

    private func section(_ change: (inout ControllerSectionState) -> Void = { _ in }) -> ControllerSectionModel {
        var state = ControllerSectionState(listening: true, allowMacControllers: true, now: now)
        change(&state)
        return ControllerSectionModel(state)
    }

    // MARK: SR-29: the gate in front of every raising button

    private static let raising: [ControllerSectionAction] = [.allow(true), .grant(id: "ab", .control), .keepOn(true)]
    private static let lowering: [ControllerSectionAction] = [.allow(false), .grant(id: "ab", .view), .remove(id: "ab"), .disconnect,
                                                              .keepOn(false), .showPairingWindow]

    func testRaisingRunsOnlyFromAHardwareClickAndLoweringFromAnything() {
        let refused: [ControllerSectionTrigger] = [.unchecked] + ScreenInputRefusal.allCases.map { .click($0) }
        for action in Self.raising {
            XCTAssertTrue(action.raises, "\(action)")
            XCTAssertNil(ControllerSectionGate.refusal(for: action, by: .click(nil)), "\(action): the person's click goes on to Touch ID")
            for trigger in refused {
                XCTAssertEqual(ControllerSectionGate.refusal(for: action, by: trigger), ScreenInputOriginText.notInFront, "\(action) by \(trigger)")
            }
        }
        for action in Self.lowering {
            XCTAssertFalse(action.raises, "\(action)")
            for trigger in refused + [.click(nil)] {
                XCTAssertNil(ControllerSectionGate.refusal(for: action, by: trigger), "\(action) acts at once by \(trigger)")
            }
        }
    }

    /// The clicks a script, an accessibility action, Jump or Screen's own injection make, judged as the window's buttons
    /// judge them, never raise anything; the hardware click inside the button does.
    func testScriptsAccessibilityAndRemoteDesktopsCannotRaise() {
        let own: Int64 = 501
        func judged(_ event: ScreenInputEvent?, inside: Bool = true) -> ControllerSectionTrigger {
            .click(ScreenInputOrigin.humanClick(event, inControl: inside, ownPid: own, screenPid: own))
        }
        func click(pid: Int64, age: Double = 0.1, poster: ScreenInputPoster? = nil) -> ScreenInputEvent {
            ScreenInputEvent(kind: .leftMouseUp, ageSeconds: age, sourcePid: pid, keyboardType: 0, sourceState: 1, poster: poster)
        }
        let jump = ScreenInputPoster(identifier: "com.p5sys.jump.connect", team: "2HCKV38EEC", apple: false)
        let screenSharing = ScreenInputPoster(identifier: "com.apple.screensharing.agent", team: nil, apple: true)
        let cases: [(String, ControllerSectionTrigger)] = [
            ("AXPress: no event ran it", judged(nil)),
            ("cliclick or CGEventPost from a script", judged(click(pid: 4242))),
            ("Jump Desktop", judged(click(pid: 777, poster: jump))),
            ("Apple screen sharing", judged(click(pid: 778, poster: screenSharing))),
            ("Screen's own injection of a remote device's input", judged(click(pid: own))),
            ("an old hardware click", judged(click(pid: 0, age: 3))),
            ("a hardware click elsewhere", judged(click(pid: 0), inside: false)),
            ("a key-down where a click belongs", judged(ScreenInputEvent(kind: .keyDown, ageSeconds: 0.1, sourcePid: 0, keyboardType: 40, sourceState: 1))),
            ("a menu item", .unchecked),
        ]
        for action in Self.raising {
            for (what, trigger) in cases {
                XCTAssertEqual(ControllerSectionGate.refusal(for: action, by: trigger), ScreenInputOriginText.notInFront, "\(what) must not raise \(action)")
            }
            XCTAssertNil(ControllerSectionGate.refusal(for: action, by: judged(click(pid: 0))), "the person's click at this Mac raises \(action)")
        }
    }

    // MARK: The switch and 「다른 Mac 추가…」

    func testTheSwitchTurnsOnOnlyFromTheStatusWindowAndOffAnywhere() {
        let off = section { $0.allowMacControllers = false }.allow
        XCTAssertFalse(off.isOn)
        XCTAssertEqual(off.status, "다른 Mac 연결 허용: 꺼짐")
        XCTAssertEqual(off.choice.action, .allow(true))
        XCTAssertEqual(off.choice.title, "켜기 (Touch ID 또는 Apple Watch)")
        XCTAssertEqual(off.choice.menuTitle, "다른 Mac 연결 허용 켜기… (상태 창에서)", "the menu cannot judge its click: it opens the window")
        XCTAssertTrue(off.detail?.contains("원격 데스크톱") == true)

        let on = section().allow
        XCTAssertTrue(on.isOn)
        XCTAssertEqual(on.status, "다른 Mac 연결 허용: 켜짐")
        XCTAssertEqual(on.choice.action, .allow(false))
        XCTAssertEqual(on.choice.menuTitle, "다른 Mac 연결 허용 끄기", "turning off acts from the menu at once")
        XCTAssertEqual(on.detail, "아직 추가한 Mac이 없습니다. 「다른 Mac 추가…」로 추가하세요.")
        XCTAssertEqual(section { $0.listening = false }.allow.detail, "화면 제어가 켜져 있지 않아 지금은 연결을 받지 않습니다.")
    }

    func testAddingWaitsWhileAnySessionHoldsTheScreen() {
        let free = section().add
        XCTAssertEqual(free.choice.title, "다른 Mac 추가…")
        XCTAssertEqual(free.choice.menuTitle, "다른 Mac 추가…")
        XCTAssertEqual(free.choice.action, .showPairingWindow)
        XCTAssertTrue(free.choice.enabled)
        XCTAssertNil(free.disabledReason)
        for busy in [section { $0.phoneWatching = true }, section { $0.watching = .init(id: "ab", name: "A", canControl: false) }] {
            XCTAssertFalse(busy.add.choice.enabled, "the window would close at once (SR-37)")
            XCTAssertEqual(busy.add.disabledReason, "화면 연결이 있는 동안에는 추가할 수 없습니다")
        }
    }

    // MARK: The list

    func testRowsShowNameModelFingerprintGenuineViewerAndGrant() throws {
        let key = P256.Signing.PrivateKey()
        let bound = try controller(key, alias: "사무실")
        let unbound = try controller(name: "\u{202E}evil", model: "\u{0007}", bound: false)
        let rows = section { $0.controllers = [bound, unbound]; $0.pushLive = true }.rows
        XCTAssertEqual(rows.map(\.id), [bound.id, unbound.id], "the order the store keeps")

        let first = rows[0]
        XCTAssertEqual(first.name, "사무실")
        XCTAssertEqual(first.enrolledName, "1호 MacBook Pro", "a renamed Mac still shows the name it enrolled with")
        XCTAssertEqual(first.model, "Mac16,7")
        XCTAssertEqual(first.fingerprint, "키 지문 \(ScreenControlIdentity.shortFingerprint(of: key.publicKey))",
                       "the four characters A's list shows for the same key")
        XCTAssertEqual(first.genuine, "정품 AgentsToZ Viewer: 확인됨")
        XCTAssertTrue(first.genuineConfirmed)
        XCTAssertEqual(first.grant, "권한: 보기")
        XCTAssertNil(first.status)
        XCTAssertEqual(first.registeredAt, now)
        XCTAssertEqual(first.expiresAt, bound.expiresAt)
        XCTAssertEqual(first.remove.title, "삭제")
        XCTAssertEqual(first.remove.action, .remove(id: bound.id))
        XCTAssertFalse(first.remove.action.raises)

        let second = rows[1]
        XCTAssertEqual(second.name, RegisteredController.unnamed, "a name this Mac cannot show")
        XCTAssertNil(second.enrolledName)
        XCTAssertNil(second.model)
        XCTAssertEqual(second.genuine, "정품 AgentsToZ Viewer: 확인할 수 없음")
        XCTAssertFalse(second.genuineConfirmed)
    }

    func testRowSaysWhatStandsInTheWay() throws {
        let bound = try controller(), unbound = try controller(bound: false, alias: "2호")
        let old = try controller(at: now.addingTimeInterval(-RegistrationLifetime.unused - 60))
        func status(_ row: RegisteredController, _ change: (inout ControllerSectionState) -> Void = { _ in }) -> String? {
            section { $0.controllers = [row]; change(&$0) }.rows.first?.status
        }
        XCTAssertNil(status(bound), "a genuine Viewer's view grant needs no push gate (9절)")
        XCTAssertEqual(status(unbound), "알림 연결 확인 전이라 받지 않음", "9절: an unbound registration waits for the push gate")
        XCTAssertNil(status(unbound) { $0.pushLive = true })
        XCTAssertEqual(status(bound) { $0.allowMacControllers = false }, "다른 Mac 연결 허용이 꺼져 있어 연결할 수 없습니다")
        XCTAssertEqual(status(old), "90일 동안 쓰지 않아 만료되었습니다. 다시 추가하세요.")
        XCTAssertTrue(try XCTUnwrap(section { $0.controllers = [old] }.rows.first).expired)

        let watched = section { $0.controllers = [bound]; $0.watching = .init(id: bound.id, name: bound.displayName, canControl: false) }.rows[0]
        XCTAssertEqual(watched.status, "지금 보는 중")
        XCTAssertTrue(watched.watching)
        XCTAssertEqual(watched.remove.title, "삭제하고 끊기", "deleting the Mac watching ends its session (6.6)")
    }

    func testGrantChoicesFollowTheBuildAndThePushGate() throws {
        let viewing = try controller(), controlling = try controller(grant: .control)
        func row(_ row: RegisteredController, offered: Bool, live: Bool) -> ControllerSectionModel.Row {
            section { $0.controllers = [row]; $0.controlOffered = offered; $0.pushLive = live }.rows[0]
        }
        // Before S-M3: 「조작」 is not offered at all, and a control grant watches.
        XCTAssertNil(row(viewing, offered: false, live: true).grantChoice, "no 「조작」 before the build passed S-M3 (D-10)")
        let unbuilt = row(controlling, offered: false, live: true)
        XCTAssertEqual(unbuilt.grant, "권한: 조작 · 이 빌드에서는 보기만 됩니다")
        XCTAssertEqual(unbuilt.grantChoice?.action, .grant(id: controlling.id, .view), "lowering always stays possible")
        XCTAssertEqual(unbuilt.grantChoice?.menuTitle, "보기로 낮추기")

        // After S-M3: raising is a hardware-click button in the status window only.
        let raise = try XCTUnwrap(row(viewing, offered: true, live: true).grantChoice)
        XCTAssertEqual(raise.action, .grant(id: viewing.id, .control))
        XCTAssertTrue(raise.action.raises)
        XCTAssertEqual(raise.title, "조작 허용 (Touch ID 또는 Apple Watch)")
        XCTAssertEqual(raise.menuTitle, "조작 허용… (상태 창에서)")
        XCTAssertEqual(row(controlling, offered: true, live: false).grant, "권한: 조작 · 알림·원격 차단 연결 확인 전이라 보기만 됩니다")
        XCTAssertEqual(row(controlling, offered: true, live: true).grant, "권한: 조작")
    }

    func testTheMacWatchingNowSaysWhyItOnlyWatches() {
        func watching(canControl: Bool, _ cause: ControllerViewOnlyCause?) -> ControllerSectionModel.Watching? {
            section { $0.watching = .init(id: "ab", name: "1호", canControl: canControl, viewOnlyCause: cause) }.watching
        }
        XCTAssertNil(section().watching)
        XCTAssertNil(section { $0.phoneWatching = true }.watching, "a phone's session is the phones' section")
        let controlling = watching(canControl: true, nil)
        XCTAssertEqual(controlling?.line, "지금 보는 Mac: ‘1호’ · 조작 가능")
        XCTAssertNil(controlling?.reason)
        XCTAssertEqual(controlling?.disconnect.action, .disconnect)
        XCTAssertEqual(controlling?.disconnect.title, "끊기")
        XCTAssertEqual(watching(canControl: false, nil)?.line, "지금 보는 Mac: ‘1호’ · 보기만")
        XCTAssertEqual(watching(canControl: false, nil)?.reason, "권한이 보기라서 보기만 됩니다.")
        XCTAssertEqual(watching(canControl: false, .build)?.reason, "이 빌드에서는 다른 Mac에 조작을 열지 않아 보기만 됩니다.")
        XCTAssertEqual(watching(canControl: false, .notifications)?.reason, "알림·원격 차단 연결 확인 전이라 보기만 됩니다.")
        XCTAssertEqual(watching(canControl: false, .inputProtection)?.reason,
                       "이 Mac의 입력 우선 보호 권한(손쉬운 사용·입력 모니터링)이 없어 보기만 됩니다.")
    }

    func testThePushGatesLine() {
        let closed = section().push
        XCTAssertFalse(closed.live)
        XCTAssertEqual(closed.line, "알림·원격 차단: 확인 전")
        XCTAssertNotNil(closed.detail)
        let open = section { $0.pushLive = true }.push
        XCTAssertEqual(open.line, "알림·원격 차단: 연결됨")
        XCTAssertNil(open.detail)
    }

    // MARK: 「켜 두기」 and the quit buttons (SR-27)

    func testKeepingOnIsHiddenUntilOfferedAndQuitDefaultsToLettingItGo() throws {
        let hidden = section()
        XCTAssertNil(hidden.keepOn, "hidden while the build or the push gate does not offer it")
        XCTAssertEqual(hidden.quit.primaryTitle, "AgentsToZ Screen 종료")
        XCTAssertNil(hidden.quit.keepingOnTitle)

        let offered = try XCTUnwrap(section { $0.keepOnOffered = true }.keepOn)
        XCTAssertFalse(offered.isOn)
        XCTAssertEqual(offered.status, "재시작·업데이트 뒤에도 켜 두기 · 이 네트워크에서")
        XCTAssertEqual(offered.primary.action, .keepOn(true))
        XCTAssertTrue(offered.primary.action.raises)
        XCTAssertEqual(offered.primary.title, "켜 두기 (Touch ID 또는 Apple Watch)")
        XCTAssertEqual(offered.primary.menuTitle, "켜 두기… (상태 창에서)")
        XCTAssertTrue(offered.primary.enabled)
        let notListening = try XCTUnwrap(section { $0.keepOnOffered = true; $0.listening = false }.keepOn)
        XCTAssertFalse(notListening.primary.enabled, "turned on only while screen control is on")
        XCTAssertEqual(notListening.detail, "화면 제어를 켠 뒤에 켤 수 있습니다.")

        let home = sampleNetwork(1, label: "집").identity, office = sampleNetwork(2, label: "사무실").identity
        let setting = KeepOnSetting(since: now, networks: [home])
        let kept = section { $0.keepOn = setting; $0.keepOnOffered = true; $0.network = home }
        let on = try XCTUnwrap(kept.keepOn)
        XCTAssertTrue(on.isOn)
        XCTAssertEqual(on.status, "재시작·업데이트 뒤에도 켜 두기: 켜짐")
        XCTAssertEqual(on.detail, "저장한 네트워크 1곳에서만 스스로 켜집니다. 다른 네트워크에서는 기다립니다.")
        XCTAssertEqual(on.primary.action, .keepOn(false))
        XCTAssertEqual(on.primary.menuTitle, "켜 두기 끄기")
        XCTAssertNil(on.addNetwork, "this network is saved already")
        XCTAssertEqual(kept.quit.primaryTitle, "끄고 끝내기", "the default lets keeping on go")
        XCTAssertEqual(kept.quit.keepingOnTitle, "켜 둔 채 끝내기 · 다음 로그인 때 이 네트워크에서 다시 켜집니다.")

        let elsewhere = try XCTUnwrap(section { $0.keepOn = setting; $0.keepOnOffered = true; $0.network = office }.keepOn)
        XCTAssertEqual(elsewhere.addNetwork?.action, .keepOn(true))
        XCTAssertEqual(elsewhere.addNetwork?.title, "이 네트워크도 켜 두기 (Touch ID 또는 Apple Watch)")
        // A network this Mac cannot tell apart is not taken for a saved one: pressing says it cannot be kept.
        let unknown = try XCTUnwrap(section { $0.keepOn = setting; $0.keepOnOffered = true; $0.network = nil }.keepOn)
        XCTAssertEqual(unknown.addNetwork?.action, .keepOn(true), "an unknown network hid 「이 네트워크도 켜 두기」")
        // Kept on while the gate has closed since: it can still be turned off, and nothing can be added.
        let gateClosed = try XCTUnwrap(section { $0.keepOn = setting; $0.network = office }.keepOn)
        XCTAssertEqual(gateClosed.primary.action, .keepOn(false))
        XCTAssertNil(gateClosed.addNetwork)

        let notice = "켜 두기 해제를 저장하지 못했습니다."
        XCTAssertEqual(section { $0.keepOnNotice = notice }.keepOn?.notice, notice, "a failed release is said even while hidden")
    }

    @MainActor
    func testTheQuitNoticeIsTheServices() {
        XCTAssertEqual(ControllerSectionModel.keepOnQuitNotice, ScreenService.keepOnQuitNotice)
    }

    // MARK: History (SR-30)

    func testHistoryIsNewestFirstCappedAndInFixedWords() {
        func entry(_ event: ControllerLogEntry.Event, reason: String? = nil, route: ControllerLogEntry.Route? = nil,
                   at offset: TimeInterval = 0) -> ControllerLogEntry {
            ControllerLogEntry(at: now.addingTimeInterval(offset), controllerID: "ab", name: "1호", event: event, reason: reason, route: route)
        }
        let empty = section().history
        XCTAssertEqual(empty.title, "최근 기록 (0/64)")
        XCTAssertEqual(empty.empty, "기록 없음")
        XCTAssertNil(empty.problem)

        let many = (0..<70).map { entry(.connected, route: .nearby, at: TimeInterval($0)) }
        let capped = section { $0.history = many }.history
        XCTAssertEqual(capped.lines.count, ControllerLog.capacity)
        XCTAssertEqual(capped.title, "최근 기록 (64/64)")
        XCTAssertEqual(capped.lines.first?.at, now.addingTimeInterval(69), "newest first")
        XCTAssertEqual(capped.lines.last?.at, now.addingTimeInterval(6))
        XCTAssertNil(capped.empty)

        let words: [(ControllerLogEntry, String)] = [
            (entry(.paired, reason: "view"), "‘1호’ · 추가됨 · 권한 보기"),
            (entry(.grantChanged, reason: "control"), "‘1호’ · 권한 변경 → 조작"),
            (entry(.removed), "‘1호’ · 이 Mac에서 삭제"),
            (entry(.connected, route: .connector), "‘1호’ · 연결 (인터넷(Cloudflare))"),
            (entry(.ended, reason: ControllerLogEntry.reason(.takenOver), route: .nearby), "‘1호’ · 끝남 · 등록된 폰이 이어받음 (근거리)"),
            (entry(.ended, reason: ControllerLogEntry.reason(nil), route: .nearby), "‘1호’ · 끝남 · 연결이 끊김 (근거리)"),
            (entry(.refused, reason: ControllerLogEntry.reason(.busy), route: .nearby), "‘1호’ · 거절 · 다른 연결 중 (근거리)"),
            (entry(.unenrolled), "‘1호’ · 그 Mac에서 스스로 등록 해제"),
            (entry(.ended, reason: "<script>"), "‘1호’ · 끝남"),
            (entry(.paired, reason: "everything"), "‘1호’ · 추가됨"),
            (entry(.refused, reason: ScreenControllerPairingRefusal.codeMismatch.rawValue), "‘1호’ · 등록 거절 · 숫자 불일치"),
            (entry(.refused, reason: ScreenControllerPairingRefusal.untrustedViewer.rawValue),
             "‘1호’ · 등록 거절 · 정품 AgentsToZ Viewer를 확인하지 못함"),
            (entry(.refused, reason: "<script>"), "‘1호’ · 거절"),
        ]
        for (logged, text) in words { XCTAssertEqual(ControllerSectionModel.text(of: logged), text) }
        // Every way the 「다른 Mac 추가」 window refuses has its words, and none reads as a session's ending.
        for refusal in ScreenControllerPairingRefusal.allCases {
            XCTAssertNotNil(ControllerSectionModel.pairingWord(refusal.rawValue), "\(refusal)")
            XCTAssertNil(ControllerSectionModel.endingWord(refusal.rawValue), "\(refusal)")
        }
        // Every ending the service logs has its words.
        let endings: [SessionEndReason?] = [nil, .idle, .timeLimit, .endedAtMac, .turnedOff, .revoked, .replaced, .turnedOffFromDevice,
                                            .takenOver, .busy, .captureUnavailable]
        for ending in endings { XCTAssertNotNil(ControllerSectionModel.endingWord(ControllerLogEntry.reason(ending)), "\(String(describing: ending))") }

        XCTAssertEqual(section { $0.historyUnread = true }.history.problem, "저장된 기록을 읽지 못했습니다. 이 Mac을 잠금 해제하면 다음 기록 때 다시 읽습니다.")
        XCTAssertEqual(section { $0.historyUnsaved = true }.history.problem, "마지막 기록을 저장하지 못했습니다. 이 화면에는 남아 있습니다.")
    }

    // MARK: The service's state, on the in-memory rig

    @MainActor
    func testTheSectionReadsTheServiceAsItIs() async throws {
        let rig = try HostRig()
        let viewer = HostTestSigner(), unbound = HostTestSigner(), phone = HostTestSigner()
        try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(viewer, bound: true), try rig.controller(unbound, name: "2호 Mac")])
        let service = rig.makeService()

        var model = ControllerSectionModel(service.controllerSectionState(now: rig.clock.now))
        XCTAssertTrue(model.allow.isOn)
        XCTAssertEqual(model.rows.map(\.id), [viewer.id, unbound.id])
        XCTAssertEqual(model.rows.map(\.status), [nil, "알림 연결 확인 전이라 받지 않음"])
        XCTAssertFalse(model.push.live)
        XCTAssertNil(model.keepOn, "this build does not offer keeping on")
        XCTAssertNil(model.rows[0].grantChoice, "this build does not offer 「조작」")

        rig.openPushGate(service)
        model = ControllerSectionModel(service.controllerSectionState(now: rig.clock.now))
        XCTAssertTrue(model.push.live)
        XCTAssertEqual(model.rows.map(\.status), [nil, nil])

        let connection = try await rig.connect(service, viewer, as: .controller)
        let started = await read(connection, until: isStarted)
        XCTAssertNotNil(started)
        model = ControllerSectionModel(service.controllerSectionState(now: rig.clock.now))
        XCTAssertEqual(model.watching?.line, "지금 보는 Mac: ‘1호 MacBook Pro’ · 보기만")
        XCTAssertEqual(model.rows.first?.status, "지금 보는 중")
        XCTAssertFalse(model.add.choice.enabled)
        XCTAssertEqual(model.history.lines.first?.text, "‘1호 MacBook Pro’ · 연결 (근거리)")

        service.disconnect()
        let ended = await ending(of: connection)
        XCTAssertEqual(ended, .reason(.endedAtMac))
        model = ControllerSectionModel(service.controllerSectionState(now: rig.clock.now))
        XCTAssertNil(model.watching)
        XCTAssertEqual(model.history.lines.first?.text, "‘1호 MacBook Pro’ · 끝남 · 이 Mac에서 끊음 (근거리)")

        // A phone holding the screen is not the section's to show, but adding waits for it.
        let phoneConnection = try await rig.connect(service, phone, as: .phone)
        let phoneStarted = await read(phoneConnection, until: isStarted)
        XCTAssertNotNil(phoneStarted)
        model = ControllerSectionModel(service.controllerSectionState(now: rig.clock.now))
        XCTAssertNil(model.watching)
        XCTAssertFalse(model.add.choice.enabled)
        phoneConnection.close()
    }

    @MainActor
    func testKeepingOnAppearsWhereTheBuildAndTheGateOfferIt() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(macControl: true, keepOn: true)
        rig.net.set(sampleNetwork(1, label: "집 Wi‑Fi"))
        try rig.seed(controllers: [try rig.controller(HostTestSigner(), bound: true)])
        let service = rig.makeService()
        XCTAssertNil(ControllerSectionModel(service.controllerSectionState()).keepOn, "not before the push gate opens")
        rig.openPushGate(service)
        await service.turnOn()
        XCTAssertTrue(service.isOn)
        var model = ControllerSectionModel(service.controllerSectionState())
        XCTAssertEqual(model.keepOn?.primary.action, .keepOn(true))
        XCTAssertEqual(model.keepOn?.primary.enabled, true)
        XCTAssertEqual(model.rows.first?.grantChoice?.action, .grant(id: model.rows[0].id, .control), "「조작」 is offered once S-M3 passed")

        await service.enableKeepOn()
        model = ControllerSectionModel(service.controllerSectionState())
        XCTAssertEqual(model.keepOn?.isOn, true)
        XCTAssertEqual(model.quit.primaryTitle, "끄고 끝내기")
        XCTAssertNotNil(model.quit.keepingOnTitle)
        service.disableKeepOn()
        model = ControllerSectionModel(service.controllerSectionState())
        XCTAssertEqual(model.keepOn?.isOn, false)
        XCTAssertEqual(model.quit.primaryTitle, "AgentsToZ Screen 종료")
        service.turnOff()
    }

    /// The listener stays on when this Mac moves to another network (it serves every network), so nothing in the service
    /// changes by itself: the section reads the network again when the menu or the window opens, and then offers to add it.
    @MainActor
    func testAddingThisNetworkFollowsAMoveWhileOn() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(keepOn: true)
        let home = sampleNetwork(1, label: "집 Wi‑Fi"), office = sampleNetwork(2, label: "사무실 Wi‑Fi")
        rig.net.set(home)
        try rig.seed()
        let service = rig.makeService()
        rig.openPushGate(service)
        await service.turnOn()
        XCTAssertTrue(service.isOn)
        XCTAssertEqual(service.presentNetwork, home.identity, "turning on reads the network")
        XCTAssertNil(service.listeningNetwork, "the nearby listener is bound to no approved network")
        await service.enableKeepOn()
        XCTAssertEqual(service.keepOn?.networks, [home.identity])
        XCTAssertNil(ControllerSectionModel(service.controllerSectionState()).keepOn?.addNetwork, "home is saved")

        // The Mac moves; the menu opens.
        rig.net.set(office)
        await service.refreshPresentNetwork()
        XCTAssertTrue(service.isOn, "still listening")
        let add = try XCTUnwrap(ControllerSectionModel(service.controllerSectionState()).keepOn?.addNetwork, "the office was taken for saved")
        XCTAssertEqual(add.action, .keepOn(true))
        XCTAssertTrue(add.action.raises)
        await service.enableKeepOn()
        XCTAssertEqual(service.keepOn?.networks, [home.identity, office.identity])
        XCTAssertNil(ControllerSectionModel(service.controllerSectionState()).keepOn?.addNetwork, "the office is saved now")

        // A network this Mac cannot tell apart: offered, and pressing says why it cannot be kept, adding nothing.
        rig.net.set(nil)
        await service.refreshPresentNetwork()
        XCTAssertNil(service.presentNetwork)
        XCTAssertNotNil(ControllerSectionModel(service.controllerSectionState()).keepOn?.addNetwork)
        await service.enableKeepOn()
        XCTAssertEqual(service.keepOn?.networks, [home.identity, office.identity])
        XCTAssertTrue(service.problem?.hasPrefix("이 네트워크를 구별할 수 없어 켜 두지 못합니다.") == true, String(describing: service.problem))
        service.turnOff()
    }

    /// The control decision is one: what the build flag says, which the pairing window and the list both read.
    @MainActor
    func testControlIsDecidedInOnePlace() throws {
        for offered in [false, true] {
            let rig = try HostRig()
            rig.flags = ScreenBuildFlags(macControl: offered)
            let service = rig.makeService()
            XCTAssertEqual(service.controlChoiceOffered, offered)
            XCTAssertEqual(service.controllerPairingDependencies().allowsControl, offered,
                           "the pairing window would offer 「조작」 where the list does not, or the other way round")
        }
        // A bundle asking for control gets it only once this build's S-M3 calibration passed.
        let bundleURL = FileManager.default.temporaryDirectory.appending(path: "screen-flags-\(UUID().uuidString).bundle")
        defer { try? FileManager.default.removeItem(at: bundleURL) }
        try FileManager.default.createDirectory(at: bundleURL.appending(path: "Contents"), withIntermediateDirectories: true)
        let info: [String: Any] = ["CFBundleIdentifier": "com.example.screen-flags.\(UUID().uuidString)",
                                   ScreenBuildFlags.macControlKey: true, ScreenBuildFlags.keepOnKey: true,
                                   ScreenBuildFlags.lockedInputKey: true]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: bundleURL.appending(path: "Contents/Info.plist"))
        let bundle = try XCTUnwrap(Bundle(url: bundleURL))
        XCTAssertEqual(bundle.object(forInfoDictionaryKey: ScreenBuildFlags.macControlKey) as? Bool, true, "the test bundle was not read")
        let flags = ScreenBuildFlags.fromBundle(bundle)
        XCTAssertEqual(flags.macControl, ScreenInputCalibration.current.allowsControl)
        XCTAssertFalse(flags.macControl, "S-M3 has not passed in this build")
        XCTAssertTrue(flags.keepOn && flags.lockedInput)
        // Nothing else in Screen reads S-M3's calibration for 「조작」.
        let readers = try swiftSources(in: ["Sources/ScreenHost", "Sources/AgentsToZScreen"])
            .filter { $0.text.contains("ScreenInputCalibration.current.allowsControl") }.map(\.name)
        XCTAssertEqual(readers, ["ScreenSessionRules.swift"])
    }

    // MARK: The 「다른 Mac 추가」 window's store becomes the service's at once

    @MainActor
    func testAControllerTheWindowStoredCanConnectAtOnceAndAReplacedOneCannot() async throws {
        let rig = try HostRig()
        let transport = RecordingPushTransport()
        rig.pushTransport = transport
        let old = HostTestSigner(), new = HostTestSigner()
        let oldRow = try rig.controller(old, bound: true)
        try rig.seed(controllers: [oldRow], allow: false)
        let service = rig.makeService()
        XCTAssertFalse(service.macControllers.allowMacControllers)

        // What the window does on approval (ScreenControllerPairing.store): the switch on and the row, replacing the old.
        let newRow = try rig.controller(new, bound: true)
        try rig.store.saveControllers(try rig.store.controllers().enrolling(newRow, replacing: oldRow.id, phones: try rig.store.devices()))
        XCTAssertEqual(service.controllers.map(\.id), [oldRow.id], "the service has not heard yet")
        service.controllerPairingEnded(.enrolled(newRow))

        XCTAssertTrue(service.macControllers.allowMacControllers, "the approval turned the switch on")
        XCTAssertEqual(service.controllers.map(\.id), [newRow.id])
        XCTAssertEqual(service.controllerHistory.last?.event, .paired)
        XCTAssertEqual(service.controllerHistory.last?.controllerID, newRow.id)
        XCTAssertEqual(service.controllerHistory.last?.reason, "view")
        let told = await eventually { transport.events.all.count == 1 }
        XCTAssertTrue(told)
        XCTAssertEqual(transport.events.all.first?.kind, .controllerRegistered)
        XCTAssertEqual(transport.events.all.first?.actorID, new.fingerprint)

        let replaced = await rig.refusal(service, old, as: .controller)
        XCTAssertNotNil(replaced, "the replaced key is refused at once")
        let connection = try await rig.connect(service, new, as: .controller)
        let started = await read(connection, until: isStarted)
        XCTAssertNotNil(started, "the new key connects without relaunching")
        connection.close()
    }

    /// The window stored a row, and the registry cannot be read again (a locked keychain): 「다른 Mac 연결 허용」 closes and
    /// stays closed until the person turns it on again here. It cannot be saved off either, so screen control stops (the
    /// closed side) and keeping on lets go; once the keychain answers, the next change saves the switch off rather than
    /// reading the window's 「켜짐」 back.
    @MainActor
    func testARegistryThatCannotBeReadAgainStaysClosedUntilTurnedOnHere() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(keepOn: true)
        rig.net.set(sampleNetwork(1, label: "집 Wi‑Fi"))
        let old = HostTestSigner(), other = HostTestSigner(), new = HostTestSigner()
        let oldRow = try rig.controller(old, bound: true), otherRow = try rig.controller(other, bound: true, name: "2호 Mac")
        try rig.seed(controllers: [oldRow, otherRow])
        let service = rig.makeService()
        rig.openPushGate(service)
        await service.turnOn()
        await service.enableKeepOn()
        XCTAssertNotNil(service.keepOn)
        let newRow = try rig.controller(new, bound: true)
        try rig.store.saveControllers(try rig.store.controllers().enrolling(newRow, replacing: oldRow.id, phones: try rig.store.devices()))

        rig.items.failReads([ScreenStore.controllersAccount])
        service.controllerPairingEnded(.enrolled(newRow))
        XCTAssertFalse(service.macControllers.allowMacControllers, "closed")
        XCTAssertFalse(service.isOn, "a closing that cannot be saved stops screen control")
        XCTAssertNil(service.keepOn, "nothing turns on by itself while the store still says on")
        XCTAssertEqual(service.controllerHistory.last?.event, .paired, "the window's addition is still logged")

        // The keychain answers again; the person turns screen control on, and deletes another Mac.
        rig.items.failReads([])
        await service.turnOn()
        XCTAssertTrue(service.isOn)
        for key in [old, new] {
            let refused = await rig.refusal(service, key, as: .controller)
            XCTAssertNotNil(refused, "a controller got in while the switch was held closed")
        }
        service.removeController(otherRow.id)
        XCTAssertTrue(service.isOn)
        XCTAssertEqual(service.controllers.map(\.id), [newRow.id], "the registry is read again")
        XCTAssertFalse(service.macControllers.allowMacControllers, "deleting a row reopened the switch without Touch ID")
        XCTAssertFalse(try rig.store.controllers().allowMacControllers, "the closing was not saved")
        let stillRefused = await rig.refusal(service, new, as: .controller)
        XCTAssertNotNil(stillRefused)
        // Later changes keep it off, and a relaunch reads it off.
        XCTAssertNil(service.renameController(newRow.id, to: "새 이름"))
        XCTAssertFalse(service.macControllers.allowMacControllers)
        XCTAssertFalse(rig.makeService().macControllers.allowMacControllers, "a relaunch read the window's 「켜짐」 back")

        // Turning the switch on here, behind the proof, opens it.
        await service.setAllowMacControllers(true)
        XCTAssertTrue(service.macControllers.allowMacControllers)
        let connection = try await rig.connect(service, new, as: .controller)
        let started = await read(connection, until: isStarted)
        XCTAssertNotNil(started, "the new Mac connects once the person turned the switch on")
        connection.close()
        service.turnOff()
    }

    /// Screen control was off when it happened: the switch is held closed in memory, and the first change after the
    /// keychain answers (here a rename, which asks for nothing) saves it off instead of reading the window's 「켜짐」 back.
    @MainActor
    func testAClosedSwitchHoldsForTheNextChange() async throws {
        let rig = try HostRig()
        let other = HostTestSigner(), new = HostTestSigner()
        let otherRow = try rig.controller(other, bound: true, name: "2호 Mac")
        try rig.seed(controllers: [otherRow])
        let service = rig.makeService()
        let newRow = try rig.controller(new, bound: true)
        try rig.store.saveControllers(try rig.store.controllers().enrolling(newRow, phones: try rig.store.devices()))
        rig.items.failReads([ScreenStore.controllersAccount])
        service.controllerPairingEnded(.enrolled(newRow))
        rig.items.failReads([])
        XCTAssertFalse(service.macControllers.allowMacControllers)
        XCTAssertTrue(try rig.store.controllers().allowMacControllers, "the window's save is still what is stored")

        XCTAssertNil(service.renameController(otherRow.id, to: "사무실"))
        XCTAssertFalse(service.macControllers.allowMacControllers, "a rename reopened the switch")
        XCTAssertFalse(try rig.store.controllers().allowMacControllers, "the closing was not saved with the rename")
        XCTAssertEqual(Set(service.controllers.map(\.id)), [otherRow.id, newRow.id])
    }

    @MainActor
    func testAPairingRefusalIsLoggedAndChangesNothingElse() throws {
        let rig = try HostRig()
        let row = try rig.controller(HostTestSigner(), bound: true)
        try rig.seed(controllers: [row])
        let service = rig.makeService()
        let asking = HostTestSigner()
        service.controllerPairingEnded(.refused(name: "누군가", reason: .codeMismatch, controllerID: asking.id))
        service.controllerPairingEnded(.refused(name: ControllerPairingText.unnamed, reason: .untrustedViewer, controllerID: nil))
        XCTAssertEqual(service.controllers, [row])
        XCTAssertTrue(service.macControllers.allowMacControllers)
        XCTAssertNil(service.problem)
        XCTAssertEqual(service.controllerHistory.map(\.event), [.refused, .refused], "SR-30: a refused registration is logged")
        XCTAssertEqual(service.controllerHistory.map(\.controllerID), [asking.id, ""])
        XCTAssertEqual(service.controllerHistory.map(\.reason), ["pairingCodeMismatch", "pairingUntrustedViewer"])
        XCTAssertEqual(service.controllerHistory.map(\.route), [nil, nil])
        XCTAssertEqual(rig.store.storedControllerLog(), .log(ControllerLog(entries: service.controllerHistory)), "saved")
        XCTAssertEqual(ControllerSectionModel(service.controllerSectionState()).history.lines.map(\.text),
                       ["‘\(ControllerPairingText.unnamed)’ · 등록 거절 · 정품 AgentsToZ Viewer를 확인하지 못함", "‘누군가’ · 등록 거절 · 숫자 불일치"])
    }

    // MARK: The app's sources (SR-29: every raising call passes the gate)

    private static var package: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func source(_ path: String) throws -> String {
        try String(contentsOf: Self.package.appending(path: path), encoding: .utf8)
    }

    /// Every Swift file under `folders`, so a file added later is read too.
    private func swiftSources(in folders: [String]) throws -> [(name: String, text: String)] {
        try folders.flatMap { folder in
            let names = try FileManager.default.contentsOfDirectory(atPath: Self.package.appending(path: folder).path)
                .filter { $0.hasSuffix(".swift") }.sorted()
            return try names.map { ($0, try source("\(folder)/\($0)")) }
        }
    }

    func testEveryRaisingCallInTheAppPassesTheGate() throws {
        // Every file of the app: ScreenApp, main.swift, the pairing window and any file added later.
        let files = try swiftSources(in: ["Sources/AgentsToZScreen"])
        XCTAssertTrue(Set(files.map(\.name)).isSuperset(of: ["ControllerSection.swift", "ScreenApp.swift", "ControllerPairingWindow.swift",
                                                             "main.swift"]), "\(files.map(\.name))")
        let section = try XCTUnwrap(files.first { $0.name == "ControllerSection.swift" }).text
        let raisingCalls = ["setAllowMacControllers(", "setControllerGrant(", "enableKeepOn(", "enrollController("]

        // The service's raising calls live in `ControllerSectionActions.run`, after the gate, and nowhere else.
        let start = try XCTUnwrap(section.range(of: "    static func run(_ action: ControllerSectionAction, by trigger: ControllerSectionTrigger"))
        let end = try XCTUnwrap(section.range(of: "\n    }\n", range: start.upperBound..<section.endIndex))
        let run = String(section[start.lowerBound..<end.upperBound])
        let gate = try XCTUnwrap(run.range(of: "if let notice = ControllerSectionGate.refusal(for: action, by: trigger) { return refused(notice) }"))
        let dispatch = try XCTUnwrap(run.range(of: "switch action {"))
        XCTAssertLessThan(gate.lowerBound, dispatch.lowerBound, "the gate comes before anything runs")
        for call in raisingCalls where call != "enrollController(" { XCTAssertTrue(run.contains("service.\(call)"), call) }
        for (name, text) in files {
            let outside = name == "ControllerSection.swift" ? text.replacingOccurrences(of: run, with: "") : text
            for call in raisingCalls { XCTAssertFalse(outside.contains(call), "\(call) outside the gate, in \(name)") }
            // A click judgement only ever comes from the button that judged it; nothing claims one.
            XCTAssertFalse(text.contains(".click(nil)") || text.contains("click: nil"), "a claimed click in \(name)")
        }
        // The pairing window's raising calls take the judgement of its own hardware-click buttons, and only there.
        let window = try XCTUnwrap(files.first { $0.name == "ControllerPairingWindow.swift" }).text
        for (name, text) in files where name != "ControllerPairingWindow.swift" {
            XCTAssertFalse(text.contains(".open(click:") || text.contains(".approve(click:"), "the pairing window's raising call in \(name)")
        }
        XCTAssertEqual(window.components(separatedBy: "open(click:").count - 1, 1)
        XCTAssertTrue(window.contains("HardwareButton(title: \"등록 창 열기 (120초)\") { click in Task { await pairing.open(click: click) } }"))
        XCTAssertEqual(window.components(separatedBy: "approve(click:").count - 1, 1)
        XCTAssertTrue(window.contains("await pairing.approve(click: click,"))
        let claimed = section.components(separatedBy: "by: .click(").dropFirst()
        XCTAssertEqual(claimed.count, 1)
        XCTAssertTrue(claimed.allSatisfy { $0.hasPrefix("click))") }, "only `HardwareButton`'s own judgement")
        XCTAssertTrue(section.contains("HardwareButton(title: choice.title, enabled: choice.enabled) { click in run(choice.action, by: .click(click)) }"))
        XCTAssertTrue(section.contains("if choice.action.raises {"), "a raising choice is a hardware-click button")
        // The menu cannot judge its click: a raising item only opens the status window.
        XCTAssertTrue(section.contains("guard !choice.action.raises else { return PanelWindows.showStatus() }\n        run(choice.action, by: .unchecked, service: service)"))
    }

    func testTheAppWiresTheWindowToTheServiceAndQuitsAsTheModelSays() throws {
        let section = try source("Sources/AgentsToZScreen/ControllerSection.swift")
        let app = try source("Sources/AgentsToZScreen/ScreenApp.swift")
        XCTAssertTrue(section.contains("pairing.onEvent = { [weak service] event in service?.controllerPairingEnded(event) }"))
        XCTAssertTrue(section.contains("service.closeControllerPairing = { [weak pairing] in pairing?.sessionStarted() }"))
        // 「이 네트워크도 켜 두기」 reads the network again when a menu or the status window opens.
        XCTAssertTrue(section.contains("addObserver(forName: NSMenu.didBeginTrackingNotification"))
        XCTAssertTrue(section.contains(".task { await service.refreshPresentNetwork() }"))
        XCTAssertTrue(app.contains("ControllerSectionActions.connect(ScreenShared.service)"))
        XCTAssertTrue(app.contains("Button(quit.primaryTitle) { Self.quit(service, keepingOn: false) }"), "the default lets keeping on go")
        XCTAssertTrue(app.contains("Button(keeping) { Self.quit(service, keepingOn: true) }"))
        XCTAssertTrue(app.contains("ControllerMenuSection(service: service)"))
        XCTAssertTrue(app.contains("ControllerStatusSection(service: service)"))
        XCTAssertFalse(app.contains("Button(\"AgentsToZ Screen 종료\")"), "one quit, as the model words it")
    }
}
#endif
