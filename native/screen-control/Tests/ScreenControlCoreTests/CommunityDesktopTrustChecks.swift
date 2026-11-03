#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

final class CommunityDesktopTrustChecks:XCTestCase {
    private func fixture() throws -> [String:Any] {
        let file=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-desktop-trust-v1.json")
        return try JSONSerialization.jsonObject(with:Data(contentsOf:file)) as! [String:Any]
    }
    private func key(_ scalar:UInt8=7) throws -> P256.Signing.PrivateKey { var data=Data(repeating:0,count:32);data[31]=scalar;return try .init(rawRepresentation:data) }
    private func authority(_ f:[String:Any]) throws -> ScreenCommunityAuthority {
        let a=f["authority"] as! [String:String]
        return try .init(origin:URL(string:a["origin"]!)!,issuer:key().publicKey,profileID:a["profileId"]!)
    }
    private func signed(_ body:[String:Any],authority:ScreenCommunityAuthority,signer:P256.Signing.PrivateKey?=nil,now:Date=Date()) throws -> CommunityAuthorization {
        let bytes=try JSONSerialization.data(withJSONObject:[2,"authorization",UUID().uuidString.lowercased(),body["issuedAt"]!,body],options:.withoutEscapingSlashes)
        let envelope=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(try (signer ?? key()).signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes).rawRepresentation))
        return try CommunityAccessReply.verify(envelope,authority:authority,now:now).authorization(authority:authority,now:now)
    }
    private func body(_ f:[String:Any],_ name:String,now:Date=Date())->[String:Any] {
        var b=f[name] as! [String:Any];let at=Int64(now.timeIntervalSince1970*1000);b["issuedAt"]=at;b["expiresAt"]=at+90_000;return b
    }
    private func pair(_ f:[String:Any],now:Date=Date()) throws -> (ScreenCommunityAuthority,CommunityAuthorization,CommunityAuthorization) {
        let a=try authority(f);return (a,try signed(body(f,"controller",now:now),authority:a,now:now),try signed(body(f,"receiver",now:now),authority:a,now:now))
    }
    func testOldEightCapabilityOrderAndMobileOrStandaloneTrustRefusal() throws {
        let old:[CommunityCapability]=[.screenView,.screenControl,.receiveView,.receiveControl,.communicate,.teams,.agentSettings,.browser]
        XCTAssertEqual(try CommunityCapability.normalized(old,kind:.desktop),old)
        XCTAssertEqual(Array(CommunityCapability.allCases.prefix(8)),old)
        XCTAssertThrowsError(try CommunityCapability.normalized([.screenView,.desktopTrust],kind:.mobile))
        XCTAssertThrowsError(try CommunityCapability.normalized([.desktopTrust],kind:.desktop))
        XCTAssertEqual(try CommunityCapability.normalized([.screenView,.desktopTrust],kind:.desktop),[.screenView,.desktopTrust])
    }
    func testSharedSoftwareDirectAndDirectoryCredentialsBindTheExactSignedEntries() throws {
        let f=try fixture(),a=try authority(f),now=Date(timeIntervalSince1970:(f["at"] as! NSNumber).doubleValue/1000)
        func envelope(_ name:String)throws->ScreenCommunityEnvelope { try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:f[name]!)) }
        let c=try CommunityAccessReply.verify(envelope("controllerEnvelope"),authority:a,now:now).authorization(authority:a,now:now)
        let r=try CommunityAccessReply.verify(envelope("receiverEnvelope"),authority:a,now:now).authorization(authority:a,now:now)
        let rows=try CommunityAccessReply.verify(envelope("directoryEnvelope"),authority:a,now:now).directory(authority:a,communityId:c.body.communityId,now:now)
        let trust=try CommunityDesktopScreenTrust.verified(authority:a,controller:rows[0],receiver:rows[1],channelId:UUID().uuidString.lowercased(),now:now)
        XCTAssertTrue(trust.canControl);XCTAssertEqual(trust.controller,c.body);XCTAssertEqual(trust.receiver,r.body)
        let substituted=CommunityAuthorization(body:r.body,envelope:c.envelope)
        XCTAssertThrowsError(try CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:substituted,now:now))
    }
    func testAbsentOneSidedForeignAndExpiredTrustNeverConstructSessionAuthority() throws {
        let f=try fixture(),now=Date(),(a,c,r)=try pair(f,now:now)
        var no=body(f,"receiver",now:now);no["capabilities"]=["screen.receive.view","screen.receive.control"]
        let legacy=try signed(no,authority:a,now:now)
        XCTAssertThrowsError(try CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:legacy,now:now))
        no["capabilities"]=["screen.receive.view","screen.receive.control","screen.desktop-trust"];no["communityId"]=UUID().uuidString.lowercased()
        XCTAssertThrowsError(try CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:signed(no,authority:a,now:now),now:now))
        let other=try ScreenCommunityAuthority(origin:a.origin,issuer:key(9).publicKey,profileID:a.profileID)
        XCTAssertThrowsError(try CommunityDesktopScreenTrust.verified(authority:other,controller:c,receiver:r,now:now))
        XCTAssertThrowsError(try CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:r,now:now.addingTimeInterval(91)))
        let selection=try CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:r,now:now)
        XCTAssertThrowsError(try CommunityDesktopTrustLease(selection,now:now),"A selected device is not an authenticated channel")
    }
    func testLeaseRenewalPreservesPolicyAndInvalidatedLeaseNeverRevivesAReplacement() throws {
        let f=try fixture(),now=Date(),(a,c,r)=try pair(f,now:now),channel=UUID().uuidString.lowercased()
        let first=try CommunityDesktopTrustLease(CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:r,channelId:channel,now:now),now:now)
        let (_,freshC,freshR)=try pair(f,now:now.addingTimeInterval(20))
        XCTAssertNoThrow(try first.renew(controller:freshC,receiver:freshR,now:now.addingTimeInterval(20)))
        var changed=body(f,"receiver",now:now.addingTimeInterval(21));changed["revision"]=(r.body.revision+1)
        XCTAssertThrowsError(try first.renew(controller:freshC,receiver:signed(changed,authority:a,now:now.addingTimeInterval(21)),now:now.addingTimeInterval(21)))
        let second=try CommunityDesktopTrustLease(CommunityDesktopScreenTrust.verified(authority:a,controller:freshC,receiver:freshR,channelId:UUID().uuidString.lowercased(),now:now.addingTimeInterval(20)),now:now.addingTimeInterval(20))
        first.invalidate();XCTAssertThrowsError(try first.renew(controller:freshC,receiver:freshR,now:now.addingTimeInterval(20)))
        XCTAssertNil(first.current());XCTAssertNotNil(second.current());XCTAssertNil(second.current(at:now.addingTimeInterval(111)))
    }
    func testViewOnlyAndInputHoldNeverBecomeControlThroughDeviceTrust() throws {
        let f=try fixture(),now=Date(),a=try authority(f)
        var b=body(f,"controller",now:now);b["capabilities"]=["screen.view","screen.desktop-trust"]
        let c=try signed(b,authority:a,now:now),r=try signed(body(f,"receiver",now:now),authority:a,now:now)
        let lease=try CommunityDesktopTrustLease(CommunityDesktopScreenTrust.verified(authority:a,controller:c,receiver:r,channelId:UUID().uuidString.lowercased(),now:now),now:now)
        XCTAssertFalse(lease.current()!.canControl)
        var state=ScreenMacState();state.hear(.sessionLimits(grant:.control,limits:.standard));state.hear(.inputAvailability(.ready));state.hear(.remoteInputResumed)
        XCTAssertFalse(ViewerInputGate.allows(state,pausedHere:false,desktopTrust:lease))
        let (_,fullC,fullR)=try pair(f,now:now),full=try CommunityDesktopTrustLease(CommunityDesktopScreenTrust.verified(authority:a,controller:fullC,receiver:fullR,channelId:UUID().uuidString.lowercased(),now:now),now:now)
        XCTAssertTrue(ViewerInputGate.allows(state,pausedHere:false,desktopTrust:full))
        state.hear(.inputHeldAtMac(true));XCTAssertFalse(ViewerInputGate.allows(state,pausedHere:false,desktopTrust:full))
    }
    func testReceiverOnTrustHasNoControllerOrHoldReleaseAuthority() throws {
        let f=try fixture(),now=Date(),(a,c,r)=try pair(f,now:now)
        XCTAssertNoThrow(try CommunityDesktopReceiveTrust.verified(authority:a,authorization:r,deviceID:r.body.deviceId,hostKey:r.body.hostPublicKey,now:now))
        XCTAssertThrowsError(try CommunityDesktopReceiveTrust.verified(authority:a,authorization:c,deviceID:c.body.deviceId,hostKey:c.body.hostPublicKey,now:now))
        XCTAssertThrowsError(try CommunityDesktopReceiveTrust.verified(authority:a,authorization:r,deviceID:c.body.deviceId,hostKey:r.body.hostPublicKey,now:now))
    }
}
#endif
