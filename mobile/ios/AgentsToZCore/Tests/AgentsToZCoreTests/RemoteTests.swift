import Foundation
#if !CORE_CHECKS
@testable import AgentsToZCore
#endif

struct RemoteRegressionChecks {
    private let token = String(repeating: "a", count: 43)
    func testConnectionGuidanceKeepsAddressAndQRRecoveryDistinct() throws {
        for https in [false, true] {
            let notice = ConnectionInputGuidance.failure(addressField: true, httpsInput: https,
                fallback: RemoteFailure.invalidQR.errorDescription)
            try checkTrue(notice.contains("https://"))
            try checkTrue(notice.contains("전체를 붙여"))
            try checkFalse(notice.contains("같은 Wi-Fi 연결 QR"))
        }
        try checkEqual(ConnectionInputGuidance.failure(addressField: false, httpsInput: false,
            fallback: RemoteFailure.invalidQR.errorDescription), RemoteFailure.invalidQR.errorDescription!)
        try checkTrue(ConnectionInputGuidance.failure(addressField: false, httpsInput: true, fallback: nil).contains("인터넷 연결 QR"))
        try checkTrue(ConnectionInputGuidance.introduction(isMacCompatible: true).contains("다른 컴퓨터"))
        try checkTrue(ConnectionInputGuidance.introduction(isMacCompatible: true).contains("연결한 컴퓨터에서"))
        try checkFalse(ConnectionInputGuidance.introduction(isMacCompatible: false).contains("모바일"))
    }
    func testInspectionIsLimitedToNamedTestChannels() throws {
        for channel in ["testflight", "development", "usb-development"] {
            try checkTrue(WorkroomInspectionPolicy.permits(releaseChannel: channel))
        }
        for channel in [nil, "", "app-store", "production", "release", "USB-Development", " usb-development"] {
            try checkFalse(WorkroomInspectionPolicy.permits(releaseChannel: channel))
        }
    }
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
func checkEqual<T: Equatable>(_ actual: T, _ expected: T, line: Int = #line) throws { if actual != expected { throw CheckFailure.failed("Unexpected value (line \(line))") } }
func checkFalse(_ value: Bool, line: Int = #line) throws { if value { throw CheckFailure.failed("Unexpected true (line \(line))") } }
func checkTrue(_ value: Bool, line: Int = #line) throws { if !value { throw CheckFailure.failed("Unexpected false (line \(line))") } }
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
        let ready = #"{"type":"session.restored","protocolVersion":"agentstoz-local-v9"}"#
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
    /// The Mac puts its Supabase project inside the QR's pair payload; the app opens the bundled
    /// portal only with a well-formed https project and a public-looking key.
    func testQRCarriesBundledPortalConfig() throws {
        func fragment(_ object: [String: Any]) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: object)
            return "pair=" + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl"
        let base: [String: Any] = ["schemaVersion": 1, "hostId": "host_abcdefgh"]
        let with = try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/#" + fragment(base.merging(["supabase": ["url": "https://abc.supabase.co", "anonKey": key]]) { $1 }))
        try checkEqual(with.bundledPortal?.supabaseUrl, "https://abc.supabase.co")
        try checkEqual(with.bundledPortal?.portalOrigin, "https://portal.example.com")
        try checkEqual(with.bundledPortal?.pageURL(fragment: "pair=x")?.absoluteString, "agentstoz-app://portal/remote/#pair=x")
        try checkTrue(try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/#" + fragment(base)).bundledPortal == nil)
        for bad: [String: Any] in [["url": "http://abc.supabase.co", "anonKey": key], ["url": "https://abc.supabase.co/rest", "anonKey": key],
                                   ["url": "https://abc.supabase.co", "anonKey": "short"], ["url": "https://abc.supabase.co", "anonKey": key, "x": 1]] {
            try checkTrue(try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/#" + fragment(base.merging(["supabase": bad]) { $1 })).bundledPortal == nil)
        }
    }
    /// 「폰 연결 링크」: the same golden table as tests/phone-connect-link.test.ts. A link sets up the
    /// data connection only; it must never parse as a QR and never carry a non-public key.
    func testPhoneConnectLinkMatchesTheSharedGoldenTable() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/phone-connect-link-golden.json")
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any]
        guard let rows = object?["parse"] as? [[String: Any]], rows.count >= 20 else { throw CheckFailure.failed("golden table missing") }
        for row in rows {
            let name = row["name"] as? String ?? "?"
            guard let text = row["text"] as? String, let expect = row["expect"] as? [String: Any] else { throw CheckFailure.failed(name) }
            let parsed = PhoneConnectLink.extract(from: text).flatMap { try? PhoneConnectLink(link: $0) }
            if expect["ok"] as? Bool == true {
                guard let parsed else { throw CheckFailure.failed("should accept: " + name) }
                guard parsed.portalOrigin == expect["portalOrigin"] as? String, parsed.supabaseUrl == expect["supabaseUrl"] as? String,
                      parsed.anonKey == expect["anonKey"] as? String, parsed.hostName == expect["hostName"] as? String,
                      parsed.bundledPortal != nil else { throw CheckFailure.failed("wrong value: " + name) }
            } else if parsed != nil {
                throw CheckFailure.failed("should reject: " + name)
            }
            // A link is never a pairing QR, whatever it contains.
            if text.contains("agentstoz://") {
                try checkThrows(try LANPairing(scanned: text), name)
                try checkThrows(try InternetWorkroomAddress(scanned: text), name)
            }
        }
    }
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

    /// The share extension writes, the app reads: an item is whole or absent, bounded, and expires.
    func testVocShareOutboxIsAtomicBoundedAndExpiring() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("voc-outbox-check-" + UUID().uuidString, isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let outbox = VocShareOutbox(root: root)
        let jpeg = VocShareEncodedImage(data: Data([0xFF, 0xD8, 0xFF, 0xD9]), width: 2, height: 1)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try checkThrows(try outbox.save(comment: "x", images: [], now: now))
        try checkThrows(try outbox.save(comment: "x", images: Array(repeating: jpeg, count: 6), now: now))
        let big = VocShareEncodedImage(data: Data(count: VocShareOutbox.maxTotalBytes / 2 + 1), width: 1, height: 1)
        try checkThrows(try outbox.save(comment: "x", images: [big, big], now: now))
        let item = try outbox.save(comment: "  버튼이 \"잘려\" 보여요 </script>\n", images: [jpeg, jpeg], now: now)
        try checkEqual(item.comment, "버튼이 \"잘려\" 보여요 </script>")
        try checkEqual(item.images.map(\.file), ["1.jpg", "2.jpg"])
        try checkEqual(outbox.pending(now: now), [item])
        // No temporary directory is left behind, and a half-written one is never listed.
        try checkEqual(try fm.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix(".") }, [])
        try fm.createDirectory(at: root.appendingPathComponent(".tmp-\(Int(now.timeIntervalSince1970))-" + UUID().uuidString.lowercased()), withIntermediateDirectories: false)
        try checkEqual(outbox.pending(now: now).count, 1)
        let detail = try outbox.eventDetail(for: item)
        try checkEqual(detail["id"] as? String, item.id)
        try checkEqual((detail["images"] as? [[String: Any]])?.first?["dataBase64"] as? String, "/9j/2Q==")
        let json = try JSONSerialization.data(withJSONObject: detail)
        try checkTrue(json.count > 0)
        // A malformed item (wrong id, or bytes that do not match) is dropped, not delivered.
        let bogus = root.appendingPathComponent(UUID().uuidString.lowercased(), isDirectory: true)
        try fm.createDirectory(at: bogus, withIntermediateDirectories: false)
        try Data("{}".utf8).write(to: bogus.appendingPathComponent("item.json"))
        try checkEqual(outbox.pending(now: now), [item])
        try checkFalse(fm.fileExists(atPath: bogus.path))
        // At most ten are kept (oldest dropped), and anything older than seven days expires.
        var saved: [VocShareItem] = []
        for offset in 1...11 { saved.append(try outbox.save(comment: "\(offset)", images: [jpeg], now: now.addingTimeInterval(Double(offset)))) }
        let kept = outbox.pending(now: now.addingTimeInterval(20))
        try checkEqual(kept.count, VocShareOutbox.maxItems)
        try checkEqual(kept.last, saved.last)
        try checkFalse(kept.contains(item))
        try checkEqual(outbox.pending(now: now.addingTimeInterval(VocShareOutbox.maxAge + 60)).count, 0)
        outbox.remove(id: "../escape")
        try checkEqual(try fm.contentsOfDirectory(atPath: root.path).filter { !$0.hasPrefix(".") }.count, 0)
    }
}

/// The app shell around the portal page (production audit 2026-10-16, track w5-ios).
extension RemoteRegressionChecks {
    /// Bookmarks, deploy/GitHub links and the voice key pages did nothing in the app: popups returned nil and every
    /// other navigation was cancelled. A link the person tapped goes to the system browser; the web view stays locked.
    func testExternalLinksLeaveOnlyFromThePortalOnUserActivation() throws {
        let portal = "https://portal.example.com"
        let bundled = BundledPortalConfig.pageOrigin
        let tappedNewWindow = WorkroomExternalLink.Request.navigation(linkActivated: true, newWindow: true)
        func target(_ value: String, origin: String = portal, request: WorkroomExternalLink.Request = tappedNewWindow, sealed: Bool = false) -> String? {
            WorkroomExternalLink.target(URL(string: value)!, origin: origin, request: request, sealed: sealed)?.absoluteString
        }
        try checkEqual(target("https://github.com/owner/repo"), "https://github.com/owner/repo")
        try checkEqual(target("https://github.com/owner/repo", request: .popup), "https://github.com/owner/repo")
        try checkEqual(target("http://192.168.1.5:5173/"), "http://192.168.1.5:5173/")
        try checkEqual(target("https://aistudio.google.com/apikey", origin: bundled), "https://aistudio.google.com/apikey")
        // Only what WebKit's popup gate lets through may leave: a popup, or a new-window (`target=_blank`) link. WebKit
        // reports a main-frame link as `.linkActivated` even for a scripted `a.click()` with no gesture (macOS WebKit probe,
        // 2026-10-16), so a main-frame link never leaves; nor does any navigation that is not a link activation.
        try checkEqual(target("https://example.com/deploy", request: .navigation(linkActivated: true, newWindow: false)), nil)
        try checkEqual(target("https://github.com/owner/repo", request: .navigation(linkActivated: false, newWindow: true)), nil)
        try checkEqual(target("https://github.com/owner/repo", request: .navigation(linkActivated: false, newWindow: false)), nil)
        // The same-network page stays sealed: anyone on that network could have served it.
        try checkEqual(target("https://github.com/owner/repo", origin: "http://192.168.1.2:43123", sealed: true), nil)
        for value in ["javascript:alert(1)", "tel:0101234", "mailto:a@example.com", "file:///etc/passwd", "agentstoz-app://portal/x",
                      "agentstoz://connect#abc", "https://user:secret@github.com/", "https:///nohost", "data:text/html,x"] {
            try checkEqual(target(value), nil)
        }
        // The workspace documents themselves are not external.
        try checkEqual(target(portal + "/remote/"), nil)
        try checkEqual(target(bundled + "/remote/", origin: bundled), nil)
        try checkEqual(target("https://github.com/" + String(repeating: "a", count: 8200)), nil)
    }

