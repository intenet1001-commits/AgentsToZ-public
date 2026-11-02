import CryptoKit
import Foundation

// What the AgentsToZ Viewer (Mac A) keeps about each Mac it may connect to (docs/design/mac-to-mac-2026-11-01/DESIGN.md
// 7.4) and the only ways a kept row changes. Pure: the Viewer's keychain backend moves the bytes
// (Sources/AgentsToZViewer/ViewerStore.swift); nothing here touches the keychain, a file or the network.
//
// - One item, `targets` format 1, in the Viewer's own data-protection keychain group. Never a file.
// - A damaged row is dropped alone and counted. An unknown format or an item that cannot be read is an error, never an
//   empty list, and nothing is written over it (`ViewerTargetsLedger`).
// - A row changes only on what the Mac said inside a session it signed, or on what the person did with a hardware click.
//   An unauthenticated pre-authentication notice, a close that names no reason, a timeout or an unreachable Mac changes
//   nothing (DESIGN 6.6, 7.7, F9): there is no "unknown at the Mac" state, and nothing is retried because of one.

/// One Mac B this Viewer registered with (DESIGN 7.4). Rows are made by the registration sheet (wp-pairing) through
/// `init(hostPublicKey:...)` and by `ViewerTargetsDocument.decode`; both validate every field.
public struct ViewerTarget: Codable, Equatable, Sendable {
    public enum Route: String, Codable, Sendable, CaseIterable {
        /// Nearby first (3 s), then the saved private-network address (10 s) when one is saved.
        case auto
        case nearby
        /// The saved private-network address only.
        case `private`
    }

    public enum State: String, Codable, Sendable, CaseIterable {
        /// The Mac confirmed it stored this controller (P7), or it has since signed a session for it.
        case confirmed
        /// Registration ended without the Mac's confirmation (P7 lost). Never sent again (SR-31).
        case needsCheck
    }

    public enum Grant: String, Codable, Sendable, CaseIterable {
        case view, control
        public init(_ grant: ScreenSessionGrant) { self = grant == .control ? .control : .view }
    }

    /// The name shown for a Mac whose own name did not pass `RegistrationInvite.isShowableName` (DESIGN 6.3).
    public static let unnamedMac = "이름 없는 Mac"
    /// Upper bound for the Secure Enclave key's data representation.
    static let maxKeyBlobBytes = 8192

    /// The Mac's fingerprint (SHA-256 of its identity key), lowercase hex.
    public let id: String
    /// The Mac's identity key, uncompressed (65 bytes), pinned at registration.
    public let hostPublicKey: Data
    public private(set) var name: String
    public private(set) var alias: String?
    /// `az-screen-<first 12 fingerprint bytes>`, the Mac's nearby service.
    public let screenService: String
    /// This target's own Secure Enclave key (DESIGN 「대상마다 새 A 키」), as CryptoKit represents it. Only usable on this Mac.
    public let controllerKeyBlob: Data
    /// The first four hex digits of the controller key's fingerprint, shown on both Macs to compare (SR-20).
    public let keyFingerprint4: String
    /// What the Mac last said this controller may do, inside a session it signed.
    public private(set) var grantLastHeard: Grant?
    /// The private-network (Cloudflare /32) address the person saved with a hardware click.
    public private(set) var privateNetwork: ScreenPrivateNetworkRoute?
    public private(set) var route: Route
    public private(set) var state: State
    public let pairedAt: Date
    public private(set) var lastConnectedAt: Date?

    /// The name the list shows: the person's alias, else the Mac's.
    public var displayName: String { alias ?? name }

    /// A row the registration sheet stores once the person entered code ② and the Mac's answer verified (DESIGN 6.3).
    /// A name that is not showable becomes `unnamedMac`.
    public init(hostPublicKey: P256.Signing.PublicKey, name: String, alias: String? = nil, controllerKeyBlob: Data,
                controllerPublicKey: P256.Signing.PublicKey, privateNetwork: ScreenPrivateNetworkRoute? = nil,
                route: Route = .auto, state: State, pairedAt: Date) throws {
        let fingerprint = ScreenControlIdentity.fingerprint(of: hostPublicKey)
        try self.init(id: Self.hex(fingerprint), hostPublicKey: hostPublicKey.x963Representation,
                      name: RegistrationInvite.isShowableName(name) ? name : Self.unnamedMac, alias: alias,
                      screenService: ScreenNearby.screenService(fingerprint: fingerprint), controllerKeyBlob: controllerKeyBlob,
                      keyFingerprint4: Self.keyFingerprint4(of: controllerPublicKey), grantLastHeard: nil,
                      privateNetwork: privateNetwork, route: route, state: state, pairedAt: pairedAt, lastConnectedAt: nil)
    }

