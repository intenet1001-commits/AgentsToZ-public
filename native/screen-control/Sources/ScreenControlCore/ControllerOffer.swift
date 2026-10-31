import CryptoKit
import Foundation

// Mac controllers (docs/design/mac-to-mac-2026-10-29/DESIGN.md): AgentsToZ Viewer on Mac A views or controls
// AgentsToZ Screen on Mac B. A cannot register itself, since registration needs App Attest and no Mac has it, so the
// owner's phone brokers it:
//
// 1. At A, after Touch ID, the viewer makes a key for this one target in its Secure Enclave and shows a controller
//    offer QR: that key, an acknowledgement key that lives only while the offer is open, a one-time 256-bit code,
//    A's name and model.
// 2. At B, the person opens 「Mac 컨트롤러 추가」. That version-3 QR says its window enrolls a Mac controller. The phone
//    registers A's key there with the unchanged version-1 record and its own App Attest, under the Mac-controller
//    labels (`RegistrationPurpose`). B shows six digits, the person compares them with the phone, chooses view or
//    control, and approves with Touch ID.
// 3. Back at A, the phone delivers B's key, names and route, the record and B's approval over a channel keyed by the
//    offer's secret under its own HKDF label. A checks that the record names its key and that B approved it, answers
//    with the offer's acknowledgement key, and shows six digits. The phone shows them only after checking that
//    answer. The person at A confirms with a click; every later connection still needs Touch ID at A.
//
// Why the acknowledgement: anyone who saw the offer QR (a photo, or a stream of A's screen) holds its secret and could
// race a delivery of their own host to A. A takes one delivery and acknowledges only that one, so the real phone then
// shows no digits and there is nothing to confirm. The registration acknowledgement exists for the same reason.
//
// Nothing here opens a listener, starts a session, or is reachable from the main app, HTTP, MCP or community: the
// viewer and the host call it after a person acted at each Mac.

public enum ControllerEnrollmentError: Error, Equatable, Sendable {
    case malformed, expired, alreadyUsed, mismatch
    /// The record names another key than this offer's.
    case notThisController
    /// The host's approval is missing, from another key, or signed as an ordinary phone registration.
    case badApproval
    /// The controller's acknowledgement did not verify, so the phone shows no digits.
    case badAcknowledgement
    /// The host's QR does not enroll Mac controllers: an older Screen, or its ordinary 「기기 등록」 QR. Never a fallback.
    case hostLacksMacControllerSupport
}

/// The offer's one-time code: an ID that names it and a 256-bit secret shown only in its QR. A type of its own, and its
/// secret is used only through HKDF under Mac-controller labels, so it is never valid where a registration secret is.
public struct ControllerOfferCode: @unchecked Sendable {
    public static let idSize = 16, secretSize = 32
    /// From the moment A shows the offer: scan it at A, enroll at B, deliver back at A. One delivery within it.
    public static let lifetime: Duration = .seconds(300)

    public let id: Data
    let secret: SymmetricKey

    /// A's side: a fresh code for one offer.
    public static func generate() -> ControllerOfferCode {
        ControllerOfferCode(id: randomBytes(idSize), secret: SymmetricKey(size: .bits256))
    }

    /// Phone side: the code read from the offer QR.
    public init(id: Data, secret: Data) throws {
        guard id.count == Self.idSize, secret.count == Self.secretSize else { throw ControllerEnrollmentError.malformed }
        self.init(id: id, secret: SymmetricKey(data: secret))
    }

    private init(id: Data, secret: SymmetricKey) {
        self.id = id
        self.secret = secret
    }

    /// Bytes for the QR. Shown on A's screen only, never logged or sent.
    public var qrSecret: Data { secret.withUnsafeBytes { Data($0) } }

    /// A key for one use of the secret, never the secret itself.
    func derivedKey(_ use: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: secret, salt: id, info: Data((ControllerOffer.label + use).utf8), outputByteCount: 32)
    }
}

/// What the controller offer QR carries. Text form: `agentstoz-screen-controller:` and base64url of length-prefixed
/// fields [version, controller key, acknowledgement key, code ID, code secret, name, model].
public struct ControllerOffer: @unchecked Sendable {
    public static let prefix = "agentstoz-screen-controller:"
    public static let version: UInt16 = 1
    static let label = "agentstoz.screen-controller/v1/"

