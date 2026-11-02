#if os(macOS)
import CryptoKit
import Foundation
import ScreenControlCore

// Mac controllers (docs/design/mac-to-mac-2026-11-01/DESIGN.md 7.3, from 10-29 「저장과 권한」): another Mac the person
// approved at this one. They live apart from the phones, in a keychain item of their own ("controllers") that a build
// before Mac controllers never reads: it reads "identity", "devices", "networks" and "internet-route" only. The item
// holds one object where "devices" holds an array, so even a misdirected read by the device reader fails closed as
// corrupt instead of taking a controller for a phone.
//
// Format 2 records how each controller was enrolled: directly at both Macs with the two codes (D-1), attested when this
// Mac verified the genuine Viewer's App Attest (S-K2), or brokered by a phone (10-29, the only kind format 1 holds).
// Format 1 is read and moved to format 2 as phone-brokered and attested; the next save writes format 2. Any other
// format is corrupt, never read as one this build knows.
//
// `attested` is the stored record of 7.3: App Attest stood behind the enrollment. It is not what the release gate asks
// (9절). The gate asks whether the key is the genuine Viewer's own biometric key, and a phone's App Attest never showed
// that: it proves only that the genuine iOS app brokered the request (2절, 11절). So the gate reads
// `bindsGenuineViewer`, which only a direct, attested enrollment answers yes to; a brokered row waits for the push gate
// like an unbound direct one.

/// What one controller may do. Chosen at this Mac, never asked for by the controller (M-SR-21); `view` until the
/// person at this Mac raises it.
public enum ScreenControllerGrant: String, Codable, Sendable, Hashable {
    case view, control
}

/// Why a controller change was refused before anything was stored.
public enum ScreenControllerError: Error, Sendable, Equatable {
    /// The enrollment's fields do not belong to its method, or an App Attest key ID is not 32 bytes.
    case inconsistentEnrollment
    /// A phone registered here holds this key (SR-22): one key is never in both sets.
    case registeredAsPhone
    /// The row to replace is not one with the newcomer's name and model (`replacementCandidates`).
    case notAReplacementCandidate
}

/// How a controller was enrolled at this Mac (DESIGN 7.3). Each method has its own fields, and a stored enrollment
/// whose fields disagree with its method fails its row: nothing here is guessed.
public struct ControllerEnrollment: Codable, Sendable, Hashable {
    public enum Method: String, Codable, Sendable, Hashable {
        /// At both Macs, the two codes typed by the person (DESIGN 6.3, D-1).
        case directSAS = "direct-sas"
        /// Brokered by a phone registered here (10-29). Format 1 rows; no build enrolls this way since D-1.
        case phoneBroker = "phone-broker"
    }

    /// An App Attest key ID: SHA-256 of the attested key (`AppAttestVerifier` takes no other size).
    static let attestationKeyIDSize = 32

    public let method: Method
    /// Whether App Attest stood behind the enrollment, as 7.3 stores it: for a direct one, this Mac verified the
    /// genuine Viewer's attestation bound to the pairing (S-K2); a brokered one carried the phone's. Never the release
    /// gate's question: that is `bindsGenuineViewer`.
    public let attested: Bool
    /// The Viewer's App Attest key this Mac verified (direct, attested only).
    public let attestationKeyID: Data?
    /// The App Attest key of the phone that brokered it (phone-broker only). A record, not a proof that a phone
    /// registered here brokered it: the iOS app makes a new App Attest key for each registration (10-29 M-10).
    public let brokerAttestationKeyID: Data?

    private init(method: Method, attested: Bool, attestationKeyID: Data?, brokerAttestationKeyID: Data?) throws {
        let keyIDs = [attestationKeyID, brokerAttestationKeyID].compactMap { $0 }
        guard keyIDs.allSatisfy({ $0.count == Self.attestationKeyIDSize }) else { throw ScreenControllerError.inconsistentEnrollment }
        switch method {
        case .directSAS:
            guard brokerAttestationKeyID == nil, attested == (attestationKeyID != nil) else { throw ScreenControllerError.inconsistentEnrollment }
        case .phoneBroker:
            guard attestationKeyID == nil, brokerAttestationKeyID != nil, attested else { throw ScreenControllerError.inconsistentEnrollment }
        }
        self.method = method
        self.attested = attested
        self.attestationKeyID = attestationKeyID
        self.brokerAttestationKeyID = brokerAttestationKeyID
    }