    /// The single saved slot was overwritten the moment a new connection was created, and a same-network QR replaced
    /// the internet workspace for good. A connection is saved only once its page loaded, and a LAN workspace sits
    /// beside the internet one instead of replacing it.
    func testSavedWorkspacesKeepTheInternetWorkspaceBesideALANOne() throws {
        let key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl"
        let config = BundledPortalConfig(portalOrigin: "https://portal.example.com", supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: key)!
        let lan = "http://192.168.1.20:43210", web = "https://other.example.com"
        let store = MemoryPreferenceStore()
        let saved = WorkroomSavedWorkspaces(store: store)
        try checkEqual(saved.resumeTarget, nil)
        saved.commit(.bundled(config))
        try checkEqual(saved.resumeTarget, .bundled(config))
        saved.commit(.lan(origin: lan))
        // The newest connection is the one reopened; the internet workspace is still there to go back to.
        try checkEqual(saved.resumeTarget, .lan(origin: lan))
        try checkEqual(saved.internet, .bundled(config))
        try checkEqual(saved.alternative(to: .lan(origin: lan)), .bundled(config))
        // A fresh read of the same preferences agrees (nothing lives only in memory).
        try checkEqual(WorkroomSavedWorkspaces(store: store).resumeTarget, .lan(origin: lan))
        saved.forget(.lan(origin: lan))
        try checkEqual(saved.resumeTarget, .bundled(config))
        try checkEqual(saved.lan, nil)
        // Web and bundled pages use separate WebKit stores. A data-only link must not hide the
        // previously paired web workspace, and switching back must keep the bundled sign-in.
        saved.commit(.web(origin: web))
        try checkEqual(saved.internet, .web(origin: web))
        try checkEqual(saved.alternative(to: .web(origin: web)), .bundled(config))
        saved.commit(.bundled(config))
        try checkEqual(saved.alternative(to: .bundled(config)), .web(origin: web))
        saved.commit(.lan(origin: lan))
        try checkEqual(saved.alternatives(to: .lan(origin: lan)), [.bundled(config), .web(origin: web)])
        try checkEqual(WorkroomSavedWorkspaces(store: store).resumeTarget, .lan(origin: lan))
        // Explicitly forgetting an inactive internet workspace leaves the other one and LAN intact.
        saved.forget(.web(origin: web))
        try checkEqual(saved.bundled, .bundled(config))
        try checkEqual(saved.resumeTarget, .lan(origin: lan))
        saved.forget(.lan(origin: lan))
        saved.commit(.web(origin: web))
        saved.forget(.web(origin: web))
        try checkEqual(saved.resumeTarget, .bundled(config))
        saved.forget(.bundled(config))
        try checkEqual(saved.resumeTarget, nil)

        // Preferences written by earlier builds: one pointer, either a LAN or a web origin, or a bundled config.
        let legacyLAN = MemoryPreferenceStore(["agentstoz.workroom.origin": lan])
        try checkEqual(WorkroomSavedWorkspaces(store: legacyLAN).resumeTarget, .lan(origin: lan))
        try checkEqual(WorkroomSavedWorkspaces(store: legacyLAN).internet, nil)
        let legacyWeb = MemoryPreferenceStore(["agentstoz.workroom.origin": web])
        try checkEqual(WorkroomSavedWorkspaces(store: legacyWeb).resumeTarget, .web(origin: web))
        let upgraded = WorkroomSavedWorkspaces(store: legacyLAN)
        upgraded.commit(.bundled(config))
        try checkEqual(upgraded.lan, .lan(origin: lan))
        try checkEqual(upgraded.resumeTarget, .bundled(config))
        try checkEqual(upgraded.legacyWebCandidate(for: .bundled(config)), .web(origin: config.portalOrigin))
        try checkEqual(upgraded.legacyWebCandidate(for: .web(origin: web)), nil)
        upgraded.commit(.web(origin: web))
        try checkEqual(upgraded.lan, .lan(origin: lan))
        try checkEqual(upgraded.bundled, .bundled(config))
        try checkEqual(upgraded.legacyWebCandidate(for: .bundled(config)), nil)
        // A stored address decides where the app connects: anything that does not re-validate is ignored.
        for bad in ["https://other.example.com/remote/x", "http://8.8.8.8:43210", "javascript:alert(1)", ""] {
            try checkEqual(WorkroomSavedWorkspaces(store: MemoryPreferenceStore(["agentstoz.workroom.origin": bad])).resumeTarget, nil)
            try checkEqual(WorkroomSavedWorkspaces(store: MemoryPreferenceStore(["agentstoz.workroom.lan": bad])).resumeTarget, nil)
        }
        // A typed portal address reuses the sign-in a link or QR already set up for that portal.
        let typed = try InternetWorkroomAddress(portalInput: "https://portal.example.com")
        try checkEqual(WorkroomSavedWorkspaces(store: MemoryPreferenceStore(["agentstoz.workroom.origin": lan])).bundledReuse(for: typed), nil)
        try checkEqual(upgraded.bundledReuse(for: typed), config)
        try checkEqual(upgraded.bundledReuse(for: try InternetWorkroomAddress(portalInput: "https://other.example.com")), nil)
        // A pairing QR keeps its own fragment and is never silently redirected.
        try checkEqual(upgraded.bundledReuse(for: try InternetWorkroomAddress(scanned: "https://portal.example.com/remote/#pair=" + token)), nil)
        // The first screen and the connection sheet name a saved workspace by what tells two apart.
        try checkEqual(SavedWorkspace.bundled(config).hostLabel, "portal.example.com · abc.supabase.co")
        try checkEqual(SavedWorkspace.web(origin: web).hostLabel, "other.example.com")
        try checkEqual(SavedWorkspace.lan(origin: lan).hostLabel, "192.168.1.20:43210")
    }

