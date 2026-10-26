import CryptoKit
import Foundation
import os

// How long a registration lives (DESIGN SR-13, 사용자 결정 「90일 무사용 등록은 만료」). A registration nobody has used
// for 90 days is refused at the key exchange like an unknown device, before anything is captured, and the menu bar shows
// it as expired. Using it — a completed connection — or registering again at the Mac starts the 90 days over.
// Measured on the Mac's wall clock, the only clock that survives a restart; setting it needs an administrator, and
// setting it forward only expires registrations sooner.

public enum RegistrationLifetime {
    /// 90 days without use.
    public static let unused: TimeInterval = 90 * 24 * 60 * 60

    /// When the registration was last used: its approval at the Mac or its last completed connection, whichever is later.
    public static func lastUse(registeredAt: Date, lastConnectedAt: Date?) -> Date {
        max(registeredAt, lastConnectedAt ?? registeredAt)
    }

    public static func expiry(registeredAt: Date, lastConnectedAt: Date?, lifetime: TimeInterval = unused) -> Date {
        lastUse(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt).addingTimeInterval(lifetime)
    }

    public static func isExpired(registeredAt: Date, lastConnectedAt: Date?, at now: Date, lifetime: TimeInterval = unused) -> Bool {
        now >= expiry(registeredAt: registeredAt, lastConnectedAt: lastConnectedAt, lifetime: lifetime)
    }
}

/// A stored registration as far as its lifetime goes: whose it is, its approval at the Mac, its last connection.
public protocol ExpiringRegistration: Identifiable {
    var registeredAt: Date { get }
    var lastConnectedAt: Date? { get set }
}

extension Array where Element: ExpiringRegistration {
    /// One row per device. A store written before re-registering replaced the row can hold two for one key, and readers
    /// that took the first or the last of them disagreed on when it expires. Merged, they all see one registration: the
    /// row of the latest approval, with the latest connection any of the rows saw, where that row stood.
    public func oneRowPerDevice() -> [Element] {
        var latest: [Element.ID: Int] = [:]
        var connected: [Element.ID: Date] = [:]
        for (index, row) in enumerated() {
            if let date = row.lastConnectedAt { connected[row.id] = Swift.max(connected[row.id] ?? date, date) }
            if let kept = latest[row.id], self[kept].registeredAt > row.registeredAt { continue }
            latest[row.id] = index
        }
        return enumerated().compactMap { index, row in
            guard latest[row.id] == index else { return nil }
            var row = row
            row.lastConnectedAt = connected[row.id]
            return row
        }
    }
}

/// The registered device keys as the key exchange asks for them, off the main actor. A device whose registration has
/// expired gets no key, so `MacHandshake` refuses it as unknown. Expiry is read at each lookup, so a Mac left on for
/// days still refuses a device the day it expires.
public final class RegisteredDeviceKeys: Sendable {
    public struct Entry: Sendable, ExpiringRegistration {
        public let publicKey: P256.Signing.PublicKey
        public let registeredAt: Date
        public var lastConnectedAt: Date?

        /// The device ID: the fingerprint of its key.
        public var id: Data { ScreenControlIdentity.fingerprint(of: publicKey) }

        public init(publicKey: P256.Signing.PublicKey, registeredAt: Date, lastConnectedAt: Date?) {
            self.publicKey = publicKey
            self.registeredAt = registeredAt
            self.lastConnectedAt = lastConnectedAt
        }
    }

    private let entries = OSAllocatedUnfairLock(initialState: [Data: Entry]())
    private let lifetime: TimeInterval
    private let now: @Sendable () -> Date

    public init(lifetime: TimeInterval = RegistrationLifetime.unused, now: @escaping @Sendable () -> Date = { Date() }) {
        self.lifetime = lifetime
        self.now = now
    }

    /// Replaces the whole set. Keyed by the fingerprint of each key, never by a stored ID. Entries for the same key are
    /// one registration (`oneRowPerDevice`), never whichever came last.
    public func set(_ list: [Entry]) {
        let map = Dictionary(uniqueKeysWithValues: list.oneRowPerDevice().map { ($0.id, $0) })
        entries.withLock { $0 = map }
    }

    /// The key for `deviceID` while its registration lives; nil when unknown or expired.
    public func key(for deviceID: Data) -> P256.Signing.PublicKey? {
        guard let entry = entries.withLock({ $0[deviceID] }),
              !RegistrationLifetime.isExpired(registeredAt: entry.registeredAt, lastConnectedAt: entry.lastConnectedAt,
                                              at: now(), lifetime: lifetime) else { return nil }
        return entry.publicKey
    }
}