    /// The key A made for this offer alone, in its Secure Enclave behind Touch ID: one per target Mac, so revoking one
    /// target never touches another and no two targets can link A by its key.
    public let controllerKey: P256.Signing.PublicKey
    /// A key that lives only in A's memory while this offer is open. A signs the one delivery it took with it.
    public let acknowledgementKey: P256.Signing.PublicKey
    public let code: ControllerOfferCode
    /// A's name and model, as B's approval prompt and registration list show them.
    public let name: String
    public let model: String

    public init(controllerKey: P256.Signing.PublicKey, acknowledgementKey: P256.Signing.PublicKey, code: ControllerOfferCode,
                name: String, model: String) throws {
        guard controllerKey.x963Representation != acknowledgementKey.x963Representation,
              isDisplaySafeName(name, maxBytes: RegistrationRecord.maxTextBytes),
              isDisplaySafeName(model, maxBytes: RegistrationRecord.maxTextBytes) else { throw ControllerEnrollmentError.malformed }
        self.controllerKey = controllerKey
        self.acknowledgementKey = acknowledgementKey
        self.code = code
        self.name = name
        self.model = model
    }

    /// The nearby service A listens on for the delivery while the offer is open.
    public var deliveryService: String { ScreenNearby.controllerOfferService(codeID: code.id) }

    public var text: String {
        Self.prefix + base64URL(LengthPrefixed.encode([Self.version.bigEndianData, controllerKey.x963Representation,
                                                       acknowledgementKey.x963Representation, code.id, code.qrSecret,
                                                       Data(name.utf8), Data(model.utf8)]))
    }

    /// Phone side. Anything else — another prefix, version, length, key encoding, name — is refused, never guessed.
    public init(text: String) throws {
        guard text.hasPrefix(Self.prefix), text.utf8.count <= 1024,
              let data = dataFromBase64URL(String(text.dropFirst(Self.prefix.count))),
              let fields = try? LengthPrefixed.decode(data, count: 7), fields[0] == Self.version.bigEndianData,
              let controllerKey = signingKey(fields[1]), let acknowledgementKey = signingKey(fields[2]),
              let name = String(data: fields[5], encoding: .utf8), let model = String(data: fields[6], encoding: .utf8) else {
            throw ControllerEnrollmentError.malformed
        }
        try self.init(controllerKey: controllerKey, acknowledgementKey: acknowledgementKey,
                      code: try ControllerOfferCode(id: fields[3], secret: fields[4]), name: name, model: model)
    }
}

extension ScreenNearby {
    public static func controllerOfferService(codeID: Data) -> String {
        "az-offer-" + codeID.map { String(format: "%02x", $0) }.joined()
    }
}

/// The channel the phone and A share for the delivery: the registration privacy framing (fresh salt per connection,
/// counters, AES-GCM) keyed from the offer's secret under its own HKDF label and direction names. A frame sealed here
/// never opens as registration metadata and the other way round, even for equal secret bytes.
public enum ControllerDeliveryChannel {
    public enum Role: Sendable, Equatable { case broker, controller }
    static let info = ControllerOffer.label + "delivery/"

    public static func transport(over base: any ScreenFrameTransport, code: ControllerOfferCode, role: Role) -> any ScreenFrameTransport {
        RegistrationPrivacyTransport(over: base, secret: code.qrSecret, id: code.id, info: info,
                                     outgoing: role == .broker ? "broker" : "controller",
                                     incoming: role == .broker ? "controller" : "broker")
    }
}

/// What the phone brings back to A: B's identity key, names and nearby screen route, the record B approved (whose
/// device key is A's offer key) and B's approval under the Mac-controller label. It exists only when B's approval and
/// B's fingerprint check out.
public struct ControllerDelivery: Equatable, @unchecked Sendable {
    static let name = "agentstoz.screen-controller"

    public let codeID: Data
    /// B, pinned to the fingerprint B's own QR carried (the record holds it).
    public let host: PinnedMac
    public let hostName: String
    /// B's Bonjour host name (`name.local`).
    public let hostLocalName: String
    public let screenService: String
    public let record: RegistrationRecord
    public let approval: Data

