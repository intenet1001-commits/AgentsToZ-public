import CryptoKit
import Foundation
import os
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

// Notifications and remote stop (PushCommands.swift, PushRelay.swift): signed message formats, the Mac's checks on a
// remote command (registry, signature, freshness, replay, never undoing what the Mac did later), who hears about an
// event, the "no endpoint → nothing" gate, and the poller acting once and answering with signed results.

/// What a relay would have received, answering each request with `reply`.
final class RecordingTransport: PushTransport {
    let requests = OSAllocatedUnfairLock(initialState: [[String: String]]())
    let reply: @Sendable (Int, [String: String]) -> (Int, Data)

    init(reply: @escaping @Sendable (Int, [String: String]) -> (Int, Data) = { _, _ in (200, Data(#"{"ok":true,"commands":[]}"#.utf8)) }) {
        self.reply = reply
    }

    func post(_ body: Data, to url: URL) async throws -> (status: Int, body: Data) {
        let fields = (try JSONSerialization.jsonObject(with: body) as? [String: String]) ?? [:]
        let index = requests.withLock { requests in
            requests.append(fields)
            return requests.count - 1
        }
        return reply(index, fields)
    }

    var all: [[String: String]] { requests.withLock { $0 } }
}

/// A wall clock the checks move by hand.
final class HandClock: Sendable {
    private let current: OSAllocatedUnfairLock<Date>
    init(_ start: Date) { current = OSAllocatedUnfairLock(initialState: start) }
    var now: Date { current.withLock { $0 } }
    func advance(_ seconds: TimeInterval) { current.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

private func deviceID(_ signer: TranscriptSigner) -> Data { ScreenControlIdentity.fingerprint(of: signer.publicKey) }

private func commandsBody(_ list: [SignedPushMessage]) -> Data {
    let items = list.map { ["message": $0.message.base64EncodedString(), "signature": $0.signature.base64EncodedString()] }
    return try! JSONSerialization.data(withJSONObject: ["ok": true, "commands": items])
}

extension ScreenControlChecks {
    static var pushChecks: [(String, (ScreenControlChecks) -> () async throws -> Void)] { [
        ("push messages sign, verify and decode strictly", { $0.testPushMessagesSignVerifyAndDecodeStrictly }),
        ("remote command: replay and expiry refused", { $0.testRemoteCommandReplayAndExpiryAreRefused }),
        ("remote command: live replay records survive capacity pressure", { $0.testRemoteCommandReplayRecordsSurviveCapacityPressure }),
        ("remote command: wrong or unregistered device refused", { $0.testRemoteCommandFromAWrongOrUnregisteredDeviceIsRefused }),
        ("remote stop never undoes what the Mac did later", { $0.testRemoteStopNeverUndoesWhatTheMacDidLater }),
        ("notifications skip the acting device", { $0.testNotificationsSkipTheActingDevice }),
        ("Mac controller notifications stay distinct and signed", { $0.testMacControllerEventsStayDistinctAndSigned }),
        ("no push endpoint: nothing signed, sent or polled", { $0.testNoEndpointMeansNothingIsSignedSentOrPolled }),
        ("poller acts once on verified commands, answers signed", { $0.testPollerActsOnceOnVerifiedCommandsAndAnswersSigned }),
        ("push messages match the relay's contract vectors", { $0.testPushMessagesMatchTheRelayContract }),
        ("weekly usage alerts: relay bytes, strict reading, own label", { $0.testWeeklyUsageAlertsMatchTheRelayAndReadStrictly }),
        ("weekly usage hand-offs: strict, fresh, budgeted, sent once", { $0.testWeeklyUsageHandoffsAreStrictFreshAndBudgeted }),
    ] }

    /// The weekly allowance alert: the same bytes as the relay's vector (signed by WebCrypto), read strictly, never mistaken
    /// for a screen event, and sent only with an endpoint.
    func testWeeklyUsageAlertsMatchTheRelayAndReadStrictly() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "PushContract").appending(path: "vectors.json")
        guard let v = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
              let pair = v["weeklyUsage"] as? [String: Any] else { throw CheckFailure(description: "vectors.json weeklyUsage unreadable") }
        func h(_ key: String) -> Data { hex(v[key] as? String ?? "") }
        let mac = SoftwareSigner(key: try .init(rawRepresentation: h("macScalar")))
        let device = SoftwareSigner(key: try .init(rawRepresentation: h("deviceScalar")))
        let other = SoftwareSigner(key: try .init(rawRepresentation: h("otherScalar")))
        guard let handoff = WeeklyUsageHandoff(provider: .codex, mark: UInt8(pair["mark"] as? Int ?? 0), windowKey: pair["windowKey"] as? String ?? "",
                                               observedAt: UInt64(v["eventAt"] as? Double ?? 0)) else { throw CheckFailure(description: "vector hand-off") }
        // The file the main app writes for this alert (tests/weekly-usage-push-host.test.ts writes the same bytes).
        try check(WeeklyUsageHandoff.decode(Data((pair["handoff"] as? String ?? "").utf8)) == handoff, "the main app's hand-off file reads as this alert")
        let usage = try WeeklyUsageEvent(macKey: mac.publicKey, macName: v["macName"] as? String ?? "", handoff: handoff,
                                         recipients: [deviceID(device), deviceID(other)],
                                         issuedAt: Date(timeIntervalSince1970: (v["issuedAt"] as? Double ?? 0) / 1000), nonce: h("nonce"))
        let signed = SignedPushMessage(message: hex(pair["message"] as? String ?? ""), signature: hex(pair["signature"] as? String ?? ""))
        try check(usage.encoded() == signed.message, "weekly usage bytes match the relay's")
        try check(signed.isValid(for: mac.publicKey) && !signed.isValid(for: device.publicKey), "signed by the Mac key only")
        try check(try WeeklyUsageEvent.decode(signed.message) == usage, "weekly usage decodes")
        try check(usage.key == "codex:r498056:30", "the alert key is the collapse ID's")
        try check((try? ScreenEvent.decode(signed.message)) == nil, "a weekly alert is not a screen event")
        let screen = try ScreenEvent(macKey: mac.publicKey, kind: .connected, at: Date(), macName: "Mac", actorID: deviceID(device),
                                     actorName: "iPad", recipients: [deviceID(other)])
        try check((try? WeeklyUsageEvent.decode(screen.encoded())) == nil, "nor a screen event a weekly alert")
        try await expectError(PushMessageError.malformed) { _ = try WeeklyUsageEvent.decode(signed.message + Data([0])) }
        try await expectError(PushMessageError.wrongSigner) { _ = try await usage.signed(by: device) }
        let roundTrip = try await usage.signed(by: mac)
        try check(try WeeklyUsageEvent.decode(roundTrip.message) == usage && roundTrip.isValid(for: mac.publicKey), "signs and reads back")

        for (mark, window) in [(UInt8(35), "r1"), (UInt8(100), "r1"), (UInt8(30), "r"), (UInt8(30), "r1234567890"), (UInt8(30), "x12"),
                               (UInt8(30), "w2026-W4"), (UInt8(30), "w2026W441"), (UInt8(30), "ｒ12")] {
            try check(WeeklyUsageHandoff(provider: .claude, mark: mark, windowKey: window, observedAt: 1) == nil, "refused \(mark) \(window)")
        }
        try check(WeeklyUsageHandoff(provider: .agy, mark: 0, windowKey: "w2026-W44", observedAt: 1) != nil, "소진 in an ISO week")
        try await expectError(PushMessageError.malformed) {
            _ = try WeeklyUsageEvent(macKey: mac.publicKey, macName: "Mac‮koob", handoff: handoff, recipients: [deviceID(device)])
        }
        try await expectError(PushMessageError.malformed) {
            _ = try WeeklyUsageEvent(macKey: mac.publicKey, macName: "Mac", handoff: handoff, recipients: [])
        }
        try await expectError(PushMessageError.malformed) {
            _ = try WeeklyUsageEvent(macKey: mac.publicKey, macName: "Mac", handoff: handoff, recipients: [deviceID(device), deviceID(device)])
        }

        // Without an endpoint nothing is signed or sent; with one, it goes as the `weekly-usage` kind, once.
        let transport = RecordingTransport(reply: { _, _ in (200, Data(#"{"ok":true,"sent":1}"#.utf8)) })
        let counting = CountingSigner()
        let offEvent = try WeeklyUsageEvent(macKey: counting.publicKey, macName: "Mac", handoff: handoff, recipients: [deviceID(device)])
        try check(try await !ScreenPushClient(endpoint: nil, transport: transport).notify(offEvent, signer: counting), "off: nothing")
        let signedCount = await counting.counter.count
        try check(transport.all.isEmpty && signedCount == 0, "nothing signed or sent without an endpoint")
        let on = ScreenPushClient(endpoint: PushEndpoint("https://project.supabase.co/functions/v1/screen-push"), transport: transport)
        try check(try await on.notify(usage, signer: mac), "sent with an endpoint")
        try check(transport.all.count == 1 && transport.all[0]["type"] == "weekly-usage"
                  && transport.all[0]["message"] == usage.encoded().base64EncodedString(), "one weekly-usage request")
    }

    /// What the main app hands over is read strictly, used only while fresh, capped like the relay, and addressed to the
    /// Mac's own devices in use.
    func testWeeklyUsageHandoffsAreStrictFreshAndBudgeted() async throws {
        let now = Date(timeIntervalSince1970: 1_793_000_000)
        let ms = UInt64(now.timeIntervalSince1970 * 1000)
        let good = #"{"version":1,"provider":"claude","mark":20,"windowKey":"r498056","observedAt":\#(ms)}"#
        guard let handoff = WeeklyUsageHandoff.decode(Data(good.utf8)) else { throw CheckFailure(description: "a good hand-off") }
        try check(handoff == WeeklyUsageHandoff(provider: .claude, mark: 20, windowKey: "r498056", observedAt: ms), "reads every field")
        for bad in [
            #"{"version":2,"provider":"claude","mark":20,"windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"gemini","mark":20,"windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":25,"windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":20.5,"windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":true,"windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":"20","windowKey":"r498056","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":20,"windowKey":"r498056\n","observedAt":1}"#,
            #"{"version":1,"provider":"claude","mark":20,"windowKey":"r498056","observedAt":0}"#,
            #"{"version":1,"provider":"claude","mark":20,"windowKey":"r498056","observedAt":1,"account":"a@b.c"}"#,
            #"{"version":1,"provider":"claude","mark":20,"windowKey":"r498056"}"#,
            #"[1]"#, "", String(repeating: " ", count: 600) + good,
        ] { try check(WeeklyUsageHandoff.decode(Data(bad.utf8)) == nil, "refused: \(bad.prefix(80))") }

        try check(handoff.isFresh(at: now) && handoff.isFresh(at: now + WeeklyUsageHandoff.maxAge), "fresh up to two hours")
        try check(!handoff.isFresh(at: now + WeeklyUsageHandoff.maxAge + 1), "older is dropped unsent")
        try check(!handoff.isFresh(at: now - RemoteStopClock.skew - 1), "and so is one from the future")

        var budget = WeeklyUsageBudget()
        try check((0..<WeeklyUsageBudget.limit).allSatisfy { budget.take(at: now + Double($0)) }, "twelve an hour")
        try check(!budget.take(at: now + 60), "not a thirteenth")
        try check(budget.take(at: now + WeeklyUsageBudget.window), "again an hour later")

        let mac = SoftwareSigner(), phone = SoftwareSigner(), ipad = SoftwareSigner()
        var fresh = WeeklyUsageBudget()
        let stale = WeeklyUsageHandoff(provider: .codex, mark: 0, windowKey: "w2026-W44", observedAt: ms - 3 * 3600 * 1000)!
        let events = WeeklyUsageEvent.plan([handoff, stale, handoff], macKey: mac.publicKey, macName: "사무실 Mac",
                                           recipients: [deviceID(phone), deviceID(ipad)], budget: &fresh, at: now)
        try check(events.count == 2 && events.allSatisfy { $0.recipients == [deviceID(phone), deviceID(ipad)] && $0.provider == .claude },
                  "fresh ones, to the Mac's devices")
        try check(Set(events.map(\.nonce)).count == 2, "each with its own nonce")
        var unused = WeeklyUsageBudget()
        try check(WeeklyUsageEvent.plan([handoff], macKey: mac.publicKey, macName: "Mac", recipients: [], budget: &unused, at: now).isEmpty,
                  "nobody registered: nothing")
        try check(unused.take(at: now) && (1..<WeeklyUsageBudget.limit).allSatisfy { _ in unused.take(at: now) }, "and no budget spent")
        var spent = WeeklyUsageBudget()
        for _ in 0..<WeeklyUsageBudget.limit { _ = spent.take(at: now) }
        try check(WeeklyUsageEvent.plan([handoff], macKey: mac.publicKey, macName: "Mac", recipients: [deviceID(phone)], budget: &spent, at: now).isEmpty,
                  "over budget: dropped")
    }

    /// The relay reads the same bytes: Tests/PushContract/vectors.json, which tests/screen-push-protocol.test.ts decodes
    /// with supabase/functions/screen-push/protocol.ts. Its signatures came from WebCrypto, so this also shows the two
    /// signature formats are one. Fixed test keys only.
    func testPushMessagesMatchTheRelayContract() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "PushContract").appending(path: "vectors.json")
        guard let v = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw CheckFailure(description: "vectors.json unreadable")
        }
        func h(_ key: String) -> Data { hex(v[key] as? String ?? "") }
        func pair(_ key: String) -> SignedPushMessage {
            let p = v[key] as? [String: String] ?? [:]
            return SignedPushMessage(message: hex(p["message"] ?? ""), signature: hex(p["signature"] ?? ""))
        }
        func date(_ key: String) -> Date { Date(timeIntervalSince1970: (v[key] as? Double ?? 0) / 1000) }
        let mac = SoftwareSigner(key: try .init(rawRepresentation: h("macScalar")))
        let device = SoftwareSigner(key: try .init(rawRepresentation: h("deviceScalar")))
        let other = SoftwareSigner(key: try .init(rawRepresentation: h("otherScalar")))
        try check(mac.publicKey.x963Representation == h("macPublic") && device.publicKey.x963Representation == h("devicePublic")
                  && other.publicKey.x963Representation == h("otherPublic"), "the same keys")
        let issuedAt = date("issuedAt"), nonce = h("nonce")

        let registration = try PushRegistration(mac: pinned(mac.publicKey), deviceKey: device.publicKey, token: h("token"),
                                                environment: .production, topic: v["topic"] as? String ?? "", issuedAt: issuedAt, nonce: nonce)
        let register = pair("register")
        try check(registration.encoded() == register.message, "registration bytes")
        try check(register.isValid(for: device.publicKey), "registration signature")
        try check(try PushRegistration.decode(register.message) == registration, "registration decodes")

        let event = try ScreenEvent(macKey: mac.publicKey, kind: .connected, at: date("eventAt"), macName: v["macName"] as? String ?? "",
                                    actorID: deviceID(device), actorName: v["actorName"] as? String ?? "", recipients: [deviceID(other)],
                                    issuedAt: issuedAt, nonce: nonce)
        let notify = pair("notify")
        try check(event.encoded() == notify.message, "event bytes")
        try check(ScreenEvent.open(notify, mac: pinned(mac.publicKey)) == event, "event opens with the pinned Mac")

        let command = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .revokeDevice(deviceID(other)),
                                        issuedAt: issuedAt, nonce: nonce)
        let sent = pair("command")
        try check(command.encoded() == sent.message, "command bytes")
        try check(sent.isValid(for: device.publicKey), "command signature")
        try check(command.id.pushHex == (v["command"] as? [String: String])?["id"], "command ID")

        let result = try RemoteCommandResult(decoding: h("result"))
        try check(RemoteCommandResult.open(h("result"), commandID: command.id, mac: pinned(mac.publicKey)) == .applied, "result opens")
        let fetch = try MacFetch(macKey: mac.publicKey, deviceIDs: [deviceID(device), deviceID(other)], results: [result],
                                 issuedAt: issuedAt, nonce: nonce)
        let poll = pair("fetch")
        try check(fetch.encoded() == poll.message, "fetch bytes")
        try check(poll.isValid(for: mac.publicKey), "fetch signature")
    }

    func testPushMessagesSignVerifyAndDecodeStrictly() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner(), other = SoftwareSigner()
        let token = Data(repeating: 0xAB, count: 32)

        let registration = try PushRegistration(mac: pinned(mac.publicKey), deviceKey: device.publicKey, token: token,
                                                environment: .production, topic: "com.intenet.agentstoz.mobile.testflight")
        let signedRegistration = try await registration.signed(by: device)
        try check(signedRegistration.isValid(for: device.publicKey), "registration verifies with the device key")
        try check(!signedRegistration.isValid(for: mac.publicKey), "and with no other key")
        try check(try PushRegistration.decode(signedRegistration.message) == registration, "registration round trip")
        try check(!SignedPushMessage(message: flipByte(signedRegistration.message, at: 120), signature: signedRegistration.signature)
            .isValid(for: device.publicKey), "a changed registration no longer verifies")
        try await expectError(PushMessageError.wrongSigner) { _ = try await registration.signed(by: other) }
        try await expectError(PushMessageError.malformed) { _ = try PushRegistration.decode(signedRegistration.message + Data([0])) }
        try await expectError(PushMessageError.malformed) {
            _ = try PushRegistration(mac: pinned(mac.publicKey), deviceKey: device.publicKey, token: token, environment: .sandbox,
                                     topic: "com.example/app")
        }
        try await expectError(PushMessageError.malformed) {
            _ = try PushRegistration(mac: pinned(mac.publicKey), deviceKey: device.publicKey, token: Data(count: 4),
                                     environment: .sandbox, topic: "com.example.app")
        }

        let event = try ScreenEvent(macKey: mac.publicKey, kind: .connected, at: Date(), macName: "최천성의 MacBook Pro",
                                    actorID: deviceID(device), actorName: "아이패드", recipients: [deviceID(other)])
        let signedEvent = try await event.signed(by: mac)
        try check(ScreenEvent.open(signedEvent, mac: pinned(mac.publicKey)) == event, "the pinned Mac's event opens")
        try check(ScreenEvent.open(signedEvent, mac: pinned(other.publicKey)) == nil, "another Mac's does not")
        try check(ScreenEvent.open(SignedPushMessage(message: signedEvent.message, signature: flipByte(signedEvent.signature, at: 3)),
                                   mac: pinned(mac.publicKey)) == nil, "a changed signature does not")
        try await expectError(PushMessageError.wrongSigner) { _ = try await event.signed(by: device) }
        try await expectError(PushMessageError.malformed) {
            _ = try ScreenEvent(macKey: mac.publicKey, kind: .registered, at: Date(), macName: "Mac\u{202E}koob", actorID: deviceID(device),
                                actorName: "iPad", recipients: [])
        }
        try await expectError(PushMessageError.malformed) {
            _ = try ScreenEvent(macKey: mac.publicKey, kind: .registered, at: Date(), macName: "Mac", actorID: deviceID(device),
                                actorName: "iPad", recipients: (0..<17).map { _ in randomBytes(32) })
        }

        let command = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .revokeDevice(deviceID(other)))
        let signedCommand = try await command.signed(by: device)
        try check(try RemoteCommand.decode(signedCommand.message) == command, "command round trip")
        try check(signedCommand.isValid(for: device.publicKey), "command verifies")
        let again = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .revokeDevice(deviceID(other)))
        try check(again.id != command.id, "a fresh nonce names a different command")
        // A signature for one kind of message never passes as another: the labels differ.
        try await expectError(PushMessageError.malformed) { _ = try RemoteCommand.decode(signedRegistration.message) }
        try await expectError(PushMessageError.malformed) { _ = try ScreenEvent.decode(signedCommand.message) }

        let result = try await RemoteCommandResult.make(commandID: command.id, outcome: .applied, signer: mac)
        try check(RemoteCommandResult.open(result.encoded, commandID: command.id, mac: pinned(mac.publicKey)) == .applied, "result opens")
        try check(RemoteCommandResult.open(result.encoded, commandID: again.id, mac: pinned(mac.publicKey)) == nil,
                  "a result for another command does not")
        try check(RemoteCommandResult.open(result.encoded, commandID: command.id, mac: pinned(other.publicKey)) == nil,
                  "a result from another Mac does not")
        var forged = [UInt8](result.encoded)
        forged[32] = RemoteCommandOutcome.refused.rawValue
        try check(RemoteCommandResult.open(Data(forged), commandID: command.id, mac: pinned(mac.publicKey)) == nil,
                  "a changed outcome does not")

        let fetch = try MacFetch(macKey: mac.publicKey, deviceIDs: [deviceID(device), deviceID(other)], results: [result])
        try check(try MacFetch.decode(try await fetch.signed(by: mac).message) == fetch, "fetch round trip")
        try await expectError(PushMessageError.malformed) {
            _ = try MacFetch(macKey: mac.publicKey, deviceIDs: [deviceID(device), deviceID(device)], results: [])
        }
    }

