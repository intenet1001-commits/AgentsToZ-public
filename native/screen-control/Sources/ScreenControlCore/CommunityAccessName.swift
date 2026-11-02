import Foundation

/// Community v2 mirrors the issuer. Legacy phone/direct-registration byte limits remain separate.
public enum CommunityAccessName {
    public static func isValid(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 120 && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && !value.unicodeScalars.contains { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format }
    }
}
