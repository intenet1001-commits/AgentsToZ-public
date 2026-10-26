import CryptoKit
import Foundation
import Security

// The phone's registration request carries an App Attest attestation (DESIGN 「켜기와 기기 등록」). It shows that a
// genuine AgentsToZ build on a genuine Apple device made the request, so a script that photographed the QR cannot
// register by itself. The Mac checks it offline, in the order of Apple's "Validating apps that connect to your
// server": the chain to the pinned App Attestation root, the nonce in the leaf, the key identifier, the app
// identifier, the counter, the environment and the credential ID.
// https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server

public enum AppAttestError: Error, Equatable, Sendable {
    case malformed, untrustedChain, nonceMismatch, keyMismatch, wrongApp, counterNotZero, wrongEnvironment
}

public enum AppAttestEnvironment: Sendable {
    case development, production

    var aaguid: Data {
        switch self {
        case .development: Data("appattestdevelop".utf8)
        case .production: Data("appattest".utf8) + Data(count: 7)
        }
    }
}

/// What a valid attestation proves: this key lives in the Secure Enclave of a genuine device, inside our app.
public struct AppAttestation: @unchecked Sendable {
    public let publicKey: P256.Signing.PublicKey
    public let keyID: Data
    /// Apple's receipt, kept for a later fraud-metric check. Not interpreted here.
    public let receipt: Data
}

public protocol AppAttestationVerifying: Sendable {
    func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation
}

/// Accepts an attestation that any one of `verifiers` accepts: the TestFlight build in production and a development
/// install in the development environment are different app IDs. Reports the most telling refusal.
public struct AnyAppAttestVerifier: AppAttestationVerifying {
    let verifiers: [any AppAttestationVerifying]

    public init(_ verifiers: [any AppAttestationVerifying]) { self.verifiers = verifiers }

    public func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation {
        var refusal = AppAttestError.wrongApp
        for verifier in verifiers {
            do {
                return try verifier.verify(attestation, keyID: keyID, clientDataHash: clientDataHash, at: date)
            } catch let error as AppAttestError {
                // Another app ID or environment says only that this verifier was the wrong one to ask.
                if error != .wrongApp && error != .wrongEnvironment || refusal == .wrongApp { refusal = error }
            }
        }
        throw refusal
    }
}

public struct AppAttestVerifier: AppAttestationVerifying {
    let appID: String
    let environment: AppAttestEnvironment
    let rootCertificate: Data

    public init(teamID: String, bundleID: String, environment: AppAttestEnvironment) {
        self.init(appID: "\(teamID).\(bundleID)", environment: environment, rootCertificate: Self.appAttestationRoot)
    }

    init(appID: String, environment: AppAttestEnvironment, rootCertificate: Data) {
        self.appID = appID
        self.environment = environment
        self.rootCertificate = rootCertificate
    }

    /// Apple App Attestation Root CA, valid 2020-03-18 to 2045-03-15, SHA-256 1CB9823B…6242C932.
    /// From https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
    static let appAttestationRoot = Data(base64Encoded: [
        "MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0",
        "YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa",
        "Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBs",
        "ZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh",
        "NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9T",
        "gS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw",
        "CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4",
        "xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD",
    ].joined())!

    /// 1.2.840.113635.100.8.2, the leaf extension that carries the nonce.
    static let nonceExtensionOID: [UInt8] = [0x2A, 0x86, 0x48, 0x86, 0xF7, 0x63, 0x64, 0x08, 0x02]

