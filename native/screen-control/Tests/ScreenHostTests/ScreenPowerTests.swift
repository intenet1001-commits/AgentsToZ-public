#if os(macOS)
import Foundation
import LocalAuthentication
import ScreenControlCore
@testable import ScreenHost
import XCTest

// 「재시작·업데이트 뒤에도 켜 두기 · 이 네트워크에서」 (docs/design/mac-to-mac-2026-11-01 D-2, 7.3, SR-27): on by itself
// only on a saved network, waiting anywhere else; every way of turning off but 「켜 둔 채 끝내기」 and an outside quit lets
// it go; a release that cannot be saved leaves a hold file, and nothing turns on by itself while it is there; a setting
// this build cannot read is off. The checks use memory items, a temporary folder and a listener that is only a stream.
final class ScreenPowerTests: XCTestCase {
    private let home = sampleNetwork(1, label: "집 Wi‑Fi")
    private let office = sampleNetwork(2, label: "사무실 유선")
    private let cafe = sampleNetwork(3, label: "카페 Wi‑Fi")

    // MARK: Rules

    func testOnBySelfOnlyOnASavedNetwork() {
        let setting = KeepOnSetting(since: Date(timeIntervalSince1970: 1_793_000_000), networks: [home.identity, office.identity])
        XCTAssertEqual(KeepOn.atLaunch(setting, held: false, network: home.identity), .listen)
        XCTAssertEqual(KeepOn.atLaunch(setting, held: false, network: office.identity), .listen)
        XCTAssertEqual(KeepOn.atLaunch(setting, held: false, network: cafe.identity), .wait)
        XCTAssertEqual(KeepOn.atLaunch(setting, held: false, network: nil), .wait, "a network that cannot be told apart is not saved")
        XCTAssertEqual(KeepOn.atLaunch(setting, held: true, network: home.identity), .stayOff)
        XCTAssertEqual(KeepOn.atLaunch(nil, held: false, network: home.identity), .stayOff)
        XCTAssertEqual(KeepOn.follow(setting, network: cafe.identity), .wait)
        XCTAssertEqual(KeepOn.follow(setting, network: office.identity), .listen)
    }

    func testTurningOnAgainAddsTheNetworkAndKeepsTheFirstTime() {
        let first = Date(timeIntervalSince1970: 1_793_000_000)
        var setting = KeepOnSetting.turningOn(nil, network: home.identity, at: first)
        setting = KeepOnSetting.turningOn(setting, network: office.identity, at: first.addingTimeInterval(60))
        setting = KeepOnSetting.turningOn(setting, network: home.identity, at: first.addingTimeInterval(120))
        XCTAssertEqual(setting.since, first)
        XCTAssertEqual(setting.networks, [office.identity, home.identity])
        for index in 0..<20 { setting = KeepOnSetting.turningOn(setting, network: sampleNetwork(UInt8(10 + index), label: "").identity, at: first) }
        XCTAssertEqual(setting.networks.count, KeepOnSetting.maxNetworks)
        XCTAssertEqual(setting.networks.last, sampleNetwork(29, label: "").identity, "a full list gives way to the newest")
    }

    func testReleaseClearsFirstThenHoldsThenSaysItFailed() {
        var order: [String] = []
        XCTAssertEqual(KeepOn.release(clear: { order.append("clear") }, hold: { order.append("hold") }), .cleared)
        XCTAssertEqual(order, ["clear"])
        order = []
        XCTAssertEqual(KeepOn.release(clear: { order.append("clear"); throw CocoaError(.fileWriteUnknown) }, hold: { order.append("hold") }), .held)
        XCTAssertEqual(order, ["clear", "hold"])
        XCTAssertEqual(KeepOn.release(clear: { throw CocoaError(.fileWriteUnknown) }, hold: { throw CocoaError(.fileWriteUnknown) }), .failed)
    }

