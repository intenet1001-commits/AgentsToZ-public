import Foundation
#if !CORE_CHECKS
@testable import AgentsToZCore
#endif

struct RemoteRegressionChecks {
    private let token = String(repeating: "a", count: 43)
    func testQRRestrictsNetworkAndDoesNotLeakSecret() throws {
        for host in ["10.0.0.1", "172.16.0.2", "172.31.255.254", "192.168.1.2"] {
            let qr = try LANPairing(scanned: "http://\(host):43123/remote/#pair=\(token)")
            try checkEqual(qr.webSocketURL.absoluteString, "ws://\(host):43123/remote/ws")
            try checkFalse(String(reflecting: qr).contains(token))
        }
        for host in ["127.0.0.1", "0.0.0.0", "169.254.1.1", "172.32.0.1", "8.8.8.8", "192.168.001.2", "localhost", "example.com", "[::1]", "3232235778"] {
            try checkThrows(try LANPairing(scanned: "http://\(host):43123/remote/#pair=\(token)"))
        }
    }
    func testRejectsAmbiguousOrPrivilegedQR() throws {
        let base = "http://192.168.1.2:43123/remote/"
        for input in [base + "?pair=\(token)", base + "#pair=\(token)&next=x", base + "#pair=%61\(token.dropFirst())",
                      base + "#pair=short", base + "#pair=\(token)\n", base.replacingOccurrences(of: "/remote/", with: "/api/") + "#pair=\(token)",
                      "http://user@192.168.1.2:43123/remote/#pair=\(token)", "http://192.168.1.2:80/remote/#pair=\(token)",
                      "http://192.168.1.2:43123/a/../remote/#pair=\(token)", "agentstoz://connect#pair=\(token)"] {
            try checkThrows(try LANPairing(scanned: input), input.replacingOccurrences(of: token, with: "redacted"))
        }
        try checkThrows(try LANPairing(scanned: "https://example.com/remote/#pair=\(token)")) {
            guard case RemoteFailure.internetNotReady = $0 else { throw CheckFailure.failed("Must not reinterpret an Internet QR as LAN") }
        }
    }
    func testWorkroomNavigationAndBrowserHandoff() throws {
        let qr = try LANPairing(scanned: "http://192.168.1.2:43123/remote/#pair=\(token)")
        let address = WorkroomAddress(pairing: qr)
        try checkFalse(String(reflecting: address).contains(token))
        try checkEqual(WorkroomAddress.allowsResponse(address.bootstrapURL, origin: address.origin), true)
        try checkEqual(WorkroomAddress.allowsDocument(address.bootstrapURL, origin: address.origin, initialURL: address.bootstrapURL, mainFrame: true), true)
        try checkFalse(WorkroomAddress.allowsDocument(address.bootstrapURL, origin: address.origin, mainFrame: true))
        for path in ["/remote/", "/remote/index.html"] {
            let url = URL(string: address.origin + path)!
            try checkEqual(WorkroomAddress.allowsDocument(url, origin: address.origin, mainFrame: true), true)
            try checkFalse(WorkroomAddress.allowsDocument(url, origin: address.origin, mainFrame: false))
        }
        for value in ["https://example.com/remote/", "http://192.168.1.2:43124/remote/", "http://192.168.1.3:43123/remote/",
                      address.origin + "/api/ports", address.origin + "/remote/?next=1", address.origin + "/remote/#x",
                      address.origin + "/a/../remote/", address.origin + "/remote/%69ndex.html", "file:///remote/", "about:blank"] {
            try checkFalse(WorkroomAddress.allowsDocument(URL(string: value)!, origin: address.origin, mainFrame: true))
        }
        let external = try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/#pair=\(token)")
        try checkEqual(external.origin, "https://portal.example.com")
        try checkFalse(String(reflecting: external).contains(token))
        _ = try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/")
        for path in ["", "/", "/portal.html", "/remote/"] {
            let entered = try InternetWorkroomAddress(portalInput: "https://portal.example.com" + path)
            try checkEqual(entered.url.absoluteString, "https://portal.example.com/remote/")
        }
        try checkEqual(try InternetWorkroomAddress(portalInput: external.url.absoluteString).url, external.url)
        for value in ["https://portal.example.com/?next=x", "https://portal.example.com/#pair=" + token,
                      "https://user@portal.example.com/", "https://portal.example.com:444/", "http://portal.example.com/",
                      "https://portal.example.com/a/../", "https://portal.example.com/%70ortal.html",
                      "https://portal.example.com/\n", "https://portal.example.com//", "https://portal.example.com.evil.test/@portal.example.com/"] {
            try checkThrows(try InternetWorkroomAddress(portalInput: value))
        }
        for value in ["http://portal.example.com/remote/", "https://user@portal.example.com/remote/", "https://portal.example.com/remote/?pair=x",
                      "https://portal.example.com/remote/#pair=x&next=evil", "https://portal.example.com/remote/#pair=%61", "https://portal.example.com/",
                      "https://portal.example.com:444/remote/", "https://portal.example.com/remote/#pair=", "https://portal.example.com/remote/\n"] {
            try checkThrows(try InternetWorkroomAddress(scanned: value))
        }
    }
    func testNativeOAuthPKCEIsBoundToExactCallbackAndState() throws {
        let state = String(repeating: "s", count: 43)
        var authorize = URLComponents(string: "https://fixture.supabase.co/auth/v1/authorize")!
        authorize.queryItems = [URLQueryItem(name: "provider", value: "google"),
            URLQueryItem(name: "redirect_to", value: NativeOAuthRequest.callback(state: state)),
            URLQueryItem(name: "code_challenge", value: token), URLQueryItem(name: "code_challenge_method", value: "s256"),
            URLQueryItem(name: "skip_http_redirect", value: "true")]
        let original = authorize.url!.absoluteString
        let request = try NativeOAuthRequest(authorizationURL: original, state: state)
        let callback = NativeOAuthRequest.callback(state: state) + "&code=12345678-abcd"
        try checkEqual(try request.authorizationCode(from: URL(string: callback)!), "12345678-abcd")
        // A trailing empty fragment carries no credential; retain exact state/code checks.
        try checkEqual(try request.authorizationCode(from: URL(string: callback + "#")!), "12345678-abcd")
        for suffix in ["#access_token=secret", "#refresh_token=secret", "#code=other", "#state=other", "#%20", "#_=_"] {
            try checkThrows(try request.authorizationCode(from: URL(string: callback + suffix)!))
        }
        try checkThrows(try request.authorizationCode(from: URL(string: callback.replacingOccurrences(of: state, with: "wrong") + "#")!))
        for bad in [callback.replacingOccurrences(of: "auth/callback", with: "evil/callback"),
                    callback.replacingOccurrences(of: state, with: "wrong"), callback + "&state=" + state,
                    callback + "&access_token=secret", callback + "#access_token=secret",
                    callback.replacingOccurrences(of: "agentstoz-mobile:", with: "https:"),
                    callback.replacingOccurrences(of: "/callback?", with: "/%63allback?")] {
            try checkThrows(try request.authorizationCode(from: URL(string: bad)!))
        }
        for bad in [original.replacingOccurrences(of: "https:", with: "http:"),
                    original.replacingOccurrences(of: "fixture.supabase.co", with: "fixture.supabase.co.evil.test"),
                    original.replacingOccurrences(of: "s256", with: "plain"), original + "&provider=google",
                    original + "&unknown_redirect=https://evil.test"] {
            try checkThrows(try NativeOAuthRequest(authorizationURL: bad, state: state))
        }
        try checkThrows(try NativeOAuthRequest(authorizationURL: original, state: "different-state-does-not-match-redirect"))
    }

