import Foundation
import Network

/// Apple peer-to-peer Wi-Fi plus ordinary local links. Discovery has no authority: the pinned Mac key,
/// one-use QR and per-connection biometric signature still authenticate the stream after it opens.
public enum ScreenNearby {
    public static let serviceType = "_atzscreen._tcp"

    public static func isValidServiceName(_ name: String) -> Bool {
        (1...63).contains(name.utf8.count) && name.first != "-" && name.last != "-"
            && name.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }
    }

    public static func screenService(fingerprint: Data) -> String {
        "az-screen-" + fingerprint.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    public static func registrationService(codeID: Data) -> String {
        "az-pair-" + codeID.map { String(format: "%02x", $0) }.joined()
    }

    static func parameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        parameters.prohibitedInterfaceTypes = [.cellular]
        (parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options)?.noDelay = true
        return parameters
    }

    /// Select the route before sending any authentication bytes; only an opening failure may fall back to Internet.
    public static func open(serviceName: String, maxFrame: Int, timeout: Duration = .seconds(5)) async throws -> any ScreenFrameTransport {
        guard isValidServiceName(serviceName) else { throw TransportError.badFrame }
        let endpoint = NWEndpoint.service(name: serviceName, type: serviceType, domain: "local.", interface: nil)
        let connection = NWConnection(to: endpoint, using: parameters())
        try await open(connection, timeout: timeout)
        return FramedConnection(connection, maxFrame: maxFrame)
    }

    static func open(_ connection: NWConnection, timeout: Duration) async throws {
        let settled = Once()
        let watchdog = Task {
            guard (try? await Task.sleep(for: timeout)) != nil else { return }
            if settled.claim() { connection.cancel() }
        }
        defer { watchdog.cancel() }
        do {
            try await connection.open(on: ScreenClient.queue)
            guard settled.claim() else { throw TransportError.timedOut }
        } catch {
            connection.cancel()
            throw settled.claim() ? error : TransportError.timedOut
        }
    }
}
