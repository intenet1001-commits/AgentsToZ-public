import Foundation

/// Device-local display names; keys are pinned Mac fingerprints, not mutable directory names.
public enum ScreenMacDisplayNames {
    public enum Failure: Error { case invalidName, invalidStore }

    public static func valid(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= 64 &&
            name.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }

    public static func displayName(json: String, id: String, fallback: String) -> String {
        guard let data = json.data(using: .utf8),
              let values = try? JSONDecoder().decode([String: String].self, from: data),
              let name = values[id], valid(name) else { return fallback }
        return name
    }

    /// Refuse to overwrite a damaged store so unrelated aliases are never silently lost.
    public static func updating(json: String, id: String, name: String?) throws -> String {
        guard let data = json.data(using: .utf8),
              var values = try? JSONDecoder().decode([String: String].self, from: data) else { throw Failure.invalidStore }
        if let name {
            guard valid(name) else { throw Failure.invalidName }
            values[id] = name.trimmingCharacters(in: .whitespacesAndNewlines)
        } else { values.removeValue(forKey: id) }
        return String(decoding: try JSONEncoder().encode(values), as: UTF8.self)
    }
}
