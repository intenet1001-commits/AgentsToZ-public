#if os(macOS)
import CryptoKit
import Foundation
import ScreenControlCore

// Mac controllers (docs/design/mac-to-mac-2026-10-29/DESIGN.md 「저장과 권한」): another Mac the person approved at this
// one, brokered by a phone already registered here. They live apart from the phones, in a keychain item of their own
// ("controllers") that a build before Mac controllers never reads: it reads "identity", "devices", "networks" and
// "internet-route" only. The item holds one object where "devices" holds an array, so even a misdirected read by the
// device reader fails closed as corrupt instead of taking a controller for a phone.

/// What one controller may do. Chosen at this Mac, never asked for by the controller (M-SR-21); `view` until the
/// person at this Mac raises it.
public enum ScreenControllerGrant: String, Codable, Sendable, Hashable {
    case view, control
}

/// A Mac the person approved at this Mac as a controller.
public struct RegisteredController: Codable, Sendable, Identifiable, Hashable, ExpiringRegistration {
    /// Hex of the controller's fingerprint: SHA-256 of its public key.
    public let id: String
    public let publicKey: Data
    public let name: String
    public let model: String
    public var grant: ScreenControllerGrant
    /// The App Attest key of the registered phone that brokered it.
    public let brokerAttestationKeyID: Data
    public let registeredAt: Date
    public var lastConnectedAt: Date?

    public init(record: RegistrationRecord, grant: ScreenControllerGrant = .view, brokerAttestationKeyID: Data, at date: Date = Date()) {
        id = record.deviceID.map { String(format: "%02x", $0) }.joined()
        publicKey = record.devicePublicKey.x963Representation
        name = record.deviceName
        model = record.deviceModel
        self.grant = grant
        self.brokerAttestationKeyID = brokerAttestationKeyID
        registeredAt = date
    }

    /// A stored row is taken only when its key parses and its ID is that key's fingerprint; an unknown grant fails the
    /// row too. A failed row is discarded without losing the others.
    public init(from decoder: Decoder) throws {
        let row = try decoder.container(keyedBy: CodingKeys.self)
        id = try row.decode(String.self, forKey: .id)
        publicKey = try row.decode(Data.self, forKey: .publicKey)
        name = try row.decode(String.self, forKey: .name)
        model = try row.decode(String.self, forKey: .model)
        grant = try row.decode(ScreenControllerGrant.self, forKey: .grant)
        brokerAttestationKeyID = try row.decode(Data.self, forKey: .brokerAttestationKeyID)
        registeredAt = try row.decode(Date.self, forKey: .registeredAt)
        lastConnectedAt = try row.decodeIfPresent(Date.self, forKey: .lastConnectedAt)
        guard let key = try? P256.Signing.PublicKey(x963Representation: publicKey),
              ScreenControlIdentity.fingerprint(of: key).map({ String(format: "%02x", $0) }).joined() == id else {
            throw DecodingError.dataCorruptedError(forKey: .publicKey, in: row, debugDescription: "key and ID disagree")
        }
    }

    /// Same 90 days without use as a phone (SR-13).
    public var expiresAt: Date { RegistrationLifetime.expiry(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt) }

    public func isExpired(at now: Date = Date()) -> Bool {
        RegistrationLifetime.isExpired(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt, at: now)
    }
}

/// The controllers item: the 'Mac 컨트롤러 허용' switch and the approved controllers. The switch is off until the person
/// turns it on at this Mac with Touch ID or the password (M-SR-19); turning it off keeps the rows but no controller can
/// connect, and turning it on again asks again.
public struct ScreenControllers: Sendable, Equatable {
    static let format = 1
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

    /// The grant of the controller with this fingerprint, nil when it is not approved here or the switch is off.
    public func grant(for fingerprint: Data) -> ScreenControllerGrant? {
        guard allowMacControllers else { return nil }
        let id = fingerprint.map { String(format: "%02x", $0) }.joined()
        return controllers.first { $0.id == id }?.grant
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
    /// without losing the others; only its count is reported. Any other document fails closed as corrupt.
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

    /// The stored document. A format this build does not know is corrupt, never read as if it were format 1.
    private struct ControllersRows: Decodable {
        var allowMacControllers = false
        var controllers: [RegisteredController] = []
        var discardedCount = 0

        enum CodingKeys: String, CodingKey { case format, allowMacControllers, controllers }

        init(from decoder: Decoder) throws {
            let document = try decoder.container(keyedBy: CodingKeys.self)
            guard try document.decode(Int.self, forKey: .format) == ScreenControllers.format else {
                throw DecodingError.dataCorruptedError(forKey: .format, in: document, debugDescription: "unknown format")
            }
            allowMacControllers = try document.decode(Bool.self, forKey: .allowMacControllers)
            var rows = try document.nestedUnkeyedContainer(forKey: .controllers)
            while !rows.isAtEnd {
                let row = try rows.superDecoder()
                do { controllers.append(try RegisteredController(from: row)) }
                catch { discardedCount += 1 }
            }
        }
    }
}
#endif
