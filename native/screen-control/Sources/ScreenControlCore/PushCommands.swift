import CryptoKit
import Foundation
import os

// Notifications and remote stop (DESIGN 「3) 세션 동안」 알림·원격 차단, 「알림·원격 차단 (코드만, 기본 꺼짐)」).
//
// The push server only relays. Every message that matters is signed by a key the server does not hold, and the side
// that acts checks the signature against a key it already trusts:
// - The phone signs its APNs token registration and its remote-stop commands with its registered device key (Face ID).
// - The Mac signs its notification requests, its polls and the result of each command with its identity key.
// - The Mac acts on a command only when the signing key is in its own registry (unexpired), the command is fresh, it was
//   not seen before, and nothing newer happened at the Mac since it was sent (`RemoteStopDecision`). A server that forges,
//   replays or reorders commands gets nothing done; it can only drop or delay them.
// - The phone believes a result only when the Mac it pinned at registration signed it.
// Each message is length-prefixed fields after a label naming its kind, so a signature for one kind never passes as
// another. `supabase/functions/screen-push/protocol.ts` parses the same layout.

/// Push messages keep their own version, apart from the screen protocol's: the relay parses them too.
enum PushLabel {
    static let base = ScreenControlProtocol.name + "/v1"
    static let register = base + " push register"
    static let notify = base + " push notify"
    static let fetch = base + " push fetch"
    static let command = base + " remote command"
    static let result = base + " remote command result"
}

public enum PushMessageError: Error, Equatable, Sendable {
    case malformed
    /// The signer is not the key the message names.
    case wrongSigner
}

enum PushWire {
    static let nonce = 16, key = 65, id = 32, signature = 64
    /// The most devices one message names. The Mac keeps the most recently used ones when it has more.
    static let maxDevices = 16

    static func key(_ data: Data) -> P256.Signing.PublicKey? {
        guard data.count == key, data.first == 0x04 else { return nil }
        return try? P256.Signing.PublicKey(x963Representation: data)
    }

    static func milliseconds(_ date: Date) -> UInt64 { UInt64(max(0, (date.timeIntervalSince1970 * 1000).rounded(.down))) }

    static func date(_ milliseconds: UInt64) -> Date { Date(timeIntervalSince1970: Double(milliseconds) / 1000) }

    static func uint64(_ data: Data) -> UInt64? {
        guard data.count == 8 else { return nil }
        return data.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    }

    /// Device IDs as one field: 32 bytes each, no repeats, at most `maxDevices`.
    static func ids(_ list: [Data]) -> Data { list.reduce(Data(), +) }

    static func ids(from data: Data) -> [Data]? {
        guard data.count % id == 0, data.count / id <= maxDevices else { return nil }
        let bytes = [UInt8](data)
        let list = stride(from: 0, to: bytes.count, by: id).map { Data(bytes[$0..<$0 + id]) }
        return Set(list).count == list.count ? list : nil
    }

    static func fields(_ data: Data, label: String, count: Int) throws -> [Data] {
        guard data.count <= 4096, let fields = try? LengthPrefixed.decode(data, count: count + 1),
              fields[0] == Data(label.utf8) else { throw PushMessageError.malformed }
        return Array(fields.dropFirst())
    }

    static func encode(label: String, _ fields: [Data]) -> Data { LengthPrefixed.encode([Data(label.utf8)] + fields) }

    static func freshNonce(_ given: Data?) throws -> Data {
        let nonce = given ?? randomBytes(PushWire.nonce)
        guard nonce.count == PushWire.nonce else { throw PushMessageError.malformed }
        return nonce
    }
}

/// A message and the raw (r ‖ s) P-256 signature over exactly its bytes.
public struct SignedPushMessage: Sendable, Equatable {
    public let message: Data
    public let signature: Data

    public init(message: Data, signature: Data) {
        self.message = message
        self.signature = signature
    }

    static func sign(_ message: Data, as key: Data, with signer: TranscriptSigner) async throws -> SignedPushMessage {
        guard signer.publicKey.x963Representation == key else { throw PushMessageError.wrongSigner }
        return SignedPushMessage(message: message, signature: try await signer.signature(for: message).rawRepresentation)
    }

    public func isValid(for key: P256.Signing.PublicKey) -> Bool {
        guard signature.count == PushWire.signature,
              let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else { return false }
        return key.isValidSignature(parsed, for: message)
    }
}

// MARK: Phone → server: where to reach this device

