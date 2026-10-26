import CryptoKit
import Foundation

// Registration happens once, in person at the Mac (DESIGN 「켜기와 기기 등록」). The QR carries the Mac
// fingerprint, a code ID and a 256-bit code secret. The phone proves it saw the QR with
// HMAC(code, H(record)) and never sends the code itself. The request also carries an App Attest attestation over
// this record (AppAttest.swift), so only a genuine AgentsToZ build on a genuine device can register.
// The Mac answers with its identity key and a signature over H(record). The phone shows the six-digit SAS only after
// checking that answer against the QR fingerprint, and the person at the Mac approves when both screens agree,
// with Touch ID or the password.
//
// Why the phone waits for the Mac: the SAS is computable by anyone holding the code. Someone who photographed the
// QR and can intercept the network could drop the real phone's record and race in their own, varied until its six
// digits match (about a million tries, seconds of work). With the acknowledgement the real phone then gets nothing
// for its record and shows no SAS at all, so there is nothing to compare and no reason to approve.

public enum RegistrationError: Error, Equatable, Sendable {
    case malformed, expired, alreadyUsed, mismatch, invalidProof, untrustedApp(AppAttestError), badAcknowledgement
    /// The Mac refused the request, or the person at the Mac declined it.
    case refused
}

/// What the registration QR carries: the Mac identity fingerprint, the one-time code, the Mac's name for the phone's
/// list, and where to reach it. The registration port is open only while this QR is on screen; the screen port is the
/// listener later connections use. Text form: `agentstoz-screen:` and base64url of length-prefixed fields.
public struct RegistrationInvite: @unchecked Sendable {
    public static let prefix = "agentstoz-screen:"

    public let macFingerprint: Data
    public let code: RegistrationCode
    public let macName: String
    /// The Mac's Bonjour host name (`name.local`), which follows it across address changes.
    public let hostName: String
    /// The IPv4 address the Mac listens on now.
    public let address: String
    public let registrationPort: UInt16
    public let screenPort: UInt16

    public init(macFingerprint: Data, code: RegistrationCode, macName: String, hostName: String, address: String,
                registrationPort: UInt16, screenPort: UInt16) throws {
        guard macFingerprint.count == 32, isDisplaySafeName(macName, maxBytes: RegistrationRecord.maxTextBytes),
              Self.isLocalHostName(hostName), Self.isIPv4(address), registrationPort != 0, screenPort != 0 else {
            throw RegistrationError.malformed
        }
        self.macFingerprint = macFingerprint
        self.code = code
        self.macName = macName
        self.hostName = hostName
        self.address = address
        self.registrationPort = registrationPort
        self.screenPort = screenPort
    }

    public var text: String {
        Self.prefix + LengthPrefixed.encode([
            ScreenControlProtocol.registrationVersion.bigEndianData, macFingerprint, code.id, code.qrSecret, Data(macName.utf8),
            Data(hostName.utf8), Data(address.utf8), registrationPort.bigEndianData, screenPort.bigEndianData,
        ]).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Phone side: the scanned text. Anything else, including another protocol version, is malformed.
    public init(text: String) throws {
        guard text.hasPrefix(Self.prefix), text.utf8.count <= 1024 else { throw RegistrationError.malformed }
        var base64 = String(text.dropFirst(Self.prefix.count))
        guard base64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw RegistrationError.malformed
        }
        base64 = base64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64), let fields = try? LengthPrefixed.decode(data, count: 9),
              fields[0] == ScreenControlProtocol.registrationVersion.bigEndianData, fields[7].count == 2, fields[8].count == 2,
              let macName = String(data: fields[4], encoding: .utf8),
              let hostName = String(data: fields[5], encoding: .utf8),
              let address = String(data: fields[6], encoding: .utf8) else { throw RegistrationError.malformed }
        try self.init(macFingerprint: fields[1], code: try RegistrationCode(id: fields[2], secret: fields[3]),
                      macName: macName, hostName: hostName, address: address,
                      registrationPort: UInt16(fields[7][0]) << 8 | UInt16(fields[7][1]),
                      screenPort: UInt16(fields[8][0]) << 8 | UInt16(fields[8][1]))
    }

    /// Whether a Mac or device name can be shown and registered as it is.
    public static func isShowableName(_ name: String) -> Bool { isDisplaySafeName(name, maxBytes: RegistrationRecord.maxTextBytes) }

    /// `name.local`: labels of ASCII letters, digits and hyphens, at most 253 characters.
    static func isLocalHostName(_ name: String) -> Bool {
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        return name.count <= 253 && labels.count >= 2 && labels.last == "local" && labels.allSatisfy { label in
            (1...63).contains(label.count) && label.first != "-" && label.last != "-"
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }

    /// Dotted-quad IPv4, no leading zeros.
    static func isIPv4(_ address: String) -> Bool {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in
            (1...3).contains(part.count) && part.allSatisfy(\.isASCII) && part.allSatisfy(\.isNumber)
                && (part.count == 1 || part.first != "0") && (Int(part) ?? 256) <= 255
        }
    }
}