    /// Every field is checked against the others: the id and the nearby service follow from the key, never from what the
    /// row says about them.
    init(id: String, hostPublicKey: Data, name: String, alias: String?, screenService: String, controllerKeyBlob: Data,
         keyFingerprint4: String, grantLastHeard: Grant?, privateNetwork: ScreenPrivateNetworkRoute?, route: Route,
         state: State, pairedAt: Date, lastConnectedAt: Date?) throws {
        guard hostPublicKey.count == 65, hostPublicKey.first == 0x04,
              let key = try? P256.Signing.PublicKey(x963Representation: hostPublicKey) else { throw ViewerTargetError.malformed }
        let fingerprint = ScreenControlIdentity.fingerprint(of: key)
        guard id == Self.hex(fingerprint), screenService == ScreenNearby.screenService(fingerprint: fingerprint),
              RegistrationInvite.isShowableName(name), alias.map(RegistrationInvite.isShowableName) ?? true,
              (1...Self.maxKeyBlobBytes).contains(controllerKeyBlob.count), Self.isFingerprint4(keyFingerprint4),
              pairedAt.timeIntervalSince1970.isFinite, lastConnectedAt?.timeIntervalSince1970.isFinite ?? true
        else { throw ViewerTargetError.malformed }
        self.id = id
        self.hostPublicKey = hostPublicKey
        self.name = name
        self.alias = alias
        self.screenService = screenService
        self.controllerKeyBlob = controllerKeyBlob
        self.keyFingerprint4 = keyFingerprint4
        self.grantLastHeard = grantLastHeard
        self.privateNetwork = privateNetwork
        self.route = route
        self.state = state
        self.pairedAt = pairedAt
        self.lastConnectedAt = lastConnectedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, hostPublicKey, name, alias, screenService, controllerKeyBlob, keyFingerprint4, grantLastHeard,
             privateNetwork, route, state, pairedAt, lastConnectedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(id: values.decode(String.self, forKey: .id), hostPublicKey: values.decode(Data.self, forKey: .hostPublicKey),
                      name: values.decode(String.self, forKey: .name), alias: values.decodeIfPresent(String.self, forKey: .alias),
                      screenService: values.decode(String.self, forKey: .screenService),
                      controllerKeyBlob: values.decode(Data.self, forKey: .controllerKeyBlob),
                      keyFingerprint4: values.decode(String.self, forKey: .keyFingerprint4),
                      grantLastHeard: values.decodeIfPresent(Grant.self, forKey: .grantLastHeard),
                      privateNetwork: values.decodeIfPresent(ScreenPrivateNetworkRoute.self, forKey: .privateNetwork),
                      route: values.decode(Route.self, forKey: .route), state: values.decode(State.self, forKey: .state),
                      pairedAt: values.decode(Date.self, forKey: .pairedAt),
                      lastConnectedAt: values.decodeIfPresent(Date.self, forKey: .lastConnectedAt))
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(hostPublicKey, forKey: .hostPublicKey)
        try values.encode(name, forKey: .name)
        try values.encodeIfPresent(alias, forKey: .alias)
        try values.encode(screenService, forKey: .screenService)
        try values.encode(controllerKeyBlob, forKey: .controllerKeyBlob)
        try values.encode(keyFingerprint4, forKey: .keyFingerprint4)
        try values.encodeIfPresent(grantLastHeard, forKey: .grantLastHeard)
        try values.encodeIfPresent(privateNetwork, forKey: .privateNetwork)
        try values.encode(route, forKey: .route)
        try values.encode(state, forKey: .state)
        try values.encode(pairedAt, forKey: .pairedAt)
        try values.encodeIfPresent(lastConnectedAt, forKey: .lastConnectedAt)
    }

