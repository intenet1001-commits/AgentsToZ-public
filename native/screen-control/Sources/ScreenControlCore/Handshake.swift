import CryptoKit
import Foundation

// Three-message SIGMA-style handshake (DESIGN 「매 연결」):
//   1. device -> Mac : device ID, Np, Pe
//   2. Mac -> device : Nm, Ma, Sig_Mac(label_mac ‖ H(T)), Confirm_Mac
//   3. device -> Mac : Sig_Dev(label_device ‖ H(T)), Confirm_Dev        (after Face ID)
// T binds the protocol name and version, both identities, both nonces and both ephemeral keys, and both
// signatures cover the same H(T) under distinct role labels. A registered device therefore cannot claim a
// session another device started, and a replayed or reflected message never verifies.
// The device ID travels in the clear (SIGMA, not SIGMA-I): an observer on the network can tell which registered
// device connects, never what it sees or sends. DESIGN 「알려진 한계」 records this.
// Each half is an actor used once: a second finish or confirm would hand out a second channel with the same keys
// and counters, which is AES-GCM nonce reuse.
//
// The version is settled inside the same three messages (`VersionStamp`): a version-1 build reads both nonces as the
// random bytes they always were, so nothing changes for it, and a newer pair agrees on the newest version both speak.

public enum HandshakeError: Error, Equatable, Sendable {
    case malformed, unknownDevice, replayedNonce, badSignature, badConfirmation, alreadyUsed, fingerprintMismatch
}

enum HandshakeSize {
    static let nonce = 32, id = 32, ephemeral = 65, signature = 64, confirmation = 32
}

enum MessageTag: UInt8 {
    case deviceHello = 1, macHello = 2, deviceFinish = 3
}

/// Version negotiation without a new message or field (DESIGN 「버전 협상」). A phone that speaks a version above 1 ends
/// its nonce Np with `marker` and the newest version it speaks. A Mac that reads such an offer answers in kind: Nm ends
/// with `marker` and the version it chose, the lower of the two newest. Without an offer it answers as version 1 does,
/// with a plain random nonce, and a phone that finds no stamp in Nm settles on version 1. A version-1 build never looks:
/// to it both nonces are random bytes, so a version-2 Mac serves a version-1 phone and the other way round.
///
/// The chosen version is the one bound into T and into every label (signatures, keys, confirmations, records), and both
/// nonces are inside T. A stamp removed or changed in transit therefore breaks the Mac's signature on the phone, or the
/// phone's on the Mac: an attacker can make a handshake fail, which anyone in the path can do anyway, but never make two
/// version-2 ends settle on version 1. And versions differ only in optional control messages, so even a version-1
/// session loses those features and nothing else (TLS 1.3 marks downgrades in ServerHello.random the same way).
enum VersionStamp {
    static let marker = Data("AZScreen".utf8)
    /// Marker and a big-endian version at the end of the 32-byte nonce, leaving 22 random bytes (176 bits).
    static let size = marker.count + 2

    static func stamped(_ nonce: Data, version: UInt16) -> Data {
        Data([UInt8](nonce).prefix(nonce.count - size)) + marker + version.bigEndianData
    }

    /// The version a nonce offers or names: 2 or more after the marker. Nil for a plain random nonce (a version-1 peer),
    /// which matches the marker by chance once in 2^64.
    static func version(in nonce: Data) -> UInt16? {
        let bytes = [UInt8](nonce)
        guard bytes.count >= size, Data(bytes.suffix(size).prefix(marker.count)) == marker else { return nil }
        let version = UInt16(bytes[bytes.count - 2]) << 8 | UInt16(bytes[bytes.count - 1])
        return version >= 2 ? version : nil
    }
}

/// How a handshake half picks the version it binds into T.
enum VersionPolicy: Sendable, Equatable {
    /// Exactly this version, offering nothing and reading no offer: what a version-1 build does, and how checks play one
    /// (or a peer of some other version).
    case only(UInt16)
    /// Any version from 1 up to this one, settled with the peer through `VersionStamp`.
    case upTo(UInt16)

    static let current = VersionPolicy.upTo(ScreenControlProtocol.version)
}

struct HandshakeLabels {
    let macSignature, deviceSignature, macToDevice, deviceToMac, macConfirm, deviceConfirm: Data
    init(version: UInt16) {
        let base = ScreenControlProtocol.label(version: version)
        macSignature = Data("\(base)/mac".utf8)
        deviceSignature = Data("\(base)/device".utf8)
        macToDevice = Data("\(base) mac->device".utf8)
        deviceToMac = Data("\(base) device->mac".utf8)
        macConfirm = Data("\(base) confirm mac".utf8)
        deviceConfirm = Data("\(base) confirm device".utf8)
    }
}