/// The phone asks the server to push this Mac's events to its APNs token. Signed by the device key registered at that
/// Mac, so nobody can put their own token in this device's place, or listen in on a Mac they are not registered with —
/// the Mac names who gets told (`ScreenEvent.recipients`), the token only says where.
public struct PushRegistration: Sendable, Equatable {
    public enum Environment: UInt8, Sendable { case sandbox = 0, production = 1 }

    public let macKey: Data
    public let deviceKey: Data
    public let token: Data
    public let environment: Environment
    /// The app's bundle ID: the APNs topic.
    public let topic: String
    public let issuedAt: UInt64
    public let nonce: Data

    public init(mac: PinnedMac, deviceKey: P256.Signing.PublicKey, token: Data, environment: Environment, topic: String,
                issuedAt: Date = Date(), nonce: Data? = nil) throws {
        try self.init(macKey: mac.publicKey.x963Representation, deviceKey: deviceKey.x963Representation, token: token,
                      environment: environment, topic: topic, issuedAt: PushWire.milliseconds(issuedAt),
                      nonce: try PushWire.freshNonce(nonce))
    }

    init(macKey: Data, deviceKey: Data, token: Data, environment: Environment, topic: String, issuedAt: UInt64, nonce: Data) throws {
        guard PushWire.key(macKey) != nil, PushWire.key(deviceKey) != nil, (8...100).contains(token.count),
              Self.isTopic(topic), nonce.count == PushWire.nonce else { throw PushMessageError.malformed }
        self.macKey = macKey
        self.deviceKey = deviceKey
        self.token = token
        self.environment = environment
        self.topic = topic
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    static func isTopic(_ topic: String) -> Bool {
        (1...100).contains(topic.utf8.count) && topic.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
    }

    public func encoded() -> Data {
        PushWire.encode(label: PushLabel.register, [macKey, deviceKey, token, Data([environment.rawValue]), Data(topic.utf8),
                                                    issuedAt.bigEndianData, nonce])
    }

    public static func decode(_ data: Data) throws -> PushRegistration {
        let f = try PushWire.fields(data, label: PushLabel.register, count: 7)
        guard f[3].count == 1, let environment = Environment(rawValue: f[3][f[3].startIndex]),
              let topic = String(data: f[4], encoding: .utf8), let issuedAt = PushWire.uint64(f[5]) else { throw PushMessageError.malformed }
        return try PushRegistration(macKey: f[0], deviceKey: f[1], token: f[2], environment: environment, topic: topic,
                                    issuedAt: issuedAt, nonce: f[6])
    }

    public func signed(by signer: TranscriptSigner) async throws -> SignedPushMessage {
        try await SignedPushMessage.sign(encoded(), as: deviceKey, with: signer)
    }
}

// MARK: Mac → server: tell the other devices

public enum ScreenEventKind: UInt8, Sendable, CaseIterable {
    case connected = 1, registered = 2
}

/// What the Mac tells its other registered devices when a device connects or a new one is registered (DESIGN
/// 「3) 세션 동안」 알림): metadata only — the Mac's name, what happened, when, and which device did it. Never screen
/// content, codes or keys. With the lid closed nobody sees the Mac's own 「제어 중」, so this is how the owner learns.
public struct ScreenEvent: Sendable, Equatable {
    public let macKey: Data
    public let kind: ScreenEventKind
    public let eventAt: UInt64
    public let macName: String
    public let actorID: Data
    public let actorName: String
    public let recipients: [Data]
    public let issuedAt: UInt64
    public let nonce: Data

    public init(macKey: P256.Signing.PublicKey, kind: ScreenEventKind, at eventDate: Date, macName: String, actorID: Data,
                actorName: String, recipients: [Data], issuedAt: Date = Date(), nonce: Data? = nil) throws {
        try self.init(macKey: macKey.x963Representation, kind: kind, eventAt: PushWire.milliseconds(eventDate), macName: macName,
                      actorID: actorID, actorName: actorName, recipients: recipients, issuedAt: PushWire.milliseconds(issuedAt),
                      nonce: try PushWire.freshNonce(nonce))
    }