    /// A direct enrollment; attested exactly when this Mac verified the Viewer's attestation. Only a verifier in the
    /// shared core makes an `AppAttestation`, so nothing here can call an enrollment attested without that check. That
    /// the attestation was bound to this pairing (its clientDataHash, 7.1) is the pairing's to check before calling this.
    public static func directSAS(attestation: AppAttestation?) throws -> ControllerEnrollment {
        try ControllerEnrollment(method: .directSAS, attested: attestation != nil, attestationKeyID: attestation?.keyID, brokerAttestationKeyID: nil)
    }

    /// A phone-brokered enrollment, as format 1 stored it: the phone's App Attest stood behind it. Not public: no build
    /// enrolls this way since D-1, and a key ID taken on trust is no attestation. A broker path, if one ever comes
    /// back, takes the `AppAttestation` its verifier made.
    static func phoneBroker(brokerAttestationKeyID: Data) throws -> ControllerEnrollment {
        try ControllerEnrollment(method: .phoneBroker, attested: true, attestationKeyID: nil, brokerAttestationKeyID: brokerAttestationKeyID)
    }

    /// Whether the enrollment shows the key is the genuine Viewer's own biometric key: a direct one this Mac verified
    /// the Viewer's App Attest for (S-K2). The release gate's question (DESIGN 9절): only such a registration opens a
    /// view session before the push gate. A brokered one is attested but says nothing about whose key the phone carried
    /// (2절, 11절), so it is no binding, whatever format 1 recorded.
    public var bindsGenuineViewer: Bool { method == .directSAS && attested }

    /// An unknown method, a missing field or fields that disagree with the method fail the row.
    public init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(method: try fields.decode(Method.self, forKey: .method), attested: try fields.decode(Bool.self, forKey: .attested),
                          attestationKeyID: try fields.decodeIfPresent(Data.self, forKey: .attestationKeyID),
                          brokerAttestationKeyID: try fields.decodeIfPresent(Data.self, forKey: .brokerAttestationKeyID))
        } catch ScreenControllerError.inconsistentEnrollment {
            throw DecodingError.dataCorruptedError(forKey: .method, in: fields, debugDescription: "fields disagree with the method")
        }
    }

    private enum CodingKeys: String, CodingKey { case method, attested, attestationKeyID, brokerAttestationKeyID }
}

/// A Mac the person approved at this Mac as a controller.
public struct RegisteredController: Codable, Sendable, Identifiable, Hashable, ExpiringRegistration {
    /// Hex of the controller's fingerprint: SHA-256 of its public key, the ID its key exchange names (Handshake.swift).
    public let id: String
    public let publicKey: Data
    /// The name it enrolled with, whatever text the other Mac sent (7.1 P1): matched for `replacementCandidates` (the
    /// person's alias never is), never shown as it is. Show `displayName`.
    public let name: String
    /// The person's own name for it at this Mac; nil until renamed. Display only, like a phone's.
    public var alias: String?
    /// The model it enrolled with, sent like `name`. Show `showableModel`.
    public let model: String
    public var grant: ScreenControllerGrant
    public let enrollment: ControllerEnrollment
    public let registeredAt: Date
    public var lastConnectedAt: Date?

    /// A key the person approved at this Mac. The name and model are kept as they came, whatever they hold: one this
    /// Mac cannot show reads as 「이름 없는 Mac」 (6.3) instead of costing the registration.
    public init(publicKey: P256.Signing.PublicKey, name: String, model: String, grant: ScreenControllerGrant = .view,
                enrollment: ControllerEnrollment, at date: Date = Date()) {
        id = Self.hex(ScreenControlIdentity.fingerprint(of: publicKey))
        self.publicKey = publicKey.x963Representation
        self.name = name
        self.model = model
        self.grant = grant
        self.enrollment = enrollment
        registeredAt = date
    }