    /// The Mac's key as the handshake pins it. Valid by construction.
    public func pinnedMac() throws -> PinnedMac {
        let key = try P256.Signing.PublicKey(x963Representation: hostPublicKey)
        return try PinnedMac(publicKey: key, fingerprint: ScreenControlIdentity.fingerprint(of: key))
    }

    /// The four hex digits both Macs show for a controller key (SR-20): the start of its fingerprint.
    public static func keyFingerprint4(of key: P256.Signing.PublicKey) -> String {
        hex(ScreenControlIdentity.fingerprint(of: key).prefix(2))
    }

    static func isFingerprint4(_ text: String) -> Bool {
        text.utf8.count == 4 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    static func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
}

public enum ViewerTargetError: Error, Equatable, Sendable {
    case malformed
}

// MARK: - What changes a row

extension ViewerTarget {
    /// After a connection attempt. Only a session the Mac signed for this controller key in the controller class changes
    /// the row: the Mac holds the key, so a `needsCheck` row becomes `confirmed`. Every failure (an unauthenticated
    /// notice, a close that named no reason, a timeout, an unreachable Mac, an old Mac) leaves it exactly as it was.
    public func after(connecting outcome: Result<Date, ScreenTargetConnectError>) -> ViewerTarget {
        guard case .success(let at) = outcome else { return self }
        var next = self
        next.lastConnectedAt = at
        next.state = .confirmed
        return next
    }

    /// After a notice inside a signed session: only `sessionLimits` names the grant. An address hint is never saved by
    /// itself (DESIGN 8절: the person saves it with a hardware click, `savingAddress`).
    public func after(hearing notice: ScreenNotice) -> ViewerTarget {
        guard case .sessionLimits(let grant, _) = notice else { return self }
        var next = self
        next.grantLastHeard = Grant(grant)
        return next
    }

    /// However the session ended, even a signed `revoked`: the Viewer tells it and keeps the row. Removing it is the
    /// person's 「이 Mac에서 삭제」 (DESIGN 6.6).
    public func after(ending reason: SessionEndReason?) -> ViewerTarget { self }

    /// The person saved an address the Mac named, with a hardware click.
    public func savingAddress(_ route: ScreenPrivateNetworkRoute) -> ViewerTarget {
        usingPrivateNetwork(route)
    }

    /// Clearing a local route never changes this target's pinned identity or membership.
    public func usingPrivateNetwork(_ route: ScreenPrivateNetworkRoute?) -> ViewerTarget {
        var next = self
        next.privateNetwork = route
        return next
    }

    /// The person chose how to reach this Mac, with a hardware click.
    public func choosingRoute(_ route: Route) -> ViewerTarget {
        var next = self
        next.route = route
        return next
    }
}

/// What to say when a session's `addressHint` arrives (DESIGN 8절). Nothing is saved without the person's hardware click,
/// and a changed address is never replaced by itself.
public enum ViewerAddressOffer: Equatable, Sendable {
    case none
    /// 「이 주소를 인터넷 경로로 저장할까요?」: only during a nearby session with no address saved.
    case save(ScreenPrivateNetworkRoute)
    /// 「B의 주소가 바뀌었습니다. Cloudflare의 /32도 함께 바꾸세요」: the saved address is not among those the Mac named.
    case changed(from: ScreenPrivateNetworkRoute, to: ScreenPrivateNetworkRoute)

    public static func offer(saved: ScreenPrivateNetworkRoute?, hint: [ScreenPrivateNetworkRoute], path: ScreenTargetPath) -> ViewerAddressOffer {
        guard let named = hint.first else { return .none }
        guard let saved else { return path.isNearby ? .save(named) : .none }
        return hint.contains(saved) ? .none : .changed(from: saved, to: named)
    }
}

// MARK: - The stored document

/// `targets` format 1: `{"format":1,"targets":[row, ...]}` with dates in seconds since 1970 and keys in base64.
public enum ViewerTargetsDocument {
    public static let format = 1
    /// More rows than any person registers; rows past it are dropped and counted like damaged ones.
    public static let maxTargets = 64

    public struct Decoded: Equatable, Sendable {
        public let targets: [ViewerTarget]
        /// Rows dropped as damaged, repeated or past `maxTargets`. Shown as a count; never silently zero.
        public let dropped: Int
    }