    init(macKey: Data, kind: ScreenEventKind, eventAt: UInt64, macName: String, actorID: Data, actorName: String,
         recipients: [Data], issuedAt: UInt64, nonce: Data) throws {
        guard PushWire.key(macKey) != nil, actorID.count == PushWire.id,
              isDisplaySafeName(macName, maxBytes: RegistrationRecord.maxTextBytes),
              isDisplaySafeName(actorName, maxBytes: RegistrationRecord.maxTextBytes),
              PushWire.ids(from: PushWire.ids(recipients)) != nil, !recipients.contains(actorID),
              nonce.count == PushWire.nonce else { throw PushMessageError.malformed }
        self.macKey = macKey
        self.kind = kind
        self.eventAt = eventAt
        self.macName = macName
        self.actorID = actorID
        self.actorName = actorName
        self.recipients = recipients
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    /// Who hears about an event: every registered device still in use, never the device that acted, each once, at most
    /// `PushWire.maxDevices` in the order given (the caller lists the most recently used first).
    public static func recipients(registered: [Data], actor: Data) -> [Data] {
        var seen = Set<Data>()
        return Array(registered.filter { $0.count == PushWire.id && $0 != actor && seen.insert($0).inserted }.prefix(PushWire.maxDevices))
    }

    public var macFingerprint: Data { sha256(macKey) }

    public func encoded() -> Data {
        PushWire.encode(label: PushLabel.notify, [macKey, Data([kind.rawValue]), eventAt.bigEndianData, Data(macName.utf8), actorID,
                                                  Data(actorName.utf8), PushWire.ids(recipients), issuedAt.bigEndianData, nonce])
    }

    public static func decode(_ data: Data) throws -> ScreenEvent {
        let f = try PushWire.fields(data, label: PushLabel.notify, count: 9)
        guard f[1].count == 1, let kind = ScreenEventKind(rawValue: f[1][f[1].startIndex]), let eventAt = PushWire.uint64(f[2]),
              let macName = String(data: f[3], encoding: .utf8), let actorName = String(data: f[5], encoding: .utf8),
              let recipients = PushWire.ids(from: f[6]), let issuedAt = PushWire.uint64(f[7]) else { throw PushMessageError.malformed }
        return try ScreenEvent(macKey: f[0], kind: kind, eventAt: eventAt, macName: macName, actorID: f[4], actorName: actorName,
                               recipients: recipients, issuedAt: issuedAt, nonce: f[8])
    }

    public func signed(by signer: TranscriptSigner) async throws -> SignedPushMessage {
        try await SignedPushMessage.sign(encoded(), as: macKey, with: signer)
    }

    /// Phone side: the event a notification carried, only when the Mac this device pinned signed it. The banner text
    /// itself comes from the server; what the app offers to do (「이 기기 해지」) follows only this.
    public static func open(_ signed: SignedPushMessage, mac: PinnedMac) -> ScreenEvent? {
        guard let event = try? decode(signed.message), event.macKey == mac.publicKey.x963Representation,
              signed.isValid(for: mac.publicKey) else { return nil }
        return event
    }

    public var date: Date { PushWire.date(eventAt) }
}

// MARK: Phone → server → Mac: remote stop

/// What a registered device may ask from afar (보안 원칙 5): only things that take access away. Turning screen control
/// back on and adding devices stay at the Mac.
public enum RemoteStopAction: Sendable, Equatable {
    /// 「지금 끊기」: end the session that is on now.
    case endSession
    /// 「이 기기 해지」 from the menu: revoke whichever device is connected now.
    case revokeConnected
    /// 「이 기기 해지」 from a notification: revoke the device it named.
    case revokeDevice(Data)
    /// 「화면 제어 전체 끄기」.
    case turnOff

    var code: UInt8 {
        switch self { case .endSession: 1; case .revokeConnected: 2; case .revokeDevice: 3; case .turnOff: 4 }
    }

    var target: Data { if case .revokeDevice(let id) = self { id } else { Data() } }

    init?(code: UInt8, target: Data) {
        switch (code, target.count) {
        case (1, 0): self = .endSession
        case (2, 0): self = .revokeConnected
        case (3, PushWire.id): self = .revokeDevice(target)
        case (4, 0): self = .turnOff
        default: return nil
        }
    }

    /// How long after it was sent the Mac still acts on it. Ending what is on now matters only now; revoking and turning
    /// off still matter when the Mac comes back after days off. Replays inside the window are refused by nonce, and a
    /// late one never undoes anything newer at the Mac (`RemoteStopDecision`).
    public var maxAge: TimeInterval {
        switch self {
        case .endSession, .revokeConnected: 10 * 60
        case .revokeDevice, .turnOff: 7 * 24 * 60 * 60
        }
    }
}

public struct RemoteCommand: Sendable, Equatable {
    public let macFingerprint: Data
    public let deviceKey: Data
    public let action: RemoteStopAction
    public let issuedAt: UInt64
    public let nonce: Data

