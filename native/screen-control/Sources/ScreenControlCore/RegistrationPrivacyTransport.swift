import CryptoKit
import Foundation
import os

/// QR v2 registration metadata is encrypted end to end, including the device name and App Attest object.
/// The relay knows its routing capability, not the independent 256-bit QR secret used here.
/// Each sender chooses a fresh 256-bit salt per connection, so opening the same QR again never reuses a GCM nonce/key.
/// The same framing carries a Mac controller's delivery (ControllerOffer.swift) under its own HKDF label and direction
/// names, so a key derived from one QR's secret is never a key of the other.
public final class RegistrationPrivacyTransport: ScreenFrameTransport, Sendable {
    public enum Role: Sendable, Equatable { case device, mac }
    static let registrationInfo = "agentstoz.screen-registration/privacy/v2/"
    private static let overhead = 32 + 8 + 16
    private static let outerLimit = 16 * 1024
    private struct Sending { var counter: UInt64 = 0 }
    private struct Receiving { var salt: Data?; var counter: UInt64 = 0 }
    private let sending = OSAllocatedUnfairLock(initialState: Sending())
    private let receiving = OSAllocatedUnfairLock(initialState: Receiving())
    private let limit = OSAllocatedUnfairLock(initialState: RegistrationPrivacyTransport.outerLimit - RegistrationPrivacyTransport.overhead)
    private let base: any ScreenFrameTransport
    private let secret: SymmetricKey
    private let codeID: Data
    private let info: Data
    private let salt = randomBytes(32)
    private let outgoing: Data
    private let incoming: Data

    public convenience init(over base: any ScreenFrameTransport, code: RegistrationCode, role: Role) {
        self.init(over: base, secret: code.qrSecret, id: code.id, info: Self.registrationInfo,
                  outgoing: role == .device ? "device" : "mac", incoming: role == .device ? "mac" : "device")
    }

    init(over base: any ScreenFrameTransport, secret: Data, id: Data, info: String, outgoing: String, incoming: String) {
        self.base = base; self.secret = SymmetricKey(data: secret); codeID = id; self.info = Data(info.utf8)
        self.outgoing = Data(outgoing.utf8)
        self.incoming = Data(incoming.utf8)
        base.setMaxFrame(Self.outerLimit)
    }

    private func key(salt: Data, direction: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: secret, salt: salt + codeID, info: info + direction, outputByteCount: 32)
    }

    public func setMaxFrame(_ value: Int) {
        limit.withLock { $0 = min(value, Self.outerLimit - Self.overhead) }
        base.setMaxFrame(Self.outerLimit)
    }

    public func receive() async throws -> Data {
        do {
            let frame = try await base.receive()
            guard frame.count > Self.overhead, frame.count <= Self.outerLimit else { throw TransportError.badFrame }
            return try receiving.withLock { state in
                let frameSalt = Data(frame.prefix(32))
                let counterBytes = Data(frame.dropFirst(32).prefix(8))
                let counter = counterBytes.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
                guard counter == state.counter, counter < UInt64.max, state.salt == nil || state.salt == frameSalt else {
                    throw TransportError.badFrame
                }
                let header = Data(frame.prefix(40))
                let nonce = try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + counterBytes)
                let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: frame.dropFirst(40).dropLast(16), tag: frame.suffix(16))
                let plaintext = try AES.GCM.open(box, using: key(salt: frameSalt, direction: incoming), authenticating: header)
                guard plaintext.count <= limit.withLock({ $0 }) else { throw TransportError.badFrame }
                state.salt = frameSalt; state.counter += 1
                return plaintext
            }
        } catch { base.cancel(); throw error }
    }

    public func send(_ payload: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            enqueue(payload) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    public func enqueue(_ payload: Data, completion: @escaping @Sendable (TransportError?) -> Void) {
        do {
            try sending.withLock { state in
                guard !payload.isEmpty, payload.count <= limit.withLock({ $0 }), state.counter < UInt64.max else {
                    throw TransportError.badFrame
                }
                let counterBytes = withUnsafeBytes(of: state.counter.bigEndian) { Data($0) }
                let header = salt + counterBytes
                let nonce = try AES.GCM.Nonce(data: Data(repeating: 0, count: 4) + counterBytes)
                let box = try AES.GCM.seal(payload, using: key(salt: salt, direction: outgoing), nonce: nonce, authenticating: header)
                state.counter += 1
                base.enqueue(header + box.ciphertext + box.tag, completion: completion)
            }
        } catch { base.cancel(); completion(.badFrame) }
    }

    public func cancel() { base.cancel() }
}
