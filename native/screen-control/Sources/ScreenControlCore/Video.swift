import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox
import os

// H.264 for `.video` records (DESIGN S0-4: hardware, Constrained High, no B-frames, real-time, low-latency rate
// control). The Mac encodes, the phone decodes; both sides share the wire format so a check can run the whole loop
// on one Mac. The phone decodes only what an authenticated channel opened, and still parses it strictly.

public enum VideoError: Error, Equatable, Sendable {
    case malformed
    /// A delta frame arrived before any keyframe, or after the stream changed; ask the Mac for a keyframe.
    case needKeyframe
    case codec(OSStatus)
}

/// One encoded picture as it travels in a `.video` record:
/// flags(1) ‖ parameter-set count(1) ‖ timestamp µs(8, big-endian) ‖ [length(2) ‖ parameter set]… ‖ AVCC NAL units.
/// A keyframe carries its SPS and PPS, so the phone can start from any keyframe; a delta frame carries none.
public struct VideoFrame: Equatable, Sendable {
    public static let maxParameterSet = 1024
    static let headerSize = 10

    public let isKeyframe: Bool
    /// Presentation time in microseconds.
    public let timestamp: UInt64
    public let parameterSets: [Data]
    /// AVCC: a 4-byte big-endian length before each NAL unit.
    public let data: Data

    public init(isKeyframe: Bool, timestamp: UInt64, parameterSets: [Data], data: Data) throws {
        // A keyframe has one SPS then one to three PPS; a delta frame none.
        if isKeyframe {
            guard (2...4).contains(parameterSets.count),
                  parameterSets.allSatisfy({ (1...Self.maxParameterSet).contains($0.count) }),
                  Self.nalType(parameterSets[0]) == 7,
                  parameterSets.dropFirst().allSatisfy({ Self.nalType($0) == 8 }) else { throw VideoError.malformed }
        } else {
            guard parameterSets.isEmpty else { throw VideoError.malformed }
        }
        guard Self.isAVCC(data) else { throw VideoError.malformed }
        self.isKeyframe = isKeyframe
        self.timestamp = timestamp
        self.parameterSets = parameterSets
        self.data = data
    }

    public init(decoding payload: Data) throws {
        let start = payload.startIndex
        guard payload.count >= Self.headerSize, payload[start] <= 1 else { throw VideoError.malformed }
        var index = start + Self.headerSize
        var sets: [Data] = []
        for _ in 0..<Int(payload[start + 1]) {
            guard payload.endIndex - index >= 2 else { throw VideoError.malformed }
            let length = Int(payload[index]) << 8 | Int(payload[index + 1])
            index += 2
            guard payload.endIndex - index >= length else { throw VideoError.malformed }
            sets.append(payload.subdata(in: index..<index + length))
            index += length
        }
        try self.init(isKeyframe: payload[start] == 1,
                      timestamp: payload[(start + 2)..<(start + Self.headerSize)].reduce(0) { $0 << 8 | UInt64($1) },
                      parameterSets: sets, data: payload.subdata(in: index..<payload.endIndex))
    }

    public func encoded() -> Data {
        var out = Data([isKeyframe ? 1 : 0, UInt8(parameterSets.count)]) + timestamp.bigEndianData
        for set in parameterSets { out += UInt16(set.count).bigEndianData + set }
        return out + data
    }

    static func nalType(_ unit: Data) -> UInt8 { (unit.first ?? 0) & 0x1F }