    public init(mac: PinnedMac, deviceKey: P256.Signing.PublicKey, action: RemoteStopAction, issuedAt: Date = Date(),
                nonce: Data? = nil) throws {
        try self.init(macFingerprint: mac.fingerprint, deviceKey: deviceKey.x963Representation, action: action,
                      issuedAt: PushWire.milliseconds(issuedAt), nonce: try PushWire.freshNonce(nonce))
    }

    init(macFingerprint: Data, deviceKey: Data, action: RemoteStopAction, issuedAt: UInt64, nonce: Data) throws {
        guard macFingerprint.count == PushWire.id, PushWire.key(deviceKey) != nil, nonce.count == PushWire.nonce,
              RemoteStopAction(code: action.code, target: action.target) == action else { throw PushMessageError.malformed }
        self.macFingerprint = macFingerprint
        self.deviceKey = deviceKey
        self.action = action
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    /// The sender: the fingerprint of its key, as in the Mac's registry.
    public var deviceID: Data { sha256(deviceKey) }

    /// Names the command for its result. Over the message, never the signature (ECDSA signatures are malleable).
    public var id: Data { sha256(encoded()) }

    public var issuedDate: Date { PushWire.date(issuedAt) }

    public func encoded() -> Data {
        PushWire.encode(label: PushLabel.command, [macFingerprint, deviceKey, Data([action.code]), action.target,
                                                   issuedAt.bigEndianData, nonce])
    }

    public static func decode(_ data: Data) throws -> RemoteCommand {
        let f = try PushWire.fields(data, label: PushLabel.command, count: 6)
        guard f[2].count == 1, let action = RemoteStopAction(code: f[2][f[2].startIndex], target: f[3]),
              let issuedAt = PushWire.uint64(f[4]) else { throw PushMessageError.malformed }
        return try RemoteCommand(macFingerprint: f[0], deviceKey: f[1], action: action, issuedAt: issuedAt, nonce: f[5])
    }

    public func signed(by signer: TranscriptSigner) async throws -> SignedPushMessage {
        try await SignedPushMessage.sign(encoded(), as: deviceKey, with: signer)
    }
}

public enum RemoteCommandOutcome: UInt8, Sendable, CaseIterable {
    /// The Mac did it.
    case applied = 1
    /// Nothing to do: no session, the device was not registered, or screen control was already off.
    case nothingToDo = 2
    /// Something newer happened at the Mac after the command was sent (a session, a registration, turning on), and the
    /// command does not undo it.
    case superseded = 3
    /// From a device not registered (or no longer in use) at this Mac, or too old. A message the Mac cannot
    /// authenticate gets no result at all (`RemoteStopPoller`).
    case refused = 4
}

/// The Mac's signed answer to one command, which the phone checks against the Mac key it pinned. Wire form:
/// command ID (32) ‖ outcome (1) ‖ signature (64).
public struct RemoteCommandResult: Sendable, Equatable {
    public static let size = PushWire.id + 1 + PushWire.signature

    public let commandID: Data
    public let outcome: RemoteCommandOutcome
    public let signature: Data

    static func signedData(macFingerprint: Data, commandID: Data, outcome: RemoteCommandOutcome) -> Data {
        PushWire.encode(label: PushLabel.result, [macFingerprint, commandID, Data([outcome.rawValue])])
    }

    public static func make(commandID: Data, outcome: RemoteCommandOutcome, signer: TranscriptSigner) async throws -> RemoteCommandResult {
        guard commandID.count == PushWire.id else { throw PushMessageError.malformed }
        let data = signedData(macFingerprint: ScreenControlIdentity.fingerprint(of: signer.publicKey), commandID: commandID, outcome: outcome)
        return RemoteCommandResult(commandID: commandID, outcome: outcome, signature: try await signer.signature(for: data).rawRepresentation)
    }

    init(commandID: Data, outcome: RemoteCommandOutcome, signature: Data) {
        self.commandID = commandID
        self.outcome = outcome
        self.signature = signature
    }

    public init(decoding data: Data) throws {
        let bytes = [UInt8](data)
        guard bytes.count == Self.size, let outcome = RemoteCommandOutcome(rawValue: bytes[PushWire.id]) else {
            throw PushMessageError.malformed
        }
        self.init(commandID: Data(bytes[0..<PushWire.id]), outcome: outcome, signature: Data(bytes[(PushWire.id + 1)...]))
    }

