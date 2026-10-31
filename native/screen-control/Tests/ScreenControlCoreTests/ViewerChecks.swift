import CoreMedia
import CryptoKit
import Foundation
import LocalAuthentication
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

extension ScreenControlChecks {
    func testDeviceAuthenticationKeyProtection() throws {
        let strict = ScreenDeviceAuthentication.biometricsOnly.accessFlags
        let owner = ScreenDeviceAuthentication.deviceOwner.accessFlags
        try check(strict.contains(.privateKeyUsage) && strict.contains(.biometryCurrentSet), "strict keys require current biometrics")
        try check(!strict.contains(.userPresence), "strict keys cannot accept passcode fallback")
        try check(owner.contains(.privateKeyUsage) && owner.contains(.userPresence), "owner keys accept system user presence")
        try check(!owner.contains(.biometryCurrentSet), "owner keys do not also require biometrics")
        try check(try JSONDecoder().decode(ScreenDeviceAuthentication.self, from: Data("\"deviceOwner\"".utf8)) == .deviceOwner, "owner mode round trip")
        do {
            _ = try JSONDecoder().decode(ScreenDeviceAuthentication.self, from: Data("\"unknown\"".utf8))
            throw CheckFailure(description: "unknown authentication mode accepted")
        } catch is DecodingError {}
    }
    func testLockoutRecoveryRequiresAvailableBiometry() async throws {
        // Reproduces the device report: owner/passcode authentication succeeded but a fresh context still
        // returned -8. That must remain a recovery failure, rather than telling the person to connect again.
        try await expectError(LAError(.biometryLockout)) {
            try await BiometricApproval.recoverLockout(authenticateOwner: { true }, verifyBiometry: {
                throw LAError(.biometryLockout)
            })
        }
        try await expectError(LAError(.authenticationFailed)) {
            try await BiometricApproval.recoverLockout(authenticateOwner: { false }, verifyBiometry: {
                throw LAError(.biometryNotEnrolled) // must not reach the availability check
            })
        }
        try await expectError(LAError(.userCancel)) {
            try await BiometricApproval.recoverLockout(authenticateOwner: { throw LAError(.userCancel) }, verifyBiometry: {
                throw LAError(.biometryNotEnrolled)
            })
        }
        try await BiometricApproval.recoverLockout(authenticateOwner: { true }, verifyBiometry: {})
    }

    func testViewerAsksForAKeyframeShowsPicturesAndSaysGoodbye() async throws {
        let encoded = Collector<VideoFrame>()
        let encoder = try VideoEncoder(.init(width: 640, height: 360)) { if case .success(let frame) = $0 { encoded.add(frame) } }
        func encode(_ index: Int) throws {
            encoder.encode(try patternFrame(width: 640, height: 360, bar: index * 8), at: CMTime(value: Int64(index), timescale: 30))
        }
        for index in 0..<4 { try encode(index) }
        encoder.flush()
        let opening = encoded.all
        try check(opening.count == 4 && opening[0].isKeyframe && !opening.dropFirst().contains(where: \.isKeyframe), "one keyframe, then deltas")

        let fixture = Fixture()
        let (listener, endpoint) = try await loopbackListener(fixture.mac)
        defer { listener.stop() }
        let viewer = try await within(5) {
            try await ScreenViewer.connect(to: endpoint, mac: pinned(fixture.macSigner.publicKey), signer: fixture.deviceSigner)
        }
        let mac = try await nextSession(listener)
        let pictures = Collector<ScreenPicture>()
        let watching = Task { for try await picture in viewer.pictures() { pictures.add(picture) } }

        // The phone joined after the keyframe: it asks once, however many delta frames arrive first.
        for frame in opening.dropFirst() { try await mac.connection.send(.video, frame.encoded()) }
        let request = try await within(3) { try await mac.connection.receive() }
        try check(request.type == .control && (try ControlMessage(decoding: request.payload)) == .requestKeyframe, "keyframe requested")
        encoder.requestKeyframe()
        for index in 4..<6 { try encode(index) }
        encoder.flush()
        let resumed = Array(encoded.all.dropFirst(4))
        try check(resumed.count == 2 && resumed[0].isKeyframe, "the Mac answers with a keyframe")
        for frame in resumed { try await mac.connection.send(.video, frame.encoded()) }
        _ = try await within(3) {
            while pictures.all.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
            return true
        }
        for picture in pictures.all {
            let size = CMVideoFormatDescriptionGetDimensions(CMSampleBufferGetFormatDescription(picture.sample)!)
            let attachments = CMSampleBufferGetSampleAttachmentsArray(picture.sample, createIfNecessary: false) as? [[CFString: Any]]
            let showsOnArrival: Bool = (attachments?.first?[kCMSampleAttachmentKey_DisplayImmediately] as? Bool) ?? false
            try check(size.width == 640 && size.height == 360 && showsOnArrival, "pictures carry the keyframe's format and show on arrival")
        }

        // Leaving says so: the next record on the Mac is the goodbye, not a second keyframe request.
        await viewer.close()
        let goodbye = try await within(3) { try await mac.connection.receive() }
        try check(goodbye.type == .close, "the Mac hears the phone leave")
        _ = await watching.result
    }

    func testFaceIDApprovalSignsOnce() async throws {
        // An unprotected SE key exercises the real approval probe/reference lifetime without asking the test
        // runner's person for biometrics. Touch ID / Face ID and their ACL need separate physical-device acceptance.
        try check(BiometricApproval.name(for: .touchID) == "Touch ID", "fingerprint hardware must not say Face ID")
        try check(BiometricApproval.name(for: .faceID) == "Face ID", "face hardware retains its own name")
        try check(BiometricApproval.name(for: .none) == "생체 인증", "unknown hardware has a neutral name")
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        let signer = try await FaceIDApprovedSigner.approve(dataRepresentation: key.dataRepresentation, reason: "Test key authorization")
        let transcript = Data("transcript".utf8)
        try check(signer.publicKey.isValidSignature(try await signer.signature(for: transcript), for: transcript), "first signature")
        try await expectError(HandshakeError.alreadyUsed) { _ = try await signer.signature(for: transcript) }
        // One connection consuming its approval cannot consume the next connection's fresh context/key reference.
        let next = try await FaceIDApprovedSigner.approve(dataRepresentation: key.dataRepresentation, reason: "Next test authorization")
        try check(next.publicKey.isValidSignature(try await next.signature(for: transcript), for: transcript), "fresh connection approval")
    }
}