    /// Non-empty, and every NAL unit is non-empty and ends exactly where the next length begins.
    static func isAVCC(_ data: Data) -> Bool {
        data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard !bytes.isEmpty else { return false }
            var index = 0
            while index < bytes.count {
                guard bytes.count - index >= 4 else { return false }
                let length = (index..<index + 4).reduce(0) { $0 << 8 | Int(bytes[$1]) }
                index += 4
                guard length > 0, bytes.count - index >= length else { return false }
                index += length
            }
            return true
        }
    }

    /// A sample buffer for VideoToolbox or `AVSampleBufferDisplayLayer`.
    public func sampleBuffer(format: CMVideoFormatDescription) throws -> CMSampleBuffer {
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: data.count, blockAllocator: nil,
                                                        customBlockSource: nil, offsetToData: 0, dataLength: data.count,
                                                        flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        guard status == noErr, let block else { throw VideoError.codec(status) }
        status = data.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: $0.count)
        }
        guard status == noErr else { throw VideoError.codec(status) }
        var timing = CMSampleTimingInfo(duration: .invalid, presentationTimeStamp: CMTime(value: Int64(clamping: timestamp), timescale: 1_000_000),
                                        decodeTimeStamp: .invalid)
        var size = data.count
        var sample: CMSampleBuffer?
        status = CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
                                           sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                           sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        guard status == noErr, let sample else { throw VideoError.codec(status) }
        return sample
    }

    /// The format a keyframe's parameter sets describe. Refuses pictures larger than any display this serves.
    public static func format(_ parameterSets: [Data]) throws -> CMVideoFormatDescription {
        let pointers = parameterSets.map { set -> UnsafeMutablePointer<UInt8> in
            let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: set.count)
            set.copyBytes(to: pointer, count: set.count)
            return pointer
        }
        defer { pointers.forEach { $0.deallocate() } }
        var format: CMVideoFormatDescription?
        let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
            allocator: nil, parameterSetCount: parameterSets.count, parameterSetPointers: pointers.map { UnsafePointer($0) },
            parameterSetSizes: parameterSets.map(\.count), nalUnitHeaderLength: 4, formatDescriptionOut: &format)
        guard status == noErr, let format else { throw VideoError.malformed }
        let size = CMVideoFormatDescriptionGetDimensions(format)
        guard (1...8192).contains(size.width), (1...8192).contains(size.height) else { throw VideoError.malformed }
        return format
    }
}

/// `.control` records: a tag byte, then exactly the bytes that tag defines, nothing else, so there is nothing to parse
/// loosely. Each message has one sender, like the record types, and the receiver ends the session on one only the
/// other side may send. Version 1 knows tags 1–3; version 2 adds the rest. A session never carries a message newer than
/// the version its key exchange settled on: the sender refuses to seal one (`SecureConnection.send(_:)`) and the
/// receiver refuses to read one (`init(decoding:version:)`).
public enum ControlMessage: Equatable, Sendable {
    /// Phone → Mac. The phone joined late or lost its decoder state: the Mac's next frame is a keyframe.
    case requestKeyframe
    /// Mac → phone. Someone at the Mac is using its own mouse or keyboard; the Mac drops the phone's input until
    /// `remoteInputResumed` (local input wins).
    case remoteInputPaused
    /// Mac → phone. The Mac takes the phone's input again.
    case remoteInputResumed
    /// Mac → phone, version 2. The Mac's screen is locked, as the system reports it: shown outside the picture, so a
    /// lock screen drawn by some process on the Mac is not taken for the real one.
    case macLocked
    /// Mac → phone, version 2. The Mac's screen is not locked.
    case macUnlocked
    /// Mac → phone, version 2. How many displays the phone may choose between and which one it sees, from 0. Sent when
    /// the session starts and after every change.
    case displays(count: Int, current: Int)
    /// Phone → Mac, version 2. Show the next display, after the last the first.
    case nextDisplay
    /// Phone → Mac, version 2. Show display `index` of the Mac's list, from 0. An index past the end changes nothing.
    case selectDisplay(Int)
    /// Phone → Mac, version 2. Leave the Mac's cursor out of the picture: the phone draws its own (trackpad mode).
    case hideCursor
    /// Phone → Mac, version 2. Put the Mac's cursor back in the picture.
    case showCursor
    /// Phone → Mac, version 2. Turn screen control off at the Mac, as its menu's 「끄기」 does. The phone asks for Face ID
    /// first; turning it on again happens only at the Mac.
    case turnOff

    /// The most displays a session names; a Mac with more offers the first sixteen.
    public static let maxDisplays = 16

    private enum Tag: UInt8 {
        case requestKeyframe = 1, remoteInputPaused, remoteInputResumed, macLocked, macUnlocked, displays, nextDisplay,
             selectDisplay, hideCursor, showCursor, turnOff
    }

    /// `version` is the session's negotiated version: a message newer than it is malformed there.
    public init(decoding payload: Data, version: UInt16 = 1) throws {
        let bytes = [UInt8](payload)
        guard let first = bytes.first, let tag = Tag(rawValue: first) else { throw ScreenControlWireError.malformed }
        let message: ControlMessage
        switch (tag, bytes.count) {
        case (.requestKeyframe, 1): message = .requestKeyframe
        case (.remoteInputPaused, 1): message = .remoteInputPaused
        case (.remoteInputResumed, 1): message = .remoteInputResumed
        case (.macLocked, 1): message = .macLocked
        case (.macUnlocked, 1): message = .macUnlocked
        case (.displays, 3):
            let count = Int(bytes[1]), current = Int(bytes[2])
            guard (1...Self.maxDisplays).contains(count), current < count else { throw ScreenControlWireError.malformed }
            message = .displays(count: count, current: current)
        case (.nextDisplay, 1): message = .nextDisplay
        case (.selectDisplay, 2):
            guard Int(bytes[1]) < Self.maxDisplays else { throw ScreenControlWireError.malformed }
            message = .selectDisplay(Int(bytes[1]))
        case (.hideCursor, 1): message = .hideCursor
        case (.showCursor, 1): message = .showCursor
        case (.turnOff, 1): message = .turnOff
        default: throw ScreenControlWireError.malformed
        }
        guard message.minimumVersion <= version else { throw ScreenControlWireError.malformed }
        self = message
    }

