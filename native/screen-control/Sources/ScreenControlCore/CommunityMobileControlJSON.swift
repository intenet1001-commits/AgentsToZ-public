import Foundation

/// Bound and reject duplicate decoded object keys before Foundation/typed decoders can disagree about them.
enum CommunityMobileControlJSON {
    static func object(_ bytes: Data, maximum: Int) throws -> [String: Any] {
        guard bytes.count <= maximum, String(data: bytes, encoding: .utf8) != nil else { throw ScreenCommunityError.malformed }
        var scanner = Scanner(bytes: Array(bytes)); try scanner.value(depth: 0); scanner.space()
        guard scanner.index == scanner.bytes.count, let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw ScreenCommunityError.malformed }
        return value
    }
    private struct Scanner {
        let bytes: [UInt8]; var index = 0
        mutating func space() { while index < bytes.count && [9,10,13,32].contains(bytes[index]) { index += 1 } }
        mutating func take(_ value: UInt8) throws { space(); guard index < bytes.count, bytes[index] == value else { throw ScreenCommunityError.malformed }; index += 1 }
        mutating func string() throws -> String {
            space(); let start = index; try take(34)
            while index < bytes.count {
                let c = bytes[index]; index += 1
                if c == 92 { guard index < bytes.count else { throw ScreenCommunityError.malformed }; index += 1 }
                else if c == 34 { guard let result = try JSONSerialization.jsonObject(with: Data(bytes[start..<index]), options: .fragmentsAllowed) as? String else { throw ScreenCommunityError.malformed }; return result }
            }
            throw ScreenCommunityError.malformed
        }
        mutating func value(depth: Int) throws {
            space(); guard depth <= 16, index < bytes.count else { throw ScreenCommunityError.malformed }
            switch bytes[index] {
            case 123:
                index += 1; space(); if index < bytes.count && bytes[index] == 125 { index += 1; return }
                var keys = Set<String>()
                while true {
                    let key = try string(); guard keys.insert(key).inserted else { throw ScreenCommunityError.malformed }
                    try take(58); try value(depth: depth + 1); space()
                    guard index < bytes.count else { throw ScreenCommunityError.malformed }
                    if bytes[index] == 125 { index += 1; return }; try take(44)
                }
            case 91:
                index += 1; space(); if index < bytes.count && bytes[index] == 93 { index += 1; return }
                while true { try value(depth: depth + 1); space(); guard index < bytes.count else { throw ScreenCommunityError.malformed }; if bytes[index] == 93 { index += 1; return }; try take(44) }
            case 34: _ = try string()
            default:
                let start = index
                while index < bytes.count && ![9,10,13,32,44,93,125].contains(bytes[index]) { index += 1 }
                guard index > start else { throw ScreenCommunityError.malformed }
            }
        }
    }
}
