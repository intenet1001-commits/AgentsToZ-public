#if os(macOS)
import Foundation

public struct ScreenCommunityCommand: Codable, Sendable {
    public enum Operation: String, Codable, Sendable { case identity, bind, prepare, commit, status, withdraw, accessCommit, accessStatus }
    public let operation: Operation
    public let arguments: [ScreenCommunityValue]
    public let certificate: ScreenCommunityEnvelope?
    public init(_ operation: Operation, _ arguments: [ScreenCommunityValue] = [], certificate: ScreenCommunityEnvelope? = nil) {
        self.operation = operation; self.arguments = arguments; self.certificate = certificate
    }
    public func call() async throws -> ScreenCommunityBrokerReply {
        let data = try await ScreenCommunitySocket.call(JSONEncoder().encode(self))
        let reply = try JSONDecoder().decode(ScreenCommunityBrokerReply.self, from: data)
        if let error = reply.error { throw ScreenCommunityError.service(error) }
        return reply
    }
}

public struct ScreenCommunityBrokerReply: Codable, Sendable {
    public let values: [ScreenCommunityValue]
    public let envelopes: [ScreenCommunityEnvelope]
    public let error: String?
    public init(values: [ScreenCommunityValue] = [], envelopes: [ScreenCommunityEnvelope] = [], error: String? = nil) {
        self.values = values; self.envelopes = envelopes; self.error = error
    }
}
#endif
