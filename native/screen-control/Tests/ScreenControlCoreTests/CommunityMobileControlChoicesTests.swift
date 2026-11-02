#if !CORE_CHECKS
import Foundation
import XCTest
@testable import ScreenControlCore
final class CommunityMobileControlChoicesTests: XCTestCase {
    private func data(_ value: [String:Any]) throws -> Data { try JSONSerialization.data(withJSONObject:value) }
    private func id() -> String { UUID().uuidString.lowercased() }
    func testActualOpsOpaqueContextIsAcceptedOnlyForAgentTargets() throws {
        let token = "ops_"+String(repeating:"a",count:64), value: [String:Any] = ["targets":[["context":token,"name":"현재 OPS"]]]
        XCTAssertEqual(try CommunityMobileControlChoicePage.decode(data(value),purpose:.agent,operation:"targets").choices.first?.id,token)
        XCTAssertThrowsError(try CommunityMobileControlChoicePage.decode(data(["targets":[["context":id(),"name":"OPS"]]]),purpose:.agent,operation:"targets"))
        XCTAssertThrowsError(try CommunityMobileControlChoicePage.decode(data(value.merging(["nextCursor":id()]){$1}),purpose:.agent,operation:"targets"))
        for (purpose,op,key,label) in [(CommunityMobileControlPurpose.teams,"projects","projects","name"),(.agentSettings,"contexts","contexts","label"),(.browser,"contexts","contexts","label")] {
            XCTAssertThrowsError(try CommunityMobileControlChoicePage.decode(data([key:[["context":token,label:"대상"]]]),purpose:purpose,operation:op))
            XCTAssertNoThrow(try CommunityMobileControlChoicePage.decode(data([key:[["context":id(),label:"대상"]]]),purpose:purpose,operation:op))
        }
    }
    func testActualPagedListsPreserveStrictFieldsAndAccumulateAll33Choices() throws {
        for (purpose,op,key,label) in [(CommunityMobileControlPurpose.teams,"projects","projects","name"),(.agentSettings,"contexts","contexts","label"),(.browser,"contexts","contexts","label")] {
            let cursor = id(), rows = (0..<32).map { ["context":id(),label:"대상 \($0)"] }
            let first = try CommunityMobileControlChoicePage.decode(data([key:rows,"nextCursor":cursor]),purpose:purpose,operation:op)
            var list = CommunityMobileControlChoiceList(); try list.accept(first)
            XCTAssertEqual(list.choices.count,32); XCTAssertEqual(list.nextCursor,cursor)
            let final = try CommunityMobileControlChoicePage.decode(data([key:[["context":id(),label:"마지막"]]]),purpose:purpose,operation:op)
            XCTAssertThrowsError(try list.accept(final,following:id()))
            try list.accept(final,following:cursor); XCTAssertEqual(list.choices.count,33); XCTAssertNil(list.nextCursor)
            XCTAssertThrowsError(try CommunityMobileControlChoicePage.decode(data([key:rows,"nextCursor":NSNull()]),purpose:purpose,operation:op))
            XCTAssertThrowsError(try CommunityMobileControlChoicePage.decode(data([key:rows,"nextCursor":cursor,"endpoint":"hidden"]),purpose:purpose,operation:op))
        }
    }
    func testCursorLoopsDuplicatesAndUnlimitedAccumulationAreRejectedOrBounded() throws {
        let cursor = id(), row = ["context":id(),"name":"프로젝트"]
        var list = CommunityMobileControlChoiceList()
        try list.accept(.decode(data(["projects":[row],"nextCursor":cursor]),purpose:.teams,operation:"projects"))
        XCTAssertThrowsError(try list.accept(.decode(data(["projects":[["context":id(),"name":"다음"]],"nextCursor":cursor]),purpose:.teams,operation:"projects"),following:cursor))
        XCTAssertThrowsError(try list.accept(.decode(data(["projects":[row]]),purpose:.teams,operation:"projects"),following:cursor))
        list = .init()
        for index in 0..<7 {
            let following = list.nextCursor
            let page = try CommunityMobileControlChoicePage.decode(data(["projects":(0..<32).map { ["context":id(),"name":"\(index)-\($0)"] },"nextCursor":id()]),purpose:.teams,operation:"projects")
            try list.accept(page,following:following)
        }
        XCTAssertEqual(list.choices.count,200); XCTAssertTrue(list.limitReached); XCTAssertNil(list.nextCursor)
    }
}
#endif