    public init(codeID: Data, host: PinnedMac, hostName: String, hostLocalName: String, screenService: String,
                record: RegistrationRecord, approval: Data) throws {
        guard codeID.count == ControllerOfferCode.idSize, RegistrationInvite.isShowableName(hostName),
              RegistrationInvite.isLocalHostName(hostLocalName), ScreenNearby.isValidServiceName(screenService) else {
            throw ControllerEnrollmentError.malformed
        }
        guard host.fingerprint == record.macFingerprint else { throw ControllerEnrollmentError.mismatch }
        guard RegistrationApproval.isValid(approval, for: record, mac: host, purpose: .macController) else {
            throw ControllerEnrollmentError.badApproval
        }
        self.codeID = codeID; self.host = host; self.hostName = hostName; self.hostLocalName = hostLocalName
        self.screenService = screenService; self.record = record; self.approval = approval
    }

    public func encoded() -> Data {
        LengthPrefixed.encode([Data(Self.name.utf8), ControllerOffer.version.bigEndianData, codeID, host.publicKey.x963Representation,
                               Data(hostName.utf8), Data(hostLocalName.utf8), Data(screenService.utf8), record.encoded(), approval])
    }

    public static func decode(_ data: Data) throws -> ControllerDelivery {
        guard let fields = try? LengthPrefixed.decode(data, count: 9), fields[0] == Data(name.utf8),
              fields[1] == ControllerOffer.version.bigEndianData, let key = signingKey(fields[3]),
              let hostName = String(data: fields[4], encoding: .utf8), let hostLocalName = String(data: fields[5], encoding: .utf8),
              let screenService = String(data: fields[6], encoding: .utf8), fields[8].count == 64,
              let record = try? RegistrationRecord.decode(fields[7]) else { throw ControllerEnrollmentError.malformed }
        guard let host = try? PinnedMac(publicKey: key, fingerprint: record.macFingerprint) else { throw ControllerEnrollmentError.mismatch }
        return try ControllerDelivery(codeID: fields[2], host: host, hostName: hostName, hostLocalName: hostLocalName,
                                      screenService: screenService, record: record, approval: fields[8])
    }

    public static func == (a: ControllerDelivery, b: ControllerDelivery) -> Bool { a.encoded() == b.encoded() }
}

/// The six digits A and the phone show for one delivery: from the offer's secret, B's key, the record and the rest of
/// the delivery. Internal on purpose: the phone gets them only from `ControllerDeliveryAcknowledgement.open`, A only
/// from `ControllerOfferWindow.receive`.
enum ControllerSAS {
    static func digits(for delivery: ControllerDelivery, code: ControllerOfferCode) -> String {
        let mac = Data(HMAC<SHA256>.authenticationCode(for: sha256(delivery.encoded()), using: code.derivedKey("sas")))
        let value = mac.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) } % 1_000_000
        return String(format: "%06u", value)
    }
}

/// A's signed statement, by the offer's acknowledgement key, that it took exactly this delivery.
public enum ControllerDeliveryAcknowledgement {
    static func signedData(for delivery: ControllerDelivery) -> Data {
        Data((ControllerOffer.label + "delivery acknowledgement").utf8) + sha256(delivery.encoded())
    }

    /// Phone side: the digits to show, only for the delivery A acknowledged.
    public static func open(_ acknowledgement: Data, for delivery: ControllerDelivery, offer: ControllerOffer) throws -> String {
        guard acknowledgement.count == 64,
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: acknowledgement) else { throw ControllerEnrollmentError.malformed }
        guard delivery.codeID == offer.code.id else { throw ControllerEnrollmentError.mismatch }
        guard offer.acknowledgementKey.isValidSignature(signature, for: signedData(for: delivery)) else {
            throw ControllerEnrollmentError.badAcknowledgement
        }
        return ControllerSAS.digits(for: delivery, code: offer.code)
    }
}

/// The phone's side of brokering. Pure checks: which host it may broker to, the record it registers there, and what it
/// brings back to A.
public enum ControllerBroker {
    /// Refuses a host whose QR does not enroll Mac controllers. There is no fallback to an ordinary registration: an
    /// older Mac would show A's key as a phone with full control and keep it where its switch and grants cannot reach.
    public static func requireMacControllerHost(_ invite: RegistrationInvite) throws {
        guard invite.purpose == .macController, invite.nearbyScreenService != nil else {
            throw ControllerEnrollmentError.hostLacksMacControllerSupport
        }
    }

