import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacOSRuntimeProductionBuildIdentityResolution } from '../src/macOSRuntimeProductionCanary';
import {
  removeMacOSRuntimeProductionSourceStage,
  stageMacOSRuntimeProductionSourcesForTest,
  type MacOSRuntimeProductionSourceStage,
} from '../stage-macos-runtime-production-sources';

const TEAM_ID = 'A1B2C3D4E5';
const scratchParents: string[] = [];

function resolution(): MacOSRuntimeProductionBuildIdentityResolution {
  return {
    diagnostic: {
      schemaVersion: 1,
      kind: 'macos-runtime-production-signing-canary',
      scope: 'build-key-possession-snapshot-only',
      result: 'snapshot-verified',
      reason: 'canary-snapshot-verified',
      authoritative: false,
      reusable: false,
      ready: false,
    },
    identity: {
      certificateFingerprint: 'A'.repeat(40),
      commonName: `Developer ID Application: AgentsToZ Builder (${TEAM_ID})`,
      teamIdentifier: TEAM_ID,
    },
  };
}

function fixture() {
  const scratchParent = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-source-stage-test-')));
  scratchParents.push(scratchParent);
  return {
    scratchParent,
    sourcePackageRoot: realpathSync(new URL(
      '../src-tauri/native/macos-runtime',
      import.meta.url,
    ).pathname),
    typescriptSigningProbePath: realpathSync(new URL(
      '../src/macOSRuntimeBrokerSigning.ts',
      import.meta.url,
    ).pathname),
  };
}

afterEach(() => {
  while (scratchParents.length > 0) {
    rmSync(scratchParents.pop()!, { recursive: true, force: true });
  }
});

describe('macOS runtime production source staging', () => {
  test('copies only build inputs and writes all four pins into scratch', () => {
    const options = fixture();
    const originalContract = readFileSync(join(
      options.sourcePackageRoot,
      'Sources',
      'RuntimeBrokerProtocol',
      'Contract.swift',
    ), 'utf8');
    const stage = stageMacOSRuntimeProductionSourcesForTest(resolution(), options);
    expect(stage).toMatchObject({
      schemaVersion: 1,
      kind: 'macos-runtime-production-source-stage',
      sourceFilesPinned: 4,
      repositoryModified: false,
      productionArtifactBuilt: false,
      productionArtifactSigned: false,
      authoritative: false,
      reusable: false,
      ready: false,
    });
    expect(stage.pinnedSourceDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(join(
      stage.packageRoot,
      'Sources',
      'RuntimeBrokerProtocol',
      'Contract.swift',
    ), 'utf8')).toContain(`productionTeamIdentifier: String? = "${TEAM_ID}"`);
    expect(readFileSync(stage.objectiveCClientBridgePath, 'utf8'))
      .toContain(`AgentsToZProductionTeamIdentifier = @"${TEAM_ID}";`);
    expect(readFileSync(stage.typescriptSigningProbePath, 'utf8'))
      .toContain(`MACOS_RUNTIME_BROKER_GENERATED_TEAM_IDENTIFIER: string | null = "${TEAM_ID}";`);
    expect(readFileSync(join(
      options.sourcePackageRoot,
      'Sources',
      'RuntimeBrokerProtocol',
      'Contract.swift',
    ), 'utf8')).toBe(originalContract);
    expect(existsSync(join(stage.packageRoot, '.artifacts'))).toBeFalse();
    removeMacOSRuntimeProductionSourceStage(stage, options.scratchParent);
    expect(existsSync(stage.scratchRoot)).toBeFalse();
  });

  test('rejects an unverified identity before returning a partial stage', () => {
    const options = fixture();
    const verified = resolution();
    const rejected: MacOSRuntimeProductionBuildIdentityResolution = {
      ...verified,
      diagnostic: { ...verified.diagnostic, result: 'not-verified' },
    };
    expect(() => stageMacOSRuntimeProductionSourcesForTest(rejected, options))
      .toThrow('identity rejected');
    expect(readdirSync(options.scratchParent)).toEqual([]);
    expect(readFileSync(join(
      options.sourcePackageRoot,
      'Sources',
      'RuntimeBrokerProtocol',
      'Contract.swift',
    ), 'utf8')).toContain('productionTeamIdentifier: String? = nil');
  });

  test('cleanup rejects a redirected stage descriptor', () => {
    const options = fixture();
    const stage = stageMacOSRuntimeProductionSourcesForTest(resolution(), options);
    const redirected: MacOSRuntimeProductionSourceStage = {
      ...stage,
      packageRoot: join(stage.scratchRoot, 'other-package'),
    };
    expect(() => removeMacOSRuntimeProductionSourceStage(redirected, options.scratchParent))
      .toThrow('cleanup rejected');
    expect(existsSync(stage.scratchRoot)).toBeTrue();
  });
});
