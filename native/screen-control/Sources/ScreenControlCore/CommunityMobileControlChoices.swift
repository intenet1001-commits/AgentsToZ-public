import Foundation

public struct CommunityMobileControlChoice: Equatable, Sendable, Identifiable {
    public let id: String, label: String
}
/// Purpose-specific opaque tokens are display/selection handles, never device IDs or endpoints.
public struct CommunityMobileControlChoicePage: Sendable {
    public let choices: [CommunityMobileControlChoice], nextCursor: String?
    public static func decode(_ bytes: Data, purpose: CommunityMobileControlPurpose, operation: String) throws -> Self {
        let value = try CommunityMobileControlJSON.object(bytes,maximum:16_000)
        let key: String, label: String, paged: Bool
        switch (purpose,operation) {
        case (.agent,"targets"): key = "targets"; label = "name"; paged = false
        case (.teams,"projects"): key = "projects"; label = "name"; paged = true
        case (.agentSettings,"contexts"),(.browser,"contexts"): key = "contexts"; label = "label"; paged = true
        default: throw ScreenCommunityError.malformed
        }
        guard Set(value.keys) == [key] || (paged && Set(value.keys) == [key,"nextCursor"]),
              let rows = value[key] as? [[String:Any]], rows.count <= (paged ? 32:1) else { throw ScreenCommunityError.malformed }
        let choices = try rows.map { row -> CommunityMobileControlChoice in
            guard Set(row.keys) == ["context",label], let id = row["context"] as? String, let text = row[label] as? String,
                  !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty, text.utf8.count <= 480,
                  !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw ScreenCommunityError.malformed }
            if purpose == .agent {
                guard id.range(of:"^ops_[0-9a-f]{64}$",options:.regularExpression) != nil else { throw ScreenCommunityError.malformed }
            } else { guard CommunityMobileControlBytes.id(id) else { throw ScreenCommunityError.malformed } }
            return .init(id:id,label:text)
        }
        guard Set(choices.map(\.id)).count == choices.count else { throw ScreenCommunityError.malformed }
        let cursor: String?
        if let raw = value["nextCursor"] {
            guard paged, let text = raw as? String, CommunityMobileControlBytes.id(text), !choices.isEmpty else { throw ScreenCommunityError.malformed }; cursor = text
        } else { cursor = nil }
        return .init(choices:choices,nextCursor:cursor)
    }
}
/// Each explicit next-page action must consume the currently issued cursor. No cycles or unlimited accumulation.
public struct CommunityMobileControlChoiceList: Sendable {
    public private(set) var choices: [CommunityMobileControlChoice] = []
    public private(set) var nextCursor: String?
    public private(set) var limitReached = false
    private var usedCursors: Set<String> = []
    public init() {}
    public mutating func accept(_ page: CommunityMobileControlChoicePage, following cursor: String? = nil) throws {
        var next = self
        if let cursor {
            guard next.nextCursor == cursor, next.usedCursors.insert(cursor).inserted else { throw ScreenCommunityError.wrongRequest }
        } else { next = .init() }
        guard page.nextCursor.map({ !next.usedCursors.contains($0) }) ?? true,
              Set(next.choices.map(\.id)).isDisjoint(with:Set(page.choices.map(\.id))) else { throw ScreenCommunityError.wrongRequest }
        let remaining = 200 - next.choices.count
        guard remaining > 0 || page.choices.isEmpty else { throw ScreenCommunityError.malformed }
        next.choices.append(contentsOf:page.choices.prefix(remaining))
        next.limitReached = page.choices.count > remaining || (next.choices.count == 200 && page.nextCursor != nil)
        next.nextCursor = next.limitReached ? nil:page.nextCursor
        self = next
    }
}
