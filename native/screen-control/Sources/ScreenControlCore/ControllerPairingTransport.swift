import Foundation
import Network
import os

// Where controller pairing (ControllerPairing.swift) meets the network (docs/design/mac-to-mac-2026-11-01/DESIGN.md 6.3).
// B listens only while its window is open: Bonjour `_atzmpair._tcp` named `az-mpair-<window ID>`, TXT {n = B's name,
// never authenticated; pv = 1}, peer-to-peer (AWDL) included, local-network peers only, behind a pre-authentication gate
// of the window's own. A browses for windows, never listens, and connects over the link Bonjour resolves first, so a
// pairing never needs the Internet; when Cloudflare One sends it into a tunnel anyway (S-N3), the Viewer asks the person
// to pause it for the pairing.

/// B's listener for one window. Stop it when the window closes; a pairing it handed out stays its owner's to end.
public final class ControllerPairingListener: Sendable {
    public enum Outcome: Sendable {
        /// The window's P1 got to P4: ask the person at B.
        case pending(PendingControllerPairing)
        /// A P1 after the window took its one, answered busy.
        case busy(PeerKey)
        /// The P1 that took the window failed before the person was asked (a refused attestation, a broken exchange).
        /// The window is used up.
        case failed(PeerKey, ControllerPairingError)
    }

    public let host: ControllerPairingHost
    /// One consumer.
    public let outcomes: AsyncStream<Outcome>
    private let sink: AsyncStream<Outcome>.Continuation
    private let listener: NWListener
    private let gate: PreAuthGate
    private let queue = DispatchQueue(label: "agentstoz.screen-control.controller-pairing")

    /// Advertises the window with Bonjour, AWDL included. `bind` instead listens on that address alone without
    /// advertising (the checks use loopback).
    public init(host: ControllerPairingHost, gate: PreAuthGate = PreAuthGate(), bind: NWEndpoint.Host? = nil,
                port: NWEndpoint.Port = .any) throws {
        listener = try Self.makeListener(host: host, bind: bind, port: port)
        self.host = host
        self.gate = gate
        (outcomes, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(16))
    }

    static func makeListener(host: ControllerPairingHost, bind: NWEndpoint.Host?, port: NWEndpoint.Port) throws -> NWListener {
        guard ScreenNearby.isValidServiceName(host.serviceName) else { throw TransportError.badFrame }
        let parameters = bind == nil ? ScreenNearby.parameters() : NWParameters.tcp
        parameters.acceptLocalOnly = true
        parameters.includePeerToPeer = bind == nil
        (parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        if let bind {
            parameters.requiredLocalEndpoint = .hostPort(host: bind, port: port)
            return try NWListener(using: parameters)
        }
        let listener = try NWListener(using: parameters, on: port)
        listener.service = NWListener.Service(name: host.serviceName, type: ControllerPairingProtocol.serviceType, domain: nil,
                                              txtRecord: ControllerPairingWindowListing.txt(hostName: host.hostName))
        return listener
    }

    public func start() async throws -> NWEndpoint.Port {
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return connection.cancel() }
            Task { await self.handle(connection) }
        }
        return try await listener.ready(on: queue)
    }

    public func stop() {
        listener.cancel()
        sink.finish()
    }

    func handle(_ connection: NWConnection) async {
        guard let peer = PeerKey(connection.endpoint) else { return connection.cancel() }
        guard case .success(let ticket) = await gate.admit(peer, at: .now) else { return connection.cancel() }
        let framed = FramedConnection(connection, maxFrame: ControllerPairingProtocol.maxFirstFrame)
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(until: ticket.deadline, clock: .continuous)) != nil else { return }
            if settled.claim() { framed.cancel() }
        }
        let first: Data
        do {
            try await connection.open(on: queue)
            first = try await framed.receive()
            _ = try ControllerPairingHello(first)
            guard settled.claim() else { throw TransportError.timedOut }
            watchdog.cancel()
            _ = await gate.finish(ticket, succeeded: true, at: .now)
        } catch {
            watchdog.cancel()
            framed.cancel()
            _ = await gate.finish(ticket, succeeded: false, at: .now)
            return
        }
        do {
            let pending = try await host.accept(over: framed, first: first)
            if case .terminated = sink.yield(.pending(pending)) { await pending.refuse() }
        } catch ControllerPairingError.windowBusy {
            sink.yield(.busy(peer))
        } catch {
            // Only the connection that took the window gets here with the window taken: every later one is busy.
            if host.isTaken { sink.yield(.failed(peer, error as? ControllerPairingError ?? .expired)) }
        }
    }
}

