#if os(macOS)
import Foundation
import ScreenControlCore

/// Pure native storage lifecycle. A failed/uncertain write retains the original candidate in RAM;
/// the next attempt can only adopt the matching stored bytes or persist the same candidate.
/// No network request, signature, LA context, replacement of an existing key or grant is performed here.
@MainActor
final class ViewerCommunityBiometricPreparation {
    typealias Account = ViewerCommunityAccount.Account
    private struct Pending { let account: Account; let original: Data?; let encoded: Data }
    private var pending: Pending?
    private let make: () throws -> CommunityBiometricKeyCandidate.Material
    private let reopen: (Data) throws -> Data
    var hasPendingCandidate: Bool { pending != nil }
    init(make: @escaping () throws -> CommunityBiometricKeyCandidate.Material = { try CommunityBiometricKeyCandidate.make() },
         reopen: @escaping (Data) throws -> Data = { try CommunityBiometricKeyCandidate.publicKey(ofStoredBlob: $0) }) {
        self.make = make; self.reopen = reopen
    }
    private func read(_ backend: any ViewerTargetsBackend) throws -> Data? {
        do { return try backend.read() }
        catch { throw CommunityBiometricPreparationError(stage: .accountRead, underlying: error) }
    }
    private func check(_ account: Account, context: CommunityBiometricKeyCandidate.Context, boundViewerKey: Data?) throws -> Account {
        guard let binding = account.biometricCandidate else { throw CommunityBiometricPreparationError.invalid(.publicBindingValidate) }
        _ = try binding.checkedPublicKey(blob: account.keyBlob, context: context, boundViewerKey: boundViewerKey)
        return account
    }
    private func commit(_ value: Pending, backend: any ViewerTargetsBackend,
                        context: CommunityBiometricKeyCandidate.Context, boundViewerKey: Data?) throws -> Account {
        _ = try check(value.account, context: context, boundViewerKey: boundViewerKey)
        let current = try read(backend)
        if current != value.encoded {
            guard current == value.original else { throw CommunityBiometricPreparationError.invalid(.accountVerify) }
            do { try backend.write(value.encoded) }
            catch { throw CommunityBiometricPreparationError(stage: .accountPersist, underlying: error) }
        }
        guard try read(backend) == value.encoded else { throw CommunityBiometricPreparationError.invalid(.accountVerify) }
        pending = nil
        return value.account
    }
    func prepare(backend: any ViewerTargetsBackend, context: CommunityBiometricKeyCandidate.Context,
                 boundViewerKey: Data?, name: String, create: Bool) throws -> Account? {
        if let pending { return try commit(pending, backend: backend, context: context, boundViewerKey: boundViewerKey) }
        let original = try read(backend)
        var account: Account
        if let original {
            account = try JSONDecoder().decode(Account.self, from: original)
            if account.biometricCandidate != nil { return try check(account, context: context, boundViewerKey: boundViewerKey) }
            // One legacy reopen for a public cache backfill, never a new key or a BIO signature.
            let material = try CommunityBiometricKeyCandidate.Material(wrappedBlob: account.keyBlob, publicKey: reopen(account.keyBlob))
            account.biometricCandidate = try material.binding(to: context)
        } else {
            guard create else { return nil }
            // A ready Screen binding with no Viewer account is key loss, not a fresh installation.
            guard boundViewerKey == nil else { throw CommunityBiometricPreparationError.invalid(.publicBindingValidate) }
            let material = try make()
            account = Account(keyBlob: material.wrappedBlob, displayName: name, enrollment: nil,
                              biometricCandidate: try material.binding(to: context))
        }
        _ = try check(account, context: context, boundViewerKey: boundViewerKey)
        let value = Pending(account: account, original: original, encoded: try JSONEncoder().encode(account))
        pending = value // Before attempting any storage write; unknown writes never generate another candidate.
        return try commit(value, backend: backend, context: context, boundViewerKey: boundViewerKey)
    }
}
#endif
