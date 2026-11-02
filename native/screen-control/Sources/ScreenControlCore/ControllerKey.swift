#if os(macOS)
import CryptoKit
import Foundation
import Security

// K_A, the AgentsToZ Viewer's key for one Mac B (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3 「이 대상만의 SE 키」,
// D-6). It lives in the shared core so the Viewer, which links ScreenControlCore only (SR-32), makes it without importing
// CryptoKit itself: the Viewer's source contract (ViewerRouteChecks) keeps its imports to AppKit, the core and a few
// system frameworks.

/// K_A as it is made: the signer the pairing signs P6 with, and the blob the Viewer keeps in its keychain group once the
/// pairing succeeded. Nothing writes the blob anywhere before that, so a pairing that fails drops the key.
public struct ControllerKeyMaterial: Sendable {
    public let signer: any TranscriptSigner
    /// The Secure Enclave key's `dataRepresentation`, wrapped to this Mac.
    public let blob: Data

    public init(signer: any TranscriptSigner, blob: Data) {
        self.signer = signer
        self.blob = blob
    }

    /// The four characters both Macs show for this key (SR-20).
    public var shortFingerprint: String { ScreenControlIdentity.shortFingerprint(of: signer.publicKey) }
}

public enum ControllerKeyFactory {
    /// A new Secure Enclave key that signs only with this Mac's current Touch ID enrolment or, per D-6, a paired Apple
    /// Watch. Creating it asks nothing; its first signature (P6) is the person's biometric step.
    public static func make() throws -> ControllerKeyMaterial {
        var flags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet, .or]
        if #available(macOS 15.0, *) { flags.insert(.companion) } else { flags.insert(.watch) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error) else {
            throw error.map { $0.takeRetainedValue() as Error } ?? ControllerPairingError.malformed
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        return ControllerKeyMaterial(signer: try SecureEnclaveTranscriptSigner(dataRepresentation: key.dataRepresentation),
                                     blob: key.dataRepresentation)
    }
}
#endif
