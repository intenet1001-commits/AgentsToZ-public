#if os(macOS)
import AppKit
import Foundation
import ScreenControlCore
import Security

/// Presentation-only launch of an exact installed, same-authority Viewer. No arguments, URL command or session RPC.
@MainActor enum ScreenViewerLauncher {
    static func open(activate:Bool)async throws {
        guard let authority=ScreenCommunityAuthority.configured else {throw ScreenCommunityError.notConfigured}
        let names=[URL(fileURLWithPath:"/Applications/AgentsToZ Viewer.app"),FileManager.default.homeDirectoryForCurrentUser.appending(path:"Applications/AgentsToZ Viewer.app")]
        guard let app=names.first(where:{FileManager.default.fileExists(atPath:$0.path)}),app.standardizedFileURL==app.resolvingSymlinksInPath().standardizedFileURL,
              let bundle=Bundle(url:app),let configuration=ScreenCommunityBundleConfiguration.parse(info:bundle.infoDictionary ?? [:]),configuration.origin==authority.origin,configuration.profileID==authority.profileID,configuration.issuer.x963Representation==authority.issuer.x963Representation else {throw ScreenCommunityError.service("VIEWER_INSTALLATION_REQUIRED")}
        var code:SecStaticCode?,requirement:SecRequirement?
        let rule="anchor apple generic and identifier \"com.intenet.agentstozbycs.viewer\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
        guard SecStaticCodeCreateWithPath(app as CFURL,[],&code)==errSecSuccess,let code,SecRequirementCreateWithString(rule as CFString,[],&requirement)==errSecSuccess,let requirement,SecStaticCodeCheckValidity(code,SecCSFlags(rawValue:kSecCSStrictValidate | kSecCSCheckAllArchitectures),requirement)==errSecSuccess else {throw ScreenCommunityError.invalidSignature}
        for running in NSRunningApplication.runningApplications(withBundleIdentifier:"com.intenet.agentstozbycs.viewer") where !running.isTerminated {
            guard running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL==app.standardizedFileURL else {throw ScreenCommunityError.service("OTHER_VIEWER_INSTANCE")}
        }
        let launch=NSWorkspace.OpenConfiguration();launch.activates=activate;launch.createsNewApplicationInstance=false;launch.arguments=[];launch.promptsUserIfNeeded=false
        _=try await NSWorkspace.shared.openApplication(at:app,configuration:launch)
    }
}
#endif
