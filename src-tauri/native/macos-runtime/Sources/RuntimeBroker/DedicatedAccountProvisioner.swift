import Darwin
import Foundation
import OpenDirectory
import RuntimeBrokerProtocol

enum RuntimeDedicatedAccountProvisioner {
    private static let accountName = RuntimeBrokerContract.dedicatedAccountName
    private static let fullName = "AgentsToZ Runtime"
    private static let parentDirectories: [(String, mode_t)] = [
        ("/Library/Application Support/com.intenet.agentstozbycs", 0o755),
        ("/Library/Application Support/com.intenet.agentstozbycs/agent-runtime", 0o755),
    ]

    private struct Identity: Equatable {
        let userIdentifier: uid_t
        let groupIdentifier: gid_t
        let userGUID: String
        let groupGUID: String
    }

    private struct Manifest: Codable {
        let schemaVersion: Int
        let kind: String
        let accountName: String
        let userIdentifier: UInt32
        let groupIdentifier: UInt32
        let userGUID: String
        let groupGUID: String
        let home: String
        let shell: String
        let passwordLoginDisabled: Bool
    }

    static func provision(challenge: Data) -> Data? {
        guard challenge.count == RuntimeBrokerContract.challengeByteCount,
              geteuid() == 0,
              getegid() == 0,
              getppid() == 1,
              ensureParentDirectories() else {
            return nil
        }

        let manifest = readManifest()
        let namedUserExists = getpwnam(accountName) != nil
        let namedGroupExists = getgrnam(accountName) != nil
        if manifest != nil || namedUserExists || namedGroupExists {
            guard let manifest,
                  namedUserExists,
                  namedGroupExists,
                  let identity = validatedIdentity(),
                  manifestMatches(manifest, identity: identity) else {
                // Never adopt, overwrite, or delete a partial or foreign account.
                return nil
            }
            return proof(challenge: challenge, identity: identity, result: "already-provisioned")
        }

        guard let identifier = unusedIdentifier(),
              let node = try? ODNode(
                session: ODSession.default(),
                type: UInt32(kODNodeTypeLocalNodes)
              ) else {
            return nil
        }
        let userGUID = UUID().uuidString.uppercased()
        let groupGUID = UUID().uuidString.uppercased()
        let identifierText = String(identifier)
        let groupAttributes: [AnyHashable: Any] = [
            kODAttributeTypePrimaryGroupID: identifierText,
            kODAttributeTypeGUID: groupGUID,
            kODAttributeTypeFullName: fullName,
        ]
        let userAttributes: [AnyHashable: Any] = [
            kODAttributeTypeUniqueID: identifierText,
            kODAttributeTypePrimaryGroupID: identifierText,
            kODAttributeTypeGUID: userGUID,
            kODAttributeTypeFullName: fullName,
            kODAttributeTypeNFSHomeDirectory: RuntimeBrokerContract.dedicatedAccountHome,
            kODAttributeTypeUserShell: RuntimeBrokerContract.dedicatedAccountShell,
            kODAttributeTypePassword: "*",
        ]

        var createdGroup: ODRecord?
        var createdUser: ODRecord?
        var committed = false
        defer {
            if !committed {
                // Roll back only record handles created by this call. Unknown
                // or pre-existing records are never selected for deletion.
                if let createdUser { try? createdUser.delete() }
                if let createdGroup { try? createdGroup.delete() }
            }
        }
        do {
            createdGroup = try node.createRecord(
                withRecordType: kODRecordTypeGroups,
                name: accountName,
                attributes: groupAttributes
            )
            createdUser = try node.createRecord(
                withRecordType: kODRecordTypeUsers,
                name: accountName,
                attributes: userAttributes
            )
            try createdGroup?.synchronize()
            try createdUser?.synchronize()
        } catch {
            return nil
        }

        guard let identity = waitForValidatedIdentity(),
              identity.userIdentifier == identifier,
              identity.groupIdentifier == identifier,
              identity.userGUID == userGUID,
              identity.groupGUID == groupGUID else {
            return nil
        }
        let newManifest = Manifest(
            schemaVersion: 1,
            kind: "macos-runtime-dedicated-account",
            accountName: accountName,
            userIdentifier: identifier,
            groupIdentifier: identifier,
            userGUID: userGUID,
            groupGUID: groupGUID,
            home: RuntimeBrokerContract.dedicatedAccountHome,
            shell: RuntimeBrokerContract.dedicatedAccountShell,
            passwordLoginDisabled: true
        )
        guard writeManifest(newManifest),
              let persisted = readManifest(),
              manifestMatches(persisted, identity: identity) else {
            _ = RuntimeBrokerContract.dedicatedAccountManifestPath.withCString { unlink($0) }
            return nil
        }
        committed = true
        return proof(challenge: challenge, identity: identity, result: "provisioned")
    }

    private static func unusedIdentifier() -> uid_t? {
        for value in RuntimeBrokerContract.dedicatedIdentifierRange.reversed() {
            let identifier = uid_t(value)
            if getpwuid(identifier) == nil && getgrgid(gid_t(value)) == nil {
                return identifier
            }
        }
        return nil
    }