    public var sender: ChannelRole {
        switch self {
        case .requestKeyframe, .nextDisplay, .selectDisplay, .hideCursor, .showCursor, .turnOff: .device
        case .remoteInputPaused, .remoteInputResumed, .macLocked, .macUnlocked, .displays: .mac
        }
    }

    /// The first session version that carries this message.
    public var minimumVersion: UInt16 {
        switch self {
        case .requestKeyframe, .remoteInputPaused, .remoteInputResumed: 1
        default: 2
        }
    }

    /// The wire form. Values outside the ranges above produce bytes no receiver accepts; `SecureConnection.send(_:)`
    /// refuses to send those.
    public var encoded: Data {
        switch self {
        case .requestKeyframe: Data([Tag.requestKeyframe.rawValue])
        case .remoteInputPaused: Data([Tag.remoteInputPaused.rawValue])
        case .remoteInputResumed: Data([Tag.remoteInputResumed.rawValue])
        case .macLocked: Data([Tag.macLocked.rawValue])
        case .macUnlocked: Data([Tag.macUnlocked.rawValue])
        case let .displays(count, current): Data([Tag.displays.rawValue, UInt8(clamping: count), UInt8(clamping: current)])
        case .nextDisplay: Data([Tag.nextDisplay.rawValue])
        case .selectDisplay(let index): Data([Tag.selectDisplay.rawValue, UInt8(clamping: index)])
        case .hideCursor: Data([Tag.hideCursor.rawValue])
        case .showCursor: Data([Tag.showCursor.rawValue])
        case .turnOff: Data([Tag.turnOff.rawValue])
        }
    }
}

#if os(macOS)
// The Mac encodes; the phone never sends a screen.
/// Hardware H.264, tuned for latency: real-time, no frame reordering, low-latency rate control.
/// `output` runs on VideoToolbox's thread, once per frame that was not dropped.
public final class VideoEncoder: @unchecked Sendable {
    public struct Settings: Sendable {
        public var width: Int
        public var height: Int
        public var averageBitRate = 4_000_000
        public var framesPerSecond = 30
        /// A keyframe at least this often, so a phone that missed one recovers.
        public var keyframeInterval: Double = 10

        public init(width: Int, height: Int) {
            self.width = width
            self.height = height
        }
    }

    private let session: VTCompressionSession
    private let output: @Sendable (Result<VideoFrame, VideoError>) -> Void
    private let forceKeyframe = OSAllocatedUnfairLock(initialState: false)

