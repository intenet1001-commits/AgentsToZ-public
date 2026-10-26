import CryptoKit
import Foundation
import os

// Talking to the push relay (`supabase/functions/screen-push`), for the Mac and the phone alike (PushCommands.swift has
// the messages and why the relay is not trusted). Everything is OFF unless an endpoint is configured: with none, nothing
// is signed, sent or polled, and the phone never asks for notification permission (DESIGN 「알림·원격 차단」).

/// The relay's URL from the build: HTTPS, a host, no credentials, query or fragment. Anything else is no endpoint.
public struct PushEndpoint: Sendable, Equatable {
    public let url: URL

    public init?(_ text: String?) {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text.utf8.count <= 512,
              let components = URLComponents(string: text), components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil, let url = components.url else { return nil }
        self.url = url
    }
}

public protocol PushTransport: Sendable {
    func post(_ body: Data, to url: URL) async throws -> (status: Int, body: Data)
}

/// HTTPS POST with no cookies, cache or credential store, and a 15-second limit.
public struct URLSessionPushTransport: PushTransport {
    public init() {}

    public func post(_ body: Data, to url: URL) async throws -> (status: Int, body: Data) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await Self.session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }()
}

public enum PushClientError: Error, Equatable, Sendable {
    /// The relay refused: its error code (`not_ready`, `rate_limited`, `not_registered`, …).
    case rejected(status: Int, code: String)
    case malformedResponse
    /// The relay returned a result the pinned Mac did not sign. It is not believed.
    case unsignedResult
}

extension Data {
    var pushHex: String { map { String(format: "%02x", $0) }.joined() }
}

public struct ScreenPushClient: Sendable {
    public let endpoint: PushEndpoint?
    let transport: any PushTransport

    public init(endpoint: PushEndpoint?, transport: any PushTransport = URLSessionPushTransport()) {
        self.endpoint = endpoint
        self.transport = transport
    }

    public var isEnabled: Bool { endpoint != nil }

    private struct ErrorBody: Decodable { let error: String }
    private struct FetchBody: Decodable {
        struct Command: Decodable { let message: String; let signature: String }
        let commands: [Command]
    }
    private struct ResultBody: Decodable { let result: String? }

    private func post(_ fields: [String: String]) async throws -> Data {
        guard let endpoint else { throw PushClientError.rejected(status: 0, code: "not_configured") }
        let body = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
        let (status, data) = try await transport.post(body, to: endpoint.url)
        guard (200..<300).contains(status) else {
            let code = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "http_\(status)"
            throw PushClientError.rejected(status: status, code: String(code.prefix(64)))
        }
        return data
    }

    private func post(_ type: String, _ signed: SignedPushMessage) async throws -> Data {
        try await post(["type": type, "message": signed.message.base64EncodedString(), "signature": signed.signature.base64EncodedString()])
    }

    // MARK: Mac

    /// Asks the relay to tell the event's recipients. Returns false, having signed and sent nothing, without an endpoint.
    @discardableResult
    public func notify(_ event: ScreenEvent, signer: TranscriptSigner) async throws -> Bool {
        guard isEnabled else { return false }
        _ = try await post("notify", try await event.signed(by: signer))
        return true
    }

    /// The commands waiting for this Mac. Empty, having signed and sent nothing, without an endpoint.
    public func fetch(_ fetch: MacFetch, signer: TranscriptSigner) async throws -> [SignedPushMessage] {
        guard isEnabled else { return [] }
        let data = try await post("fetch", try await fetch.signed(by: signer))
        guard let body = try? JSONDecoder().decode(FetchBody.self, from: data) else { throw PushClientError.malformedResponse }
        return try body.commands.prefix(PushWire.maxDevices).map { command in
            guard let message = Data(base64Encoded: command.message), message.count <= 4096,
                  let signature = Data(base64Encoded: command.signature) else { throw PushClientError.malformedResponse }
            return SignedPushMessage(message: message, signature: signature)
        }
    }

    // MARK: Phone

    /// Asks the relay to push this Mac's events to this device. False without an endpoint.
    @discardableResult
    public func register(_ registration: PushRegistration, signer: TranscriptSigner) async throws -> Bool {
        guard isEnabled else { return false }
        _ = try await post("register", try await registration.signed(by: signer))
        return true
    }

    /// Stops pushes for this Mac to this device. Holding the token is the authority: only this app, Apple and the relay
    /// know it, so stopping needs no Face ID — and it only ever takes notifications away. False without an endpoint.
    @discardableResult
    public func unregister(macFingerprint: Data, deviceID: Data, token: Data) async throws -> Bool {
        guard isEnabled else { return false }
        _ = try await post(["type": "unregister", "macFingerprint": macFingerprint.pushHex, "deviceID": deviceID.pushHex,
                            "token": token.pushHex])
        return true
    }

    /// Queues a remote stop for the Mac. False without an endpoint.
    @discardableResult
    public func send(_ command: RemoteCommand, signer: TranscriptSigner) async throws -> Bool {
        guard isEnabled else { return false }
        _ = try await post("command", try await command.signed(by: signer))
        return true
    }

