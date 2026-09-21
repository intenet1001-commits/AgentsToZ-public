import { describe, expect, test } from 'bun:test';
import {
  executeMacOSDirectDistributionForTest,
  parseAcceptedNotaryResponse,
  parseAcceptedNotaryLog,
  parseSubmittedNotaryResponse,
  planMacOSNotaryCommands,
  type MacOSDirectDistributionDependencies,
} from '../src/macOSDirectDistributionPipeline';

const identity = {
  diagnostic: {
    schemaVersion: 1 as const,
    kind: 'macos-runtime-production-signing-canary' as const,
    scope: 'build-key-possession-snapshot-only' as const,
    result: 'snapshot-verified' as const,
    reason: 'canary-snapshot-verified' as const,
    authoritative: false as const,
    reusable: false as const,
    ready: false as const,
  },
  identity: {
    certificateFingerprint: 'A'.repeat(40),
    teamIdentifier: 'A1B2C3D4E5',
    commonName: 'Developer ID Application: Example (A1B2C3D4E5)',
  },
};

describe('macOS direct distribution pipeline', () => {
  test('plans submit, wait, info and log with one unchanged Keychain authority', () => {
    const commands = planMacOSNotaryCommands({
      artifactPath: '/release/AgentsToZ_byCS.zip',
      submissionId: '11111111-2222-4333-8444-555555555555',
      logPath: '/release/app-notary.json',
      authArgs: ['--keychain-profile', 'agentstoz-release', '--keychain', '/Users/test/release.keychain-db'],
    });
    expect(commands).toEqual([
      ['notarytool', 'submit', '/release/AgentsToZ_byCS.zip', '--keychain-profile', 'agentstoz-release', '--keychain', '/Users/test/release.keychain-db', '--output-format', 'json', '--no-progress'],
      ['notarytool', 'wait', '11111111-2222-4333-8444-555555555555', '--keychain-profile', 'agentstoz-release', '--keychain', '/Users/test/release.keychain-db', '--timeout', '30m', '--output-format', 'json', '--no-progress'],
      ['notarytool', 'info', '11111111-2222-4333-8444-555555555555', '--keychain-profile', 'agentstoz-release', '--keychain', '/Users/test/release.keychain-db', '--output-format', 'json', '--no-progress'],
      ['notarytool', 'log', '11111111-2222-4333-8444-555555555555', '/release/app-notary.json', '--keychain-profile', 'agentstoz-release', '--keychain', '/Users/test/release.keychain-db', '--no-progress'],
    ]);
  });

  test('accepts only an exact accepted response for the submitted UUID', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(parseAcceptedNotaryResponse(JSON.stringify({ id, status: 'Accepted' }), id)).toEqual({ id, status: 'Accepted' });
    for (const value of [
      '{"status":"Accepted"}',
      JSON.stringify({ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'Accepted' }),
      JSON.stringify({ id, status: 'In Progress' }),
      JSON.stringify({ id, status: 'Invalid' }),
      'not-json',
    ]) expect(() => parseAcceptedNotaryResponse(value, id)).toThrow();
  });

  test('accepts the real submit and log shapes without weakening UUID or issue checks', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(parseSubmittedNotaryResponse(JSON.stringify({ id, message: 'Successfully uploaded file' }))).toEqual({ id, status: 'Submitted' });
    expect(parseSubmittedNotaryResponse(JSON.stringify({ id, status: 'In Progress' }))).toEqual({ id, status: 'In Progress' });
    expect(parseAcceptedNotaryLog(JSON.stringify({ jobId: id, status: 'Accepted', issues: null }), id).status).toBe('Accepted');
    expect(() => parseAcceptedNotaryLog(JSON.stringify({ jobId: id, status: 'Accepted', issues: [{ severity: 'error' }] }), id)).toThrow();
  });

  test('sequences app and DMG notarization without claiming installation or publication', async () => {
    const calls: string[] = [];
    const deps: MacOSDirectDistributionDependencies = {
      buildBase: async () => ({
        mode: 'developer-id-base', result: 'signed-awaiting-notarization', appSigned: true,
        notarized: false, installed: false, ready: false,
        sourceSha: 'b'.repeat(40), bundleDigest: 'e'.repeat(64),
        signingIdentity: identity.identity,
        appBundlePath: '/candidate/release/bundle/macos/AgentsToZ_byCS.app',
      }),
      resolveIdentity: async () => identity,
      revalidateSource: () => { calls.push('revalidate-source'); },
      preparePaths: () => ({
        outputRoot: '/candidate', appArchivePath: '/candidate/AgentsToZ_byCS.zip',
        dmgPath: '/candidate/AgentsToZ_byCS_476_arm64.dmg', finalReceiptPath: '/candidate/direct-distribution.receipt.json',
      }),
      packageApp: async () => { calls.push('package-app'); },
      notarize: async kind => { calls.push(`notarize-${kind}`); return { submissionId: kind === 'app' ? '11111111-2222-4333-8444-555555555555' : 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', logSha256: 'c'.repeat(64) }; },
      stapleAndValidate: async kind => { calls.push(`staple-${kind}`); },
      createDmg: async () => { calls.push('create-dmg'); },
      signAndVerifyDmg: async () => { calls.push('sign-dmg'); },
      verifyMountedDistribution: async () => { calls.push('verify-mounted'); return { appManifestSha256: 'f'.repeat(64), appCdHash: 'a'.repeat(40) }; },
      hashFile: async () => 'd'.repeat(64),
      writeFinalReceipt: (_path, receipt) => { calls.push(`write-${receipt.result}`); },
    };
    const receipt = await executeMacOSDirectDistributionForTest({ profile: 'agentstoz-release', version: '476.0.0' }, deps);
    expect(calls).toEqual([
      'revalidate-source', 'package-app', 'notarize-app', 'staple-app', 'revalidate-source',
      'create-dmg', 'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-mounted',
      'revalidate-source', 'write-notarized-dmg-awaiting-install-test',
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: 1, mode: 'developer-id-base', result: 'notarized-dmg-awaiting-install-test',
      sourceSha: 'b'.repeat(40), version: '476.0.0', architecture: 'arm64',
      appNotarized: true, appStapled: true, dmgSigned: true, dmgNotarized: true,
      dmgStapled: true, gatekeeperAssessed: true, installed: false, published: false, ready: false,
    });
    expect(receipt).not.toHaveProperty('profile');
  });

  test('stops before DMG creation when app notarization is uncertain', async () => {
    const calls: string[] = [];
    const deps: MacOSDirectDistributionDependencies = {
      buildBase: async () => ({
        mode: 'developer-id-base', result: 'signed-awaiting-notarization', appSigned: true,
        notarized: false, installed: false, ready: false,
        sourceSha: 'b'.repeat(40), bundleDigest: 'e'.repeat(64),
        signingIdentity: identity.identity,
        appBundlePath: '/candidate/release/bundle/macos/AgentsToZ_byCS.app',
      }),
      resolveIdentity: async () => identity,
      revalidateSource: () => { calls.push('revalidate-source'); },
      preparePaths: () => ({ outputRoot: '/candidate', appArchivePath: '/candidate/app.zip', dmgPath: '/candidate/app.dmg', finalReceiptPath: '/candidate/receipt.json' }),
      packageApp: async () => { calls.push('package-app'); },
      notarize: async () => { calls.push('notarize-app'); throw new Error('submission still in progress'); },
      stapleAndValidate: async () => { calls.push('unexpected-staple'); },
      createDmg: async () => { calls.push('unexpected-dmg'); },
      signAndVerifyDmg: async () => { calls.push('unexpected-sign'); },
      verifyMountedDistribution: async () => { calls.push('unexpected-verify'); return { appManifestSha256: 'f'.repeat(64), appCdHash: 'a'.repeat(40) }; },
      hashFile: async () => 'd'.repeat(64),
      writeFinalReceipt: () => { calls.push('unexpected-receipt'); },
    };
    await expect(executeMacOSDirectDistributionForTest({ profile: 'agentstoz-release', version: '476.0.0' }, deps)).rejects.toThrow('submission still in progress');
    expect(calls).toEqual(['revalidate-source', 'package-app', 'notarize-app']);
  });

  test('refuses to mix an app signed by one identity with a DMG signed by another', async () => {
    const deps: MacOSDirectDistributionDependencies = {
      buildBase: async () => ({
        mode: 'developer-id-base', result: 'signed-awaiting-notarization', appSigned: true,
        notarized: false, installed: false, ready: false, sourceSha: 'b'.repeat(40),
        bundleDigest: 'e'.repeat(64), appBundlePath: '/candidate/release/bundle/macos/AgentsToZ_byCS.app',
        signingIdentity: { ...identity.identity, certificateFingerprint: 'B'.repeat(40) },
      }),
      resolveIdentity: async () => identity,
      revalidateSource: () => { throw new Error('must not reach source'); },
      preparePaths: () => { throw new Error('must not prepare'); },
      packageApp: async () => {}, notarize: async () => ({ submissionId: '11111111-2222-4333-8444-555555555555', logSha256: 'c'.repeat(64) }),
      stapleAndValidate: async () => {}, createDmg: async () => {}, signAndVerifyDmg: async () => {},
      verifyMountedDistribution: async () => ({ appManifestSha256: 'f'.repeat(64), appCdHash: 'a'.repeat(40) }),
      hashFile: async () => 'd'.repeat(64), writeFinalReceipt: () => {},
    };
    await expect(executeMacOSDirectDistributionForTest({ profile: 'agentstoz-release', version: '476.0.0' }, deps)).rejects.toThrow('identity changed');
  });
});