    /// iOS reclaims the page's WebContent process after an app switch. That showed a failure with network advice; the
    /// app now reloads on its own, at most once a minute, before admitting a failure.
    func testContentProcessReloadIsBoundedToOncePerMinute() throws {
        let now = Date(timeIntervalSince1970: 2_000_000)
        try checkTrue(WorkroomContentRecovery.mayReload(lastReload: nil, now: now))
        try checkFalse(WorkroomContentRecovery.mayReload(lastReload: now.addingTimeInterval(-30), now: now))
        try checkTrue(WorkroomContentRecovery.mayReload(lastReload: now.addingTimeInterval(-61), now: now))
        // A page that keeps dying after it loaded: it was reloaded once already, and 「다시 연결」 reopens the same connection.
        let repeated = WorkroomContentRecovery.failureMessage(loaded: true)
        try checkTrue(repeated.contains("반복")); try checkTrue(repeated.contains("같은 연결로 다시 엽니다"))
        // Review 2026-10-16: a page that died before its first load died once, and 「다시 연결」 drops a QR's one-use
        // fragment, so neither "repeatedly" nor "the same connection" is true there.
        let early = WorkroomContentRecovery.failureMessage(loaded: false)
        try checkFalse(early.contains("반복")); try checkFalse(early.contains("같은 연결로 다시 엽니다")); try checkTrue(early.contains("QR"))
        for message in [repeated, early, WorkroomContentRecovery.signInCancelledMessage] { try checkFalse(message.contains("인터넷")) }
        try checkTrue(WorkroomContentRecovery.signInCancelledMessage.contains("로그인"))
    }