    /// The Mac's answer to a command: nil while there is none. An answer the pinned Mac did not sign is an error, never
    /// an outcome.
    public func result(of commandID: Data, mac: PinnedMac) async throws -> RemoteCommandOutcome? {
        guard isEnabled else { return nil }
        let data = try await post(["type": "result", "commandID": commandID.pushHex])
        guard let body = try? JSONDecoder().decode(ResultBody.self, from: data) else { throw PushClientError.malformedResponse }
        guard let encoded = body.result else { return nil }
        guard let raw = Data(base64Encoded: encoded),
              let outcome = RemoteCommandResult.open(raw, commandID: commandID, mac: mac) else { throw PushClientError.unsignedResult }
        return outcome
    }
}

/// The Mac's side of remote stop: poll, check each command (`RemoteCommandVerifier`), act, and answer with a signed
/// result on the next poll. The host runs it only while screen control is on, and it does nothing without an endpoint.
///
/// The Mac signs a result only about a command it could authenticate, so a relay cannot make it sign 「거절」 for a real
/// command by sending the same bytes with a broken signature: a command that verified gets what the Mac did; one too old
/// or from a device this Mac does not know gets 「거절」 (the genuine message would get the same); malformed messages,
/// another Mac's commands and bad signatures get no answer at all. A command sent again gets the answer it got the first
/// time and is never acted on twice.
public final class RemoteStopPoller: Sendable {
    /// A modest interval: a remote 「지금 끊기」 lands within about this long.
    public static let interval: Duration = .seconds(30)
    /// How many answered commands the poller remembers, to answer one sent again the same way.
    static let remembered = 256

    private struct Waiting {
        var results: [Data: RemoteCommandResult] = [:]
        var order: [Data] = []
        var answered: [Data: RemoteCommandOutcome] = [:]
        var answeredOrder: [Data] = []
    }

    private let client: ScreenPushClient
    private let signer: TranscriptSigner
    private let verifier: RemoteCommandVerifier
    private let waiting = OSAllocatedUnfairLock(initialState: Waiting())

    public init(client: ScreenPushClient, signer: TranscriptSigner, verifier: RemoteCommandVerifier) {
        self.client = client
        self.signer = signer
        self.verifier = verifier
    }

    public var hasUndeliveredResults: Bool { waiting.withLock { !$0.order.isEmpty } }

    /// One poll: hands over the results not yet delivered, then answers each command (acting through `apply` only on a
    /// verified one, once) and keeps the signed results for the next poll. Returns how many results it added, so the
    /// host can deliver them at once.
    @discardableResult
    public func round(deviceIDs: [Data], apply: @Sendable (RemoteCommand) async -> RemoteCommandOutcome) async throws -> Int {
        guard client.isEnabled else { return 0 }
        let carried = undelivered()
        let commands = try await client.fetch(try MacFetch(macKey: signer.publicKey, deviceIDs: deviceIDs, results: carried),
                                              signer: signer)
        delivered(carried)
        var added = 0
        for signed in commands {
            let id = sha256(signed.message)
            guard !waiting.withLock({ $0.results[id] != nil }),
                  let outcome = await outcome(of: signed, id: id, apply: apply) else { continue }
            keep(try await RemoteCommandResult.make(commandID: id, outcome: outcome, signer: signer))
            added += 1
        }
        return added
    }

    /// Delivers waiting results without taking new commands: the one last poll after screen control turned off.
    public func deliverResults(deviceIDs: [Data]) async throws {
        guard client.isEnabled, hasUndeliveredResults else { return }
        let carried = undelivered()
        _ = try await client.fetch(try MacFetch(macKey: signer.publicKey, deviceIDs: deviceIDs, results: carried), signer: signer)
        delivered(carried)
    }

    /// What to answer, or nil for no answer (see the type's comment).
    private func outcome(of signed: SignedPushMessage, id: Data, apply: @Sendable (RemoteCommand) async -> RemoteCommandOutcome)
        async -> RemoteCommandOutcome? {
        if let earlier = waiting.withLock({ $0.answered[id] }) { return earlier }
        do {
            let command = try verifier.verify(signed)
            let outcome = await apply(command)
            waiting.withLock { waiting in
                waiting.answered[id] = outcome
                waiting.answeredOrder.append(id)
                while waiting.answeredOrder.count > Self.remembered { waiting.answered[waiting.answeredOrder.removeFirst()] = nil }
            }
            return outcome
        } catch RemoteCommandError.expired, RemoteCommandError.unknownDevice {
            return .refused
        } catch {
            // Malformed, another Mac's, a bad signature, or a replay no longer remembered: nothing authenticated to answer.
            return nil
        }
    }

    private func undelivered() -> [RemoteCommandResult] {
        waiting.withLock { waiting in
            let results = waiting.results
            return waiting.order.compactMap { results[$0] }
        }
    }

    private func delivered(_ results: [RemoteCommandResult]) {
        waiting.withLock { waiting in
            for result in results { waiting.results[result.commandID] = nil }
            let kept = waiting.results
            waiting.order.removeAll { kept[$0] == nil }
        }
    }

    private func keep(_ result: RemoteCommandResult) {
        waiting.withLock { waiting in
            waiting.results[result.commandID] = result
            waiting.order.append(result.commandID)
            while waiting.order.count > PushWire.maxDevices { waiting.results[waiting.order.removeFirst()] = nil }
        }
    }
}