    private static func waitForValidatedIdentity() -> Identity? {
        let deadline = DispatchTime.now() + .seconds(3)
        repeat {
            if let identity = validatedIdentity() {
                return identity
            }
            usleep(20_000)
        } while DispatchTime.now() < deadline
        return nil
    }

    private static func validatedIdentity() -> Identity? {
        guard let accountPointer = getpwnam(accountName) else { return nil }
        let account = accountPointer.pointee
        let userIdentifier = account.pw_uid
        let primaryGroupIdentifier = account.pw_gid
        let home = String(cString: account.pw_dir)
        let shell = String(cString: account.pw_shell)
        let password = String(cString: account.pw_passwd)

        guard let groupPointer = getgrnam(accountName) else { return nil }
        let groupIdentifier = groupPointer.pointee.gr_gid
        guard RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(userIdentifier)),
              RuntimeBrokerContract.dedicatedIdentifierRange.contains(Int(groupIdentifier)),
              primaryGroupIdentifier == groupIdentifier,
              home == RuntimeBrokerContract.dedicatedAccountHome,
              shell == RuntimeBrokerContract.dedicatedAccountShell,
              password == "*",
              getpwuid(userIdentifier).map({ String(cString: $0.pointee.pw_name) }) == accountName,
              getgrgid(groupIdentifier).map({ String(cString: $0.pointee.gr_name) }) == accountName,
              hasNoPrivilegedSupplementaryGroup(primaryGroup: groupIdentifier),
              let directoryValues = directoryIdentityValues(),
              directoryValues.userIdentifier == userIdentifier,
              directoryValues.groupIdentifier == groupIdentifier else {
            return nil
        }
        return Identity(
            userIdentifier: userIdentifier,
            groupIdentifier: groupIdentifier,
            userGUID: directoryValues.userGUID,
            groupGUID: directoryValues.groupGUID
        )
    }

    private static func directoryIdentityValues() -> Identity? {
        do {
            let node = try ODNode(
                session: ODSession.default(),
                type: UInt32(kODNodeTypeLocalNodes)
            )
            let user = try node.record(
                withRecordType: kODRecordTypeUsers,
                name: accountName,
                attributes: [
                    kODAttributeTypeUniqueID, kODAttributeTypePrimaryGroupID,
                    kODAttributeTypeGUID, kODAttributeTypeNFSHomeDirectory,
                    kODAttributeTypeUserShell, kODAttributeTypePassword,
                ]
            )
            let group = try node.record(
                withRecordType: kODRecordTypeGroups,
                name: accountName,
                attributes: [kODAttributeTypePrimaryGroupID, kODAttributeTypeGUID]
            )
            guard let userIdentifier = exactUInt32(user, kODAttributeTypeUniqueID),
                  let primaryGroup = exactUInt32(user, kODAttributeTypePrimaryGroupID),
                  let groupIdentifier = exactUInt32(group, kODAttributeTypePrimaryGroupID),
                  primaryGroup == groupIdentifier,
                  exactString(user, kODAttributeTypeNFSHomeDirectory) == RuntimeBrokerContract.dedicatedAccountHome,
                  exactString(user, kODAttributeTypeUserShell) == RuntimeBrokerContract.dedicatedAccountShell,
                  exactString(user, kODAttributeTypePassword) == "*",
                  let userGUID = exactGUID(user, kODAttributeTypeGUID),
                  let groupGUID = exactGUID(group, kODAttributeTypeGUID) else {
                return nil
            }
            return Identity(
                userIdentifier: uid_t(userIdentifier),
                groupIdentifier: gid_t(groupIdentifier),
                userGUID: userGUID,
                groupGUID: groupGUID
            )
        } catch {
            return nil
        }
    }

    private static func exactString(_ record: ODRecord, _ attribute: String) -> String? {
        guard let values = try? record.values(forAttribute: attribute),
              values.count == 1,
              let value = values.first as? String,
              !value.isEmpty else {
            return nil
        }
        return value
    }

    private static func exactUInt32(_ record: ODRecord, _ attribute: String) -> UInt32? {
        guard let value = exactString(record, attribute),
              !value.hasPrefix("+"), !value.hasPrefix("-"),
              value.allSatisfy({ $0.isASCII && $0.isNumber }),
              let parsed = UInt32(value) else {
            return nil
        }
        return parsed
    }

    private static func exactGUID(_ record: ODRecord, _ attribute: String) -> String? {
        guard let value = exactString(record, attribute),
              let parsed = UUID(uuidString: value) else {
            return nil
        }
        return parsed.uuidString.uppercased()
    }

    private static func hasNoPrivilegedSupplementaryGroup(
        primaryGroup: gid_t
    ) -> Bool {
        var groupCount: Int32 = 0
        let baseGroup = Int32(bitPattern: primaryGroup)
        _ = accountName.withCString { getgrouplist($0, baseGroup, nil, &groupCount) }
        guard groupCount > 0, groupCount <= 128 else { return false }
        var groups = [Int32](repeating: 0, count: Int(groupCount))
        var capacity = groupCount
        let status = accountName.withCString {
            getgrouplist($0, baseGroup, &groups, &capacity)
        }
        guard status >= 0, capacity > 0, capacity <= groupCount else { return false }
        groups.removeSubrange(Int(capacity)..<groups.count)
        return !groups.contains(0) && !groups.contains(80)
    }

    private static func ensureParentDirectories() -> Bool {
        for (path, mode) in parentDirectories {
            var metadata = stat()
            if path.withCString({ lstat($0, &metadata) }) != 0 {
                guard errno == ENOENT,
                      path.withCString({ mkdir($0, mode) }) == 0,
                      path.withCString({ chown($0, 0, 0) }) == 0,
                      path.withCString({ chmod($0, mode) }) == 0,
                      path.withCString({ lstat($0, &metadata) }) == 0 else {
                    return false
                }
            }
            guard (metadata.st_mode & S_IFMT) == S_IFDIR,
                  metadata.st_uid == 0,
                  metadata.st_gid == 0,
                  (metadata.st_mode & 0o7777) == mode else {
                return false
            }
        }
        return true
    }

    private static func manifestMatches(_ manifest: Manifest, identity: Identity) -> Bool {
        manifest.schemaVersion == 1
            && manifest.kind == "macos-runtime-dedicated-account"
            && manifest.accountName == accountName
            && manifest.userIdentifier == identity.userIdentifier
            && manifest.groupIdentifier == identity.groupIdentifier
            && manifest.userGUID == identity.userGUID
            && manifest.groupGUID == identity.groupGUID
            && manifest.home == RuntimeBrokerContract.dedicatedAccountHome
            && manifest.shell == RuntimeBrokerContract.dedicatedAccountShell
            && manifest.passwordLoginDisabled
    }

    private static func readManifest() -> Manifest? {
        let path = RuntimeBrokerContract.dedicatedAccountManifestPath
        var pathMetadata = stat()
        guard path.withCString({ lstat($0, &pathMetadata) }) == 0,
              (pathMetadata.st_mode & S_IFMT) == S_IFREG,
              pathMetadata.st_nlink == 1,
              pathMetadata.st_uid == 0,
              pathMetadata.st_gid == 0,
              (pathMetadata.st_mode & 0o7777) == 0o444,
              pathMetadata.st_size > 0,
              pathMetadata.st_size <= RuntimeBrokerContract.maximumWireBytes else {
            return nil
        }
        let descriptor = path.withCString { open($0, O_RDONLY | O_NOFOLLOW | O_CLOEXEC) }
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }
        var descriptorMetadata = stat()
        guard fstat(descriptor, &descriptorMetadata) == 0,
              descriptorMetadata.st_dev == pathMetadata.st_dev,
              descriptorMetadata.st_ino == pathMetadata.st_ino,
              descriptorMetadata.st_size == pathMetadata.st_size else {
            return nil
        }
        var data = Data(count: Int(descriptorMetadata.st_size))
        var offset = 0
        let readAll = data.withUnsafeMutableBytes { buffer -> Bool in
            while offset < buffer.count {
                let amount = read(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if amount <= 0 { return false }
                offset += amount
            }
            return true
        }
        var trailing: UInt8 = 0
        guard readAll, read(descriptor, &trailing, 1) == 0 else { return nil }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    private static func writeManifest(_ manifest: Manifest) -> Bool {
        let path = RuntimeBrokerContract.dedicatedAccountManifestPath
        guard var data = try? JSONEncoder().encode(manifest), data.count < RuntimeBrokerContract.maximumWireBytes else {
            return false
        }
        data.append(0x0A)
        let descriptor = path.withCString {
            open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o444)
        }
        guard descriptor >= 0 else { return false }
        defer { close(descriptor) }
        guard fchown(descriptor, 0, 0) == 0, fchmod(descriptor, 0o444) == 0 else {
            return false
        }
        var offset = 0
        let wroteAll = data.withUnsafeBytes { buffer -> Bool in
            while offset < buffer.count {
                let amount = write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if amount <= 0 { return false }
                offset += amount
            }
            return true
        }
        return wroteAll && fsync(descriptor) == 0
    }

    private static func proof(challenge: Data, identity: Identity, result: String) -> Data? {
        let object: [String: Any] = [
            "schemaVersion": 1,
            "kind": "macos-runtime-dedicated-account-provisioning",
            "result": result,
            "accountName": accountName,
            "effectiveUserIdentifier": Int(identity.userIdentifier),
            "effectiveGroupIdentifier": Int(identity.groupIdentifier),
            "challenge": challenge.base64EncodedString(),
            "passwordLoginDisabled": true,
            "adminMembership": false,
            "authoritative": false,
            "executionAuthorized": false,
            "reusable": false,
            "ready": false,
        ]
        guard JSONSerialization.isValidJSONObject(object),
              var wire = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              wire.count + 1 <= RuntimeBrokerContract.maximumWireBytes else {
            return nil
        }
        wire.append(0x0A)
        return wire
    }
}
