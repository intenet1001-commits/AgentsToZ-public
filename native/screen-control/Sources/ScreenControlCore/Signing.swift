import CryptoKit
import Foundation
import LocalAuthentication

/// Signs handshake transcripts. The Mac signs with its Secure Enclave identity key; the phone signs
/// with a Face ID-gated Secure Enclave key, which is why signing is asynchronous.
public protocol TranscriptSigner: Sendable {
    var publicKey: P256.Signing.PublicKey { get }
    func signature(for data: Data) async throws -> P256.Signing.ECDSASignature
}

/// A Secure Enclave key. Its blob is wrapped to this device, not to this app (DESIGN S0-7), so the caller
/// must keep the blob in an access-grouped keychain item; this type only signs.
///
/// Every signature loads the key with a new authentication context and invalidates it afterwards, so a Face ID
/// approval for one connection can never be reused by the next (SR-12), whatever context created the key.
public struct SecureEnclaveTranscriptSigner: TranscriptSigner {
    private let dataRepresentation: Data
    public let publicKey: P256.Signing.PublicKey

    public init(dataRepresentation: Data) throws {
        self.dataRepresentation = dataRepresentation
        publicKey = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation).publicKey
    }

    public func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        let context = LAContext()
        defer { context.invalidate() }
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: context)
            .signature(for: data)
    }
}

public enum ScreenControlIdentity {
    /// SHA-256 of the uncompressed point: the Mac fingerprint in the QR and the device ID in the registry.
    public static func fingerprint(of key: P256.Signing.PublicKey) -> Data { sha256(key.x963Representation) }
}

/// The Mac identity key as the phone keeps it. It exists only when the key matches the fingerprint the phone
/// read from the Mac's own screen, so a handshake can never be pointed at a key nobody checked.
public struct PinnedMac: Sendable {
    public let publicKey: P256.Signing.PublicKey
    public var fingerprint: Data { ScreenControlIdentity.fingerprint(of: publicKey) }

    public init(publicKey: P256.Signing.PublicKey, fingerprint: Data) throws {
        guard ScreenControlIdentity.fingerprint(of: publicKey) == fingerprint else { throw HandshakeError.fingerprintMismatch }
        self.publicKey = publicKey
    }
}
