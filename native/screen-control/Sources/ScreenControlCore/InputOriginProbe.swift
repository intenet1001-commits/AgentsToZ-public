import Foundation

/// Bounded, human-labelled S-M3 observations. This is diagnostic evidence, never hardware attestation, a
/// ScreenInputCalibration, or a permission grant. It retains no key codes, characters, coordinates or event payloads.
public struct InputOriginProbe: Sendable {
    public enum Source: String, CaseIterable, Codable, Sendable {
        case hardwareKeyboard, hardwarePointer, syntheticProcess, screenInjection
        case jumpDesktop, appleScreenSharing, virtualHID
        var hardware: Bool { self == .hardwareKeyboard || self == .hardwarePointer }
    }
    public struct Sample: Encodable, Equatable, Sendable {
        public let source: Source
        public let kind: String
        public let sourcePid: Int64
        public let keyboardType: Int64
        public let sourceState: Int64
        public var count: Int
    }
    public struct Report: Encodable, Sendable {
        public let format: Int
        public let purpose: String
        public let certifiesCalibration: Bool
        public let assessment: String
        public let missingSources: [Source]
        public let ambiguousSources: [Source]
        public let unavailableEvents: Int
        public let droppedEvents: Int
        public let truncated: Bool
        public let samples: [Sample]
    }
    public static let maximumSamples = 128
    public static let maximumEvents = 10_000
    private var samples: [Sample] = []
    private var events = 0
    private var unavailable = 0
    private var dropped = 0

    public init() {}

    /// A missing CGEvent is observable uncertainty, not proof that synthetic input was rejected.
    public mutating func record(source: Source, event: ScreenInputEvent?) {
        guard events < Self.maximumEvents else { dropped = min(dropped + 1, Self.maximumEvents); return }
        events += 1
        guard let event else { unavailable += 1; return }
        if let index = samples.firstIndex(where: {
            $0.source == source && $0.kind == event.kind.rawValue && $0.sourcePid == event.sourcePid
                && $0.keyboardType == event.keyboardType && $0.sourceState == event.sourceState
        }) {
            samples[index].count += 1
        } else if samples.count < Self.maximumSamples {
            samples.append(.init(source: source, kind: event.kind.rawValue, sourcePid: event.sourcePid,
                                 keyboardType: event.keyboardType, sourceState: event.sourceState, count: 1))
        } else { dropped = min(dropped + 1, Self.maximumEvents) }
    }

    public var report: Report {
        let seen = Set(samples.map(\.source))
        let missing = Source.allCases.filter { !seen.contains($0) }
        let hardware = samples.filter { $0.source.hardware && $0.sourcePid == 0 }
        let ambiguous = Source.allCases.filter { source in
            if source.hardware { return samples.contains { $0.source == source && $0.sourcePid != 0 } }
            return samples.contains { sample in
                sample.source == source && sample.sourcePid == 0 && hardware.contains {
                    $0.sourceState == sample.sourceState && $0.keyboardType == sample.keyboardType
                }
            }
        }
        let assessment = !ambiguous.isEmpty ? "ambiguous"
            : !missing.isEmpty || unavailable > 0 || dropped > 0 ? "incomplete" : "needs-human-review"
        return .init(format: 1, purpose: "human-labelled-input-origin-diagnostic", certifiesCalibration: false,
                     assessment: assessment, missingSources: missing, ambiguousSources: ambiguous,
                     unavailableEvents: unavailable, droppedEvents: dropped, truncated: dropped > 0,
                     samples: samples.sorted {
                         ($0.source.rawValue, $0.kind, $0.sourcePid, $0.keyboardType, $0.sourceState)
                             < ($1.source.rawValue, $1.kind, $1.sourcePid, $1.keyboardType, $1.sourceState)
                     })
    }
}
