import CoreMedia
import CryptoKit
import Foundation
import LocalAuthentication
#if !CORE_CHECKS
@testable import ScreenControlCore
#endif

extension ScreenControlChecks {
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
        // A key without Face ID access control stands in: the one-use rule is what this checks; the Face ID prompt
        // itself needs a real iPhone (SR-12, iOS UI test).
        let key = try SecureEnclave.P256.Signing.PrivateKey()
        let signer = try FaceIDApprovedSigner(dataRepresentation: key.dataRepresentation, context: LAContext())
        let transcript = Data("transcript".utf8)
        try check(signer.publicKey.isValidSignature(try await signer.signature(for: transcript), for: transcript), "first signature")
        try await expectError(HandshakeError.alreadyUsed) { _ = try await signer.signature(for: transcript) }
    }
}
