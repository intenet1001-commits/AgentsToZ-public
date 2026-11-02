import Foundation
import CoreFoundation

/// Untrusted discovery hints from the main app, never enrollment or a route to a session.
public struct ViewerCommunityDirectory: Equatable, Sendable {
    public struct Device: Equatable, Sendable {
        public let ref: String
        public let name: String
        public let lastSeenAt: Date?
    }
    public let inside: Bool
    public let devices: [Device]
    public enum Invalid: Error { case document }
    public static let maximumBytes = 32_768

    public static func decode(_ data: Data, now: Date = Date()) throws -> Self {
        guard data.count <= maximumBytes,
              let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == ["schemaVersion", "generatedAt", "expiresAt", "inside", "devices"],
              let version = root["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let inside = root["inside"] as? NSNumber, CFGetTypeID(inside) == CFBooleanGetTypeID(),
              let generated = milliseconds(root["generatedAt"]), let expires = milliseconds(root["expiresAt"]),
              expires - generated == 90_000,
              generated <= now.timeIntervalSince1970 * 1000 + 5_000,
              expires > now.timeIntervalSince1970 * 1000,
              let rows = root["devices"] as? [[String: Any]], rows.count <= 64,
              inside.boolValue || rows.isEmpty else { throw Invalid.document }
        var devices: [Device] = []
        var seen = Set<String>()
        for row in rows {
            guard Set(row.keys) == ["ref", "name", "lastSeenAt"],
                  let ref = row["ref"] as? String, ref.count == 16,
                  ref.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }), seen.insert(ref).inserted,
                  let name = row["name"] as? String, !name.isEmpty, name.utf8.count <= 240,
                  name == name.trimmingCharacters(in: .whitespacesAndNewlines),
                  name.unicodeScalars.allSatisfy({ ![.control, .format].contains($0.properties.generalCategory) })
            else { throw Invalid.document }
            let lastSeen: Date?
            if row["lastSeenAt"] is NSNull { lastSeen = nil }
            else {
                guard let stamp = milliseconds(row["lastSeenAt"]), stamp <= generated + 5_000 else { throw Invalid.document }
                lastSeen = Date(timeIntervalSince1970: stamp / 1000)
            }
            devices.append(Device(ref: ref, name: name, lastSeenAt: lastSeen))
        }
        return Self(inside: inside.boolValue, devices: devices)
    }

    private static func milliseconds(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        return value.isFinite && value >= 0 && value <= 9_007_199_254_740_991 && value.rounded() == value ? value : nil
    }
}
