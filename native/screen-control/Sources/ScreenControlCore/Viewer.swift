import CoreMedia
import CryptoKit
import Foundation
import LocalAuthentication
import Network
import os

// The phone's side of a screen session without UI. The iOS view feeds `ScreenPicture`s to AVSampleBufferDisplayLayer,
// which decodes in hardware; nothing here draws.

/// One picture ready for the display layer, marked to show on arrival: the stream is live, not timed playback.
public struct ScreenPicture: @unchecked Sendable {
    public let sample: CMSampleBuffer
    public let timestamp: UInt64
}

/// Turns `.video` frames into sample buffers under the format their last keyframe described.
public struct VideoSampleBuilder: @unchecked Sendable {
    private var parameterSets: [Data] = []
    private var format: CMVideoFormatDescription?

    public init() {}

    public mutating func picture(for frame: VideoFrame) throws -> ScreenPicture {
        if frame.isKeyframe, frame.parameterSets != parameterSets {
            format = try VideoFrame.format(frame.parameterSets)
            parameterSets = frame.parameterSets
        }
        guard let format else { throw VideoError.needKeyframe }
        let sample = try frame.sampleBuffer(format: format)
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true), CFArrayGetCount(attachments) > 0 {
            let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(first, Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                                 Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
        }
        return ScreenPicture(sample: sample, timestamp: frame.timestamp)
    }
}

/// What the Mac tells the phone beside the picture, for a native banner outside the video (DESIGN 보안 원칙 4).
public enum ScreenNotice: Equatable, Sendable {
    /// Someone at the Mac is using its own mouse or keyboard. The Mac drops this phone's input until resumed.
    case remoteInputPaused
    /// The Mac takes this phone's input again.
    case remoteInputResumed
    /// Version 2: the Mac's screen is locked, as its system reports it. Anything that looks like a lock screen while the
    /// Mac says otherwise was drawn by some process on it.
    case macLocked
    /// Version 2: the Mac's screen is not locked.
    case macUnlocked
    /// Version 2: the displays the phone may choose between and the one it sees, from 0.
    case displays(count: Int, current: Int)
    case keyboardState(id: UInt32, ScreenKeyboardState, ScreenControlResult)
    case spaceResult(ScreenSpaceAction, ScreenControlResult)
    case spaceChanged
    case videoQuality(ScreenVideoQuality)
    case inputAvailability(ScreenInputAvailability)
    case pointerPosition(ScreenPointerPosition)
    case textAndReturnResult(id: UInt32, ScreenTextReturnResult)
}

/// What the phone shows of the Mac beside the picture, from its notices in order. Each notice changes only its own
/// part: the lock state or a display change must not clear a pause, or the phone would drop its banner while the Mac
/// still drops its input. A version-1 Mac tells only the pauses, so its lock state stays unknown and it has one display.
public struct ScreenMacState: Equatable, Sendable {
    /// Someone at the Mac is using its own mouse or keyboard; the Mac drops this phone's input until it says so.
    public private(set) var inputPaused = false
    /// Whether the Mac's screen is locked, as the Mac said outside the picture; nil until it says.
    public private(set) var locked: Bool?
    public private(set) var displayCount = 1
    /// The display shown, from 0.
    public private(set) var currentDisplay = 0
    public private(set) var keyboard: ScreenKeyboardState?
    public private(set) var videoQuality: ScreenVideoQuality?
    public private(set) var inputAvailability: ScreenInputAvailability?
    public private(set) var pointerPosition: ScreenPointerPosition?
    public var canSendInput: Bool { !inputPaused && (inputAvailability == nil || inputAvailability == .ready) }

    public init() {}

    /// The Mac has more than one display, so the phone offers a choice.
    public var choosesDisplay: Bool { displayCount > 1 }

    public mutating func hear(_ notice: ScreenNotice) {
        switch notice {
        case .remoteInputPaused: inputPaused = true
        case .remoteInputResumed: inputPaused = false
        case .macLocked: locked = true
        case .macUnlocked: locked = false
        case let .displays(count, current):
            displayCount = count
            currentDisplay = current
        case .keyboardState(_, let state, _): keyboard = state
        case .videoQuality(let quality): videoQuality = quality
        case .inputAvailability(let reason): inputAvailability = reason
        case .pointerPosition(let position): pointerPosition = position
        case .spaceResult, .spaceChanged, .textAndReturnResult: break
        }
    }
}