    public enum DecodeError: Error, Equatable, Sendable {
        /// A format this build does not know: refused as a whole, never read as empty.
        case unknownFormat
        case malformed
    }

    public static func decode(_ data: Data) throws -> Decoded {
        guard let object = try? JSONSerialization.jsonObject(with: data), let document = object as? [String: Any],
              let rows = document["targets"] as? [Any] else { throw DecodeError.malformed }
        // A JSON number, not `true`: Foundation bridges both to NSNumber, and `is Bool` holds for any 0 or 1.
        guard let format = document["format"] as? NSNumber, CFGetTypeID(format) != CFBooleanGetTypeID(),
              format.doubleValue.rounded() == format.doubleValue else { throw DecodeError.malformed }
        guard format.doubleValue == Double(Self.format) else { throw DecodeError.unknownFormat }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        var targets: [ViewerTarget] = [], seen = Set<String>(), dropped = 0
        for row in rows {
            guard targets.count < maxTargets, JSONSerialization.isValidJSONObject(row),
                  let bytes = try? JSONSerialization.data(withJSONObject: row),
                  let target = try? decoder.decode(ViewerTarget.self, from: bytes), seen.insert(target.id).inserted else {
                dropped += 1
                continue
            }
            targets.append(target)
        }
        return Decoded(targets: targets, dropped: dropped)
    }

    public static func encode(_ targets: [ViewerTarget]) throws -> Data {
        guard targets.count <= maxTargets, Set(targets.map(\.id)).count == targets.count else { throw DecodeError.malformed }
        struct Document: Encodable { let format: Int; let targets: [ViewerTarget] }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(Document(format: format, targets: targets))
    }
}

/// Where the document's bytes live: the Viewer's data-protection keychain item, or an in-memory stand-in in checks.
public protocol ViewerTargetsBackend: Sendable {
    /// The stored bytes, nil when nothing was ever stored. Throws when the store cannot be read now (locked keychain,
    /// missing entitlement): that is never "nothing stored".
    func read() throws -> Data?
    func write(_ data: Data) throws
}

/// The Viewer's list as it was last read, and the one way to change it: read again, change, write. A list that could
/// not be read is shown as an error and never replaced by an empty or remembered one (DESIGN 7.4, 12절).
public final class ViewerTargetsLedger {
    public enum Contents: Equatable, Sendable {
        case unread
        case loaded(ViewerTargetsDocument.Decoded)
        /// Why the list could not be read. Nothing is written while it stays so.
        case unreadable(String)
    }

    public enum LedgerError: Error, Equatable, Sendable {
        /// The stored list could not be read just now; nothing was written.
        case unreadable(String)
    }

    private let backend: any ViewerTargetsBackend
    public private(set) var contents: Contents = .unread

    public init(backend: any ViewerTargetsBackend) { self.backend = backend }

    /// The targets, or nil while the list is unread or unreadable.
    public var targets: [ViewerTarget]? {
        if case .loaded(let decoded) = contents { return decoded.targets }
        return nil
    }

    @discardableResult
    public func load() -> Contents {
        do {
            guard let data = try backend.read() else {
                contents = .loaded(.init(targets: [], dropped: 0))
                return contents
            }
            contents = .loaded(try ViewerTargetsDocument.decode(data))
        } catch {
            contents = .unreadable("\(error)")
        }
        return contents
    }

    /// Reads the list again, applies `change` and writes the result. Refused, writing nothing, when the read fails. A failed
    /// write leaves the stored list as it was, and this ledger with it.
    public func update(_ change: ([ViewerTarget]) throws -> [ViewerTarget]) throws {
        let fresh = load()
        guard case .loaded(let decoded) = fresh else {
            if case .unreadable(let reason) = fresh { throw LedgerError.unreadable(reason) }
            throw LedgerError.unreadable("unread")
        }
        let changed = try change(decoded.targets)
        try backend.write(try ViewerTargetsDocument.encode(changed))
        contents = .loaded(.init(targets: changed, dropped: 0))
    }

    /// Replaces the row with the same id, when the list still has it.
    public func replace(_ target: ViewerTarget) throws {
        try update { targets in targets.map { $0.id == target.id ? target : $0 } }
    }

    public func remove(id: String) throws {
        try update { targets in targets.filter { $0.id != id } }
    }
}