/// A window as A's list shows it: B's name as B advertised it (not authenticated; the codes are) and the window number
/// the person matches against B's screen.
public struct ControllerPairingWindowListing: Sendable, Hashable, Identifiable {
    public let serviceName: String
    public let windowID: Data
    /// B's name when it can be shown, else 「이름 없는 Mac」.
    public let hostName: String
    public var windowNumber: String { ControllerPairingProtocol.windowNumber(windowID) }
    public var id: String { serviceName }

    /// From a browse result: a pairing window's service name and TXT of this protocol's version, else nil.
    public init?(serviceName: String, txt: [String: String]) {
        guard let windowID = ControllerPairingProtocol.windowID(serviceName: serviceName),
              txt[ControllerPairingProtocol.versionKey] == String(ControllerPairingProtocol.version) else { return nil }
        self.serviceName = serviceName
        self.windowID = windowID
        hostName = txt[ControllerPairingProtocol.nameKey].map(ControllerPairingText.showable) ?? ControllerPairingText.unnamed
    }

    static func txt(hostName: String) -> NWTXTRecord {
        NWTXTRecord([ControllerPairingProtocol.nameKey: hostName, ControllerPairingProtocol.versionKey: String(ControllerPairingProtocol.version)])
    }
}

/// A's browser for pairing windows. Peer-to-peer included, so two Macs on no common network still find each other.
public final class ControllerPairingBrowser: Sendable {
    /// The windows open now, sorted by name and number; one consumer.
    public let listings: AsyncStream<[ControllerPairingWindowListing]>
    private let sink: AsyncStream<[ControllerPairingWindowListing]>.Continuation
    private let browser: NWBrowser
    private let queue = DispatchQueue(label: "agentstoz.screen-control.controller-pairing.browse")

    public init() {
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        browser = NWBrowser(for: .bonjourWithTXTRecord(type: ControllerPairingProtocol.serviceType, domain: nil), using: parameters)
        (listings, sink) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(1))
    }

    public func start() {
        let sink = sink
        browser.browseResultsChangedHandler = { results, _ in
            sink.yield(Self.listings(results.compactMap { result in
                guard case .service(let name, _, _, _) = result.endpoint else { return nil }
                guard case .bonjour(let record) = result.metadata else { return nil }
                return (name, record.dictionary)
            }))
        }
        browser.stateUpdateHandler = { state in
            if case .failed = state { sink.finish() }
        }
        browser.start(queue: queue)
    }

    public func stop() {
        browser.cancel()
        sink.finish()
    }

    /// One row per window, whatever interfaces it was found on.
    static func listings(_ results: [(name: String, txt: [String: String])]) -> [ControllerPairingWindowListing] {
        var seen = Set<String>()
        return results.compactMap { ControllerPairingWindowListing(serviceName: $0.name, txt: $0.txt) }
            .filter { seen.insert($0.serviceName).inserted }
            .sorted { ($0.hostName, $0.windowNumber, $0.serviceName) < ($1.hostName, $1.windowNumber, $1.serviceName) }
    }
}

extension ControllerPairingClient {
    /// Connects to the window the person picked and pairs. Bonjour resolves the link-local or AWDL address first;
    /// never cellular. When the connection cannot open, the Viewer shows `ControllerPairingText.warpHint` too (S-N3).
    public static func pair(with listing: ControllerPairingWindowListing, signer: any TranscriptSigner, name: String, model: String,
                            prompts: ControllerPairingPrompts, timeout: Duration = ControllerPairingProtocol.exchangeTimeout) async throws -> ControllerPairingResult {
        let endpoint = NWEndpoint.service(name: listing.serviceName, type: ControllerPairingProtocol.serviceType, domain: "local.", interface: nil)
        return try await pair(to: endpoint, windowID: listing.windowID, signer: signer, name: name, model: model, prompts: prompts, timeout: timeout)
    }

    /// The same to an endpoint at hand (the checks use loopback).
    public static func pair(to endpoint: NWEndpoint, windowID: Data, signer: any TranscriptSigner, name: String, model: String,
                            prompts: ControllerPairingPrompts, timeout: Duration = ControllerPairingProtocol.exchangeTimeout,
                            decisionTimeout: Duration = ControllerPairingProtocol.decisionTimeout,
                            storedTimeout: Duration = ControllerPairingProtocol.storedTimeout) async throws -> ControllerPairingResult {
        let connection = NWConnection(to: endpoint, using: ScreenNearby.parameters())
        let framed = FramedConnection(connection, maxFrame: ControllerPairingProtocol.maxFrame)
        do {
            try await ScreenNearby.open(connection, timeout: timeout)
        } catch {
            framed.cancel()
            throw ControllerPairingError.afterGivingUp(error)
        }
        return try await pair(over: framed, windowID: windowID, signer: signer, name: name, model: model, prompts: prompts,
                              timeout: timeout, decisionTimeout: decisionTimeout, storedTimeout: storedTimeout)
    }
}
