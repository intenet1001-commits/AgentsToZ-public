#if os(macOS)
import Foundation
import CryptoKit
import Security
import Darwin

/// Management-only link to the signed Main app. It cannot open a screen session, sign bytes or submit input.
public enum CommunityEnrollmentTransport {
    public static var path: String { FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/AgentsToZ Enrollment/main.sock").path }
    private static let mainRequirement = "anchor apple generic and identifier \"com.intenet.agentstozbycs\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    private static func checkMain(_ fd: Int32) throws {
        var uid: uid_t = 0, gid: gid_t = 0, token = audit_token_t(), length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid(),
              getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0, length == MemoryLayout<audit_token_t>.size else { throw ScreenCommunitySocketError.wrongPeer }
        var code: SecCode?, requirement: SecRequirement?
        let audit = withUnsafeBytes(of: token) { Data($0) }
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit as String: audit] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecRequirementCreateWithString(mainRequirement as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else { throw ScreenCommunitySocketError.wrongPeer }
    }
    private static func call(_ request: Data) async throws -> Data {
        guard request.count <= 16_384 else { throw ScreenCommunityError.malformed }
        return try await Task.detached {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { throw ScreenCommunitySocketError.unavailable }
            defer { Darwin.close(fd) }; ScreenCommunitySocket.configure(fd)
            var address = try ScreenCommunitySocket.address(path)
            let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard result == 0 else { throw ScreenCommunitySocketError.unavailable }
            try checkMain(fd); try ScreenCommunitySocket.write(request, fd: fd)
            let response = try ScreenCommunitySocket.read(fd: fd)
            guard response.count <= 16_384 else { throw ScreenCommunityError.malformed }; return response
        }.value
    }
    public struct ControlCandidate: Sendable {
        public let publicKey: Data
        public let agentDeviceId: String
    }
    public static func prepareControlKey(profileID: String, deviceID: String) async throws -> ControlCandidate {
        _ = try AccessValue.id(profileID); _ = try AccessValue.id(deviceID)
        let bytes = try await call(JSONSerialization.data(withJSONObject: ["operation": "prepare", "profileId": profileID, "deviceId": deviceID]))
        let value = try JSONSerialization.jsonObject(with: bytes)
        guard let response = value as? [String: Any], response["success"] as? Bool == true else { throw ScreenCommunityError.service("CONTROL_KEY_NOT_READY") }
        let object = try AccessValue.object(value, ["success", "halted", "controlKey", "profileId", "deviceId", "agentDeviceId", "candidateOnly"])
        guard object["candidateOnly"] as? Bool == true, object["halted"] as? Bool == false,
              object["profileId"] as? String == profileID, object["deviceId"] as? String == deviceID,
              let key = object["controlKey"] as? String else { throw ScreenCommunityError.wrongCommunity }
        let agentDeviceId = try AccessValue.id(object["agentDeviceId"] as Any)
        return ControlCandidate(publicKey: try AccessValue.key(key), agentDeviceId: agentDeviceId)
    }
    /// Negative only. A Viewer cannot choose another identity/key or use this to create/restore authority.
    public static func disableControlAccess() async throws {
        let bytes = try await call(JSONSerialization.data(withJSONObject: ["operation": "disable"]))
        let value = try JSONSerialization.jsonObject(with: bytes)
        guard let raw = value as? [String: Any], raw["success"] as? Bool == true else { throw ScreenCommunityError.service("CONTROL_DISABLE_UNCONFIRMED") }
        let result = try AccessValue.object(value, ["success", "halted", "disabled"])
        guard result["halted"] as? Bool == false, result["disabled"] as? Bool == true else { throw ScreenCommunityError.service("CONTROL_DISABLE_UNCONFIRMED") }
    }
    public static func installControlAuthorization(_ authorization: CommunityAuthorization, authority: ScreenCommunityAuthority) async throws {
        let reply = try CommunityAccessReply.verify(authorization.envelope, authority: authority)
        let checked = try reply.authorization(authority: authority)
        guard checked.body == authorization.body, checked.body.deviceKind == .desktop, checked.body.controlKey != nil else { throw ScreenCommunityError.wrongCommunity }
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(authorization.envelope))
        let bytes = try await call(JSONSerialization.data(withJSONObject: ["operation": "install", "requestId": reply.requestId, "envelope": object]))
        guard let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], result["success"] as? Bool == true,
              result["installed"] as? Bool == true, (result["revision"] as? NSNumber)?.int64Value == authorization.body.revision,
              (result["expiresAt"] as? NSNumber)?.int64Value == authorization.body.expiresAt else { throw ScreenCommunityError.service("CONTROL_INSTALL_NOT_READY") }
    }
}
#endif
