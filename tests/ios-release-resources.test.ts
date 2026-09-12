import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appleDevelopmentIdentityLabels, appleTeamIdentifierFromSubject } from '../mobile/ios/scripts/signingTeam';

const root = resolve(import.meta.dir, '..');
const source = (path: string) => readFileSync(resolve(root, path));

test('iOS ships the opaque 1024px AgentsToZ icon through the app resource phase', () => {
  const image = source('mobile/ios/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
  expect(image.subarray(1, 4).toString()).toBe('PNG');
  expect(image.readUInt32BE(16)).toBe(1024);
  expect(image.readUInt32BE(20)).toBe(1024);
  expect(image[25]).toBe(2);
  const project = source('mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj').toString();
  expect(project).toContain('ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon');
  expect(project).toContain('path = Assets.xcassets');
});

test('iOS release family follows the shared build and includes privacy and provenance resources', () => {
  const { buildNumber } = JSON.parse(source('build-number.json').toString()) as { buildNumber: number };
  const project = source('mobile/ios/AgentsToZMobile.xcodeproj/project.pbxproj').toString();
  expect(project.match(new RegExp(`CURRENT_PROJECT_VERSION = ${buildNumber};`, 'g'))).toHaveLength(2);
  expect(project.match(new RegExp(`MARKETING_VERSION = ${buildNumber}\\.0\\.0;`, 'g'))).toHaveLength(2);
  expect(project).toContain('path = PrivacyInfo.xcprivacy');
  const info = source('mobile/ios/App/Info.plist').toString();
  expect(info).toContain('<key>ITSAppUsesNonExemptEncryption</key>');
  expect(info).toContain('<key>AgentsToZSourceCommit</key>');
  expect(info).toContain('<key>AgentsToZRemoteProtocolVersion</key>');
});

test('USB development signing derives the team from the certificate subject, not its display suffix', () => {
  expect(appleDevelopmentIdentityLabels([
    '  1) AAA "Apple Development: Developer One (ABCDEFGHIJ)"',
    '  2) BBB "Apple Development: Duplicate (ABCDEFGHIJ)"',
    '  3) CCC "Developer ID Application: Desktop Team (KLMNOPQRST)"',
    '  4) DDD "Apple Distribution: Store Team (UVWXYZ1234)"',
  ].join('\n'))).toEqual([
    'Apple Development: Developer One (ABCDEFGHIJ)',
    'Apple Development: Duplicate (ABCDEFGHIJ)',
  ]);
  expect(appleDevelopmentIdentityLabels('Apple Development: missing identity row (ABCDEFGHIJ)')).toEqual([]);
  expect(appleTeamIdentifierFromSubject('UID=person\nCN=Apple Development: Person (CERTID1234)\nOU=TEAMID5678\nO=Person')).toBe('TEAMID5678');
  expect(appleTeamIdentifierFromSubject('CN=Apple Development: Person (CERTID1234)')).toBeNull();
});
