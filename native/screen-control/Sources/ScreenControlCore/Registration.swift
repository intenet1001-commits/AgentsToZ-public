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
    case malformed, wrongPurpose, expired, alreadyUsed, mismatch, invalidProof, untrustedApp(AppAttestError), badAcknowledgement
    /// The Mac refused the request, or the person at the Mac declined it.
    case refused
}

/// What one registration window enrolls. Every shipped phone and Mac registers `.device`, a phone or iPad registering
/// itself, and its labels have not changed. `.macController` enrolls a Mac viewer key that a phone brokers
/// (docs/design/mac-to-mac-2026-10-29/DESIGN.md): the Mac's acknowledgement and approval are signed under their own
/// labels, so neither passes for the other, and a Mac that does not know Mac controllers can never produce what a
/// brokering phone accepts. The record, its App Attest binding and the SAS are the same for both.
public enum RegistrationPurpose: Sendable, Equatable {
    case device, macController

    func label(_ suffix: String) -> String {
        ScreenControlProtocol.label(version: ScreenControlProtocol.registrationVersion) + (self == .device ? "" : " controller") + suffix
    }
}

/// What the registration QR carries: the Mac identity fingerprint, the one-time code, the Mac's name for the phone's
/// list, and where to reach it. The registration port is open only while this QR is on screen; the screen port is the
/// listener later connections use. Text form: `agentstoz-screen:` and base64url of length-prefixed fields.
///
/// That text is also a URL in the iPhone app's own scheme (mobile/ios/App/Info.plist registers `scheme`), so the
/// iPhone Camera offers to open AgentsToZ with it instead of 「사용 가능한 데이터가 없음」. A custom scheme on purpose,
/// never an https universal link: the QR carries the one-time code, which a web link would hand to a server whenever
/// the app is missing. The opened text is read exactly like a scanned one, with every check that has.
public struct RegistrationInvite: @unchecked Sendable {
    public static let scheme = "agentstoz-screen"
    public static let prefix = scheme + ":"

    /// The invitation text of a URL the system opened the app with (the Camera, a tapped link), or nil when the URL
    /// is not in this scheme. It is not read here: the caller hands it to `init(deviceRegistrationText:)`.
    public static func text(openedURL url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        return url.absoluteString
    }

    /// What a version-3 invitation adds to version 2. Its one capability, `macController`, is shown only from the Mac's
    /// 「Mac 컨트롤러 추가」: this Mac takes Mac controller keys, and this QR's window enrolls one. Phones before version 3
    /// cannot read it at all, and a brokering phone refuses every invitation without it (`ControllerBroker`), so a Mac
    /// controller is never enrolled through a build that cannot tell it from a phone.
    public struct Capabilities: OptionSet, Sendable, Hashable {
        public let rawValue: UInt16
        public init(rawValue: UInt16) { self.rawValue = rawValue }
        public static let macController = Capabilities(rawValue: 1)
        static let known: Capabilities = [.macController]
    }

    public let macFingerprint: Data
    public let code: RegistrationCode
    public let macName: String
    /// The Mac's Bonjour host name (`name.local`), which follows it across address changes.
    public let hostName: String
    /// The IPv4 address the Mac listens on now.
    public let address: String
    public let registrationPort: UInt16
    public let screenPort: UInt16
    public let nearbyRegistrationService: String?
    public let nearbyScreenService: String?
    public let registrationRelay: ScreenRelayRoute?
    public let screenRelay: ScreenRelayRoute?
    /// Empty for versions 1 and 2.
    public let capabilities: Capabilities

    /// Whom this QR's window enrolls: the phone itself, or a Mac controller the phone brokers.
    public var purpose: RegistrationPurpose { capabilities.contains(.macController) ? .macController : .device }

    /// The ordinary phone-registration path must never consume a Mac-controller invitation. The generic parser
    /// remains available to the distinct broker path; this check does not grant controller authority.
    public func requireDeviceRegistration() throws {
        guard purpose == .device else { throw RegistrationError.wrongPurpose }
    }

