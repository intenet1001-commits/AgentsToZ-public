#if os(macOS)
import Foundation

enum ViewerCommunityText {
    /// Presentation only: a shorter device label never resolves or matches a registered key.
    static func deviceName(_ raw: String) -> String {
        let suffix = " / 아젠투지(OPS)"
        guard raw.hasSuffix(suffix) else { return raw }
        let name = String(raw.dropLast(suffix.count))
        return name.isEmpty ? raw : name
    }

    static func lastResponse(_ date: Date?, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        guard let date else { return "최근 응답 시각 없음" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy년 M월 d일 HH:mm"
        return "최근 응답: " + formatter.string(from: date)
    }
}
#endif