    func testRemoteCommandReplayRecordsSurviveCapacityPressure() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner()
        let clock = HandClock(Date(timeIntervalSince1970: 1_800_000_000))
        let verifier = RemoteCommandVerifier(macFingerprint: deviceID(mac), capacity: 2, now: { clock.now }) { id in
            id == deviceID(device) ? device.publicKey : nil
        }
        func command(_ action: RemoteStopAction = .endSession) async throws -> SignedPushMessage {
            try await RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: action,
                                    issuedAt: clock.now).signed(by: device)
        }
        let first = try await command(.turnOff), second = try await command(), overflow = try await command()
        _ = try verifier.verify(first)
        _ = try verifier.verify(second)
        // Pressure must not erase an unexpired replay record. Overflow may be refused, but the first command
        // must remain refused even when a relay resends its original, valid signature.
        try await expectError(RemoteCommandError.replayCapacityExceeded) { _ = try verifier.verify(overflow) }
        try await expectError(RemoteCommandError.replayed) { _ = try verifier.verify(first) }
        // The short-lived entry expires, freeing room without dropping the seven-day turn-off record.
        clock.advance(RemoteStopAction.endSession.maxAge + RemoteStopClock.skew + 1)
        _ = try verifier.verify(try await command())
        try await expectError(RemoteCommandError.replayed) { _ = try verifier.verify(first) }
    }

    func testRemoteCommandReplayAndExpiryAreRefused() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner()
        let clock = HandClock(Date(timeIntervalSince1970: 1_800_000_000))
        let keys = RegisteredDeviceKeys(now: { clock.now })
        keys.set([.init(publicKey: device.publicKey, registeredAt: clock.now.addingTimeInterval(-86_400), lastConnectedAt: nil)])
        let verifier = RemoteCommandVerifier(macFingerprint: deviceID(mac), now: { clock.now }) { keys.key(for: $0) }
        func signed(_ action: RemoteStopAction, issued offset: TimeInterval) async throws -> SignedPushMessage {
            try await RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: action,
                                    issuedAt: clock.now.addingTimeInterval(offset)).signed(by: device)
        }

        let end = try await signed(.endSession, issued: -5)
        try check(try verifier.verify(end).action == .endSession, "a fresh command is accepted")
        try await expectError(RemoteCommandError.replayed) { _ = try verifier.verify(end) }
        // ECDSA signs with a fresh random nonce each time: the same command signed again has other signature bytes and
        // is still the same command.
        let resigned = try await device.signature(for: end.message).rawRepresentation
        try check(resigned != end.signature, "a second signature differs")
        try await expectError(RemoteCommandError.replayed) { _ = try verifier.verify(SignedPushMessage(message: end.message, signature: resigned)) }

        try await expectError(RemoteCommandError.expired) { _ = try verifier.verify(try await signed(.endSession, issued: -11 * 60)) }
        try await expectError(RemoteCommandError.expired) { _ = try verifier.verify(try await signed(.revokeConnected, issued: -11 * 60)) }
        try check(try verifier.verify(try await signed(.turnOff, issued: -6 * 86_400)).action == .turnOff, "turning off holds for days")
        try await expectError(RemoteCommandError.expired) { _ = try verifier.verify(try await signed(.turnOff, issued: -8 * 86_400)) }
        try await expectError(RemoteCommandError.expired) { _ = try verifier.verify(try await signed(.endSession, issued: 3 * 60)) }
        try check(try verifier.verify(try await signed(.endSession, issued: 60)).action == .endSession, "a minute of clock skew is fine")

        // Remembered until it would expire anyway: a week later the same command is refused as too old.
        let revoke = try await signed(.revokeDevice(randomBytes(32)), issued: 0)
        _ = try verifier.verify(revoke)
        try await expectError(RemoteCommandError.replayed) { _ = try verifier.verify(revoke) }
        clock.advance(7 * 86_400 + 1)
        keys.set([.init(publicKey: device.publicKey, registeredAt: clock.now, lastConnectedAt: nil)])
        try await expectError(RemoteCommandError.expired) { _ = try verifier.verify(revoke) }
    }

    func testRemoteCommandFromAWrongOrUnregisteredDeviceIsRefused() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner(), stranger = SoftwareSigner()
        let clock = HandClock(Date(timeIntervalSince1970: 1_800_000_000))
        let keys = RegisteredDeviceKeys(now: { clock.now })
        keys.set([.init(publicKey: device.publicKey, registeredAt: clock.now.addingTimeInterval(-3600), lastConnectedAt: nil)])
        let verifier = RemoteCommandVerifier(macFingerprint: deviceID(mac), now: { clock.now }) { keys.key(for: $0) }
        func command(from key: P256.Signing.PublicKey, mac macKey: P256.Signing.PublicKey? = nil) throws -> RemoteCommand {
            try RemoteCommand(mac: pinned(macKey ?? mac.publicKey), deviceKey: key, action: .turnOff, issuedAt: clock.now)
        }

        try check(try verifier.verify(try await command(from: device.publicKey).signed(by: device)).deviceID == deviceID(device),
                  "the registered device is accepted")
        // A device the Mac never approved signs its own command perfectly well; the server could be holding its key.
        try await expectError(RemoteCommandError.unknownDevice) {
            _ = try verifier.verify(try await command(from: stranger.publicKey).signed(by: stranger))
        }
        // Naming the registered device but signing with another key.
        let impostor = ImpostorSigner(claimed: device.publicKey)
        try await expectError(RemoteCommandError.badSignature) {
            _ = try verifier.verify(try await command(from: device.publicKey).signed(by: impostor))
        }
        // A registered command with the signature of another registered-looking message.
        let real = try await command(from: device.publicKey).signed(by: device)
        let swapped = try await command(from: device.publicKey).signed(by: device)
        try await expectError(RemoteCommandError.badSignature) {
            _ = try verifier.verify(SignedPushMessage(message: real.message, signature: swapped.signature))
        }
        try await expectError(RemoteCommandError.otherMac) {
            _ = try verifier.verify(try await command(from: device.publicKey, mac: stranger.publicKey).signed(by: device))
        }
        try await expectError(RemoteCommandError.malformed) {
            _ = try verifier.verify(SignedPushMessage(message: Data("turn off".utf8), signature: Data(count: 64)))
        }
        // Revoked at the Mac, or 90 days without use: refused like an unknown device.
        let pending = try await command(from: device.publicKey).signed(by: device)
        keys.set([.init(publicKey: device.publicKey, registeredAt: clock.now.addingTimeInterval(-91 * 86_400), lastConnectedAt: nil)])
        try await expectError(RemoteCommandError.unknownDevice) { _ = try verifier.verify(pending) }
        keys.set([])
        try await expectError(RemoteCommandError.unknownDevice) { _ = try verifier.verify(pending) }
    }

    func testRemoteStopNeverUndoesWhatTheMacDidLater() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner()
        let sent = Date(timeIntervalSince1970: 1_800_000_000)
        let viewer = randomBytes(32), other = randomBytes(32)
        func decide(_ action: RemoteStopAction, _ state: RemoteStopState) throws -> (RemoteStopEffect?, RemoteCommandOutcome) {
            let command = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: action, issuedAt: sent)
            let decision = RemoteStopDecision.decide(command, state: state)
            return (decision.effect, decision.outcome)
        }
        func state(on: TimeInterval? = -3600, session: TimeInterval? = nil, registered: [Data: TimeInterval] = [:]) -> RemoteStopState {
            RemoteStopState(onSince: on.map { sent.addingTimeInterval($0) },
                            session: session.map { .init(deviceID: viewer, since: sent.addingTimeInterval($0)) },
                            registeredAt: registered.mapValues { sent.addingTimeInterval($0) })
        }

        try check(try decide(.turnOff, state()) == (.turnOff, .applied), "turns off what was on before")
        try check(try decide(.turnOff, state(on: 600)) == (nil, .superseded), "turned on again at the Mac afterwards: stays on")
        try check(try decide(.turnOff, state(on: 60)) == (.turnOff, .applied), "within the clock skew it still applies")
        try check(try decide(.turnOff, state(on: nil)) == (nil, .nothingToDo), "already off")
        try check(try decide(.endSession, state(session: -300)) == (.endSession, .applied), "ends the session it was sent about")
        try check(try decide(.endSession, state(session: 300)) == (nil, .superseded), "never a session that began later")
        try check(try decide(.endSession, state()) == (nil, .nothingToDo), "no session")
        try check(try decide(.revokeConnected, state(session: -300)) == (.revoke(viewer), .applied), "revokes the device connected now")
        try check(try decide(.revokeConnected, state(session: 300)) == (nil, .superseded), "not one that connected later")
        try check(try decide(.revokeDevice(other), state(registered: [other: -86_400])) == (.revoke(other), .applied), "revokes the named device")
        try check(try decide(.revokeDevice(other), state(registered: [other: 3600])) == (nil, .superseded),
                  "approved again at the Mac afterwards: stays registered")
        try check(try decide(.revokeDevice(other), state()) == (nil, .nothingToDo), "not registered")
    }

    func testNotificationsSkipTheActingDevice() async throws {
        let mac = SoftwareSigner()
        let actor = randomBytes(32), a = randomBytes(32), b = randomBytes(32), c = randomBytes(32)
        try check(ScreenEvent.recipients(registered: [a, actor, b, a, c], actor: actor) == [a, b, c],
                  "every other device once, never the one that acted")
        try check(ScreenEvent.recipients(registered: [actor], actor: actor).isEmpty, "alone: nobody to tell")
        try check(ScreenEvent.recipients(registered: (0..<20).map { _ in randomBytes(32) }, actor: actor).count == 16, "at most 16")
        try await expectError(PushMessageError.malformed) {
            _ = try ScreenEvent(macKey: mac.publicKey, kind: .connected, at: Date(), macName: "Mac", actorID: actor, actorName: "iPad",
                                recipients: [a, actor])
        }
        // A message listing the actor, however it was made, does not decode.
        let listing = PushWire.encode(label: PushLabel.notify, [
            mac.publicKey.x963Representation, Data([1]), UInt64(1).bigEndianData, Data("Mac".utf8), actor, Data("iPad".utf8),
            a + actor, UInt64(1).bigEndianData, randomBytes(16),
        ])
        try await expectError(PushMessageError.malformed) { _ = try ScreenEvent.decode(listing) }
    }

    func testMacControllerEventsStayDistinctAndSigned() async throws {
        let mac = SoftwareSigner(), phone = SoftwareSigner(), controller = SoftwareSigner(), wrongMac = SoftwareSigner()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        for (kind, byte) in [(ScreenEventKind.controllerConnected, UInt8(3)), (.controllerRegistered, UInt8(4))] {
            try check(kind.rawValue == byte, "controller events have their own wire values")
            let event = try ScreenEvent(macKey: mac.publicKey, kind: kind, at: now, macName: "Mac B",
                actorID: deviceID(controller), actorName: "Mac A", recipients: [deviceID(phone)], issuedAt: now)
            let signed = try await event.signed(by: mac)
            try check(try ScreenEvent.decode(signed.message) == event, "controller event round trip")
            try check(ScreenEvent.open(signed, mac: pinned(mac.publicKey)) == event, "only the pinned host signs the event")
            try check(ScreenEvent.open(signed, mac: pinned(wrongMac.publicKey)) == nil, "another host is refused")
            let forged = SignedPushMessage(message: signed.message, signature: try await controller.signature(for: signed.message).rawRepresentation)
            try check(ScreenEvent.open(forged, mac: pinned(mac.publicKey)) == nil, "controller cannot impersonate the host")
        }
        try check(ScreenEventKind.connected.rawValue == 1 && ScreenEventKind.registered.rawValue == 2,
                  "existing phone event wire values stay unchanged")
        try check(ScreenEventKind(rawValue: 5) == nil, "unknown event kinds fail closed")

        // Controller registration is a separate key set: even a properly signed controller command has no phone authority.
        let keys = RegisteredDeviceKeys(now: { now })
        keys.set([.init(publicKey: phone.publicKey, registeredAt: now, lastConnectedAt: nil)])
        let verifier = RemoteCommandVerifier(macFingerprint: deviceID(mac), now: { now }) { keys.key(for: $0) }
        let command = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: controller.publicKey, action: .turnOff, issuedAt: now)
        try await expectError(RemoteCommandError.unknownDevice) { _ = try verifier.verify(try await command.signed(by: controller)) }
    }

    func testNoEndpointMeansNothingIsSignedSentOrPolled() async throws {
        for text in [nil, "", "   ", "http://example.com/functions/v1/screen-push", "https://user:secret@example.com/x",
                     "https://example.com/x?key=1", "https://example.com/x#a", "ftp://example.com/x", "https://", "screen-push"] {
            try check(PushEndpoint(text) == nil, "no endpoint from \(text ?? "nil")")
        }
        let endpoint = PushEndpoint("https://project.supabase.co/functions/v1/screen-push")
        try check(endpoint?.url.host == "project.supabase.co", "an HTTPS URL is an endpoint")

        let transport = RecordingTransport()
        let mac = CountingSigner(), device = CountingSigner()
        let off = ScreenPushClient(endpoint: nil, transport: transport)
        try check(!off.isEnabled, "off without an endpoint")
        let event = try ScreenEvent(macKey: mac.publicKey, kind: .connected, at: Date(), macName: "Mac",
                                    actorID: randomBytes(32), actorName: "iPad", recipients: [randomBytes(32)])
        try check(try await !off.notify(event, signer: mac), "notify does nothing")
        try check(try await off.fetch(try MacFetch(macKey: mac.publicKey, deviceIDs: [], results: []), signer: mac).isEmpty, "fetch does nothing")
        let registration = try PushRegistration(mac: pinned(mac.publicKey), deviceKey: device.publicKey, token: Data(count: 32),
                                                environment: .sandbox, topic: "com.intenet.agentstoz.mobile.dev")
        try check(try await !off.register(registration, signer: device), "register does nothing")
        try check(try await !off.unregister(macFingerprint: randomBytes(32), deviceID: randomBytes(32), token: Data(count: 32)),
                  "unregister does nothing")
        let command = try RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .turnOff)
        try check(try await !off.send(command, signer: device), "send does nothing")
        try check(try await off.result(of: command.id, mac: pinned(mac.publicKey)) == nil, "result does nothing")
        let poller = RemoteStopPoller(client: off, signer: mac,
                                      verifier: RemoteCommandVerifier(macFingerprint: deviceID(mac)) { _ in device.publicKey })
        try check(try await poller.round(deviceIDs: [deviceID(device)]) { _ in .applied } == 0, "the poller does nothing")
        try await poller.deliverResults(deviceIDs: [])
        try check(transport.all.isEmpty, "nothing reached any relay")
        let signedByMac = await mac.counter.count, signedByDevice = await device.counter.count
        try check(signedByMac == 0 && signedByDevice == 0, "nothing was signed")

        // With an endpoint the same call is one signed request, so the counts above can tell.
        let on = ScreenPushClient(endpoint: endpoint, transport: transport)
        try check(try await on.notify(event, signer: mac), "notify sends with an endpoint")
        try check(transport.all.count == 1 && transport.all[0]["type"] == "notify", "one notify request")
        try check(await mac.counter.count == 1, "signed once")
    }

    func testPollerActsOnceOnVerifiedCommandsAndAnswersSigned() async throws {
        let mac = SoftwareSigner(), device = SoftwareSigner(), stranger = SoftwareSigner()
        let keys = RegisteredDeviceKeys()
        keys.set([.init(publicKey: device.publicKey, registeredAt: Date().addingTimeInterval(-3600), lastConnectedAt: nil)])
        let end = try await RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .endSession).signed(by: device)
        let forged = try await RemoteCommand(mac: pinned(mac.publicKey), deviceKey: stranger.publicKey, action: .turnOff).signed(by: stranger)
        let junk = SignedPushMessage(message: Data("junk".utf8), signature: Data(count: 64))
        // A real command of the registered device with its signature broken: the relay must not get a signed 「거절」 for it.
        let held = try await RemoteCommand(mac: pinned(mac.publicKey), deviceKey: device.publicKey, action: .turnOff).signed(by: device)
        let broken = SignedPushMessage(message: held.message, signature: flipByte(held.signature, at: 10))
        let queue = [end, forged, junk, broken]
        // The relay serves the same four every time and fails the third poll.
        let transport = RecordingTransport { index, _ in index == 2 ? (503, Data(#"{"error":"unavailable"}"#.utf8)) : (200, commandsBody(queue)) }
        let client = ScreenPushClient(endpoint: PushEndpoint("https://relay.example/screen-push"), transport: transport)
        let poller = RemoteStopPoller(client: client, signer: mac,
                                      verifier: RemoteCommandVerifier(macFingerprint: deviceID(mac)) { keys.key(for: $0) })
        let applied = OSAllocatedUnfairLock(initialState: [RemoteStopAction]())
        let apply: @Sendable (RemoteCommand) async -> RemoteCommandOutcome = { command in
            applied.withLock { $0.append(command.action) }
            return .applied
        }
        func results(_ request: Int) throws -> [RemoteCommandResult] {
            try MacFetch.decode(Data(base64Encoded: transport.all[request]["message"]!)!).results
        }

        try check(try await poller.round(deviceIDs: [deviceID(device)], apply: apply) == 2, "two answers: the real command and the stranger's")
        try check(applied.withLock { $0 } == [.endSession], "only the registered device's command was acted on")
        try check(poller.hasUndeliveredResults, "their results wait for the next poll")

        // The relay sends them again before it has the results: the same answers, nothing acted on twice.
        try check(try await poller.round(deviceIDs: [deviceID(device)], apply: apply) == 2, "answered again")
        try check(applied.withLock { $0 } == [.endSession], "still acted on once")
        let carried = try results(1)
        let outcomes = carried.map { RemoteCommandResult.open($0.encoded, commandID: $0.commandID, mac: pinned(mac.publicKey)) }
        try check(outcomes == [.applied, .refused], "applied for the real one, refused for the stranger's: \(outcomes)")
        try check(carried.map(\.commandID) == [sha256(end.message), sha256(forged.message)], "results name the command by its message")
        try check(!carried.contains { $0.commandID == sha256(held.message) }, "nothing signed about the broken one")

        // A poll that fails keeps the results for the one after.
        do {
            _ = try await poller.round(deviceIDs: [], apply: apply)
            throw CheckFailure(description: "the failed poll should throw")
        } catch PushClientError.rejected(503, "unavailable") {}
        try check(poller.hasUndeliveredResults, "kept after a failed poll")
        try await poller.deliverResults(deviceIDs: [])
        let again = try results(3)
        try check(again.map { RemoteCommandResult.open($0.encoded, commandID: $0.commandID, mac: pinned(mac.publicKey)) } == [.applied, .refused],
                  "a command sent again gets the answer it got the first time")
        try check(!poller.hasUndeliveredResults, "delivered by the next one")
        try check(applied.withLock { $0 } == [.endSession], "delivering takes no new commands")

        // The phone believes only a result its pinned Mac signed.
        let result = try await RemoteCommandResult.make(commandID: sha256(end.message), outcome: .applied, signer: mac)
        func phone(_ body: String) -> ScreenPushClient {
            ScreenPushClient(endpoint: PushEndpoint("https://relay.example/screen-push"),
                             transport: RecordingTransport { _, _ in (200, Data(body.utf8)) })
        }
        let commandID = sha256(end.message)
        try check(try await phone(#"{"ok":true,"result":null}"#).result(of: commandID, mac: pinned(mac.publicKey)) == nil, "no result yet")
        try check(try await phone(#"{"ok":true,"result":"\#(result.encoded.base64EncodedString())"}"#)
            .result(of: commandID, mac: pinned(mac.publicKey)) == .applied, "the Mac's result")
        let unsigned = try await RemoteCommandResult.make(commandID: commandID, outcome: .applied, signer: stranger)
        try await expectError(PushClientError.unsignedResult) {
            _ = try await phone(#"{"ok":true,"result":"\#(unsigned.encoded.base64EncodedString())"}"#)
                .result(of: commandID, mac: pinned(mac.publicKey))
        }
    }
}
