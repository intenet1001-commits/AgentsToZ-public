import Foundation

/// An explicitly chosen VPN/private-network route to an already pinned Mac. It is never a relay URL, a public
/// address, or an automatic fallback. The ordinary biometric handshake and AES-GCM channel still authenticate it.
public struct ScreenPrivateNetworkRoute: Codable, Hashable, Sendable {
    public static let port: UInt16 = 52741
    public let address: String

    public init(address: String) throws {
        guard Self.validAddress(address) else { throw RegistrationError.malformed }
        self.address = address
    }

    public static func validAddress(_ address: String) -> Bool {
        let fields = address.split(separator: ".", omittingEmptySubsequences: false)
        guard fields.count == 4 else { return false }
        var bytes: [UInt8] = []
        for field in fields {
            guard field.allSatisfy({ $0.isASCII && $0.isNumber }), let byte = UInt8(field), String(byte) == field else { return false }
            bytes.append(byte)
        }
        return bytes[0] == 10 || (bytes[0] == 172 && (16...31).contains(bytes[1]))
            || (bytes[0] == 192 && bytes[1] == 168)
    }

    private enum CodingKeys: String, CodingKey { case address }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(address: values.decode(String.self, forKey: .address))
    }
}