    /// A phone-brokered controller (10-29): the record the phone carried and its App Attest key. Not public, like
    /// `ControllerEnrollment.phoneBroker`: no build enrolls this way since D-1.
    init(record: RegistrationRecord, grant: ScreenControllerGrant = .view, brokerAttestationKeyID: Data, at date: Date = Date()) throws {
        self.init(publicKey: record.devicePublicKey, name: record.deviceName, model: record.deviceModel, grant: grant,
                  enrollment: try .phoneBroker(brokerAttestationKeyID: brokerAttestationKeyID), at: date)
    }

    /// A stored row, taken only when its key parses and its ID is that key's fingerprint.
    fileprivate init(storedID id: String, publicKey: Data, name: String, alias: String?, model: String, grant: ScreenControllerGrant,
                     enrollment: ControllerEnrollment, registeredAt: Date, lastConnectedAt: Date?) throws {
        guard let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
              Self.hex(ScreenControlIdentity.fingerprint(of: key)) == id else { throw ScreenStoreError.corrupt }
        self.id = id
        self.publicKey = publicKey
        self.name = name
        // Display only: a stored alias this build would not let the person type is dropped, and `displayName` shows its
        // next choice, instead of costing the registration.
        self.alias = alias.flatMap { RegistrationInvite.isShowableName($0) ? $0 : nil }
        self.model = model
        self.grant = grant
        self.enrollment = enrollment
        self.registeredAt = registeredAt
        self.lastConnectedAt = lastConnectedAt
    }

    /// A format 2 row. A key that does not parse, an ID that is not its fingerprint, an unknown grant or an enrollment
    /// that fails its own rules fails the row; a failed row is discarded without losing the others.
    public init(from decoder: Decoder) throws {
        let row = try decoder.container(keyedBy: CodingKeys.self)
        do {
            try self.init(storedID: try row.decode(String.self, forKey: .id), publicKey: try row.decode(Data.self, forKey: .publicKey),
                          name: try row.decode(String.self, forKey: .name), alias: try? row.decodeIfPresent(String.self, forKey: .alias),
                          model: try row.decode(String.self, forKey: .model), grant: try row.decode(ScreenControllerGrant.self, forKey: .grant),
                          enrollment: try row.decode(ControllerEnrollment.self, forKey: .enrollment),
                          registeredAt: try row.decode(Date.self, forKey: .registeredAt),
                          lastConnectedAt: try row.decodeIfPresent(Date.self, forKey: .lastConnectedAt))
        } catch ScreenStoreError.corrupt {
            throw DecodingError.dataCorruptedError(forKey: .publicKey, in: row, debugDescription: "key and ID disagree")
        }
    }

    private enum CodingKeys: String, CodingKey { case id, publicKey, name, alias, model, grant, enrollment, registeredAt, lastConnectedAt }

    /// What this Mac shows, and may tell the person's phones (a push carries only a name like this): the person's name
    /// for it, else the one it enrolled with, else 「이름 없는 Mac」 (6.3). Each passes the rule for a phone's name
    /// first, so a name sent over the LAN can neither reorder itself on this Mac's screen nor cost a push.
    public var displayName: String {
        [alias, name].lazy.compactMap { $0 }.first(where: RegistrationInvite.isShowableName) ?? Self.unnamed
    }

    /// The model as this Mac may show it; nil when it fails the rule for a phone's model, and the model is left out.
    public var showableModel: String? { RegistrationInvite.isShowableName(model) ? model : nil }

    /// What a controller whose name cannot be shown is called (DESIGN 6.3 「이름 거르기」).
    public static let unnamed = "이름 없는 Mac"

