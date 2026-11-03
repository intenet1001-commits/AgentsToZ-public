import Foundation
import CryptoKit

/// Classification is not authorization. A version-2 notice can never enter the legacy review path.
public enum CommunityEnrollmentNoticeRoute: Sendable {
    case legacy, access
    public static func classify(_ envelope: ScreenCommunityEnvelope) throws -> Self {
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:2048)
        guard bytes.count<=1024,let fields=try JSONSerialization.jsonObject(with:bytes) as? [Any],fields.count==8,let kind=fields[1] as? String else { throw ScreenCommunityError.malformed }
        switch (try AccessValue.integer(fields[0]),kind) {
        case (1,"enrollment-notice"): return .legacy
        case (2,"access-enrollment-notice"): return .access
        default: throw ScreenCommunityError.malformed
        }
    }
}
public struct CommunityAccessNotice: Sendable {
    public let planId: String, communityId: String, profileId: String, digest: String
    public let issuedAt: Int64, expiresAt: Int64
    public static func verify(_ envelope: ScreenCommunityEnvelope, authority: ScreenCommunityAuthority, now: Date = Date()) throws -> Self {
        guard envelope.hostSignature==nil,case .access=try CommunityEnrollmentNoticeRoute.classify(envelope) else { throw ScreenCommunityError.malformed }
        let bytes=try ScreenCommunityRequest.decodeBase64(envelope.payload,max:2048)
        let signature=try P256.Signing.ECDSASignature(rawRepresentation:ScreenCommunityRequest.decodeBase64(envelope.signature,max:86))
        guard authority.issuer.isValidSignature(signature,for:Data("agentstoz.community-access.notice/v2\0".utf8)+bytes),
              let fields=try JSONSerialization.jsonObject(with:bytes) as? [Any] else { throw ScreenCommunityError.invalidSignature }
        let plan=try AccessValue.id(fields[2]),at=try AccessValue.integer(fields[3]),community=try AccessValue.id(fields[4]),profile=try AccessValue.id(fields[5]),expiry=try AccessValue.integer(fields[7])
        let clock=Int64(now.timeIntervalSince1970*1000)
        guard profile==authority.profileID,let digest=fields[6] as? String,digest.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil,
              at<=clock+5_000,expiry>clock,expiry>at,expiry<=at+600_000 else { throw ScreenCommunityError.expired }
        return Self(planId:plan,communityId:community,profileId:profile,digest:digest,issuedAt:at,expiresAt:expiry)
    }
    /// The notification opens a fresh issuer review. It is never an approval token.
    public func validate(review: CommunityAccessReview, communityId: String, now: Date = Date()) throws {
        guard self.communityId==communityId,review.planId==planId,review.digest==digest,review.plan.profileId==profileId,
              expiresAt>Int64(now.timeIntervalSince1970*1000) else { throw ScreenCommunityError.wrongCommunity }
    }
}