    /// 「이 앱의 연결 정보 지우기」 said it deleted what it had not. The report says what actually happened.
    func testWipeReportTellsTheRealOutcome() throws {
        let done = WorkroomWipeReport(local: .removed, macsConfirmed: true).message
        try checkTrue(done.contains("지웠습니다")); try checkFalse(done.contains("확인하지 못했습니다"))
        let cleared = WorkroomWipeReport(local: .cleared, macsConfirmed: false).message
        try checkTrue(cleared.contains("지웠습니다")); try checkTrue(cleared.contains("확인하지 못했습니다"))
        let timedOut = WorkroomWipeReport(local: .removed, macsConfirmed: nil).message
        try checkTrue(timedOut.contains("확인하지 못했습니다"))
        let failed = WorkroomWipeReport(local: .failed, macsConfirmed: true).message
        try checkFalse(failed.contains("지웠습니다")); try checkTrue(failed.contains("지우지 못했습니다"))
        try checkEqual(WorkroomWipeReport.Local.from(removed: true, remainingRecords: 3), .removed)
        try checkEqual(WorkroomWipeReport.Local.from(removed: false, remainingRecords: 0), .cleared)
        try checkEqual(WorkroomWipeReport.Local.from(removed: false, remainingRecords: 2), .failed)
        try checkEqual(WorkroomWipeReport.Local.from(removed: false, remainingRecords: nil), .failed)
    }

