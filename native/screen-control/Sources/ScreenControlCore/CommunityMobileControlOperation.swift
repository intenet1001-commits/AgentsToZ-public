import Foundation
import Security

/// Original admission identity. Receipt reads never regenerate or retimestamp this value.
public struct CommunityMobileControlOperation: Codable, Equatable, Sendable {
    public let operationId: String, createdAt: Int64
    public static func make(now: Date = Date()) throws -> Self {
        let at = Int64(now.timeIntervalSince1970 * 1000)
        guard at >= 0, at <= 0xffff_ffff_ffff else { throw ScreenCommunityError.malformed }
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw ScreenCommunityError.malformed }
        for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: at >> ((5 - index) * 8)) }
        bytes[6] = (bytes[6] & 15) | 0x70; bytes[8] = (bytes[8] & 63) | 0x80
        let id = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15])).uuidString.lowercased()
        return Self(operationId: id, createdAt: at)
    }
    public func validate() throws {
        guard operationId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
              let stamp = Int64(operationId.replacingOccurrences(of: "-", with: "").prefix(12), radix: 16), stamp == createdAt else { throw ScreenCommunityError.malformed }
    }
    public func isAdmissible(at now: Date = Date()) -> Bool {
        guard (try? validate()) != nil else { return false }
        let clock = Int64(now.timeIntervalSince1970 * 1000)
        return createdAt >= clock - 30_000 && createdAt <= clock + 5_000
    }
}