    /// Used both by the device scanner and by the route that opens a previously scanned or pasted invitation.
    public init(deviceRegistrationText text: String) throws {
        try self.init(text: text)
        try requireDeviceRegistration()
    }

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
        nearbyRegistrationService = nil; nearbyScreenService = nil
        registrationRelay = nil; screenRelay = nil
        capabilities = []
    }

    /// Version 2 invitations locate nearby Bonjour services without a router address. Internet routes are opt-in.
    /// With `capabilities` the invitation is version 3, which only phones that know it can read.
    public init(macFingerprint: Data, code: RegistrationCode, macName: String, hostName: String,
                nearbyRegistrationService: String, nearbyScreenService: String,
                registrationRelay: ScreenRelayRoute? = nil, screenRelay: ScreenRelayRoute? = nil,
                capabilities: Capabilities = []) throws {
        guard macFingerprint.count == 32, Self.isShowableName(macName), Self.isLocalHostName(hostName),
              ScreenNearby.isValidServiceName(nearbyRegistrationService), ScreenNearby.isValidServiceName(nearbyScreenService),
              (registrationRelay == nil) == (screenRelay == nil),
              registrationRelay.map({ $0.matches(fingerprint: macFingerprint) }) ?? true,
              screenRelay.map({ $0.matches(fingerprint: macFingerprint) }) ?? true,
              registrationRelay?.endpoint == screenRelay?.endpoint,
              Capabilities.known.isSuperset(of: capabilities) else { throw RegistrationError.malformed }
        self.macFingerprint = macFingerprint; self.code = code; self.macName = macName; self.hostName = hostName
        address = ""; registrationPort = 0; screenPort = 0
        self.nearbyRegistrationService = nearbyRegistrationService; self.nearbyScreenService = nearbyScreenService
        self.registrationRelay = registrationRelay; self.screenRelay = screenRelay
        self.capabilities = capabilities
    }

    public var text: String {
        let version: UInt16 = nearbyRegistrationService == nil ? 1 : capabilities.isEmpty ? 2 : 3
        var fields: [Data] = [
            version.bigEndianData,
            macFingerprint, code.id, code.qrSecret, Data(macName.utf8), Data(hostName.utf8),
            Data(address.utf8), registrationPort.bigEndianData, screenPort.bigEndianData,
        ]
        if let nearbyRegistrationService, let nearbyScreenService {
            fields += [Data(nearbyRegistrationService.utf8), Data(nearbyScreenService.utf8),
                       Data((registrationRelay?.endpoint.absoluteString ?? "").utf8),
                       Data((registrationRelay?.room ?? "").utf8), Data((screenRelay?.room ?? "").utf8)]
        }
        if version == 3 { fields.append(capabilities.rawValue.bigEndianData) }
        return Self.prefix + LengthPrefixed.encode(fields).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Phone side: legacy LAN invitations remain readable; unknown versions fail closed. Version 3 is version 2 with
    /// one more field, its capabilities: never empty and never a bit this build does not know, so one invitation has
    /// one spelling and a newer meaning is refused rather than read as less.
    public init(text: String) throws {
        guard text.hasPrefix(Self.prefix), text.utf8.count <= 2048 else { throw RegistrationError.malformed }
        var base64 = String(text.dropFirst(Self.prefix.count))
        guard base64.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            throw RegistrationError.malformed
        }
        base64 = base64.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64) else { throw RegistrationError.malformed }
        if let fields = try? LengthPrefixed.decode(data, count: 15), fields[0] == UInt16(3).bigEndianData {
            guard fields[14].count == 2 else { throw RegistrationError.malformed }
            let capabilities = Capabilities(rawValue: UInt16(fields[14][0]) << 8 | UInt16(fields[14][1]))
            guard !capabilities.isEmpty else { throw RegistrationError.malformed }
            try self.init(nearbyFields: Array(fields.prefix(14)), capabilities: capabilities)
        } else if let fields = try? LengthPrefixed.decode(data, count: 14), fields[0] == UInt16(2).bigEndianData {
            try self.init(nearbyFields: fields, capabilities: [])
        } else {
            guard text.utf8.count <= 1024, let fields = try? LengthPrefixed.decode(data, count: 9),
                  fields[0] == ScreenControlProtocol.registrationVersion.bigEndianData, fields[7].count == 2, fields[8].count == 2,
                  let name = String(data: fields[4], encoding: .utf8), let host = String(data: fields[5], encoding: .utf8),
                  let address = String(data: fields[6], encoding: .utf8) else { throw RegistrationError.malformed }
            try self.init(macFingerprint: fields[1], code: try RegistrationCode(id: fields[2], secret: fields[3]),
                          macName: name, hostName: host, address: address,
                          registrationPort: UInt16(fields[7][0]) << 8 | UInt16(fields[7][1]),
                          screenPort: UInt16(fields[8][0]) << 8 | UInt16(fields[8][1]))
        }
    }

    /// The fourteen fields versions 2 and 3 share.
    private init(nearbyFields fields: [Data], capabilities: Capabilities) throws {
        guard fields.count == 14, fields[6].isEmpty, fields[7] == UInt16(0).bigEndianData, fields[8] == UInt16(0).bigEndianData,
              let name = String(data: fields[4], encoding: .utf8), let host = String(data: fields[5], encoding: .utf8),
              let registration = String(data: fields[9], encoding: .utf8), let screen = String(data: fields[10], encoding: .utf8),
              let urlText = String(data: fields[11], encoding: .utf8),
              let registrationRoom = String(data: fields[12], encoding: .utf8), let screenRoom = String(data: fields[13], encoding: .utf8) else {
            throw RegistrationError.malformed
        }
        var registrationRelay: ScreenRelayRoute?, screenRelay: ScreenRelayRoute?
        if !urlText.isEmpty {
            guard let endpoint = URL(string: urlText) else { throw RegistrationError.malformed }
            registrationRelay = try ScreenRelayRoute(endpoint: endpoint, room: registrationRoom)
            screenRelay = try ScreenRelayRoute(endpoint: endpoint, room: screenRoom)
        } else if !registrationRoom.isEmpty || !screenRoom.isEmpty { throw RegistrationError.malformed }
        try self.init(macFingerprint: fields[1], code: try RegistrationCode(id: fields[2], secret: fields[3]),
                      macName: name, hostName: host, nearbyRegistrationService: registration, nearbyScreenService: screen,
                      registrationRelay: registrationRelay, screenRelay: screenRelay, capabilities: capabilities)
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
    static func signedData(for record: RegistrationRecord, purpose: RegistrationPurpose = .device) -> Data {
        Data(purpose.label(" registration approved").utf8) + sha256(record.encoded())
    }

    public static func make(for record: RegistrationRecord, purpose: RegistrationPurpose = .device,
                            signer: TranscriptSigner) async throws -> Data {
        try await signer.signature(for: signedData(for: record, purpose: purpose)).rawRepresentation
    }

    public static func isValid(_ approval: Data, for record: RegistrationRecord, mac: PinnedMac,
                               purpose: RegistrationPurpose = .device) -> Bool {
        guard let signature = try? P256.Signing.ECDSASignature(rawRepresentation: approval) else { return false }
        return mac.publicKey.isValidSignature(signature, for: signedData(for: record, purpose: purpose))
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
    static func signedData(for record: RegistrationRecord, purpose: RegistrationPurpose = .device) -> Data {
        Data(purpose.label(" registration acknowledgement").utf8) + sha256(record.encoded())
    }

    static func make(for record: RegistrationRecord, purpose: RegistrationPurpose = .device,
                     signer: TranscriptSigner) async throws -> Data {
        let signature = try await signer.signature(for: signedData(for: record, purpose: purpose)).rawRepresentation
        return LengthPrefixed.encode([signer.publicKey.x963Representation, signature])
    }

    /// Phone side: checks the Mac's answer to this record and only then returns the SAS to show, with the Mac key
    /// pinned to the fingerprint from the QR (the record carries it). A brokering phone opens it as `.macController`,
    /// which only a Mac whose window enrolls Mac controllers signs.
    public static func open(_ acknowledgement: Data, for record: RegistrationRecord, code: RegistrationCode,
                            purpose: RegistrationPurpose = .device) throws -> (sas: String, mac: PinnedMac) {
        guard let fields = try? LengthPrefixed.decode(acknowledgement, count: 2),
              fields[0].count == 65, fields[0].first == 0x04, fields[1].count == 64,
              let key = try? P256.Signing.PublicKey(x963Representation: fields[0]),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: fields[1]) else { throw RegistrationError.malformed }
        guard let mac = try? PinnedMac(publicKey: key, fingerprint: record.macFingerprint) else { throw RegistrationError.mismatch }
        guard key.isValidSignature(signature, for: signedData(for: record, purpose: purpose)) else { throw RegistrationError.badAcknowledgement }
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
    /// What the window enrolls; the approval is signed under the same purpose.
    public let purpose: RegistrationPurpose
}

/// The Mac's side of one QR: it accepts one device and closes on the first attempt that names its code,
/// whatever the outcome. A second attempt must come from a fresh QR shown at the Mac.
public actor RegistrationWindow {
    private let code: RegistrationCode
    private let signer: TranscriptSigner
    private let macFingerprint: Data
    private let openedAt: ContinuousClock.Instant
    private let attestationVerifier: any AppAttestationVerifying
    private let purpose: RegistrationPurpose
    private var consumed = false

    /// `signer` is the Mac identity key; the QR carries its fingerprint. `.macController` is only for a window opened
    /// from 「Mac 컨트롤러 추가」, whose QR says so (`RegistrationInvite.Capabilities.macController`).
    public init(code: RegistrationCode, signer: TranscriptSigner, openedAt: ContinuousClock.Instant,
                attestationVerifier: any AppAttestationVerifying, purpose: RegistrationPurpose = .device) {
        self.code = code
        self.signer = signer
        self.macFingerprint = ScreenControlIdentity.fingerprint(of: signer.publicKey)
        self.openedAt = openedAt
        self.attestationVerifier = attestationVerifier
        self.purpose = purpose
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
                                      acknowledgement: try await RegistrationAcknowledgement.make(for: record, purpose: purpose, signer: signer),
                                      purpose: purpose)
    }

    /// Closes the window without an attempt, for example when a screen session starts or the lid closes (SR-18).
    public func close() { consumed = true }
}