    func testASettingThisBuildCannotReadIsOff() throws {
        let setting = KeepOnSetting(since: Date(timeIntervalSince1970: 1_793_000_000), networks: [home.identity])
        let stored = try ScreenStore.encodeKeepOn(setting)
        XCTAssertEqual(ScreenStore.decodeKeepOn(stored), setting)
        XCTAssertNil(ScreenStore.decodeKeepOn(try ScreenStore.encodeKeepOn(nil)))

        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: stored) as? [String: Any])
        XCTAssertEqual(document["format"] as? Int, 1)
        document["format"] = 2
        XCTAssertNil(ScreenStore.decodeKeepOn(try JSONSerialization.data(withJSONObject: document)), "an unknown format is off")
        document["format"] = 1
        document["networks"] = [["router": Data(repeating: 0, count: 6).base64EncodedString(), "subnet": Data([192, 168, 1, 0]).base64EncodedString(), "prefixLength": 24]]
        XCTAssertNil(ScreenStore.decodeKeepOn(try JSONSerialization.data(withJSONObject: document)), "no network it could match is off")
        XCTAssertNil(ScreenStore.decodeKeepOn(Data("{\"format\":1,\"keepOn\":true".utf8)), "a damaged item is off")

        let items = HostTestItems()
        try items.write(ScreenStore.powerAccount, Data("not json".utf8))
        let read = ScreenStore(items: items).keepOn()
        XCTAssertNil(read.setting)
        XCTAssertFalse(read.unreadable)
    }

    func testHoldFileIsOwnerOnly() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "power-hold-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = folder.appending(path: "power-hold")
        XCTAssertFalse(PowerHold.isHeld(at: url))
        try PowerHold.hold(at: url)
        XCTAssertTrue(PowerHold.isHeld(at: url))
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
        PowerHold.release(at: url)
        XCTAssertFalse(PowerHold.isHeld(at: url))
    }

    // MARK: The service

    @MainActor
    private func keptOnRig(networks: [NetworkIdentity]? = nil, flags: ScreenBuildFlags = ScreenBuildFlags(keepOn: true)) throws -> HostRig {
        let rig = try HostRig()
        rig.flags = flags
        try rig.store.saveKeepOn(KeepOnSetting(since: rig.clock.now, networks: networks ?? [home.identity]))
        return rig
    }

    @MainActor
    func testLaunchListensOnASavedNetworkAndWaitsElsewhere() async throws {
        let rig = try keptOnRig()
        rig.net.set(home)
        let service = rig.makeService()
        await service.resumeKeptOn()
        XCTAssertTrue(service.isOn)
        XCTAssertEqual(rig.opened.count, 1)
        XCTAssertTrue(rig.policies.isEmpty, "on by itself asks nothing")

        // Moved to a network keeping on did not save: waits, the listener closed, a session ended.
        let phone = HostTestSigner()
        try rig.store.save([try rig.phone(phone)])
        let fresh = rig.makeService()
        rig.net.set(home)
        await fresh.resumeKeptOn()
        let source = try XCTUnwrap(rig.opened.last)
        let connection = try await rig.connect(fresh, phone, as: .phone)
        let awaited1 = await read(connection, until: isStarted)
        XCTAssertNotNil(awaited1)
        rig.net.set(cafe)
        await fresh.followKeptOnNetwork().value
        XCTAssertEqual(fresh.power, .waiting(.notKept(label: "카페 Wi‑Fi")))
        XCTAssertTrue(source.isStopped)
        let left = await ending(of: connection)
        XCTAssertEqual(left, .reason(.endedAtMac))

        // Back on a saved network: listens again by itself.
        rig.net.set(home)
        await fresh.followKeptOnNetwork().value
        XCTAssertTrue(fresh.isOn)
        XCTAssertFalse(try XCTUnwrap(rig.opened.last).isStopped)
        service.turnOff()
        fresh.turnOff()
    }

    @MainActor
    func testLaunchOnAnotherNetworkWaitsWithoutListening() async throws {
        let rig = try keptOnRig()
        rig.net.set(cafe)
        let service = rig.makeService()
        await service.resumeKeptOn()
        XCTAssertEqual(service.power, .waiting(.notKept(label: "카페 Wi‑Fi")))
        XCTAssertTrue(rig.opened.isEmpty)
        service.turnOff()
    }

    @MainActor
    func testNothingTurnsOnBySelfWithoutTheSettingOrTheBuild() async throws {
        let off = try HostRig()
        off.flags = ScreenBuildFlags(keepOn: true)
        off.net.set(home)
        let notKept = off.makeService()
        await notKept.resumeKeptOn()
        XCTAssertEqual(notKept.power, .off(reason: nil))

        let oldBuild = try keptOnRig(flags: ScreenBuildFlags())
        oldBuild.net.set(home)
        let service = oldBuild.makeService()
        await service.resumeKeptOn()
        XCTAssertEqual(service.power, .off(reason: nil), "a build without the flag never turns on by itself")
        XCTAssertTrue(oldBuild.opened.isEmpty)
    }

    @MainActor
    func testQuitOffLetsGoAndQuitKeepingOnKeeps() async throws {
        let keeping = try keptOnRig()
        keeping.net.set(home)
        let first = keeping.makeService()
        await first.resumeKeptOn()
        await first.quit(keepingOn: true)
        XCTAssertNotNil(keeping.store.keepOn().setting, "「켜 둔 채 끝내기」 keeps it")
        XCTAssertEqual(ScreenService.keepOnQuitNotice, "다음 로그인 때 이 네트워크에서 다시 켜집니다.")

        let second = keeping.makeService()
        await second.resumeKeptOn()
        XCTAssertTrue(second.isOn, "and the next launch turns on by itself")
        await second.quit()
        XCTAssertNil(keeping.store.keepOn().setting, "「끄고 끝내기」 lets it go")
        XCTAssertNil(second.keepOn)
        XCTAssertFalse(PowerHold.isHeld(at: keeping.powerHoldURL))

        let third = keeping.makeService()
        await third.resumeKeptOn()
        XCTAssertEqual(third.power, .off(reason: nil))
    }

    @MainActor
    func testEveryTurnOffLetsGo() async throws {
        for path in ["menu", "disableKeepOn", "phone", "remote", "failed save"] {
            let rig = try keptOnRig()
            rig.net.set(home)
            let phone = HostTestSigner(), viewer = HostTestSigner()
            try rig.seed(phones: [try rig.phone(phone)], controllers: [try rig.controller(viewer)])
            let service = rig.makeService()
            await service.resumeKeptOn()
            XCTAssertTrue(service.isOn, path)
            switch path {
            case "menu": service.turnOff()
            case "disableKeepOn": service.disableKeepOn()
            case "phone":
                // The phone's own 끄기 in its session.
                let connection = try await rig.connect(service, phone, as: .phone)
                let started = await read(connection, until: isStarted)
                XCTAssertNotNil(started, path)
                try await connection.send(ControlMessage.turnOff)
                let ended = await ending(of: connection)
                XCTAssertEqual(ended, .reason(.turnedOffFromDevice), path)
                _ = await eventually { !service.isOn }
            case "remote":
                // A phone's remote 「화면 제어 전체 끄기」.
                let mac = try PinnedMac(publicKey: rig.mac.publicKey, fingerprint: rig.mac.fingerprint)
                let command = try RemoteCommand(mac: mac, deviceKey: phone.publicKey, action: .turnOff, issuedAt: rig.clock.now)
                let since = try XCTUnwrap(rig.store.keepOn().setting?.since)
                XCTAssertEqual(ScreenPush.apply(command, to: service, onSince: since, at: rig.clock.now), .applied, path)
            default:
                // A removal that cannot be saved stops screen control.
                rig.items.fail([ScreenStore.controllersAccount])
                service.removeController(viewer.id)
            }
            XCTAssertEqual(service.isOn, path == "disableKeepOn", "\(path): only letting go of keeping on leaves it on")
            XCTAssertNil(service.keepOn, path)
            XCTAssertNil(rig.store.keepOn().setting, path)
            XCTAssertFalse(PowerHold.isHeld(at: rig.powerHoldURL), path)
            service.turnOff()
        }
    }

    @MainActor
    func testRevocationThatCannotBeSavedClearsKeepingOnFirst() async throws {
        let rig = try keptOnRig()
        rig.net.set(home)
        let phone = HostTestSigner()
        let device = try rig.phone(phone)
        try rig.store.save([device])
        let service = rig.makeService()
        await service.resumeKeptOn()
        rig.items.fail(["devices"])
        service.revoke(device)
        guard case .off(let reason?) = service.power else { return XCTFail("a revocation that cannot be saved stops screen control") }
        XCTAssertTrue(reason.contains("해지"))
        XCTAssertNil(rig.store.keepOn().setting, "keeping on is cleared first")
        XCTAssertFalse(PowerHold.isHeld(at: rig.powerHoldURL))
    }

    @MainActor
    func testAReleaseThatCannotBeSavedLeavesAHoldAndNothingTurnsOnBySelf() async throws {
        let rig = try keptOnRig()
        rig.net.set(home)
        let phone = HostTestSigner()
        let device = try rig.phone(phone)
        try rig.store.save([device])
        let service = rig.makeService()
        await service.resumeKeptOn()
        rig.items.fail(["devices", ScreenStore.powerAccount])
        service.revoke(device)
        XCTAssertNotNil(rig.store.keepOn().setting, "the store could not be changed")
        XCTAssertTrue(PowerHold.isHeld(at: rig.powerHoldURL), "so the hold file says off")
        XCTAssertNotNil(service.keepOnNotice)

        // The next launch: held, so nothing turns on by itself and nothing listens.
        let next = rig.makeService()
        XCTAssertNil(next.keepOn)
        let decision = await next.keepOnLaunchDecision().decision
        XCTAssertEqual(decision, .stayOff)
        await next.resumeKeptOn()
        XCTAssertEqual(next.power, .off(reason: nil))
        XCTAssertEqual(rig.opened.count, 1, "only the first launch listened")

        // Turning on at this Mac removes the hold only once the store says off.
        await next.turnOn()
        XCTAssertTrue(next.isOn)
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthentication], "the phone path's turning on keeps its prompt")
        XCTAssertTrue(PowerHold.isHeld(at: rig.powerHoldURL), "the store still cannot say off")
        next.turnOff()
        rig.items.fail([])
        await next.turnOn()
        XCTAssertFalse(PowerHold.isHeld(at: rig.powerHoldURL))
        XCTAssertNil(rig.store.keepOn().setting)
        next.turnOff()
    }

    @MainActor
    func testTurningKeepingOnOnTakesBiometricsOrWatchAndThePushGate() async throws {
        let rig = try HostRig()
        rig.flags = ScreenBuildFlags(keepOn: true)
        rig.net.set(office)
        try rig.seed()
        let service = rig.makeService()
        await service.turnOn()
        XCTAssertTrue(service.isOn)
        XCTAssertFalse(service.keepOnOffered)
        await service.enableKeepOn()
        XCTAssertNil(service.keepOn, "hidden before the push gate")
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthentication])

        rig.openPushGate(service)
        XCTAssertTrue(service.keepOnOffered)
        await service.enableKeepOn()
        XCTAssertEqual(rig.policies, [.deviceOwnerAuthentication, .deviceOwnerAuthenticationWithBiometricsOrWatch])
        XCTAssertEqual(service.keepOn?.networks, [office.identity])
        XCTAssertEqual(rig.store.keepOn().setting?.networks, [office.identity])
        service.turnOff()
        XCTAssertNil(rig.store.keepOn().setting)
    }
}
#endif