struct SessionKeys {
    let macToDevice, deviceToMac, macConfirm, deviceConfirm: SymmetricKey
    init(secret: SharedSecret, transcriptHash: Data, labels: HandshakeLabels) {
        func derive(_ info: Data) -> SymmetricKey {
            secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: transcriptHash, sharedInfo: info, outputByteCount: 32)
        }
        macToDevice = derive(labels.macToDevice)
        deviceToMac = derive(labels.deviceToMac)
        macConfirm = derive(labels.macConfirm)
        deviceConfirm = derive(labels.deviceConfirm)
    }
}

func transcriptHash(version: UInt16, macFingerprint: Data, deviceID: Data, deviceNonce: Data,
                    deviceEphemeral: Data, macNonce: Data, macEphemeral: Data) -> Data {
    sha256(LengthPrefixed.encode([Data(ScreenControlProtocol.name.utf8), version.bigEndianData, macFingerprint,
                                  deviceID, deviceNonce, deviceEphemeral, macNonce, macEphemeral]))
}

func encodeMessage(_ tag: MessageTag, _ fields: [Data]) -> Data { LengthPrefixed.encode([Data([tag.rawValue])] + fields) }

/// Splits a message into its fields, checking the tag and every field's exact size.
func decodeMessage(_ data: Data, _ tag: MessageTag, sizes: [Int]) throws -> [Data] {
    let fields: [Data]
    do { fields = try LengthPrefixed.decode(data, count: sizes.count + 1) } catch { throw HandshakeError.malformed }
    guard fields[0] == Data([tag.rawValue]) else { throw HandshakeError.malformed }
    let rest = Array(fields.dropFirst())
    guard zip(rest, sizes).allSatisfy({ $0.count == $1 }) else { throw HandshakeError.malformed }
    return rest
}

func ephemeralKey(_ data: Data) throws -> P256.KeyAgreement.PublicKey {
    // Uncompressed points only; CryptoKit rejects points that are not on the curve.
    guard data.count == HandshakeSize.ephemeral, data.first == 0x04,
          let key = try? P256.KeyAgreement.PublicKey(x963Representation: data) else { throw HandshakeError.malformed }
    return key
}

func signature(_ data: Data) throws -> P256.Signing.ECDSASignature {
    guard let value = try? P256.Signing.ECDSASignature(rawRepresentation: data) else { throw HandshakeError.malformed }
    return value
}

func confirmation(_ key: SymmetricKey, _ transcript: Data, _ signature: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: transcript + signature, using: key))
}

func confirmationIsValid(_ code: Data, _ key: SymmetricKey, _ transcript: Data, _ signature: Data) -> Bool {
    HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: transcript + signature, using: key)
}

// MARK: - Phone side

