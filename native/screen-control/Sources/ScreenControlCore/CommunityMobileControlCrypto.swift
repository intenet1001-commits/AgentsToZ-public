import Foundation
import CryptoKit

struct CommunityMobileControlKeys: Sendable {
    let clientToHost, hostToClient, clientConfirm, hostConfirm: SymmetricKey
    let hash: Data
    init(privateKey: P256.KeyAgreement.PrivateKey, transcript: CommunityMobileControlTranscript, role: CommunityMobileControlRole) throws {
        let own = role == .client ? transcript.senderEphemeral : transcript.receiverEphemeral
        guard ScreenCommunityRequest.base64(privateKey.publicKey.x963Representation) == own else { throw ScreenCommunityError.wrongCommunity }
        let peer = role == .client ? transcript.receiverEphemeral : transcript.senderEphemeral
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: CommunityMobileControlBytes.decode(peer, bytes: 65)))
        let hash = try transcript.hash; self.hash = hash
        func derive(_ label: String) -> SymmetricKey { shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: hash, sharedInfo: Data(("agentstoz.community-mobile-control/keys/v2\0" + label).utf8), outputByteCount: 32) }
        clientToHost = derive("client-to-host"); hostToClient = derive("host-to-client"); clientConfirm = derive("client-confirm"); hostConfirm = derive("host-confirm")
    }
    func confirmation(role: CommunityMobileControlRole, signature: Data) throws -> Data {
        guard signature.count == 64 else { throw ScreenCommunityError.invalidSignature }
        let bytes = Data(("agentstoz.community-mobile-control/confirm/v2\0" + role.rawValue + "\0").utf8) + hash + CommunityMobileControlBytes.hash(signature)
        return Data(HMAC<SHA256>.authenticationCode(for: bytes, using: role == .client ? clientConfirm : hostConfirm))
    }
    func verifiesConfirmation(_ value: Data, role: CommunityMobileControlRole, signature: Data) throws -> Bool {
        let bytes = Data(("agentstoz.community-mobile-control/confirm/v2\0" + role.rawValue + "\0").utf8) + hash + CommunityMobileControlBytes.hash(signature)
        guard signature.count == 64 else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(value, authenticating: bytes, using: role == .client ? clientConfirm : hostConfirm)
    }
    func ready(clientSignature: Data, hostSignature: Data) throws -> Data {
        guard clientSignature.count == 64, hostSignature.count == 64 else { throw ScreenCommunityError.invalidSignature }
        let bytes = Data("agentstoz.community-mobile-control/ready/v2\0".utf8) + hash + CommunityMobileControlBytes.hash(clientSignature) + CommunityMobileControlBytes.hash(hostSignature)
        return Data(HMAC<SHA256>.authenticationCode(for: bytes, using: hostConfirm))
    }
    func verifiesReady(_ value: Data, clientSignature: Data, hostSignature: Data) throws -> Bool {
        guard clientSignature.count == 64, hostSignature.count == 64 else { return false }
        let bytes = Data("agentstoz.community-mobile-control/ready/v2\0".utf8) + hash + CommunityMobileControlBytes.hash(clientSignature) + CommunityMobileControlBytes.hash(hostSignature)
        return HMAC<SHA256>.isValidAuthenticationCode(value, authenticating: bytes, using: hostConfirm)
    }
}

/// Crypto only. The client actor separately checks the live RAM-generation/foreground fence on every operation.
struct CommunityMobileControlCipher: Sendable {
    static let maximumPlaintext = 24_000
    let transcript: CommunityMobileControlTranscript, role: CommunityMobileControlRole
    private(set) var keys: CommunityMobileControlKeys?
    private var sendSequence: Int64 = 1, receiveSequence: Int64 = 1
    init(privateKey: P256.KeyAgreement.PrivateKey, transcript: CommunityMobileControlTranscript, role: CommunityMobileControlRole) throws {
        self.transcript = transcript; self.role = role; keys = try CommunityMobileControlKeys(privateKey: privateKey, transcript: transcript, role: role)
    }
    private func aad(direction: CommunityMobileControlRole, sequence: Int64, requestID: String) throws -> Data {
        try CommunityMobileControlBytes.json(["agentstoz.community-mobile-control/record/v2",transcript.channelId,transcript.purpose.rawValue,direction.rawValue,sequence,requestID])
    }
    private func nonce(direction: CommunityMobileControlRole, sequence: Int64) throws -> AES.GCM.Nonce {
        guard sequence > 0, sequence <= 9_007_199_254_740_991 else { throw ScreenCommunityError.malformed }
        var bytes = Data((direction == .client ? "c2h\0" : "h2c\0").utf8)
        for shift in stride(from: 56, through: 0, by: -8) { bytes.append(UInt8(truncatingIfNeeded: UInt64(sequence) >> shift)) }
        return try AES.GCM.Nonce(data: bytes)
    }
    mutating func seal(_ plaintext: Data, requestID: String) throws -> Data {
        guard let keys, CommunityMobileControlBytes.id(requestID) else { throw ScreenCommunityError.malformed }
        _ = try CommunityMobileControlJSON.object(plaintext, maximum: Self.maximumPlaintext)
        let box = try AES.GCM.seal(plaintext, using: role == .client ? keys.clientToHost : keys.hostToClient,
            nonce: nonce(direction: role, sequence: sendSequence), authenticating: aad(direction: role, sequence: sendSequence, requestID: requestID))
        let wire = try CommunityMobileControlBytes.json(["v":2,"type":"record","channelId":transcript.channelId,"direction":role.rawValue,"seq":sendSequence,"requestId":requestID,"ciphertext":ScreenCommunityRequest.base64(box.ciphertext + box.tag)])
        sendSequence += 1; return wire
    }
    mutating func open(_ wire: Data, fromConnectionID: String) throws -> (requestID: String, plaintext: Data) {
        guard let keys else { throw ScreenCommunityError.expired }
        let value = try CommunityMobileControlJSON.object(wire, maximum: 40_000)
        guard Set(value.keys) == ["v","type","channelId","direction","seq","requestId","ciphertext"], try AccessValue.integer(value["v"] as Any) == 2,
              value["type"] as? String == "record", value["channelId"] as? String == transcript.channelId,
              let directionText = value["direction"] as? String, let direction = CommunityMobileControlRole(rawValue: directionText), direction != role,
              fromConnectionID == (role == .client ? transcript.receiverConnectionId : transcript.senderConnectionId),
              try AccessValue.integer(value["seq"] as Any) == receiveSequence,
              let id = value["requestId"] as? String, CommunityMobileControlBytes.id(id), let encoded = value["ciphertext"] as? String else { throw ScreenCommunityError.malformed }
        let raw = try ScreenCommunityRequest.decodeBase64(encoded, max: 32_024)
        guard raw.count > 16, raw.count <= Self.maximumPlaintext + 16, ScreenCommunityRequest.base64(raw) == encoded else { throw ScreenCommunityError.malformed }
        let n = try nonce(direction: direction, sequence: receiveSequence)
        let box = try AES.GCM.SealedBox(nonce: n, ciphertext: raw.dropLast(16), tag: raw.suffix(16))
        let plaintext = try AES.GCM.open(box, using: direction == .client ? keys.clientToHost : keys.hostToClient, authenticating: aad(direction: direction, sequence: receiveSequence, requestID: id))
        let object = try CommunityMobileControlJSON.object(plaintext, maximum: Self.maximumPlaintext)
        guard object["requestId"] as? String == id else { throw ScreenCommunityError.wrongRequest }
        receiveSequence += 1; return (id, plaintext)
    }
    mutating func destroy() { keys = nil }
}
