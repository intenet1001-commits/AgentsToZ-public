import Foundation
import CryptoKit

/// Production trust is sealed into the signed helpers. A response, discovery file, URL argument or environment
/// variable cannot select an issuer. A closed configuration keeps enrollment unavailable before provisioning.
public struct ScreenCommunityAuthority: Sendable {
    public let origin: URL
    public let issuer: P256.Signing.PublicKey
    public let profileID: String
    public init(origin: URL, issuer: P256.Signing.PublicKey, profileID: String) throws {
        guard origin.scheme == "https", origin.user == nil, origin.password == nil, origin.port == nil,
              origin.query == nil, origin.fragment == nil, origin.path.isEmpty || origin.path == "/",
              let host = origin.host, host.hasSuffix(".workers.dev"), UUID(uuidString: profileID)?.uuidString.lowercased() == profileID
        else { throw ScreenCommunityError.malformed }
        self.origin = origin; self.issuer = issuer; self.profileID = profileID
    }
    public static var configured: Self? { ScreenCommunityDeployment.authority }
}

// Changed only by a reviewed, signed build after the service's public issuer and exact origin are known.
// No secret belongs in this file. Never fall back to /health's advertised issuer.
private enum ScreenCommunityDeployment {
#if SCREEN_COMMUNITY_QA
    // Explicit personal QA build only. Normal/public builds remain closed; no runtime file or environment selects trust.
    static let authority: ScreenCommunityAuthority? = {
        guard Bundle.main.infoDictionary?[ScreenCommunityBundleConfiguration.infoKey] == nil else { return nil }
        guard let origin = URL(string: "https://agentstoz-screen-community.agentstoz-screen-community.workers.dev"),
              let raw = try? ScreenCommunityRequest.decodeBase64("BBBrsAeK5pOokQ3HXnIBqqMzAhWIGKtuS6LZnsyhNn_W8xzzKVd7sTG1tTBYTuIlm6QVkBS9O5faAJmz1Tesvu8", max: 87),
              let issuer = try? P256.Signing.PublicKey(x963Representation: raw) else { return nil }
        return try? ScreenCommunityAuthority(origin: origin, issuer: issuer, profileID: "51c574e8-2109-4065-92e0-66523c206fe8")
    }()
#else
    static let authority: ScreenCommunityAuthority? = {
        guard let config = ScreenCommunityBundleConfiguration.parse(info: Bundle.main.infoDictionary ?? [:]) else { return nil }
        return try? ScreenCommunityAuthority(origin: config.origin, issuer: config.issuer, profileID: config.profileID)
    }()
#endif
}

private final class NoCommunityRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

public struct ScreenCommunityHTTP: Sendable {
    public let authority: ScreenCommunityAuthority
    public init(authority: ScreenCommunityAuthority) { self.authority = authority }
    public func send(_ envelope: ScreenCommunityEnvelope, expectedRequestID: String) async throws -> ScreenCommunityResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.urlCredentialStorage = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 12; configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: NoCommunityRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: authority.origin.appending(path: "v1"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(envelope)
        guard request.httpBody!.count <= 32_768 else { throw ScreenCommunityError.malformed }
        let (stream, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url,
              [200, 400].contains(response.statusCode), response.mimeType == "application/json",
              response.expectedContentLength <= 70_000 else { throw ScreenCommunityError.service("UNAVAILABLE") }
        var body = Data()
        for try await byte in stream { guard body.count < 70_000 else { throw ScreenCommunityError.malformed }; body.append(byte) }
        let reply = try JSONDecoder().decode(ScreenCommunityEnvelope.self, from: body)
        return try ScreenCommunityResponse.verify(reply, issuer: authority.issuer, expectedRequestID: expectedRequestID)
    }
}

#if os(macOS)
import Security
import Darwin

public enum ScreenCommunityPeer: Sendable {
    case screen, viewer
    fileprivate var requirement: String {
        let identifier = self == .screen ? "com.intenet.agentstozbycs.screen" : "com.intenet.agentstozbycs.viewer"
        return "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
    }
}
public enum ScreenCommunitySocketError: Error { case unavailable, unsafePath, wrongPeer, malformed, alreadyRunning }

/// No PID lookup: the kernel's connected-peer audit token is checked against the exact Developer ID requirement.
/// An app with the same UID, a copied display name or a PID reused during validation is insufficient.
public enum ScreenCommunityPeerCheck {
    public static func require(_ expected: ScreenCommunityPeer, fd: Int32) throws {
        var uid: uid_t = 0, gid: gid_t = 0
        guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw ScreenCommunitySocketError.wrongPeer }
        var token = audit_token_t(), length = socklen_t(MemoryLayout<audit_token_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) == 0,
              length == MemoryLayout<audit_token_t>.size else { throw ScreenCommunitySocketError.wrongPeer }
        let audit = withUnsafeBytes(of: token) { Data($0) }
        var code: SecCode?, requirement: SecRequirement?
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit as String: audit] as CFDictionary, [], &code) == errSecSuccess,
              let code, SecRequirementCreateWithString(expected.requirement as CFString, [], &requirement) == errSecSuccess,
              let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { throw ScreenCommunitySocketError.wrongPeer }
    }
}

