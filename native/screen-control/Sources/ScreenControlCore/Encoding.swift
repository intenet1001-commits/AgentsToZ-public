import CryptoKit
import Foundation

/// Protocol identity bound into every transcript and record, so a peer speaking another
/// version can never agree on keys with this one (SR-1).
public enum ScreenControlProtocol {
    public static let name = "agentstoz.screen-control"
    /// The newest session version this build speaks. A session settles on the newest version both ends speak, and that
    /// version is the one bound into its transcript, keys and records (Handshake.swift, `VersionStamp`).
    /// Version 2 adds control messages only: the Mac's lock state, its displays, the cursor in the picture and turning
    /// screen control off from the phone (`ControlMessage`). The key exchange, records and input are version 1's.
    public static let version: UInt16 = 2
    /// The oldest session version this build still speaks, so a Mac and a phone of different builds still connect.
    public static let minimumVersion: UInt16 = 1
    /// Registration (QR, record, acknowledgement, approval) did not change with version 2 and stays at 1, so a phone and a
    /// Mac of either build register with each other.
    public static let registrationVersion: UInt16 = 1
    static func label(version: UInt16) -> String { "\(name)/v\(version)" }
}

public enum ScreenControlWireError: Error, Equatable, Sendable {
    case malformed
}

/// A 4-byte big-endian length before each field, so no two field lists share an encoding.
enum LengthPrefixed {
    static let maxField = 1 << 20

    static func encode(_ fields: [Data]) -> Data {
        var out = Data()
        for field in fields {
            out.append(UInt32(field.count).bigEndianData)
            out.append(field)
        }
        return out
    }

    /// Decodes exactly `count` fields; anything short, long or trailing is malformed.
    static func decode(_ data: Data, count: Int) throws -> [Data] {
        let bytes = [UInt8](data)
        var fields: [Data] = []
        var index = 0
        while index < bytes.count {
            guard fields.count < count, bytes.count - index >= 4 else { throw ScreenControlWireError.malformed }
            let length = bytes[index..<index + 4].reduce(0) { $0 << 8 | Int($1) }
            index += 4
            guard length <= maxField, bytes.count - index >= length else { throw ScreenControlWireError.malformed }
            fields.append(Data(bytes[index..<index + length]))
            index += length
        }
        guard fields.count == count else { throw ScreenControlWireError.malformed }
        return fields
    }
}

extension FixedWidthInteger {
    var bigEndianData: Data { withUnsafeBytes(of: bigEndian) { Data($0) } }
}

func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

/// CryptoKit's generator: the same source it uses for its own keys, with no failure path.
func randomBytes(_ count: Int) -> Data {
    var out = Data()
    while out.count < count {
        out.append(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }
    return out.prefix(count)
}

/// Unicode text that is safe to show or inject: non-empty, bounded, no control characters.
func isPlainText(_ text: String, maxBytes: Int) -> Bool {
    let utf8 = text.utf8.count
    return utf8 > 0 && utf8 <= maxBytes && !text.unicodeScalars.contains { $0.properties.generalCategory == .control }
}

/// A name the Mac's approval prompt can show as exactly what was registered: letters, marks, numbers, punctuation,
/// symbols and plain spaces, already in NFC, at most `maxVisible` characters. Format characters (bidirectional
/// overrides, zero-width joiners and spaces), line and paragraph separators, private-use and unassigned code points
/// are refused, so a name can neither reorder itself, break onto a second line, nor hide differences from the eye.
func isDisplaySafeName(_ text: String, maxBytes: Int, maxVisible: Int = 32) -> Bool {
    let allowed: Set<Unicode.GeneralCategory> = [
        .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
        .nonspacingMark, .spacingMark, .enclosingMark,
        .decimalNumber, .letterNumber, .otherNumber,
        .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
        .initialPunctuation, .finalPunctuation, .otherPunctuation,
        .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol,
    ]
    let hidden: Set<Unicode.Scalar> = ["\u{FFFC}", "\u{FFFD}"]   // symbols by category, but stand-ins rather than text
    return isPlainText(text, maxBytes: maxBytes) && text.count <= maxVisible
        && text.utf8.elementsEqual(text.precomposedStringWithCanonicalMapping.utf8)   // String == ignores normalization
        && text.unicodeScalars.allSatisfy { $0 == " " || allowed.contains($0.properties.generalCategory) && !hidden.contains($0) }
}
