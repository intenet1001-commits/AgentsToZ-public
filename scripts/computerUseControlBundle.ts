// The bundle files of AgentsToZ Control.app (native/computer-use/CONTRACT.md section 11): Info.plist, its own
// LaunchAgent and the signing entitlements. Shared by the packaging script and the checks; writes nothing itself.
export const CONTROL_TEAM_ID = 'DA8QKAQ2C9';
export const CONTROL_BUNDLE_ID = 'com.intenet.agentstozbycs.control';
export const CONTROL_APP_NAME = 'AgentsToZ Control';
export const CONTROL_EXECUTABLE = 'AgentsToZ Control';
/** The SwiftPM product the packaging script copies into Contents/MacOS under CONTROL_EXECUTABLE. */
export const CONTROL_PRODUCT = 'agentstoz-control';
export const CONTROL_MACH_SERVICE = 'com.intenet.agentstozbycs.control.xpc';
export const CONTROL_AGENT_LABEL = 'com.intenet.agentstozbycs.control.agent';
export const CONTROL_AGENT_PLIST = `${CONTROL_AGENT_LABEL}.plist`;

const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`;

export function controlInfoPlist(version: string): string {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw Error('Invalid AgentsToZ Control bundle version');
  return xml(`  <key>CFBundleIdentifier</key><string>${CONTROL_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${CONTROL_APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${CONTROL_APP_NAME}</string>
  <key>CFBundleExecutable</key><string>${CONTROL_EXECUTABLE}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
`);
}

/**
 * Control's own LaunchAgent, inside its own bundle (Contents/Library/LaunchAgents) where SMAppService.agent finds
 * it. launchd starts the app on the main app's first XPC request (MachServices); nothing runs at load.
 */
export function controlLaunchAgentPlist(): string {
  return xml(`  <key>Label</key><string>${CONTROL_AGENT_LABEL}</string>
  <key>BundleProgram</key><string>Contents/MacOS/${CONTROL_EXECUTABLE}</string>
  <key>MachServices</key><dict><key>${CONTROL_MACH_SERVICE}</key><true/></dict>
  <key>AssociatedBundleIdentifiers</key><array><string>${CONTROL_BUNDLE_ID}</string></array>
  <key>ProcessType</key><string>Interactive</string>
  <key>RunAtLoad</key><false/>
`);
}

/**
 * The Secure Enclave approval key lives in the data protection keychain, which needs the app's own access group;
 * a Developer ID provisioning profile for the bundle ID must allow these (embedded as Contents/embedded.provisionprofile).
 */
export function controlEntitlements(): string {
  return xml(`  <key>com.apple.application-identifier</key><string>${CONTROL_TEAM_ID}.${CONTROL_BUNDLE_ID}</string>
  <key>com.apple.developer.team-identifier</key><string>${CONTROL_TEAM_ID}</string>
  <key>keychain-access-groups</key><array><string>${CONTROL_TEAM_ID}.${CONTROL_BUNDLE_ID}</string></array>
`);
}

/** What the main app's bridge requires of this app (CONTRACT.md section 2), checked after signing. */
export const CONTROL_HELPER_REQUIREMENT = `anchor apple generic and identifier "${CONTROL_BUNDLE_ID}" and certificate leaf[subject.OU] = "${CONTROL_TEAM_ID}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`;