public enum ScreenCommunitySocket {
    public static var path: String {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/AgentsToZ Screen/community.sock").path
    }
    public static func call(_ data: Data) async throws -> Data {
        try await Task.detached {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0); guard fd >= 0 else { throw ScreenCommunitySocketError.unavailable }
            defer { Darwin.close(fd) }; configure(fd)
            var address = try address(path)
            let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard connected == 0 else { throw ScreenCommunitySocketError.unavailable }
            try ScreenCommunityPeerCheck.require(.screen, fd: fd)
            try write(data, fd: fd); return try read(fd: fd)
        }.value
    }
    static func configure(_ fd: Int32, timeoutEnabled: Bool = true) {
        var yes: Int32 = 1, timeout = timeval(tv_sec: 20, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        if timeoutEnabled {
            _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        }
        _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    }
    static func address(_ path: String) throws -> sockaddr_un {
        var result = sockaddr_un(); result.sun_family = sa_family_t(AF_UNIX); result.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        guard path.utf8.count < MemoryLayout.size(ofValue: result.sun_path) else { throw ScreenCommunitySocketError.unsafePath }
        _ = path.withCString { bytes in withUnsafeMutablePointer(to: &result.sun_path) { memcpy($0, bytes, path.utf8.count + 1) } }
        return result
    }
    static func read(fd: Int32) throws -> Data {
        func exactly(_ count: Int) throws -> Data {
            var bytes = [UInt8](repeating: 0, count: count), offset = 0
            while offset < count {
                let n = bytes.withUnsafeMutableBytes { Darwin.recv(fd, $0.baseAddress! + offset, count - offset, 0) }
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw ScreenCommunitySocketError.unavailable }; offset += n
            }
            return Data(bytes)
        }
        let count = try exactly(4).reduce(0) { ($0 << 8) | Int($1) }
        guard count > 0, count <= 65_536 else { throw ScreenCommunitySocketError.malformed }; return try exactly(count)
    }
    static func write(_ bytes: Data, fd: Int32) throws {
        guard !bytes.isEmpty, bytes.count <= 65_536 else { throw ScreenCommunitySocketError.malformed }
        let count = UInt32(bytes.count)
        let frame = Data([UInt8((count >> 24) & 255), UInt8((count >> 16) & 255), UInt8((count >> 8) & 255), UInt8(count & 255)]) + bytes
        var offset = 0
        while offset < frame.count {
            let n = frame.withUnsafeBytes { Darwin.send(fd, $0.baseAddress! + offset, frame.count - offset, 0) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw ScreenCommunitySocketError.unavailable }; offset += n
        }
    }
}

/// Screen alone creates the listener. It accepts only the signed Viewer and only one bounded request per socket.
/// The handler's registration allowlist contains no session, capture, input, arbitrary signature or shell operation.
public final class ScreenCommunitySocketServer: @unchecked Sendable {
    private let fd: Int32
    private let inode: ino_t
    private let handler: @Sendable (Data) async throws -> Data
    private let capacity = DispatchSemaphore(value: 8)
    public init(handler: @escaping @Sendable (Data) async throws -> Data) throws {
        self.handler = handler
        let path = ScreenCommunitySocket.path, parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        if mkdir(parent, 0o700) != 0 && errno != EEXIST { throw ScreenCommunitySocketError.unsafePath }
        var info = stat()
        guard lstat(parent, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFDIR, info.st_mode & 0o077 == 0 else { throw ScreenCommunitySocketError.unsafePath }
        if lstat(path, &info) == 0 {
            guard info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFSOCK else { throw ScreenCommunitySocketError.unsafePath }
            let old = socket(AF_UNIX, SOCK_STREAM, 0); guard old >= 0 else { throw ScreenCommunitySocketError.unavailable }
            var address = try ScreenCommunitySocket.address(path)
            let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(old, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            let failure = errno; Darwin.close(old)
            guard result != 0, failure == ECONNREFUSED else { throw ScreenCommunitySocketError.alreadyRunning }
            var again = stat(); guard lstat(path, &again) == 0, again.st_ino == info.st_ino else { throw ScreenCommunitySocketError.unsafePath }
            guard unlink(path) == 0 else { throw ScreenCommunitySocketError.unsafePath }
        } else if errno != ENOENT { throw ScreenCommunitySocketError.unsafePath }
        let server = socket(AF_UNIX, SOCK_STREAM, 0); guard server >= 0 else { throw ScreenCommunitySocketError.unavailable }
        ScreenCommunitySocket.configure(server, timeoutEnabled: false)
        var address = try ScreenCommunitySocket.address(path)
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard bound == 0, chmod(path, 0o600) == 0, listen(server, 8) == 0, lstat(path, &info) == 0 else { Darwin.close(server); throw ScreenCommunitySocketError.unavailable }
        fd = server; inode = info.st_ino
    }
    public func run() async {
        await withCheckedContinuation { continuation in
          DispatchQueue.global(qos: .utility).async { [self] in
            while !Task.isCancelled {
                let client = accept(fd, nil, nil)
                guard client >= 0 else { if errno == EINTR { continue }; break }
                guard capacity.wait(timeout: .now()) == .success else { Darwin.close(client); continue }
                ScreenCommunitySocket.configure(client)
                Task.detached { [self] in
                    defer { Darwin.close(client); capacity.signal() }
                    do {
                        try ScreenCommunityPeerCheck.require(.viewer, fd: client)
                        let request = try ScreenCommunitySocket.read(fd: client)
                        guard request.count <= 32_768 else { throw ScreenCommunitySocketError.malformed }
                        try await ScreenCommunitySocket.write(handler(request), fd: client)
                    } catch { /* Close without disclosing a peer's keychain or request. */ }
                }
            }
            continuation.resume()
          }
        }
    }
    deinit {
        Darwin.close(fd)
        var info = stat()
        if lstat(ScreenCommunitySocket.path, &info) == 0, info.st_ino == inode { _ = unlink(ScreenCommunitySocket.path) }
    }
}
#endif