    /// What the person typed, under the rule for a phone's alias (`RegisteredDevice.alias(from:)`).
    public func alias(from text: String) -> RegisteredDevice.AliasInput {
        let typed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ").precomposedStringWithCanonicalMapping
        if typed.isEmpty || typed == name { return .clear }
        return RegistrationInvite.isShowableName(typed) ? .name(typed) : .invalid
    }

    /// Whether this registration is bound to the genuine Viewer's own key: what the release gate reads (DESIGN 9절,
    /// `ControllerEnrollment.bindsGenuineViewer`). There is no `attested` here on purpose: a phone-brokered row is
    /// attested yet unbound, and the gate must not take one for the other.
    public var bindsGenuineViewer: Bool { enrollment.bindsGenuineViewer }

    /// The four characters both Macs show for this key, so the person can tell the two lists name the same key
    /// (DESIGN 6.3, SR-20). The rule is the shared core's (`ScreenControlIdentity.shortFingerprint`), the one the
    /// Viewer uses too. Every row's key parses (the public init takes a parsed key, the decoder checks a stored one), so
    /// this is never empty.
    public var keyFingerprint: String {
        (try? P256.Signing.PublicKey(x963Representation: publicKey)).map(ScreenControlIdentity.shortFingerprint(of:)) ?? ""
    }

    public static func keyFingerprint(of key: P256.Signing.PublicKey) -> String { ScreenControlIdentity.shortFingerprint(of: key) }

    /// Same 90 days without use as a phone (SR-13).
    public var expiresAt: Date { RegistrationLifetime.expiry(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt) }

    public func isExpired(at now: Date = Date()) -> Bool {
        RegistrationLifetime.isExpired(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt, at: now)
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}

/// The controllers item: the 'Mac 컨트롤러 허용' switch and the approved controllers. The switch is off until the person
/// turns it on at this Mac (M-SR-19), or approves an enrollment there, which says it turns the switch on; turning it off
/// keeps the rows but no controller can connect, and turning it on again asks again.
public struct ScreenControllers: Sendable, Equatable {
    /// The format this build writes. It reads format 1 too (`ScreenStore.decodeControllers`).
    static let format = 2
    public var allowMacControllers: Bool
    public var controllers: [RegisteredController]

    public init(allowMacControllers: Bool = false, controllers: [RegisteredController] = []) {
        self.allowMacControllers = allowMacControllers
        self.controllers = controllers
    }

    /// The keys a Mac controller's key exchange may know: none while the switch is off. Kept apart from the phones'
    /// `RegisteredDeviceKeys`, so a controller key never opens a phone session and a phone key never a controller one.
    public var keyEntries: [RegisteredDeviceKeys.Entry] {
        guard allowMacControllers else { return [] }
        return controllers.compactMap { controller in
            (try? P256.Signing.PublicKey(x963Representation: controller.publicKey)).map {
                RegisteredDeviceKeys.Entry(publicKey: $0, registeredAt: controller.registeredAt, lastConnectedAt: controller.lastConnectedAt)
            }
        }
    }

    /// The controller with this fingerprint, nil when it is not approved here or the switch is off.
    public func controller(for fingerprint: Data) -> RegisteredController? {
        guard allowMacControllers else { return nil }
        let id = RegisteredController.hex(fingerprint)
        return controllers.first { $0.id == id }
    }

    /// The grant of the controller with this fingerprint, nil when it is not approved here or the switch is off.
    public func grant(for fingerprint: Data) -> ScreenControllerGrant? { controller(for: fingerprint)?.grant }

    /// Whether a controller row holds this key, whatever the switch and however long unused: a phone registration of
    /// it is refused (SR-22).
    public func holds(_ fingerprint: Data) -> Bool {
        let id = RegisteredController.hex(fingerprint)
        return controllers.contains { $0.id == id }
    }