/// A screen session from the phone: pictures in, input and a keyframe request when the phone has none out, `.close`
/// on the way out.
public final class ScreenViewer: Sendable {
    let connection: SecureConnection
    private enum Outgoing: Sendable { case input(InputEvent), control(ControlMessage) }
    private let inputs: AsyncStream<Outgoing>.Continuation
    /// Notices in arrival order. One consumer; keeps the newest few while nobody reads. Ends with the session.
    public let notices: AsyncStream<ScreenNotice>
    private let noticeSink: AsyncStream<ScreenNotice>.Continuation
    private let ended = OSAllocatedUnfairLock<SessionEndReason?>(initialState: nil)

    init(connection: SecureConnection) {
        self.connection = connection
        (notices, noticeSink) = AsyncStream.makeStream(of: ScreenNotice.self, bufferingPolicy: .bufferingOldest(64))
        let (stream, inputs) = AsyncStream.makeStream(of: Outgoing.self, bufferingPolicy: .bufferingOldest(512))
        self.inputs = inputs
        // One sender, so input reaches the Mac in the order the person made it.
        Task { [connection, inputs] in
            for await event in stream {
                do {
                    switch event {
                    case .input(let event):
                        if case .textAndReturn = event, connection.version < 4 { throw ChannelError.notNegotiated }
                        try await connection.send(.input, InputCodec.encode(event))
                    case .control(let message): try await connection.send(message)
                    }
                } catch { inputs.finish(); connection.close(); return }
            }
        }
    }

    /// `signer` should already carry this connection's Face ID approval (`FaceIDApprovedSigner`).
    public static func connect(to endpoint: NWEndpoint, mac: PinnedMac, signer: TranscriptSigner) async throws -> ScreenViewer {
        ScreenViewer(connection: try await ScreenClient.connect(
            to: endpoint, handshake: DeviceHandshake(mac: mac, devicePublicKey: signer.publicKey), signer: signer))
    }

    public static func connect(over transport: any ScreenFrameTransport, mac: PinnedMac,
                               signer: any TranscriptSigner) async throws -> ScreenViewer {
        ScreenViewer(connection: try await ScreenTransportHandshake.connect(
            over: transport, handshake: DeviceHandshake(mac: mac, devicePublicKey: signer.publicKey), signer: signer))
    }

    /// Why the Mac ended the session, once `pictures()` finished because it did: idle, time limit, ended at the Mac and
    /// so on. Nil while the session runs, when the phone left, or when the Mac named no reason this version knows.
    public var endReason: SessionEndReason? { ended.withLock { $0 } }