/// The Mac's signed statement that the person at the Mac approved exactly this record, so the phone keeps a
/// registration only when the Mac it pinned says so.
public enum RegistrationApproval {
    static func signedData(for record: RegistrationRecord) -> Data {
        Data((ScreenControlProtocol.label(version: ScreenControlProtocol.registrationVersion) + " registration approved").utf8) + sha256(record.encoded())
    }

    public static func make(for record: RegistrationRecord, signer: TranscriptSigner) async throws -> Data {
        try await signer.signature(for: signedData(for: record)).rawRepresentation
    }

    public static func isValid(_ approval: Data, for record: RegistrationRecord, mac: PinnedMac) -> Bool {
        guard let signature = try? P256.Signing.ECDSASignature(rawRepresentation: approval) else { return false }
        return mac.publicKey.isValidSignature(signature, for: signedData(for: record))
    }
}

public struct RegistrationCode: @unchecked Sendable {
    public static let idSize = 16, secretSize = 32
    public static let lifetime: Duration = .seconds(120)

    public let id: Data
    let secret: SymmetricKey

    /// Mac side: a fresh code for one QR.
    public static func generate() -> RegistrationCode {
        RegistrationCode(id: randomBytes(idSize), secret: SymmetricKey(size: .bits256))
    }

    /// Phone side: the code read from the QR.
    public init(id: Data, secret: Data) throws {
        guard id.count == Self.idSize, secret.count == Self.secretSize else { throw RegistrationError.malformed }
        self.init(id: id, secret: SymmetricKey(data: secret))
    }

    private init(id: Data, secret: SymmetricKey) {
        self.id = id
        self.secret = secret
    }

    /// Bytes for the QR. Shown on the Mac's screen only, never logged or sent.
    public var qrSecret: Data { secret.withUnsafeBytes { Data($0) } }
}

public struct RegistrationRecord: Equatable, @unchecked Sendable {
    public static let maxTextBytes = 64

    public let macFingerprint: Data
    public let codeID: Data
    public let devicePublicKey: P256.Signing.PublicKey
    public let deviceName: String
    public let deviceModel: String

    public init(macFingerprint: Data, codeID: Data, devicePublicKey: P256.Signing.PublicKey,
                deviceName: String, deviceModel: String) throws {
        guard macFingerprint.count == 32, codeID.count == RegistrationCode.idSize,
              isDisplaySafeName(deviceName, maxBytes: Self.maxTextBytes),
              isDisplaySafeName(deviceModel, maxBytes: Self.maxTextBytes) else { throw RegistrationError.malformed }
        self.macFingerprint = macFingerprint
        self.codeID = codeID
        self.devicePublicKey = devicePublicKey
        self.deviceName = deviceName
        self.deviceModel = deviceModel
    }

    public var deviceID: Data { ScreenControlIdentity.fingerprint(of: devicePublicKey) }

    /// The clientDataHash the phone gives App Attest, so the attestation covers exactly this record.
    public var attestationClientDataHash: Data {
        sha256(LengthPrefixed.encode([Data((ScreenControlProtocol.label(version: ScreenControlProtocol.registrationVersion) + " registration attestation").utf8), encoded()]))
    }

    public func encoded() -> Data {
        LengthPrefixed.encode([Data(ScreenControlProtocol.name.utf8), ScreenControlProtocol.registrationVersion.bigEndianData,
                               macFingerprint, codeID, devicePublicKey.x963Representation,
                               Data(deviceName.utf8), Data(deviceModel.utf8)])
    }

    public static func decode(_ data: Data) throws -> RegistrationRecord {
        guard let fields = try? LengthPrefixed.decode(data, count: 7),
              fields[0] == Data(ScreenControlProtocol.name.utf8),
              fields[1] == ScreenControlProtocol.registrationVersion.bigEndianData,
              fields[4].count == 65, fields[4].first == 0x04,
              let key = try? P256.Signing.PublicKey(x963Representation: fields[4]),
              let name = String(data: fields[5], encoding: .utf8),
              let model = String(data: fields[6], encoding: .utf8) else { throw RegistrationError.malformed }
        return try RegistrationRecord(macFingerprint: fields[2], codeID: fields[3], devicePublicKey: key,
                                      deviceName: name, deviceModel: model)
    }

    public static func == (a: RegistrationRecord, b: RegistrationRecord) -> Bool { a.encoded() == b.encoded() }
}

public enum RegistrationProof {
    public static func proof(for record: RegistrationRecord, code: RegistrationCode) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: sha256(record.encoded()), using: code.secret))
    }

    /// Six digits both screens show. Internal on purpose: the phone gets them only from
    /// `RegistrationAcknowledgement.open`, the Mac only from `RegistrationWindow.verify`.
    static func sas(for record: RegistrationRecord, code: RegistrationCode) -> String {
        let mac = Data(HMAC<SHA256>.authenticationCode(for: Data("sas".utf8) + sha256(record.encoded()), using: code.secret))
        let value = mac.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) } % 1_000_000
        return String(format: "%06u", value)
    }
}