    /// The fingerprints of controller rows a phone holds too. Enrolling refuses that, so only a store written some
    /// other way can hold one; neither key lookup should answer for these keys, or a controller would open a phone
    /// session with every right.
    public func doublyRegistered(with phones: [RegisteredDevice]) -> Set<Data> {
        Set(controllers.compactMap { controller in
            guard let key = try? P256.Signing.PublicKey(x963Representation: controller.publicKey) else { return nil }
            let fingerprint = ScreenControlIdentity.fingerprint(of: key)
            return phones.holds(fingerprint) ? fingerprint : nil
        })
    }

    /// The rows the person may choose to replace when approving a controller with this name and model: most likely the
    /// same Mac enrolled again with a new key (DESIGN 6.3 「기존 항목 바꾸기」: off by default, both fingerprints side by
    /// side). Matched on the enrolled name, never the alias, through the spellings one Mac's name can take (Unicode
    /// composition, spaces, letter case), and on the exact model. The row of the key being enrolled is left out: it is
    /// the same registration and gives way anyway.
    public func replacementCandidates(name: String, model: String, excluding fingerprint: Data? = nil) -> [RegisteredController] {
        let wanted = Self.comparable(name), excluded = fingerprint.map(RegisteredController.hex)
        return controllers.filter { $0.id != excluded && $0.model == model && Self.comparable($0.name) == wanted }
    }

    /// The controllers once the person approved `controller` at this Mac (DESIGN 6.3): the switch on, as the approval
    /// says, and its row stored, in one change. One row per key: a row of the same key gives way. `replacing` is the ID
    /// of a row the person chose to replace, one of `replacementCandidates`; nil replaces nothing. A key a phone holds
    /// here is refused (SR-22). Nothing changes when it throws.
    public func enrolling(_ controller: RegisteredController, replacing replacedID: String? = nil, phones: [RegisteredDevice]) throws -> ScreenControllers {
        guard let key = try? P256.Signing.PublicKey(x963Representation: controller.publicKey) else { throw ScreenControllerError.inconsistentEnrollment }
        let fingerprint = ScreenControlIdentity.fingerprint(of: key)
        guard !phones.holds(fingerprint) else { throw ScreenControllerError.registeredAsPhone }
        if let replacedID, !replacementCandidates(name: controller.name, model: controller.model, excluding: fingerprint).contains(where: { $0.id == replacedID }) {
            throw ScreenControllerError.notAReplacementCandidate
        }
        return ScreenControllers(allowMacControllers: true,
                                 controllers: controllers.filter { $0.id != controller.id && $0.id != replacedID } + [controller])
    }

    static func comparable(_ name: String) -> String {
        name.split(whereSeparator: \.isWhitespace).joined(separator: " ").precomposedStringWithCanonicalMapping.lowercased()
    }
}

extension Array where Element == RegisteredDevice {
    /// Whether a phone row holds this key, however long unused: a controller enrollment of it is refused (SR-22).
    /// Matched on the stored ID and on the stored key's own fingerprint, so a row whose two disagree still counts.
    public func holds(_ fingerprint: Data) -> Bool {
        let id = RegisteredController.hex(fingerprint)
        return contains { phone in
            phone.id == id || (try? P256.Signing.PublicKey(x963Representation: phone.publicKey)).map { ScreenControlIdentity.fingerprint(of: $0) == fingerprint } == true
        }
    }
}

/// What a connected controller gets.
public enum ScreenControllerPolicy {
    /// Input goes to this Mac only when the person's own input can take it back (the local input monitor runs, SR-7)
    /// and the person granted control. Otherwise the controller watches: view-only is never a degraded control session.
    public static func canControl(inputMonitorAvailable: Bool, grant: ScreenControllerGrant) -> Bool {
        inputMonitorAvailable && grant == .control
    }