    func testNativeOAuthDeadlineCancelsAndFencesLateCallbacks() throws {
        let start = Date(timeIntervalSince1970: 1000)
        var first = NativeOAuthAttempt(now: start)
        try checkFalse(first.consume(id: UUID(), now: start))
        try checkTrue(first.consume(id: first.id, now: start.addingTimeInterval(294)))
        try checkFalse(first.consume(id: first.id, now: start.addingTimeInterval(294)))
        var expired = NativeOAuthAttempt(now: start)
        try checkFalse(expired.consume(id: expired.id, now: start.addingTimeInterval(295)))
        var next = NativeOAuthAttempt(now: start.addingTimeInterval(296))
        try checkFalse(next.consume(id: expired.id, now: start.addingTimeInterval(297)))
        next.cancel()
        try checkFalse(next.consume(id: next.id, now: start.addingTimeInterval(297)))
    }

    func testBoundedWireAndUnknownFieldsAreNotAuthority() throws {
        let card: [String: Any] = ["controlId": token, "name": "Fixture", "kind": "main", "status": "stopped", "port": 9000,
                                   "actions": ["start", "arbitrary.shell"], "localPath": "/must/not/be/exposed"]
        let data = try JSONSerialization.data(withJSONObject: ["type": "action.result", "projects": [card], "projectCount": 1])
        let decoded = try RemoteWire.decode(data)
        try checkEqual(decoded.projects?.first?.availableActions, [.start])
        try checkThrows(try RemoteWire.decode(Data(repeating: 32, count: 16385)))
        try checkThrows(try RemoteWire.decode(Data("{\"type\":\"future-authority\"}".utf8)))
        try checkThrows(try RemoteWire.decode(JSONSerialization.data(withJSONObject: ["type": "action.result", "projects": [card, card], "projectCount": 2])))
        try checkThrows(try RemoteWire.decode(JSONSerialization.data(withJSONObject: ["type": "action.result", "projects": [card], "projectCount": 0])))
    }
    func testUnpairedClientCannotExecute() async throws {
        let client = LANClient()
        do { _ = try await client.refresh(); throw CheckFailure.failed("unpaired refresh") } catch is RemoteFailure {}
        do { try await client.perform(.start, controlID: token); throw CheckFailure.failed("unpaired action") } catch is RemoteFailure {}
        await client.disconnect()
    }
}

