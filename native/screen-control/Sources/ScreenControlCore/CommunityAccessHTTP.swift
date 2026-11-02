import Foundation

private final class NoAccessRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
public struct CommunityAccessHTTP: Sendable {
    public let authority: ScreenCommunityAuthority
    public init(authority: ScreenCommunityAuthority) { self.authority = authority }
    public func send(_ envelope: ScreenCommunityEnvelope, requestId: String) async throws -> CommunityAccessReply {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false; configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.urlCredentialStorage = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 12; configuration.timeoutIntervalForResource = 15
        let session = URLSession(configuration: configuration, delegate: NoAccessRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: authority.origin.appending(path: "v2"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(envelope)
        guard request.httpBody!.count <= 32_768 else { throw ScreenCommunityError.malformed }
        let (stream, response) = try await session.bytes(for: request)
        guard let response = response as? HTTPURLResponse, response.url == request.url, [200, 400].contains(response.statusCode),
              response.mimeType == "application/json", response.expectedContentLength <= 70_000 else { throw ScreenCommunityError.service("UNAVAILABLE") }
        var body = Data()
        for try await byte in stream { guard body.count < 70_000 else { throw ScreenCommunityError.malformed }; body.append(byte) }
        return try CommunityAccessReply.verify(JSONDecoder().decode(ScreenCommunityEnvelope.self, from: body), authority: authority, requestId: requestId)
    }
}
