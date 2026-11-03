#if os(macOS)
import CryptoKit
import Foundation
import Security

/// Fixed stage + OS domain/code only. No error userInfo, key material or certificate is displayed.
public struct CommunityBiometricPreparationError: Error, Equatable, Sendable {
    public enum Stage: String, Codable, Sendable {
        case accountRead, accessControl, protectedKeyCreate, createdPublicKeyCapture
        case storedPublicKeyReopen, publicBindingValidate, accountPersist, accountVerify
    }
    public let stage: Stage
    public let domain: String
    public let code: Int
    public init(stage: Stage, underlying: any Error) {
        let error = underlying as NSError
        self.stage = stage
        let domains = ["com.apple.LocalAuthentication", "NSOSStatusErrorDomain", "kCFErrorDomainOSStatus",
                       "com.apple.CryptoKit.CryptoKitError", "AgentsToZ.CommunityBiometricCandidate"]
        domain = domains.contains(error.domain) ? error.domain : "native-key"
        code = error.code
    }
    public static func invalid(_ stage: Stage) -> Self {
        Self(stage: stage, underlying: NSError(domain: "AgentsToZ.CommunityBiometricCandidate", code: 1))
    }
}

/// Public provisioning data for an unapproved plan, never an authenticated signer or device grant.
public enum CommunityBiometricKeyCandidate {
    public struct Context: Equatable, Sendable {
        public let profileId: String, deviceId: String
        public let hostPublicKey: Data
        public init(profileId: String, deviceId: String, hostPublicKey: Data) {
            self.profileId = profileId; self.deviceId = deviceId; self.hostPublicKey = hostPublicKey
        }
    }
    public struct Material: Sendable {
        /// Kept only in the Viewer's existing private Keychain account, never an IPC/JS result.
        public let wrappedBlob: Data
        public let publicKey: Data
        public init(wrappedBlob: Data, publicKey: Data) throws {
            guard (1...8192).contains(wrappedBlob.count),
                  (try? P256.Signing.PublicKey(x963Representation: publicKey)) != nil else {
                throw CommunityBiometricPreparationError.invalid(.createdPublicKeyCapture)
            }
            self.wrappedBlob = wrappedBlob; self.publicKey = publicKey
        }
        public func binding(to context: Context) throws -> Binding {
            let binding = Binding(version: 1, profileId: context.profileId, deviceId: context.deviceId,
                hostPublicKey: context.hostPublicKey, publicKey: publicKey, wrappedBlobHash: Data(SHA256.hash(data: wrappedBlob)))
            _ = try binding.checkedPublicKey(blob: wrappedBlob, context: context, boundViewerKey: nil)
            return binding
        }
    }
    public struct Binding: Codable, Equatable, Sendable {
        public let version: Int
        public let profileId: String, deviceId: String
        public let hostPublicKey: Data, publicKey: Data, wrappedBlobHash: Data
        public func checkedPublicKey(blob: Data, context: Context, boundViewerKey: Data?) throws -> Data {
            guard version == 1, profileId == context.profileId, deviceId == context.deviceId,
                  UUID(uuidString: profileId)?.uuidString.lowercased() == profileId,
                  UUID(uuidString: deviceId)?.uuidString.lowercased() == deviceId,
                  hostPublicKey == context.hostPublicKey, publicKey != hostPublicKey,
                  (try? P256.Signing.PublicKey(x963Representation: hostPublicKey)) != nil,
                  (try? P256.Signing.PublicKey(x963Representation: publicKey)) != nil,
                  (1...8192).contains(blob.count), wrappedBlobHash == Data(SHA256.hash(data: blob)),
                  boundViewerKey == nil || boundViewerKey == publicKey else {
                throw CommunityBiometricPreparationError.invalid(.publicBindingValidate)
            }
            return publicKey
        }
    }
    /// Same strong ACL as the unchanged legacy ControllerKeyFactory. Creation/capture does not sign or approve.
    /// Capture from the original handle: do not reopen the protected blob merely to rediscover its public key.
    public static func make() throws -> Material {
        var flags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet, .or]
        if #available(macOS 15.0, *) { flags.insert(.companion) } else { flags.insert(.watch) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error) else {
            throw error.map { CommunityBiometricPreparationError(stage: .accessControl, underlying: $0.takeRetainedValue() as Error) }
                ?? .invalid(.accessControl)
        }
        let key: SecureEnclave.P256.Signing.PrivateKey
        do { key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access) }
        catch { throw CommunityBiometricPreparationError(stage: .protectedKeyCreate, underlying: error) }
        do { return try Material(wrappedBlob: key.dataRepresentation, publicKey: key.publicKey.x963Representation) }
        catch { throw CommunityBiometricPreparationError(stage: .createdPublicKeyCapture, underlying: error) }
    }
    /// Old accounts without a cache must use their exact existing key once. Never replace it on failure.
    public static func publicKey(ofStoredBlob blob: Data) throws -> Data {
        do { return try SecureEnclaveTranscriptSigner(dataRepresentation: blob).publicKey.x963Representation }
        catch { throw CommunityBiometricPreparationError(stage: .storedPublicKeyReopen, underlying: error) }
    }
}
#endif