    public var encoded: Data { commandID + Data([outcome.rawValue]) + signature }

    /// Phone side: the outcome, only when the Mac this device pinned signed it for this very command.
    public static func open(_ data: Data, commandID: Data, mac: PinnedMac) -> RemoteCommandOutcome? {
        guard let result = try? RemoteCommandResult(decoding: data), result.commandID == commandID,
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: result.signature),
              mac.publicKey.isValidSignature(signature, for: signedData(macFingerprint: mac.fingerprint, commandID: commandID,
                                                                         outcome: result.outcome)) else { return nil }
        return result.outcome
    }
}

// MARK: Mac → server: poll

/// The Mac's poll while screen control is on: the devices registered and in use now (the server takes commands only from
/// these and drops other devices' tokens), and the results of the commands it handled since the last poll.
public struct MacFetch: Sendable, Equatable {
    public let macKey: Data
    public let deviceIDs: [Data]
    public let results: [RemoteCommandResult]
    public let issuedAt: UInt64
    public let nonce: Data

    public init(macKey: P256.Signing.PublicKey, deviceIDs: [Data], results: [RemoteCommandResult], issuedAt: Date = Date(),
                nonce: Data? = nil) throws {
        try self.init(macKey: macKey.x963Representation, deviceIDs: deviceIDs, results: results,
                      issuedAt: PushWire.milliseconds(issuedAt), nonce: try PushWire.freshNonce(nonce))
    }

    init(macKey: Data, deviceIDs: [Data], results: [RemoteCommandResult], issuedAt: UInt64, nonce: Data) throws {
        guard PushWire.key(macKey) != nil, PushWire.ids(from: PushWire.ids(deviceIDs)) != nil, results.count <= PushWire.maxDevices,
              nonce.count == PushWire.nonce else { throw PushMessageError.malformed }
        self.macKey = macKey
        self.deviceIDs = deviceIDs
        self.results = results
        self.issuedAt = issuedAt
        self.nonce = nonce
    }

    public func encoded() -> Data {
        PushWire.encode(label: PushLabel.fetch, [macKey, PushWire.ids(deviceIDs), results.map(\.encoded).reduce(Data(), +),
                                                 issuedAt.bigEndianData, nonce])
    }

    public static func decode(_ data: Data) throws -> MacFetch {
        let f = try PushWire.fields(data, label: PushLabel.fetch, count: 5)
        guard let ids = PushWire.ids(from: f[1]), f[2].count % RemoteCommandResult.size == 0,
              let issuedAt = PushWire.uint64(f[3]) else { throw PushMessageError.malformed }
        let bytes = [UInt8](f[2])
        let results = try stride(from: 0, to: bytes.count, by: RemoteCommandResult.size).map {
            try RemoteCommandResult(decoding: Data(bytes[$0..<$0 + RemoteCommandResult.size]))
        }
        return try MacFetch(macKey: f[0], deviceIDs: ids, results: results, issuedAt: issuedAt, nonce: f[4])
    }

    public func signed(by signer: TranscriptSigner) async throws -> SignedPushMessage {
        try await SignedPushMessage.sign(encoded(), as: macKey, with: signer)
    }
}

// MARK: Mac: what to believe and what to do

public enum RemoteCommandError: Error, Equatable, Sendable {
    case malformed
    /// For another Mac.
    case otherMac
    /// The sender is not registered here, or its registration expired (refused like the key exchange refuses it).
    case unknownDevice
    /// Not signed by the registered key it names.
    case badSignature
    /// Older than its action's `maxAge`, or dated further ahead than the clocks can differ.
    case expired
    /// Seen before.
    case replayed
    /// No expired replay record can be reclaimed. Refuse new commands rather than forget a live one.
    case replayCapacityExceeded
}

/// How far apart the phone's and the Mac's wall clocks may be. A remote command is one message with no exchange, so
/// unlike the key exchange it cannot avoid comparing them; both normally follow network time.
public enum RemoteStopClock {
    public static let skew: TimeInterval = 120
}

/// The Mac's check of a remote command. Only a device in this Mac's own registry, unexpired, can command it; the server
/// cannot add one. Each command is accepted once.
public final class RemoteCommandVerifier: Sendable {
    private struct Seen {
        var until: [Data: Date] = [:]
        var order: [Data] = []
    }