    /// Pictures in arrival order until the Mac closes the session. One consumer; a malformed frame ends the session.
    /// Notices that arrive meanwhile go to `notices`.
    public func pictures() -> AsyncThrowingStream<ScreenPicture, Error> {
        AsyncThrowingStream { continuation in
            let task = Task { [connection, ended, noticeSink] in
                var builder = VideoSampleBuilder()
                var waitingForKeyframe = false
                defer { noticeSink.finish() }
                do {
                    receiving: while true {
                        let record = try await connection.receive()
                        switch record.type {
                        case .close:
                            ended.withLock { $0 = SessionEndReason(closePayload: record.payload) }
                            break receiving
                        case .control:
                            // Only what the Mac sends, and only what this session's version carries: the Mac never
                            // sends anything else, so anything else ends the session.
                            let message = try ControlMessage(decoding: record.payload, version: connection.version)
                            guard message.sender == .mac else { throw ScreenControlWireError.malformed }
                            switch message {
                            case .remoteInputPaused: noticeSink.yield(.remoteInputPaused)
                            case .remoteInputResumed: noticeSink.yield(.remoteInputResumed)
                            case .macLocked: noticeSink.yield(.macLocked)
                            case .macUnlocked: noticeSink.yield(.macUnlocked)
                            case let .displays(count, current): noticeSink.yield(.displays(count: count, current: current))
                            case let .keyboardState(id, state, result): noticeSink.yield(.keyboardState(id: id, state, result))
                            case let .spaceResult(action, result): noticeSink.yield(.spaceResult(action, result))
                            case .spaceChanged: noticeSink.yield(.spaceChanged)
                            case .videoQuality(let quality): noticeSink.yield(.videoQuality(quality))
                            case .inputAvailability(let reason): noticeSink.yield(.inputAvailability(reason))
                            case .pointerPosition(let position): noticeSink.yield(.pointerPosition(position))
                            case let .textAndReturnResult(id, result): noticeSink.yield(.textAndReturnResult(id: id, result))
                            default: throw ScreenControlWireError.malformed
                            }
                        case .video:
                            let frame = try VideoFrame(decoding: record.payload)
                            do {
                                continuation.yield(try builder.picture(for: frame))
                                waitingForKeyframe = false
                            } catch VideoError.needKeyframe {
                                // Ask once; delta frames until the keyframe are useless anyway.
                                if !waitingForKeyframe { try await connection.send(ControlMessage.requestKeyframe) }
                                waitingForKeyframe = true
                            }
                        default: continue
                        }
                    }
                    continuation.finish()
                } catch {
                    // The first refusal ends the session for good, as the channel does for a refused record.
                    connection.close()
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Queues one input event; it is sent after every event queued before it. Safe to call from the main thread.
    public func input(_ event: InputEvent) { enqueue(.input(event)) }

    /// Version-3 controls share the input sender, so a language switch cannot overtake its preceding key release.
    public func desktopControl(_ message: ControlMessage) throws {
        guard message.minimumVersion == 3, message.sender == .device, connection.version >= 3 else { throw ChannelError.notNegotiated }
        _ = try ControlMessage(decoding: message.encoded, version: connection.version)
        enqueue(.control(message))
    }

    private func enqueue(_ item: Outgoing) {
        if case .dropped = inputs.yield(item) {
            // Losing a release or language command would corrupt input ordering. End rather than silently drop it.
            inputs.finish(); connection.close()
        }
    }

    /// For when the display layer failed and needs to start again from a keyframe.
    public func requestKeyframe() async throws { try await connection.send(ControlMessage.requestKeyframe) }

    /// The version the key exchange settled on. A version-1 Mac tells nothing of its lock state or displays and takes
    /// none of the requests below.
    public var protocolVersion: UInt16 { connection.version }

    /// Whether the Mac takes display, cursor and turn-off requests and tells its lock state (version 2).
    public var macHasSessionControls: Bool { connection.version >= 2 }

    /// Asks the Mac for its next display; `notices` then names the one shown. Throws `ChannelError.notNegotiated` with a
    /// version-1 Mac, before sending anything.
    public func nextDisplay() async throws { try await connection.send(ControlMessage.nextDisplay) }

    /// Asks the Mac for display `index`, from 0 (version 2).
    public func selectDisplay(_ index: Int) async throws { try await connection.send(ControlMessage.selectDisplay(index)) }

    /// Leaves the Mac's cursor out of the picture, or puts it back: in trackpad mode the phone draws its own. Does
    /// nothing with a version-1 Mac, whose picture keeps its cursor.
    public func setMacCursorHidden(_ hidden: Bool) async throws {
        guard macHasSessionControls else { return }
        try await connection.send(hidden ? ControlMessage.hideCursor : .showCursor)
    }

    /// Turns screen control off at the Mac, as its menu's 「끄기」 does; the Mac then ends this session with
    /// `SessionEndReason.turnedOffFromDevice`. `approval` is a Face ID approval asked for this, used once: a second
    /// call with it throws `HandshakeError.alreadyUsed`. With a version-1 Mac it throws `ChannelError.notNegotiated`
    /// before using the approval or sending anything.
    public func turnOffScreenControl(approval: BiometricApproval) async throws {
        guard macHasSessionControls else { throw ChannelError.notNegotiated }
        guard approval.claim() else { throw HandshakeError.alreadyUsed }
        try await connection.send(ControlMessage.turnOff)
    }

    public func close() async {
        inputs.finish()
        noticeSink.finish()
        try? await connection.send(.close, Data())
        connection.close()
    }
}

/// Face ID for one action inside a session, biometrics only (DESIGN 「Face ID 실패 시」): a failed Face ID does not fall
/// back to the passcode. The Mac cannot see the prompt; it trusts the session, whose key exchange already needed Face ID.
/// This makes the phone ask again before an action that cannot be undone from the phone, and the approval works once.
public final class BiometricApproval: Sendable {
    private let used = Once()

    /// Hardware-specific wording; this lookup never displays an authentication prompt.
    public static let methodName: String = {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return name(for: context.biometryType)
    }()

    static func name(for type: LABiometryType) -> String {
        switch type {
        case .touchID: "Touch ID"
        case .faceID: "Face ID"
        default: "생체 인증"
        }
    }

    /// Checks make one without the prompt; only `request` should elsewhere.
    init() {}

    public static func request(reason: String, authentication: ScreenDeviceAuthentication = .biometricsOnly) async throws -> BiometricApproval {
        let context: LAContext
        if authentication == .biometricsOnly {
            context = try await biometricContext(reason: reason)
        } else {
            context = LAContext()
            do {
                guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else {
                    throw LAError(.authenticationFailed)
                }
            } catch {
                context.invalidate()
                throw error
            }
        }
        context.invalidate()
        return BiometricApproval()
    }

    /// Apple's lockout recovery policy may ask for the device passcode. It only re-enables biometry:
    /// this context never touches a device key and returns no approval or signer. Discard it even on success;
    /// a later Mac connection must create its own context and satisfy the protected key's biometric ACL.
    public static func recoverLockout(reason: String) async throws {
        try await recoverLockout(authenticateOwner: {
            let context = LAContext()
            defer { context.invalidate() }
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        }, verifyBiometry: {
            // Owner authentication can succeed while the OS still refuses biometry. Check a fresh context,
            // after discarding the passcode context, before telling the person the lockout was recovered.
            let context = LAContext()
            defer { context.invalidate() }
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
                throw error ?? LAError(.biometryNotAvailable) as NSError
            }
        })
    }

    static func recoverLockout(authenticateOwner: @Sendable () async throws -> Bool,
                               verifyBiometry: @Sendable () throws -> Void) async throws {
        guard try await authenticateOwner() else {
            throw LAError(.authenticationFailed)
        }
        try verifyBiometry()
    }

    /// True the first time only.
    func claim() -> Bool { used.claim() }

    /// A context Face ID (or Touch ID) has just approved, with no passcode fallback.
    static func biometricContext(reason: String) async throws -> LAContext {
        let context = LAContext()
        context.localizedFallbackTitle = ""
        _ = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        return context
    }
}

/// The phone's device key, approved by Face ID for one connection (SR-12). Approve *before* connecting, so the Mac's
/// five-second deadline covers the network and the cryptography, not the person. The approval signs that
/// connection's transcript once and is then invalidated; the next connection asks again.
public enum ScreenDeviceAuthentication: String, Codable, Sendable {
    case biometricsOnly
    case deviceOwner

    var accessFlags: SecAccessControlCreateFlags {
        switch self {
        case .biometricsOnly: [.privateKeyUsage, .biometryCurrentSet]
        case .deviceOwner: [.privateKeyUsage, .userPresence]
        }
    }
}

public final class FaceIDApprovedSigner: TranscriptSigner, @unchecked Sendable {
    public let publicKey: P256.Signing.PublicKey
    private let key: SecureEnclave.P256.Signing.PrivateKey
    private let context: LAContext
    private let used = Once()

    init(dataRepresentation: Data, context: LAContext) throws {
        self.context = context
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: dataRepresentation, authenticationContext: context)
        publicKey = key.publicKey
    }

    /// The Secure Enclave key enforces its registration-time authentication choice. Existing keys remain biometric-only.
    public static func approve(dataRepresentation: Data, reason: String,
                               authentication: ScreenDeviceAuthentication = .biometricsOnly) async throws -> FaceIDApprovedSigner {
        // Authorize the actual protected key, not just a generic LA policy. The key ACL remains authoritative.
        // The same key reference/context is retained for the one transcript signature;
        // reopening the key after disabling interaction can lose the authorization obtained by a policy prompt.
        // Run this blocking Secure Enclave operation away from the UI executor. The probe is local and domain
        // separated: it is never sent to a Mac and cannot serve as a handshake signature.
        try await Task.detached {
            let context = LAContext()
            context.localizedReason = reason
            if authentication == .biometricsOnly { context.localizedFallbackTitle = "" }
            do {
                let signer = try FaceIDApprovedSigner(dataRepresentation: dataRepresentation, context: context)
                let nonce = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
                let probe = Data("agentstoz.screen-control.key-approval/v1\n".utf8) + nonce
                _ = try signer.key.signature(for: probe)
                // No second prompt during the bounded handshake; a new connection always gets a fresh context.
                context.interactionNotAllowed = true
                return signer
            } catch {
                context.invalidate()
                throw error
            }
        }.value
    }

    public func signature(for data: Data) async throws -> P256.Signing.ECDSASignature {
        guard used.claim() else { throw HandshakeError.alreadyUsed }
        defer { context.invalidate() }
        return try key.signature(for: data)
    }

    deinit { context.invalidate() }

    /// The device key is created at registration and remains on this device. Biometric-only keys are bound to the
    /// current enrollment; owner-authentication keys additionally allow the device passcode.
    public static func createDeviceKey(authentication: ScreenDeviceAuthentication = .biometricsOnly) throws -> Data {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           authentication.accessFlags, &error) else {
            throw error.map { $0.takeRetainedValue() as Error } ?? HandshakeError.malformed
        }
        return try SecureEnclave.P256.Signing.PrivateKey(accessControl: access).dataRepresentation
    }
}