/// The phone's half. Create one per connection attempt: each holds a fresh ephemeral key and nonce (SR-5).
public actor DeviceHandshake {
    let mac: PinnedMac
    let deviceID: Data
    let nonce: Data
    let ephemeral: P256.KeyAgreement.PrivateKey
    let versions: VersionPolicy
    private var used = false
    /// Message 1, to send to the Mac.
    public nonisolated let hello: Data

    /// `mac` is the Mac identity key saved at registration, pinned to the fingerprint from the QR. Offers every version
    /// this build speaks; the session uses the newest one the Mac speaks too.
    public init(mac: PinnedMac, devicePublicKey: P256.Signing.PublicKey) {
        self.init(mac: mac, devicePublicKey: devicePublicKey, versions: .current)
    }

    /// A phone that speaks exactly `version` and offers nothing (checks: a version-1 build, or a peer of another version).
    init(mac: PinnedMac, devicePublicKey: P256.Signing.PublicKey, version: UInt16,
         nonce: Data = randomBytes(HandshakeSize.nonce), ephemeral: P256.KeyAgreement.PrivateKey = .init()) {
        self.init(mac: mac, devicePublicKey: devicePublicKey, versions: .only(version), nonce: nonce, ephemeral: ephemeral)
    }

    /// Checks may fix the nonce and ephemeral key to pin the key schedule; nothing else should.
    init(mac: PinnedMac, devicePublicKey: P256.Signing.PublicKey, versions: VersionPolicy,
         nonce: Data = randomBytes(HandshakeSize.nonce), ephemeral: P256.KeyAgreement.PrivateKey = .init()) {
        self.mac = mac
        self.versions = versions
        if case .upTo(let newest) = versions, newest >= 2 {
            self.nonce = VersionStamp.stamped(nonce, version: newest)
        } else {
            self.nonce = nonce
        }
        self.ephemeral = ephemeral
        deviceID = ScreenControlIdentity.fingerprint(of: devicePublicKey)
        hello = encodeMessage(.deviceHello, [deviceID, self.nonce, ephemeral.publicKey.x963Representation])
    }

    /// The version the Mac's answer settles on: the one its nonce names when this phone offered one, else 1.
    func settledVersion(macNonce: Data) throws -> UInt16 {
        switch versions {
        case .only(let version):
            return version
        case .upTo(let newest):
            guard newest >= 2, let named = VersionStamp.version(in: macNonce) else { return 1 }
            // A Mac never names more than was offered. Refused before any signature is checked or made.
            guard named <= newest else { throw HandshakeError.malformed }
            return named
        }
    }

    /// Verifies the Mac first, so a fake Mac never triggers Face ID, then signs and returns message 3 and the channel.
    /// One call per handshake, whatever its outcome.
    public func finish(macHello: Data, signer: TranscriptSigner) async throws -> (message: Data, channel: SecureChannel) {
        guard !used else { throw HandshakeError.alreadyUsed }
        used = true
        let fields = try decodeMessage(macHello, .macHello, sizes: [HandshakeSize.nonce, HandshakeSize.ephemeral,
                                                                     HandshakeSize.signature, HandshakeSize.confirmation])
        let macEphemeral = try ephemeralKey(fields[1])
        let version = try settledVersion(macNonce: fields[0])
        let labels = HandshakeLabels(version: version)
        let hash = transcriptHash(version: version, macFingerprint: mac.fingerprint,
                                  deviceID: deviceID, deviceNonce: nonce,
                                  deviceEphemeral: ephemeral.publicKey.x963Representation,
                                  macNonce: fields[0], macEphemeral: fields[1])
        guard mac.publicKey.isValidSignature(try signature(fields[2]), for: labels.macSignature + hash) else {
            throw HandshakeError.badSignature
        }
        let keys = SessionKeys(secret: try ephemeral.sharedSecretFromKeyAgreement(with: macEphemeral),
                               transcriptHash: hash, labels: labels)
        guard confirmationIsValid(fields[3], keys.macConfirm, hash, fields[2]) else { throw HandshakeError.badConfirmation }
        guard ScreenControlIdentity.fingerprint(of: signer.publicKey) == deviceID else { throw HandshakeError.badSignature }
        let deviceSignature = try await signer.signature(for: labels.deviceSignature + hash).rawRepresentation
        let message = encodeMessage(.deviceFinish, [deviceSignature,
                                                    confirmation(keys.deviceConfirm, hash, deviceSignature)])
        return (message, SecureChannel(role: .device, sendKey: keys.deviceToMac, receiveKey: keys.macToDevice, version: version))
    }
}

// MARK: - Mac side

/// Device nonces the Mac has already answered. The Mac's own fresh nonce and ephemeral key already make a
/// replayed hello useless; this rejects it outright (defense in depth). Keyed by nonce bytes, never by
/// signature bytes, which ECDSA lets anyone vary.
public actor NonceReplayCache {
    private let capacity: Int
    private var seen = Set<Data>()
    private var order: [Data] = []

    public init(capacity: Int = 4096) { self.capacity = capacity }

    /// Returns false when the nonce was seen before.
    public func insert(_ nonce: Data) -> Bool {
        guard seen.insert(nonce).inserted else { return false }
        order.append(nonce)
        if order.count > capacity { seen.remove(order.removeFirst()) }
        return true
    }
}

/// The Mac's half. `registeredKey` answers only from the screen host's protected registry.
public struct MacHandshake: Sendable {
    let signer: TranscriptSigner
    let registeredKey: @Sendable (Data) async -> P256.Signing.PublicKey?
    let replay: NonceReplayCache
    let versions: VersionPolicy
    let fresh: @Sendable () -> (nonce: Data, ephemeral: P256.KeyAgreement.PrivateKey)

    /// Answers a phone of any version this build speaks, in the newest version both speak.
    public init(signer: TranscriptSigner, replay: NonceReplayCache,
                registeredKey: @escaping @Sendable (Data) async -> P256.Signing.PublicKey?) {
        self.init(signer: signer, replay: replay, versions: .current, registeredKey: registeredKey)
    }

    /// A Mac that speaks exactly `version` and reads no offer (checks: a version-1 build, or a peer of another version).
    init(signer: TranscriptSigner, replay: NonceReplayCache, version: UInt16,
         fresh: @escaping @Sendable () -> (nonce: Data, ephemeral: P256.KeyAgreement.PrivateKey) = { (randomBytes(HandshakeSize.nonce), .init()) },
         registeredKey: @escaping @Sendable (Data) async -> P256.Signing.PublicKey?) {
        self.init(signer: signer, replay: replay, versions: .only(version), fresh: fresh, registeredKey: registeredKey)
    }

