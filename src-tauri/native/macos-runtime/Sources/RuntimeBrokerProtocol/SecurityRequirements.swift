import Foundation
import Security

public enum RuntimeBrokerSecurityRequirements {
    private static let rejectedPlaceholders: Set<String> = [
        "ABCDEFGHIJ",
        "1234567890",
        "TEAMID1234",
        "YOURTEAMID",
        "XXXXXXXXXX",
    ]

    public static func validatedProductionTeamIdentifier() -> String? {
        guard let candidate = RuntimeBrokerBuildIdentity.productionTeamIdentifier,
              candidate.utf8.count == 10,
              candidate.utf8.allSatisfy({ byte in
                  (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
              }),
              Set(candidate.utf8).count > 1,
              !rejectedPlaceholders.contains(candidate) else {
            return nil
        }
        return candidate
    }

    public static func clientRequirement(teamIdentifier: String) -> String {
        developerIDRequirement(
            identifier: RuntimeBrokerContract.applicationIdentifier,
            teamIdentifier: teamIdentifier,
            entitlement: RuntimeBrokerContract.clientEntitlement,
            entitlementValue: RuntimeBrokerContract.clientEntitlementValue
        )
    }

    public static func brokerRequirement(teamIdentifier: String) -> String {
        developerIDRequirement(
            identifier: RuntimeBrokerContract.brokerIdentifier,
            teamIdentifier: teamIdentifier,
            entitlement: RuntimeBrokerContract.serviceEntitlement,
            entitlementValue: RuntimeBrokerContract.serviceEntitlementValue
        )
    }

    public static func currentProcessSatisfiesBrokerRequirement(
        teamIdentifier: String
    ) -> Bool {
        var requirement: SecRequirement?
        let requirementStatus = SecRequirementCreateWithString(
            brokerRequirement(teamIdentifier: teamIdentifier) as CFString,
            SecCSFlags(),
            &requirement
        )
        guard requirementStatus == errSecSuccess, let requirement else {
            return false
        }

        var code: SecCode?
        let codeStatus = SecCodeCopySelf(SecCSFlags(), &code)
        guard codeStatus == errSecSuccess, let code else {
            return false
        }
        return SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
    }

    private static func developerIDRequirement(
        identifier: String,
        teamIdentifier: String,
        entitlement: String,
        entitlementValue: String
    ) -> String {
        "anchor apple generic" +
            " and certificate 1[field.\(RuntimeBrokerContract.developerIDIssuerOID)] exists" +
            " and certificate leaf[field.\(RuntimeBrokerContract.developerIDApplicationOID)] exists" +
            " and certificate leaf[subject.OU] = \"\(teamIdentifier)\"" +
            " and identifier \"\(identifier)\"" +
            " and entitlement[\"\(entitlement)\"] = \"\(entitlementValue)\""
    }
}