    public init(_ settings: Settings, output: @escaping @Sendable (Result<VideoFrame, VideoError>) -> Void) throws {
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        ]
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(settings.width), height: Int32(settings.height),
                                                codecType: kCMVideoCodecType_H264, encoderSpecification: specification as CFDictionary,
                                                imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil,
                                                refcon: nil, compressionSessionOut: &created)
        guard status == noErr, let created else { throw VideoError.codec(status) }
        let properties: [CFString: Any] = [
            kVTCompressionPropertyKey_RealTime: true,
            kVTCompressionPropertyKey_AllowFrameReordering: false,
            kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_ConstrainedHigh_AutoLevel,
            kVTCompressionPropertyKey_AverageBitRate: settings.averageBitRate,
            kVTCompressionPropertyKey_ExpectedFrameRate: settings.framesPerSecond,
            kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: settings.keyframeInterval,
        ]
        for (key, value) in properties {
            let result = VTSessionSetProperty(created, key: key, value: value as CFTypeRef)
            guard result == noErr else {
                VTCompressionSessionInvalidate(created)
                throw VideoError.codec(result)
            }
        }
        VTCompressionSessionPrepareToEncodeFrames(created)
        session = created
        self.output = output
    }

    deinit { VTCompressionSessionInvalidate(session) }

    public func encode(_ image: CVPixelBuffer, at time: CMTime) {
        let force = forceKeyframe.withLock { force in defer { force = false }; return force }
        let options = force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: image, presentationTimeStamp: time, duration: .invalid,
                                                     frameProperties: options, infoFlagsOut: nil) { [output] status, flags, sample in
            if flags.contains(.frameDropped) { return }
            output(Self.frame(status: status, sample: sample))
        }
        if status != noErr { output(.failure(.codec(status))) }
    }

    /// The next frame will be a keyframe: the phone joined late or lost its decoder state.
    public func requestKeyframe() { forceKeyframe.withLock { $0 = true } }

    /// Emits every frame still inside the encoder.
    public func flush() { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }

    static func frame(status: OSStatus, sample: CMSampleBuffer?) -> Result<VideoFrame, VideoError> {
        guard status == noErr, let sample, let block = CMSampleBufferGetDataBuffer(sample),
              let format = CMSampleBufferGetFormatDescription(sample) else { return .failure(.codec(status)) }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let isKeyframe = !((attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
        var sets: [Data] = []
        if isKeyframe {
            var count = 0
            var headerLength: Int32 = 0
            var result = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                                            parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                                            nalUnitHeaderLengthOut: &headerLength)
            guard result == noErr, headerLength == 4 else { return .failure(.codec(result)) }
            for index in 0..<count {
                var pointer: UnsafePointer<UInt8>?
                var size = 0
                result = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                                                                            parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                                            nalUnitHeaderLengthOut: nil)
                guard result == noErr, let pointer else { return .failure(.codec(result)) }
                sets.append(Data(bytes: pointer, count: size))
            }
        }
        var data = Data(count: CMBlockBufferGetDataLength(block))
        let copied = data.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
        }
        guard copied == noErr else { return .failure(.codec(copied)) }
        let time = CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), timescale: 1_000_000, method: .default)
        do {
            return .success(try VideoFrame(isKeyframe: isKeyframe, timestamp: UInt64(max(0, time.value)), parameterSets: sets, data: data))
        } catch {
            return .failure(.malformed)
        }
    }
}
#endif

public struct DecodedFrame: @unchecked Sendable {
    public let image: CVPixelBuffer
    public let timestamp: UInt64
}

/// Decodes what the channel opened. Starts at a keyframe and restarts when a keyframe brings new parameter sets
/// (the Mac changed resolution). Call `decode` from one task; `output` runs on VideoToolbox's thread.
public final class VideoDecoder: @unchecked Sendable {
    private struct State {
        var parameterSets: [Data] = []
        var format: CMVideoFormatDescription?
        var session: VTDecompressionSession?
    }

    private let pixelFormat: OSType
    private let output: @Sendable (Result<DecodedFrame, VideoError>) -> Void
    private let state = OSAllocatedUnfairLock(uncheckedState: State())

    public init(pixelFormat: OSType = kCVPixelFormatType_32BGRA, output: @escaping @Sendable (Result<DecodedFrame, VideoError>) -> Void) {
        self.pixelFormat = pixelFormat
        self.output = output
    }

    deinit { state.withLockUnchecked { if let session = $0.session { VTDecompressionSessionInvalidate(session) } } }

    public func decode(_ frame: VideoFrame) throws {
        let (session, format) = try state.withLockUnchecked { state -> (VTDecompressionSession, CMVideoFormatDescription) in
            if frame.isKeyframe, frame.parameterSets != state.parameterSets {
                if let old = state.session { VTDecompressionSessionInvalidate(old) }
                state = State()
                let format = try VideoFrame.format(frame.parameterSets)
                let attributes: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: pixelFormat,
                                                   kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
                var created: VTDecompressionSession?
                let status = VTDecompressionSessionCreate(allocator: nil, formatDescription: format, decoderSpecification: nil,
                                                          imageBufferAttributes: attributes as CFDictionary, outputCallback: nil,
                                                          decompressionSessionOut: &created)
                guard status == noErr, let created else { throw VideoError.codec(status) }
                state = State(parameterSets: frame.parameterSets, format: format, session: created)
            }
            guard let session = state.session, let format = state.format else { throw VideoError.needKeyframe }
            return (session, format)
        }
        let timestamp = frame.timestamp
        let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: try frame.sampleBuffer(format: format), flags: [],
                                                       infoFlagsOut: nil) { [output] status, _, image, _, _ in
            guard status == noErr, let image else { return output(.failure(.codec(status))) }
            output(.success(DecodedFrame(image: image, timestamp: timestamp)))
        }
        guard status == noErr else { throw VideoError.codec(status) }
    }

    /// Waits until every frame handed to `decode` has come out.
    public func flush() {
        if let session = state.withLockUnchecked({ $0.session }) { VTDecompressionSessionWaitForAsynchronousFrames(session) }
    }
}
