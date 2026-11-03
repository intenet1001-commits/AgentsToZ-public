#if !CORE_CHECKS
import XCTest
import Foundation
import CryptoKit
@testable import ScreenControlCore

final class CommunityManagementChecks: XCTestCase {
    private struct Fixture {
        let object:[String:Any]
        let authority:ScreenCommunityAuthority
        let now:Date
        let certificate:ScreenCommunityCertificate
        let issuer:P256.Signing.PrivateKey
        init() throws {
            let path=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path:"Fixtures/community-access-management-v1.json")
            object=try JSONSerialization.jsonObject(with:Data(contentsOf:path)) as! [String:Any]
            let a=object["authority"] as! [String:String]
            now=Date(timeIntervalSince1970:(object["at"] as! NSNumber).doubleValue/1000)
            var scalar=Data(repeating:0,count:32);scalar[31]=7;issuer=try P256.Signing.PrivateKey(rawRepresentation:scalar)
            authority=try ScreenCommunityAuthority(origin:URL(string:a["origin"]!)!,issuer:P256.Signing.PublicKey(x963Representation:ScreenCommunityRequest.decodeBase64(a["issuerPublicKey"]!,max:87)),profileID:a["profileId"]!)
            let own=object["actor"] as! [String:Any]
            let envelope=try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:own["certificate"] as Any))
            certificate=try ScreenCommunityResponse.verify(envelope,issuer:authority.issuer,now:now).certificate(profileID:authority.profileID,deviceID:own["deviceId"] as! String,hostKey:ScreenCommunityRequest.decodeBase64(own["hostPublicKey"] as! String,max:87),viewerKey:ScreenCommunityRequest.decodeBase64(own["biometricPublicKey"] as! String,max:87),now:now)
        }
        var body:[String:Any] { object["review"] as! [String:Any] }
        func envelope(_ key:String) throws -> ScreenCommunityEnvelope { try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:JSONSerialization.data(withJSONObject:object[key] as Any)) }
        func reply(_ body:[String:Any]? = nil,kind:String="management-review",at:Date? = nil,key:P256.Signing.PrivateKey? = nil) throws -> CommunityAccessReply {
            if let body {
                let date=at ?? now,bytes=try JSONSerialization.data(withJSONObject:[2,kind,"77777777-7777-4777-8777-777777777777",Int64(date.timeIntervalSince1970*1000),body],options:.withoutEscapingSlashes)
                let sig=try (key ?? issuer).signature(for:Data("agentstoz.community-access.response/v2\0".utf8)+bytes)
                let wrapped=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(bytes),signature:ScreenCommunityRequest.base64(sig.rawRepresentation))
                let a=try ScreenCommunityAuthority(origin:authority.origin,issuer:(key ?? issuer).publicKey,profileID:authority.profileID)
                return try CommunityAccessReply.verify(wrapped,authority:a,now:now)
            }
            return try CommunityAccessReply.verify(envelope("reviewEnvelope"),authority:authority,now:now)
        }
    }
    func testExactWorkerSDKManagementBytesAndBoundBIOApprovalGolden() throws {
        let f=try Fixture(),reply=try f.reply(),review=try reply.managementReview(authority:f.authority,administrator:f.certificate,now:f.now)
        let intent=try XCTUnwrap(review.management)
        XCTAssertEqual(try intent.computedDigest(for:review),f.object["managementDigest"] as? String)
        XCTAssertEqual(try intent.bytes(for:review),try ScreenCommunityRequest.decodeBase64(f.object["managementBytes"] as! String,max:24000))
        XCTAssertEqual(review.approvalOperation,.approveManagement)
        let raw=try ScreenCommunityRequest.decodeBase64(f.object["approvalRequestBytes"] as! String,max:24000),fields=try JSONSerialization.jsonObject(with:raw) as! [Any]
        XCTAssertEqual(try JSONSerialization.data(withJSONObject:fields[6],options:.withoutEscapingSlashes),try review.approvalArguments(communityId:f.certificate.communityID))
        let proof=try f.envelope("approvalRequestEnvelope"),sig=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(proof.signature,max:86))
        XCTAssertTrue(try P256.Signing.PublicKey(x963Representation:f.certificate.member.viewerKey).isValidSignature(sig,for:Data("agentstoz.community-access.request/v2\0".utf8)+raw))
        XCTAssertThrowsError(try CommunityAccessRequest.validateHostProof(Data("agentstoz.community-access.request/v2\0".utf8)+raw,profileId:f.authority.profileID,deviceId:f.certificate.member.deviceID,hostKey:f.certificate.member.hostKey,biometricKey:f.certificate.member.viewerKey,certificate:f.certificate,now:f.now))
        XCTAssertNil(CommunityManagementChoice.unchanged.administrator);XCTAssertEqual(CommunityManagementChoice.grant.administrator,true);XCTAssertEqual(CommunityManagementChoice.revoke.administrator,false)
    }
    func testConfirmationIncludesManagementContextEvenWhenPlanAndChallengeStayEqual() throws {
        let f=try Fixture(),old=try f.reply().managementReview(authority:f.authority,administrator:f.certificate,now:f.now)
        var confirmation=CommunityEnrollmentConfirmation();confirmation.setConfirmed(true,for:old,now:f.now);XCTAssertTrue(confirmation.isConfirmed(for:old,now:f.now))
        var body=f.body,m=body["management"] as! [String:Any]
        let current=try XCTUnwrap(old.management),nonce=ScreenCommunityRequest.base64(Data(repeating:11,count:32))
        let changed=CommunityManagementIntent(version:current.version,communityId:current.communityId,targetEnrollmentId:current.targetEnrollmentId,targetKeyEpoch:current.targetKeyEpoch,previousAdministrator:current.previousAdministrator,administrator:current.administrator,issuedAt:current.issuedAt,nonce:nonce,digest:"")
        m["nonce"]=nonce;m["digest"]=try changed.computedDigest(for:old);body["management"]=m
        let next=try f.reply(body).managementReview(authority:f.authority,administrator:f.certificate,now:f.now)
        XCTAssertEqual(old.digest,next.digest);XCTAssertEqual(old.challenge,next.challenge);XCTAssertFalse(confirmation.isConfirmed(for:next,now:f.now))
        let normal=CommunityAccessReview(plan:old.plan,planId:old.planId,admin:old.admin,digest:old.digest,challenge:old.challenge,revision:old.revision,expiresAt:old.expiresAt)
        XCTAssertFalse(confirmation.isConfirmed(for:normal,now:f.now));XCTAssertEqual(normal.approvalOperation,.approve)
    }
    func testAlteredRoleDigestEpochNonceUnknownFieldsAndOtherIssuerAreRejected() throws {
        let f=try Fixture()
        for field in ["administrator","targetKeyEpoch","nonce","extra"] {
            var body=f.body,m=body["management"] as! [String:Any]
            switch field {case "administrator":m[field]=false;case "targetKeyEpoch":m[field]=2;case "nonce":m[field]="AA";default:m[field]=true}
            body["management"]=m
            XCTAssertThrowsError(try f.reply(body).managementReview(authority:f.authority,administrator:f.certificate,now:f.now))
        }
        let other=P256.Signing.PrivateKey();XCTAssertThrowsError(try f.reply(f.body,key:other).managementReview(authority:f.authority,administrator:f.certificate,now:f.now))
        XCTAssertThrowsError(try f.reply().review(authority:f.authority,adminId:f.certificate.member.enrollmentID,now:f.now))
        XCTAssertThrowsError(try f.reply().managementReview(authority:f.authority,administrator:f.certificate,now:f.now.addingTimeInterval(121)))
    }
    func testNoticeHasSeparateDomainAndStrictVersionRoutingAndOpensOnlyMatchingFreshReview() throws {
        let f=try Fixture(),notice=try CommunityAccessNotice.verify(f.envelope("noticeEnvelope"),authority:f.authority,now:f.now)
        let review=try f.reply().managementReview(authority:f.authority,administrator:f.certificate,now:f.now)
        try notice.validate(review:review,communityId:f.certificate.communityID,now:f.now)
        XCTAssertThrowsError(try notice.validate(review:review,communityId:UUID().uuidString.lowercased(),now:f.now))
        XCTAssertThrowsError(try CommunityAccessNotice.verify(f.envelope("reviewEnvelope"),authority:f.authority,now:f.now))
        XCTAssertThrowsError(try CommunityAccessNotice.verify(f.envelope("noticeEnvelope"),authority:f.authority,now:f.now.addingTimeInterval(601)))
        let old=try f.envelope("noticeEnvelope"),bytes=try ScreenCommunityRequest.decodeBase64(old.payload,max:2048)
        var fields=try JSONSerialization.jsonObject(with:bytes) as! [Any];fields[1]="enrollment-notice"
        let wrong=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(try JSONSerialization.data(withJSONObject:fields)),signature:old.signature)
        XCTAssertThrowsError(try CommunityEnrollmentNoticeRoute.classify(wrong))
        fields[0]=1;let legacy=ScreenCommunityEnvelope(payload:ScreenCommunityRequest.base64(try JSONSerialization.data(withJSONObject:fields)),signature:old.signature)
        if case .legacy=try CommunityEnrollmentNoticeRoute.classify(legacy) {} else { XCTFail("legacy route") }
        XCTAssertThrowsError(try CommunityAccessNotice.verify(legacy,authority:f.authority,now:f.now))
    }
}
#endif