    private let macFingerprint: Data
    private let deviceKey: @Sendable (Data) -> P256.Signing.PublicKey?
    private let now: @Sendable () -> Date
    private let capacity: Int
    private let seen = OSAllocatedUnfairLock(initialState: Seen())

    /// `deviceKey` is the registry's lookup (`RegisteredDeviceKeys.key(for:)`): nil for unknown and expired devices.
    public init(macFingerprint: Data, capacity: Int = 4096, now: @escaping @Sendable () -> Date = { Date() },
                deviceKey: @escaping @Sendable (Data) -> P256.Signing.PublicKey?) {
        self.macFingerprint = macFingerprint
        self.capacity = capacity
        self.now = now
        self.deviceKey = deviceKey
    }

    public func verify(_ signed: SignedPushMessage) throws -> RemoteCommand {
        guard let command = try? RemoteCommand.decode(signed.message) else { throw RemoteCommandError.malformed }
        guard command.macFingerprint == macFingerprint else { throw RemoteCommandError.otherMac }
        guard let key = deviceKey(command.deviceID), key.x963Representation == command.deviceKey else {
            throw RemoteCommandError.unknownDevice
        }
        guard signed.isValid(for: key) else { throw RemoteCommandError.badSignature }
        let now = now(), issued = command.issuedDate
        guard issued <= now.addingTimeInterval(RemoteStopClock.skew),
              now.timeIntervalSince(issued) <= command.action.maxAge else { throw RemoteCommandError.expired }
        // Remembered until it would be refused as expired anyway, and only once every check above passed, so commands
        // nobody registered signed never take room.
        let seenKey = command.deviceID + command.nonce
        let refusal = seen.withLock { seen -> RemoteCommandError? in
            for old in seen.order where seen.until[old].map({ $0 < now }) ?? true { seen.until[old] = nil }
            let kept = seen.until
            seen.order.removeAll { kept[$0] == nil }
            guard seen.until[seenKey] == nil else { return .replayed }
            // Live entries protect commands for up to seven days. Evicting the oldest entry under pressure
            // would make its still-valid signature usable again; only expiry may release replay capacity.
            guard seen.order.count < capacity else { return .replayCapacityExceeded }
            seen.until[seenKey] = issued.addingTimeInterval(command.action.maxAge + RemoteStopClock.skew)
            seen.order.append(seenKey)
            return nil
        }
        if let refusal { throw refusal }
        return command
    }
}

/// The Mac's state as far as a remote command goes.
public struct RemoteStopState: Sendable {
    public struct Viewing: Sendable {
        public let deviceID: Data
        public let since: Date
        public init(deviceID: Data, since: Date) {
            self.deviceID = deviceID
            self.since = since
        }
    }

    /// When screen control was turned on; nil while off.
    public var onSince: Date?
    public var session: Viewing?
    /// Each registered device's latest approval at the Mac.
    public var registeredAt: [Data: Date]

    public init(onSince: Date?, session: Viewing?, registeredAt: [Data: Date]) {
        self.onSince = onSince
        self.session = session
        self.registeredAt = registeredAt
    }
}

public enum RemoteStopEffect: Sendable, Equatable {
    case endSession, revoke(Data), turnOff
}

/// What a verified command may still do. A command never undoes what the person at the Mac did after it was sent:
/// a session that began, a device approved, screen control turned on. So a command the server held back, or replayed
/// after the Mac restarted and forgot its nonces, can at worst repeat what its sender asked for while it still applied.
public enum RemoteStopDecision {
    public static func decide(_ command: RemoteCommand, state: RemoteStopState,
                              skew: TimeInterval = RemoteStopClock.skew) -> (effect: RemoteStopEffect?, outcome: RemoteCommandOutcome) {
        let latest = command.issuedDate.addingTimeInterval(skew)
        switch command.action {
        case .endSession, .revokeConnected:
            guard let session = state.session else { return (nil, .nothingToDo) }
            guard session.since <= latest else { return (nil, .superseded) }
            return (command.action == .endSession ? .endSession : .revoke(session.deviceID), .applied)
        case .revokeDevice(let target):
            guard let registered = state.registeredAt[target] else { return (nil, .nothingToDo) }
            guard registered <= latest else { return (nil, .superseded) }
            return (.revoke(target), .applied)
        case .turnOff:
            guard let on = state.onSince else { return (nil, .nothingToDo) }
            guard on <= latest else { return (nil, .superseded) }
            return (.turnOff, .applied)
        }
    }
}