    /// A controller session's limits, fixed when it starts (DESIGN 「세션 규칙」 시간 한도, M-13). A view-only session
    /// carries no input that shows someone is at the other Mac, and the pump counts its input records and screen
    /// controls as activity anyway, so it ends 60 minutes after it began whatever arrives. A control session keeps the
    /// phone's 60 minutes without input and stops after 8 hours. Going on is a new connection with a new Touch ID
    /// there; nothing about the other Mac's own window counts here. Phones keep `SessionLimits.standard`.
    public static func sessionLimits(canControl: Bool) -> SessionLimits {
        let hour = Duration.seconds(60 * 60)
        return canControl ? SessionLimits(idle: SessionLimits.standard.idle, maximum: hour * 8) : SessionLimits(idle: hour, maximum: hour)
    }
}

extension ScreenStore {
    static let controllersAccount = "controllers"

    /// The controllers item, or the switch off and nobody when there is none. A row that fails to decode is discarded
    /// without losing the others; only its count is reported. Any other document fails closed as corrupt. Reading never
    /// writes: a format 1 item stays as it is until the next save writes format 2.
    public func controllers(onDiscarded: (Int) -> Void = { _ in }) throws -> ScreenControllers {
        guard let data = try read(Self.controllersAccount) else { return ScreenControllers() }
        let loaded = try Self.decodeControllers(data)
        if loaded.discardedCount > 0 { onDiscarded(loaded.discardedCount) }
        return loaded.controllers
    }

    public func saveControllers(_ controllers: ScreenControllers) throws {
        try write(Self.controllersAccount, try Self.encodeControllers(controllers))
    }

    static func encodeControllers(_ controllers: ScreenControllers) throws -> Data {
        try JSONEncoder().encode(ControllersDocument(format: ScreenControllers.format, allowMacControllers: controllers.allowMacControllers,
                                                     controllers: controllers.controllers.oneRowPerDevice()))
    }

    static func decodeControllers(_ data: Data) throws -> (controllers: ScreenControllers, discardedCount: Int) {
        guard let document = try? JSONDecoder().decode(ControllersRows.self, from: data) else { throw ScreenStoreError.corrupt }
        return (ScreenControllers(allowMacControllers: document.allowMacControllers, controllers: document.controllers.oneRowPerDevice()),
                document.discardedCount)
    }

    private struct ControllersDocument: Encodable {
        let format: Int
        let allowMacControllers: Bool
        let controllers: [RegisteredController]
    }

    /// The stored document, format 2 or format 1. Any other format is corrupt, never read as if it were one of them.
    private struct ControllersRows: Decodable {
        var allowMacControllers = false
        var controllers: [RegisteredController] = []
        var discardedCount = 0

        enum CodingKeys: String, CodingKey { case format, allowMacControllers, controllers }

        init(from decoder: Decoder) throws {
            let document = try decoder.container(keyedBy: CodingKeys.self)
            let format = try document.decode(Int.self, forKey: .format)
            guard format == ScreenControllers.format || format == 1 else {
                throw DecodingError.dataCorruptedError(forKey: .format, in: document, debugDescription: "unknown format")
            }
            allowMacControllers = try document.decode(Bool.self, forKey: .allowMacControllers)
            var rows = try document.nestedUnkeyedContainer(forKey: .controllers)
            while !rows.isAtEnd {
                let row = try rows.superDecoder()
                do { controllers.append(format == 1 ? try FormatOneRow(from: row).controller() : try RegisteredController(from: row)) }
                catch { discardedCount += 1 }
            }
        }
    }

    /// A format 1 row (10-29): brokered by a phone, which App Attest stood behind. It moves to format 2 under the same
    /// rules as before plus the enrollment's own: a broker key ID that is not an App Attest key ID fails the row.
    private struct FormatOneRow: Decodable {
        let id: String
        let publicKey: Data
        let name: String
        let model: String
        let grant: ScreenControllerGrant
        let brokerAttestationKeyID: Data
        let registeredAt: Date
        let lastConnectedAt: Date?

        func controller() throws -> RegisteredController {
            try RegisteredController(storedID: id, publicKey: publicKey, name: name, alias: nil, model: model, grant: grant,
                                     enrollment: try .phoneBroker(brokerAttestationKeyID: brokerAttestationKeyID),
                                     registeredAt: registeredAt, lastConnectedAt: lastConnectedAt)
        }
    }
}
#endif
