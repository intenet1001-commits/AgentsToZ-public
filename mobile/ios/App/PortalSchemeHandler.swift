import Foundation
import UniformTypeIdentifiers
import WebKit
import AgentsToZCore

/// Serves the portal bundled in the app (`App.app/web/…`) at `agentstoz-app://portal/…`.
///
/// A custom scheme rather than file:// or a loopback server: WebKit treats pages served by a
/// WKURLSchemeHandler as a secure context (WebCrypto, IndexedDB, camera/microphone), and the app
/// gets a stable origin of its own. The same approach is proven on device by the 통역사 app.
/// Pages get the web deployment's security headers; `connect-src` adds the QR's Supabase project,
/// since a self-hosted project need not live under *.supabase.co.
final class PortalSchemeHandler: NSObject, WKURLSchemeHandler {
    static var bundleRoot: URL? {
        guard let root = Bundle.main.url(forResource: "web", withExtension: nil),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("remote/index.html").path) else { return nil }
        return root
    }
    /// Builds without a bundled portal (the web folder is produced by a separate step) fall back to the web.
    static var isAvailable: Bool { bundleRoot != nil }

    private let root: URL
    private let contentSecurityPolicy: String

    init?(config: BundledPortalConfig) {
        guard let root = Self.bundleRoot else { return nil }
        self.root = root.standardizedFileURL
        let supabaseSocket = "wss://" + config.supabaseUrl.dropFirst("https://".count)
        contentSecurityPolicy = "default-src 'none'; script-src 'self' 'sha256-2Ikg1YRUrB38OfTDHWhzdUsw+Hqf9ulExv02Q73jsz8='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' https://*.supabase.co wss://*.supabase.co \(config.supabaseUrl) \(supabaseSocket); manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == BundledPortalConfig.host, let file = resolve(url.path),
              let data = try? Data(contentsOf: file) else {
            let body = Data("Not found".utf8)
            let url = task.request.url ?? URL(string: BundledPortalConfig.pageOrigin + "/")!
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1",
                                            headerFields: ["Content-Type": "text/plain; charset=utf-8", "Content-Length": "\(body.count)"])!)
            task.didReceive(body); task.didFinish(); return
        }
        var headers = [
            "Content-Type": Self.mimeType(for: file),
            "Content-Length": "\(data.count)",
            "X-Content-Type-Options": "nosniff",
            // index.html must never be stale after an app update; hashed assets can be cached.
            "Cache-Control": file.pathExtension == "html" ? "no-store" : "max-age=31536000, immutable",
        ]
        if file.pathExtension == "html" {
            headers["Content-Security-Policy"] = contentSecurityPolicy
            headers["Referrer-Policy"] = "no-referrer"
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Responses are delivered synchronously in start; nothing to cancel.
    }

    /// Maps a URL path to a file inside `root`; a directory serves its index.html. Paths that
    /// escape the root are rejected. No SPA fallback: the portal has fixed entry documents.
    private func resolve(_ path: String) -> URL? {
        let clean = path.removingPercentEncoding ?? path
        var candidate = root.appendingPathComponent(clean.isEmpty || clean == "/" ? "portal.html" : clean).standardizedFileURL
        guard candidate.path.hasPrefix(root.path + "/") else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) else { return nil }
        if isDirectory.boolValue {
            candidate.appendPathComponent("index.html")
            guard FileManager.default.fileExists(atPath: candidate.path) else { return nil }
        }
        return candidate
    }

    static func mimeType(for file: URL) -> String {
        switch file.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        case "wasm": return "application/wasm"
        default: return UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