    /// Checks may fix `fresh` to pin the key schedule; nothing else should.
    init(signer: TranscriptSigner, replay: NonceReplayCache, versions: VersionPolicy,
         fresh: @escaping @Sendable () -> (nonce: Data, ephemeral: P256.KeyAgreement.PrivateKey) = { (randomBytes(HandshakeSize.nonce), .init()) },
         registeredKey: @escaping @Sendable (Data) async -> P256.Signing.PublicKey?) {
        self.signer = signer
        self.replay = replay
        self.versions = versions
        self.fresh = fresh
        self.registeredKey = registeredKey
    }

    /// The version to answer `deviceNonce` in, and the Mac's nonce for that answer.
    func settle(deviceNonce: Data, freshNonce: Data) -> (version: UInt16, nonce: Data) {
        let newest: UInt16
        switch versions {
        case .only(let version): return (version, freshNonce)
        case .upTo(let version): newest = version
        }
        let version = min(VersionStamp.version(in: deviceNonce) ?? 1, newest)
        if version >= 2 { return (version, VersionStamp.stamped(freshNonce, version: version)) }
        // Answered as version 1 answers: a plain random nonce. One that happens to look stamped is drawn again, so a
        // newer phone never reads a version into it.
        var nonce = freshNonce
        while VersionStamp.version(in: nonce) != nil { nonce = randomBytes(HandshakeSize.nonce) }
        return (1, nonce)
    }

    /// Answers message 1 with message 2. Nothing is captured until `PendingMacSession.confirm` succeeds.
    public func respond(to hello: Data) async throws -> (message: Data, pending: PendingMacSession) {
        let fields = try decodeMessage(hello, .deviceHello, sizes: [HandshakeSize.id, HandshakeSize.nonce,
                                                                    HandshakeSize.ephemeral])
        guard let deviceKey = await registeredKey(fields[0]),
              ScreenControlIdentity.fingerprint(of: deviceKey) == fields[0] else { throw HandshakeError.unknownDevice }
        let deviceEphemeral = try ephemeralKey(fields[2])
        guard await replay.insert(fields[1]) else { throw HandshakeError.replayedNonce }
        let (freshNonce, ephemeral) = fresh()
        let (version, nonce) = settle(deviceNonce: fields[1], freshNonce: freshNonce)
        let labels = HandshakeLabels(version: version)
        let hash = transcriptHash(version: version, macFingerprint: ScreenControlIdentity.fingerprint(of: signer.publicKey),
                                  deviceID: fields[0], deviceNonce: fields[1], deviceEphemeral: fields[2],
                                  macNonce: nonce, macEphemeral: ephemeral.publicKey.x963Representation)
        let keys = SessionKeys(secret: try ephemeral.sharedSecretFromKeyAgreement(with: deviceEphemeral),
                               transcriptHash: hash, labels: labels)
        let macSignature = try await signer.signature(for: labels.macSignature + hash).rawRepresentation
        let message = encodeMessage(.macHello, [nonce, ephemeral.publicKey.x963Representation, macSignature,
                                                confirmation(keys.macConfirm, hash, macSignature)])
        return (message, PendingMacSession(deviceID: fields[0], deviceKey: deviceKey, transcriptHash: hash,
                                           keys: keys, labels: labels, version: version))
    }
}

/// A Mac-side session waiting for the device's signature. One confirm per session, whatever its outcome.
public actor PendingMacSession {
    public nonisolated let deviceID: Data
    let deviceKey: P256.Signing.PublicKey
    let transcriptHash: Data
    let keys: SessionKeys
    let labels: HandshakeLabels
    let version: UInt16
    private var used = false

    init(deviceID: Data, deviceKey: P256.Signing.PublicKey, transcriptHash: Data, keys: SessionKeys,
         labels: HandshakeLabels, version: UInt16) {
        self.deviceID = deviceID
        self.deviceKey = deviceKey
        self.transcriptHash = transcriptHash
        self.keys = keys
        self.labels = labels
        self.version = version
    }

    public func confirm(_ finish: Data) throws -> SecureChannel {
        guard !used else { throw HandshakeError.alreadyUsed }
        used = true
        let fields = try decodeMessage(finish, .deviceFinish, sizes: [HandshakeSize.signature, HandshakeSize.confirmation])
        guard deviceKey.isValidSignature(try signature(fields[0]), for: labels.deviceSignature + transcriptHash) else {
            throw HandshakeError.badSignature
        }
        guard confirmationIsValid(fields[1], keys.deviceConfirm, transcriptHash, fields[0]) else {
            throw HandshakeError.badConfirmation
        }
        return SecureChannel(role: .mac, sendKey: keys.macToDevice, receiveKey: keys.deviceToMac, version: version)
    }
}