/// The Mac's signed statement that it received exactly this record, with the Mac identity key.
public enum RegistrationAcknowledgement {
    static func signedData(for record: RegistrationRecord) -> Data {
        Data((ScreenControlProtocol.label(version: ScreenControlProtocol.registrationVersion) + " registration acknowledgement").utf8) + sha256(record.encoded())
    }

    static func make(for record: RegistrationRecord, signer: TranscriptSigner) async throws -> Data {
        let signature = try await signer.signature(for: signedData(for: record)).rawRepresentation
        return LengthPrefixed.encode([signer.publicKey.x963Representation, signature])
    }

    /// Phone side: checks the Mac's answer to this record and only then returns the SAS to show, with the Mac key
    /// pinned to the fingerprint from the QR (the record carries it).
    public static func open(_ acknowledgement: Data, for record: RegistrationRecord,
                            code: RegistrationCode) throws -> (sas: String, mac: PinnedMac) {
        guard let fields = try? LengthPrefixed.decode(acknowledgement, count: 2),
              fields[0].count == 65, fields[0].first == 0x04, fields[1].count == 64,
              let key = try? P256.Signing.PublicKey(x963Representation: fields[0]),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: fields[1]) else { throw RegistrationError.malformed }
        guard let mac = try? PinnedMac(publicKey: key, fingerprint: record.macFingerprint) else { throw RegistrationError.mismatch }
        guard key.isValidSignature(signature, for: signedData(for: record)) else { throw RegistrationError.badAcknowledgement }
        return (RegistrationProof.sas(for: record, code: code), mac)
    }
}

/// What the Mac has after a valid request: what to show for approval, what to keep, and what to send back.
public struct RegistrationAcceptance: @unchecked Sendable {
    public let record: RegistrationRecord
    /// Shown on the Mac beside the device name, for the person to compare with the phone.
    public let sas: String
    /// The App Attest key, kept with the registration.
    public let attestation: AppAttestation
    /// Sent back to the phone, which shows its SAS only after checking it.
    public let acknowledgement: Data
}

/// The Mac's side of one QR: it accepts one device and closes on the first attempt that names its code,
/// whatever the outcome. A second attempt must come from a fresh QR shown at the Mac.
public actor RegistrationWindow {
    private let code: RegistrationCode
    private let signer: TranscriptSigner
    private let macFingerprint: Data
    private let openedAt: ContinuousClock.Instant
    private let attestationVerifier: any AppAttestationVerifying
    private var consumed = false

    /// `signer` is the Mac identity key; the QR carries its fingerprint.
    public init(code: RegistrationCode, signer: TranscriptSigner, openedAt: ContinuousClock.Instant,
                attestationVerifier: any AppAttestationVerifying) {
        self.code = code
        self.signer = signer
        self.macFingerprint = ScreenControlIdentity.fingerprint(of: signer.publicKey)
        self.openedAt = openedAt
        self.attestationVerifier = attestationVerifier
    }

    /// Whether the QR may still be shown: not used, not closed and not expired.
    public func isOpen(at now: ContinuousClock.Instant) -> Bool { !consumed && now - openedAt <= RegistrationCode.lifetime }

    /// Checks one request. Approval itself is not here: registration is incomplete until the person at the Mac
    /// confirms the SAS with Touch ID or the password. `date` is the wall clock for the attestation certificates;
    /// `now` times the QR.
    public func verify(record data: Data, proof: Data, attestation: Data, attestationKeyID: Data,
                       now: ContinuousClock.Instant, date: Date = Date()) async throws -> RegistrationAcceptance {
        guard !consumed else { throw RegistrationError.alreadyUsed }
        let record = try RegistrationRecord.decode(data)
        guard record.codeID == code.id else { throw RegistrationError.mismatch }
        consumed = true
        guard now - openedAt <= RegistrationCode.lifetime else { throw RegistrationError.expired }
        guard record.macFingerprint == macFingerprint else { throw RegistrationError.mismatch }
        guard HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: sha256(record.encoded()), using: code.secret) else {
            throw RegistrationError.invalidProof
        }
        let attested: AppAttestation
        do {
            attested = try attestationVerifier.verify(attestation, keyID: attestationKeyID,
                                                      clientDataHash: record.attestationClientDataHash, at: date)
        } catch let error as AppAttestError {
            throw RegistrationError.untrustedApp(error)
        }
        return RegistrationAcceptance(record: record, sas: RegistrationProof.sas(for: record, code: code), attestation: attested,
                                      acknowledgement: try await RegistrationAcknowledgement.make(for: record, signer: signer))
    }

    /// Closes the window without an attempt, for example when a screen session starts or the lid closes (SR-18).
    public func close() { consumed = true }
}