    /// Synchronous and possibly slow (certificate evaluation): call it off the main thread.
    public func verify(_ attestation: Data, keyID: Data, clientDataHash: Data, at date: Date) throws -> AppAttestation {
        guard keyID.count == 32, clientDataHash.count == 32,
              case .map(let object) = try CBOR.decode(attestation),
              case .text("apple-appattest") = object["fmt"],
              case .map(let statement) = object["attStmt"],
              case .bytes(let authData) = object["authData"],
              case .array(let chain) = statement["x5c"], chain.count == 2,
              case .bytes(let leafDER) = chain[0], case .bytes(let intermediateDER) = chain[1],
              case .bytes(let receipt) = statement["receipt"] else { throw AppAttestError.malformed }

        // 1. The leaf and intermediate chain to Apple's App Attestation root, and to nothing else.
        guard let leaf = SecCertificateCreateWithData(nil, leafDER as CFData),
              let intermediate = SecCertificateCreateWithData(nil, intermediateDER as CFData),
              let root = SecCertificateCreateWithData(nil, rootCertificate as CFData) else { throw AppAttestError.malformed }
        try Self.evaluate(chain: [leaf, intermediate], anchor: root, at: date)

        // 2–3. The leaf vouches for exactly this authData and this request.
        guard try Self.nonce(inLeaf: leafDER) == sha256(authData + clientDataHash) else { throw AppAttestError.nonceMismatch }

        // 4. The certified key is the key the phone named.
        guard let leafKey = SecCertificateCopyKey(leaf),
              let x963 = SecKeyCopyExternalRepresentation(leafKey, nil) as Data?,
              let publicKey = try? P256.Signing.PublicKey(x963Representation: x963) else { throw AppAttestError.malformed }
        guard sha256(x963) == keyID else { throw AppAttestError.keyMismatch }

        // 5–8. authData: rpIdHash(32) flags(1) counter(4) aaguid(16) credentialIdLength(2) credentialId …
        let bytes = [UInt8](authData)
        guard bytes.count >= 55 else { throw AppAttestError.malformed }
        let credentialLength = Int(bytes[53]) << 8 | Int(bytes[54])
        guard bytes.count >= 55 + credentialLength else { throw AppAttestError.malformed }
        guard Data(bytes[0..<32]) == sha256(Data(appID.utf8)) else { throw AppAttestError.wrongApp }
        guard bytes[33..<37].allSatisfy({ $0 == 0 }) else { throw AppAttestError.counterNotZero }
        guard Data(bytes[37..<53]) == environment.aaguid else { throw AppAttestError.wrongEnvironment }
        guard Data(bytes[55..<55 + credentialLength]) == keyID else { throw AppAttestError.keyMismatch }

        return AppAttestation(publicKey: publicKey, keyID: keyID, receipt: receipt)
    }

    static func evaluate(chain: [SecCertificate], anchor: SecCertificate, at date: Date) throws {
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(chain as CFArray, SecPolicyCreateBasicX509(), &trust) == errSecSuccess,
              let trust,
              SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetVerifyDate(trust, date as CFDate) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else { throw AppAttestError.untrustedChain }
    }

    /// The 32-byte nonce in the leaf: tbsCertificate → [3] extensions → the nonce extension, whose value is
    /// SEQUENCE { [1] EXPLICIT OCTET STRING }. The extension must appear exactly once.
    static func nonce(inLeaf certificate: Data) throws -> Data {
        let bytes = [UInt8](certificate)
        guard let cert = try DER.only(bytes[...]), cert.tag == 0x30,
              let tbs = try DER.nodes(cert.content).first, tbs.tag == 0x30 else { throw AppAttestError.malformed }
        let wrappers = try DER.nodes(tbs.content).filter { $0.tag == 0xA3 }
        guard wrappers.count == 1, let extensions = try DER.only(wrappers[0].content), extensions.tag == 0x30 else {
            throw AppAttestError.malformed
        }
        var found: Data?
        for item in try DER.nodes(extensions.content) {
            let parts = try DER.nodes(item.content)
            guard item.tag == 0x30, parts.count == 2 || (parts.count == 3 && parts[1].tag == 0x01),
                  parts[0].tag == 0x06, let value = parts.last, value.tag == 0x04 else { throw AppAttestError.malformed }
            guard Array(parts[0].content) == nonceExtensionOID else { continue }
            guard found == nil,
                  let sequence = try DER.only(value.content), sequence.tag == 0x30,
                  let tagged = try DER.only(sequence.content), tagged.tag == 0xA1,
                  let octets = try DER.only(tagged.content), octets.tag == 0x04, octets.content.count == 32 else {
                throw AppAttestError.malformed
            }
            found = Data(octets.content)
        }
        guard let found else { throw AppAttestError.malformed }
        return found
    }
}

