import CryptoKit
import Foundation
import os

public enum RecordType: UInt8, Sendable {
    case video = 1, control = 2, input = 3, close = 4
}

public enum ChannelError: Error, Equatable, Sendable {
    case malformed, outOfOrder, authenticationFailed, closed, limitReached, tooLarge, wrongDirection
    /// A control message newer than the session's negotiated version. Refused before anything is sealed, so the peer
    /// never sees a message its version does not know.
    case notNegotiated
}

/// Which end of a session a channel belongs to. The Mac sends video and receives input; the phone the reverse.
public enum ChannelRole: Sendable {
    case mac, device

    var sends: Set<RecordType> { self == .mac ? [.video, .control, .close] : [.input, .control, .close] }
    var receives: Set<RecordType> { self == .mac ? [.input, .control, .close] : [.video, .control, .close] }
}

/// AES-256-GCM records over a reliable, ordered transport, one key per direction.
///
/// Record: type(1) ‖ counter(8, big-endian) ‖ ciphertext ‖ tag(16). The nonce is the counter, and the
/// receiver accepts exactly the next counter, so a replayed, skipped, reordered or reflected record is
/// refused (SR-5, SR-6). The first refusal closes the channel for good: a caller cannot retry past a
/// forged record. Callers decode or inject only what `open` returns.
///
/// A class behind a lock, not a struct: a copy is the same channel, so two senders can never reuse a nonce.
public final class SecureChannel: Sendable {
    public static let maxPayload = 8 << 20
    static let headerSize = 9, tagSize = 16
    static let maxRecords: UInt64 = 1 << 32

    private struct State {
        var sendCounter: UInt64 = 0
        var receiveCounter: UInt64 = 0
        var failed = false
    }

    let role: ChannelRole
    /// The version the key exchange settled on; it is in every record's associated data.
    public let version: UInt16
    let sendKey: SymmetricKey
    let receiveKey: SymmetricKey
    let label: Data
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(role: ChannelRole, sendKey: SymmetricKey, receiveKey: SymmetricKey, version: UInt16) {
        self.role = role
        self.sendKey = sendKey
        self.receiveKey = receiveKey
        self.version = version
        label = Data("\(ScreenControlProtocol.label(version: version)) record".utf8)
    }

    public var isClosed: Bool { state.withLock { $0.failed } }

    public func seal(_ type: RecordType, _ payload: Data) throws -> Data {
        try state.withLock { state in
            guard !state.failed else { throw ChannelError.closed }
            guard role.sends.contains(type) else { throw ChannelError.wrongDirection }
            guard payload.count <= Self.maxPayload else { throw ChannelError.tooLarge }
            guard state.sendCounter < Self.maxRecords else {
                state.failed = true
                throw ChannelError.limitReached
            }
            let header = Data([type.rawValue]) + state.sendCounter.bigEndianData
            let box = try AES.GCM.seal(payload, using: sendKey, nonce: Self.nonce(state.sendCounter), authenticating: label + header)
            state.sendCounter += 1
            return header + box.ciphertext + box.tag
        }
    }

    public func open(_ record: Data) throws -> (type: RecordType, payload: Data) {
        try state.withLock { state in
            guard !state.failed else { throw ChannelError.closed }
            do {
                let opened = try openRecord([UInt8](record), expecting: state.receiveCounter)
                state.receiveCounter += 1
                return opened
            } catch {
                state.failed = true
                throw error
            }
        }
    }

    private func openRecord(_ bytes: [UInt8], expecting expected: UInt64) throws -> (type: RecordType, payload: Data) {
        guard bytes.count >= Self.headerSize + Self.tagSize,
              bytes.count - Self.headerSize - Self.tagSize <= Self.maxPayload,
              let type = RecordType(rawValue: bytes[0]) else { throw ChannelError.malformed }
        guard role.receives.contains(type) else { throw ChannelError.wrongDirection }
        let counter = bytes[1..<Self.headerSize].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
        guard counter == expected, counter < Self.maxRecords else { throw ChannelError.outOfOrder }
        let header = Data(bytes[0..<Self.headerSize])
        do {
            let box = try AES.GCM.SealedBox(nonce: Self.nonce(counter),
                                            ciphertext: Data(bytes[Self.headerSize..<(bytes.count - Self.tagSize)]),
                                            tag: Data(bytes[(bytes.count - Self.tagSize)...]))
            return (type, try AES.GCM.open(box, using: receiveKey, authenticating: label + header))
        } catch {
            throw ChannelError.authenticationFailed
        }
    }

    static func nonce(_ counter: UInt64) -> AES.GCM.Nonce {
        // 4 zero bytes ‖ counter: unique per key because each direction has its own key.
        try! AES.GCM.Nonce(data: Data(count: 4) + counter.bigEndianData)
    }
}