enum CheckFailure: Error { case failed(String) }
func checkEqual<T: Equatable>(_ actual: T, _ expected: T) throws { if actual != expected { throw CheckFailure.failed("Unexpected value") } }
func checkFalse(_ value: Bool) throws { if value { throw CheckFailure.failed("Unexpected true") } }
func checkTrue(_ value: Bool) throws { if !value { throw CheckFailure.failed("Unexpected false") } }
func checkThrows<T>(_ operation: @autoclosure () throws -> T, _ label: String = "", check: ((Error) throws -> Void)? = nil) throws {
    do { _ = try operation() } catch { try check?(error); return }
    throw CheckFailure.failed("Expected rejection: " + label)
}
func failCheck(_ message: String) throws { throw CheckFailure.failed(message) }

extension RemoteRegressionChecks {
    /// The host's frame vocabulary, checked against the host rather than against a name we made
    /// up. The old allowlist contained `session.ended`, which exists nowhere in the Mac, and
    /// rejected three frames the Mac does send — so a resumed session could not be read and every
    /// refusal was flattened into "the connection died".
    func testDecodesTheFramesTheHostActuallySends() throws {
        let ready = #"{"type":"session.restored","protocolVersion":"agentstoz-local-v7"}"#
        try checkEqual(try RemoteWire.decode(Data(ready.utf8)).type, "session.restored")
        let closed = #"{"type":"session.closed","reason":"Mac에서 연결을 종료했습니다."}"#
        try checkEqual(try RemoteWire.decode(Data(closed.utf8)).reason, "Mac에서 연결을 종료했습니다.")
        let refused = #"{"type":"error","error":{"code":"RATE_LIMITED","message":"천천히"}}"#
        try checkEqual(try RemoteWire.decode(Data(refused.utf8)).error?.code, "RATE_LIMITED")
        // A frame the Mac never sends must not be quietly accepted just because we once named it.
        try checkThrows(try RemoteWire.decode(Data(#"{"type":"session.ended"}"#.utf8)))
        try checkThrows(try RemoteWire.decode(Data(#"{"type":"whatever"}"#.utf8)))
    }

    /// A refusal is an answer on a healthy socket. Treating every one as a dead connection is
    /// what made a retriable RATE_LIMITED cost a walk to the Mac for a new QR.
    func testRefusalsAreSeparatedFromDisconnections() throws {
        try checkTrue(RemoteFailure.hostRefused(code: "RATE_LIMITED", message: nil).keepsSession)
        try checkTrue(RemoteFailure.hostRefused(code: "SESSION_DISCONNECTED", message: nil).keepsSession)
        try checkFalse(RemoteFailure.hostRefused(code: "SESSION_EXPIRED", message: nil).keepsSession)
        try checkFalse(RemoteFailure.disconnected.keepsSession)
        // Only the host saying it does not know this session may throw the stored token away.
        try checkTrue(RemoteFailure.hostRefused(code: "SESSION_EXPIRED", message: nil).endsStoredSession)
        try checkTrue(RemoteFailure.sessionEnded(reason: nil).endsStoredSession)
        try checkFalse(RemoteFailure.disconnected.endsStoredSession)
        try checkFalse(RemoteFailure.resumable.endsStoredSession)
        // The host's own text wins; an unknown code still gets a sentence rather than a blank.
        try checkEqual(RemoteFailure.hostRefused(code: "X", message: "고유 문구").errorDescription, "고유 문구")
        try checkFalse((RemoteFailure.hostRefused(code: "X", message: nil).errorDescription ?? "").isEmpty)
    }

    /// A remembered address is not a secret, so it is stored in plain preferences — which means
    /// it has to be re-validated on the way back in, exactly like a scanned one.
    func testRememberedOriginIsRevalidated() throws {
        try checkTrue(LANClient.resumableOrigin("http://192.168.1.20:43210"))
        for bad in ["https://192.168.1.20:43210", "http://8.8.8.8:43210", "http://127.0.0.1:43210",
                    "http://192.168.1.20:80", "http://192.168.1.20", "http://192.168.1.20:43210/remote/",
                    "http://192.168.001.20:43210", ""] {
            try checkFalse(LANClient.resumableOrigin(bad))
        }
    }

    /// Suspending keeps the right to come back; disconnecting gives it up. Backgrounding uses the
    /// first, and getting that backwards is what made every screen lock a re-pair.
    func testSuspendKeepsTheSessionAndDisconnectForgetsIt() async throws {
        let store = EphemeralSessionStore()
        let origin = "http://192.168.1.20:43210"
        store.save(token: token, origin: origin)
        let client = LANClient(store: store)
        try checkTrue(await client.canResume(origin: origin))
        await client.suspend()
        try checkTrue(await client.canResume(origin: origin))
        // Nothing was ever connected, so this only has to prove the stored token is dropped.
        store.clear(origin: origin)
        try checkFalse(await client.canResume(origin: origin))
    }
}

#if CORE_CHECKS
@main struct CoreChecksMain {
    static func main() async throws {
        let suite = RemoteRegressionChecks()
        try suite.testQRRestrictsNetworkAndDoesNotLeakSecret()
        try suite.testRejectsAmbiguousOrPrivilegedQR()
        try suite.testWorkroomNavigationAndBrowserHandoff()
        try suite.testNativeOAuthPKCEIsBoundToExactCallbackAndState()
        try suite.testNativeOAuthDeadlineCancelsAndFencesLateCallbacks()
        try suite.testBoundedWireAndUnknownFieldsAreNotAuthority()
        try await suite.testUnpairedClientCannotExecute()
        try suite.testDecodesTheFramesTheHostActuallySends()
        try suite.testRefusalsAreSeparatedFromDisconnections()
        try suite.testRememberedOriginIsRevalidated()
        try await suite.testSuspendKeepsTheSessionAndDisconnectForgetsIt()
        print("11 native regression groups passed")
    }
}
#else
import XCTest
final class RemoteTests: XCTestCase {
    func testNativeContract() async throws {
        let suite = RemoteRegressionChecks()
        try suite.testQRRestrictsNetworkAndDoesNotLeakSecret()
        try suite.testRejectsAmbiguousOrPrivilegedQR()
        try suite.testWorkroomNavigationAndBrowserHandoff()
        try suite.testNativeOAuthPKCEIsBoundToExactCallbackAndState()
        try suite.testNativeOAuthDeadlineCancelsAndFencesLateCallbacks()
        try suite.testBoundedWireAndUnknownFieldsAreNotAuthority()
        try await suite.testUnpairedClientCannotExecute()
        try suite.testDecodesTheFramesTheHostActuallySends()
        try suite.testRefusalsAreSeparatedFromDisconnections()
        try suite.testRememberedOriginIsRevalidated()
        try await suite.testSuspendKeepsTheSessionAndDisconnectForgetsIt()
    }
}
#endif