    /// The settings sheet showed the internal page origin; a self-hosted Supabase was accepted by the link and QR but
    /// blocked by the bundled page's own meta CSP and by the native sign-in check.
    func testBundledPortalNamesItsHostsAndServesItsOwnProject() throws {
        let key = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl"
        let hosted = BundledPortalConfig(portalOrigin: "https://portal.example.com", supabaseUrl: "https://abc.supabase.co", supabaseAnonKey: key)!
        let selfHosted = BundledPortalConfig(portalOrigin: "https://portal.example.com", supabaseUrl: "https://db.example.org", supabaseAnonKey: key)!
        try checkEqual(hosted.portalHost, "portal.example.com")
        try checkEqual(hosted.supabaseHost, "abc.supabase.co")
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let page = try String(contentsOf: root.appendingPathComponent("remote/index.html"), encoding: .utf8)
        try checkTrue(page.contains("connect-src 'self' https://*.supabase.co wss://*.supabase.co;"))
        try checkEqual(selfHosted.servedHTML(page) == page, false)
        try checkTrue(selfHosted.servedHTML(page).contains("connect-src 'self' https://*.supabase.co wss://*.supabase.co https://db.example.org wss://db.example.org;"))
        try checkEqual(selfHosted.servedHTML(page).replacingOccurrences(of: " https://db.example.org wss://db.example.org", with: ""), page)
        try checkEqual(hosted.servedHTML(page), page)
        try checkEqual(selfHosted.servedHTML("<html>no policy</html>"), "<html>no policy</html>")

        let state = String(repeating: "s", count: 43)
        var authorize = URLComponents(string: "https://db.example.org/auth/v1/authorize")!
        authorize.queryItems = [URLQueryItem(name: "provider", value: "google"),
            URLQueryItem(name: "redirect_to", value: NativeOAuthRequest.callback(state: state)),
            URLQueryItem(name: "code_challenge", value: token), URLQueryItem(name: "code_challenge_method", value: "s256")]
        let url = authorize.url!.absoluteString
        try checkThrows(try NativeOAuthRequest(authorizationURL: url, state: state))
        _ = try NativeOAuthRequest(authorizationURL: url, state: state, projectHost: selfHosted.supabaseHost)
        try checkThrows(try NativeOAuthRequest(authorizationURL: url.replacingOccurrences(of: "db.example.org", with: "evil.example.org"), state: state, projectHost: selfHosted.supabaseHost))
        try checkThrows(try NativeOAuthRequest(authorizationURL: url.replacingOccurrences(of: "db.example.org", with: "db.example.org.evil.test"), state: state, projectHost: selfHosted.supabaseHost))
    }
}

/// A dictionary standing in for UserDefaults.
final class MemoryPreferenceStore: WorkroomPreferenceStore, @unchecked Sendable {
    var values: [String: Any]
    init(_ values: [String: Any] = [:]) { self.values = values }
    func string(forKey key: String) -> String? { values[key] as? String }
    func data(forKey key: String) -> Data? { values[key] as? Data }
    func set(_ value: Any?, forKey key: String) { values[key] = value }
    func removeObject(forKey key: String) { values[key] = nil }
}

#if CORE_CHECKS
@main struct CoreChecksMain {
    static func main() async throws {
        let suite = RemoteRegressionChecks()
        try suite.testConnectionGuidanceKeepsAddressAndQRRecoveryDistinct()
        try suite.testInspectionIsLimitedToNamedTestChannels()
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
        try suite.testQRCarriesBundledPortalConfig()
        try suite.testPhoneConnectLinkMatchesTheSharedGoldenTable()
        try await suite.testSuspendKeepsTheSessionAndDisconnectForgetsIt()
        try suite.testVocShareOutboxIsAtomicBoundedAndExpiring()
        try suite.testExternalLinksLeaveOnlyFromThePortalOnUserActivation()
        try suite.testSavedWorkspacesKeepTheInternetWorkspaceBesideALANOne()
        try suite.testContentProcessReloadIsBoundedToOncePerMinute()
        try suite.testWipeReportTellsTheRealOutcome()
        try suite.testBundledPortalNamesItsHostsAndServesItsOwnProject()
        print("21 native regression groups passed")
    }
}
#else
import XCTest
final class RemoteTests: XCTestCase {
    func testNativeContract() async throws {
        let suite = RemoteRegressionChecks()
        try suite.testConnectionGuidanceKeepsAddressAndQRRecoveryDistinct()
        try suite.testInspectionIsLimitedToNamedTestChannels()
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
        try suite.testQRCarriesBundledPortalConfig()
        try suite.testPhoneConnectLinkMatchesTheSharedGoldenTable()
        try await suite.testSuspendKeepsTheSessionAndDisconnectForgetsIt()
        try suite.testVocShareOutboxIsAtomicBoundedAndExpiring()
        try suite.testExternalLinksLeaveOnlyFromThePortalOnUserActivation()
        try suite.testSavedWorkspacesKeepTheInternetWorkspaceBesideALANOne()
        try suite.testContentProcessReloadIsBoundedToOncePerMinute()
        try suite.testWipeReportTellsTheRealOutcome()
        try suite.testBundledPortalNamesItsHostsAndServesItsOwnProject()
    }
}
#endif