/// Just enough definite-length CBOR for an attestation object: integers, byte and text strings, arrays and maps
/// with unique text keys. Anything else, indefinite lengths, deep nesting and trailing bytes are malformed.
indirect enum CBOR: Equatable {
    case unsigned(UInt64), negative(UInt64), bytes(Data), text(String), array([CBOR]), map([String: CBOR])

    static let maxDepth = 8, maxItems = 64

    static func decode(_ data: Data) throws -> CBOR {
        var reader = Reader(bytes: [UInt8](data))
        let value = try reader.item(depth: 0)
        guard reader.index == reader.bytes.count else { throw AppAttestError.malformed }
        return value
    }

    struct Reader {
        let bytes: [UInt8]
        var index = 0

        mutating func take(_ count: UInt64) throws -> ArraySlice<UInt8> {
            guard count <= UInt64(bytes.count - index) else { throw AppAttestError.malformed }
            defer { index += Int(count) }
            return bytes[index..<index + Int(count)]
        }

        mutating func argument(_ info: UInt8) throws -> UInt64 {
            switch info {
            case 0..<24: return UInt64(info)
            case 24...27: return try take(1 << UInt64(info - 24)).reduce(0) { $0 << 8 | UInt64($1) }
            default: throw AppAttestError.malformed
            }
        }

        mutating func item(depth: Int) throws -> CBOR {
            guard depth <= CBOR.maxDepth else { throw AppAttestError.malformed }
            let initial = try take(1).first!
            let argument = try argument(initial & 0x1F)
            switch initial >> 5 {
            case 0: return .unsigned(argument)
            case 1: return .negative(argument)
            case 2: return .bytes(Data(try take(argument)))
            case 3:
                guard let text = String(data: Data(try take(argument)), encoding: .utf8) else { throw AppAttestError.malformed }
                return .text(text)
            case 4:
                guard argument <= CBOR.maxItems else { throw AppAttestError.malformed }
                return .array(try (0..<argument).map { _ in try item(depth: depth + 1) })
            case 5:
                guard argument <= CBOR.maxItems else { throw AppAttestError.malformed }
                var map: [String: CBOR] = [:]
                for _ in 0..<argument {
                    guard case .text(let key) = try item(depth: depth + 1), map[key] == nil else { throw AppAttestError.malformed }
                    map[key] = try item(depth: depth + 1)
                }
                return .map(map)
            default: throw AppAttestError.malformed
            }
        }
    }
}

/// Just enough DER to walk a certificate: single-byte tags and minimal definite lengths.
enum DER {
    struct Node { let tag: UInt8; let content: ArraySlice<UInt8> }

    static func nodes(_ bytes: ArraySlice<UInt8>) throws -> [Node] {
        var nodes: [Node] = []
        var index = bytes.startIndex
        while index < bytes.endIndex {
            guard bytes.endIndex - index >= 2, bytes[index] & 0x1F != 0x1F else { throw AppAttestError.malformed }
            let tag = bytes[index]
            var length = Int(bytes[index + 1])
            index += 2
            if length & 0x80 != 0 {
                let count = length & 0x7F
                guard (1...3).contains(count), bytes.endIndex - index >= count, bytes[index] != 0 else { throw AppAttestError.malformed }
                length = bytes[index..<index + count].reduce(0) { $0 << 8 | Int($1) }
                guard length >= 0x80 else { throw AppAttestError.malformed }
                index += count
            }
            guard bytes.endIndex - index >= length else { throw AppAttestError.malformed }
            nodes.append(Node(tag: tag, content: bytes[index..<index + length]))
            index += length
        }
        return nodes
    }

    /// The single node `bytes` holds, or nil when it holds none or several.
    static func only(_ bytes: ArraySlice<UInt8>) throws -> Node? {
        let all = try nodes(bytes)
        return all.count == 1 ? all[0] : nil
    }
}
