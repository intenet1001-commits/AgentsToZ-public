import XCTest
@testable import ScreenHost
import ScreenControlCore

final class TextAndReturnTests: XCTestCase {
    func testUTF16ChunksPreserveSupplementaryScalarsAtBoundaries() {
        let samples = ["", String(repeating: "a", count: 20),
                       String(repeating: "a", count: 19) + "😀",
                       String(repeating: "가", count: 19) + "😀" + String(repeating: "b", count: 18) + "🚀tail",
                       String(repeating: "😀", count: 31)]
        for sample in samples {
            let chunks = screenTextUTF16Chunks(sample)
            XCTAssertEqual(chunks.flatMap { $0 }, Array(sample.utf16))
            for chunk in chunks {
                XCTAssertFalse(chunk.isEmpty)
                XCTAssertLessThanOrEqual(chunk.count, 20)
                XCTAssertFalse((0xDC00...0xDFFF).contains(chunk[0]))
                XCTAssertFalse((0xD800...0xDBFF).contains(chunk[chunk.count - 1]))
                XCTAssertEqual(Array(String(decoding: chunk, as: UTF16.self).utf16), chunk)
            }
        }
        XCTAssertEqual(screenTextUTF16Chunks(""), [])
        let boundary = screenTextUTF16Chunks(String(repeating: "a", count: 19) + "😀")
        XCTAssertEqual(boundary.map(\.count), [19, 2])
    }

    func testTextAlwaysPrecedesReturnAndTakeoverWithholdsIt() {
        var events: [String] = []
        let posted = performPreparedTextAndReturn(postText: { events.append("text"); return true }, mayPostReturn: { true },
                                                  postReturn: { events.append("return") })
        XCTAssertEqual(posted, .posted)
        XCTAssertEqual(events, ["text", "return"])
        events.removeAll()
        let interrupted = performPreparedTextAndReturn(postText: { events.append("text"); return true }, mayPostReturn: { false },
                                                       postReturn: { events.append("return") })
        XCTAssertEqual(interrupted, .unknown)
        XCTAssertEqual(events, ["text"])
        events.removeAll()
        let partial = performPreparedTextAndReturn(postText: { events.append("partial"); return false },
                                                   mayPostReturn: { true }, postReturn: { events.append("return") })
        XCTAssertEqual(partial, .unknown)
        XCTAssertEqual(events, ["partial"])
    }
}