    /// The record the phone registers with B on A's behalf: B's QR, A's per-target key, A's name and model.
    public static func record(for offer: ControllerOffer, at invite: RegistrationInvite) throws -> RegistrationRecord {
        try requireMacControllerHost(invite)
        guard let record = try? RegistrationRecord(macFingerprint: invite.macFingerprint, codeID: invite.code.id,
                                                   devicePublicKey: offer.controllerKey, deviceName: offer.name,
                                                   deviceModel: offer.model) else { throw ControllerEnrollmentError.malformed }
        return record
    }

    /// After B approved: what to bring back to A.
    public static func delivery(for offer: ControllerOffer, at invite: RegistrationInvite, record: RegistrationRecord,
                                host: PinnedMac, approval: Data) throws -> ControllerDelivery {
        guard record == (try self.record(for: offer, at: invite)), let screenService = invite.nearbyScreenService else {
            throw ControllerEnrollmentError.mismatch
        }
        return try ControllerDelivery(codeID: offer.code.id, host: host, hostName: invite.macName, hostLocalName: invite.hostName,
                                      screenService: screenService, record: record, approval: approval)
    }
}

/// What A has after a valid delivery: what to show, what to keep once the person confirms, what to send back.
public struct ControllerDeliveryAcceptance: @unchecked Sendable {
    /// B as A keeps it after the person at A confirms the digits.
    public let delivery: ControllerDelivery
    /// Shown on A beside B's name, for the person to compare with the phone.
    public let sas: String
    /// Sent back to the phone, which shows its digits only after checking it.
    public let acknowledgement: Data
}

/// A's side of one offer. It takes one delivery and closes on the first that reaches it, whatever the outcome; only a
/// holder of the offer's secret can send one through `ControllerDeliveryChannel`. Its acknowledgement key never leaves
/// memory and dies with the window.
public actor ControllerOfferWindow {
    public nonisolated let offer: ControllerOffer
    private let acknowledgementKey: P256.Signing.PrivateKey
    private let openedAt: ContinuousClock.Instant
    private var consumed = false

    /// `controllerKey` is the public half of the key A just made for this target behind Touch ID.
    public init(controllerKey: P256.Signing.PublicKey, name: String, model: String, openedAt: ContinuousClock.Instant) throws {
        let acknowledgementKey = P256.Signing.PrivateKey()
        offer = try ControllerOffer(controllerKey: controllerKey, acknowledgementKey: acknowledgementKey.publicKey,
                                    code: .generate(), name: name, model: model)
        self.acknowledgementKey = acknowledgementKey
        self.openedAt = openedAt
    }

    /// Whether the offer may still be shown: not used, not closed and not expired.
    public func isOpen(at now: ContinuousClock.Instant) -> Bool { !consumed && now - openedAt <= ControllerOfferCode.lifetime }

    /// Checks one delivery. Keeping B is not here: the person at A confirms the digits first.
    public func receive(_ data: Data, now: ContinuousClock.Instant) throws -> ControllerDeliveryAcceptance {
        guard !consumed else { throw ControllerEnrollmentError.alreadyUsed }
        consumed = true
        guard now - openedAt <= ControllerOfferCode.lifetime else { throw ControllerEnrollmentError.expired }
        let delivery = try ControllerDelivery.decode(data)
        guard delivery.codeID == offer.code.id else { throw ControllerEnrollmentError.mismatch }
        guard delivery.record.devicePublicKey.x963Representation == offer.controllerKey.x963Representation else {
            throw ControllerEnrollmentError.notThisController
        }
        guard delivery.record.deviceName == offer.name, delivery.record.deviceModel == offer.model else {
            throw ControllerEnrollmentError.mismatch
        }
        let signature = try acknowledgementKey.signature(for: ControllerDeliveryAcknowledgement.signedData(for: delivery))
        return ControllerDeliveryAcceptance(delivery: delivery, sas: ControllerSAS.digits(for: delivery, code: offer.code),
                                            acknowledgement: signature.rawRepresentation)
    }

    /// Closes the offer without a delivery: cancelled, the window closed, or this Mac's screen started streaming.
    public func close() { consumed = true }
}

private func signingKey(_ data: Data) -> P256.Signing.PublicKey? {
    guard data.count == 65, data.first == 0x04 else { return nil }
    return try? P256.Signing.PublicKey(x963Representation: data)
}

private func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func dataFromBase64URL(_ text: String) -> Data? {
    guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
    var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
}
