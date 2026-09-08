import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  githubFieldsAfterCrossDeviceMatch,
  sourcePortIdentityAfterCrossDeviceMatch,
} from '../src/portCrossDeviceIdentity';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('cross-device source identity authority', () => {
  test('does not grant destructive source identity from a matching name alone', () => {
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-project',
    }, {
      id: 'unrelated-remote-project',
      sourceDeviceId: 'remote-device',
    })).toEqual({});
  });

  test('grants source identity when canonical GitHub repository lineage agrees', () => {
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-project',
      githubUrl: 'git@github.com:CSnCompany/AgentsToZ_byCS.git',
    }, {
      id: 'remote-project',
      sourceDeviceId: 'remote-device',
      githubUrls: ['https://github.com/csncompany/agentstoz_bycs'],
    })).toEqual({
      sourcePortId: 'remote-project',
      sourcePortDeviceId: 'remote-device',
    });
  });

  test('grants source identity for the exact stable row UUID', () => {
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'same-row',
    }, {
      id: 'same-row',
      sourceDeviceId: 'remote-device',
    })).toEqual({
      sourcePortId: 'same-row',
      sourcePortDeviceId: 'remote-device',
    });
  });

  test('captures and refreshes generation only for the exact established source row', () => {
    const captured = sourcePortIdentityAfterCrossDeviceMatch({
      id: 'same-row',
    }, {
      id: 'same-row',
      sourceDeviceId: 'remote-device',
      syncGeneration: '7',
    });
    expect(captured).toEqual({
      sourcePortId: 'same-row',
      sourcePortDeviceId: 'remote-device',
      sourcePortSyncGeneration: '7',
    });
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-row',
      ...captured,
    }, {
      id: 'same-row',
      sourceDeviceId: 'remote-device',
      syncGeneration: '8',
    })).toEqual({
      ...captured,
      sourcePortSyncGeneration: '8',
    });
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-row',
      ...captured,
    }, {
      id: 'different-row',
      sourceDeviceId: 'remote-device',
      syncGeneration: '99',
    })).toEqual(captured);
  });

  test('does not complete a legacy partial identity from a later same-name row', () => {
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-project',
      sourcePortId: 'possibly-name-matched-id',
    }, {
      id: 'possibly-name-matched-id',
      sourceDeviceId: 'remote-device',
    })).toEqual({
      sourcePortId: 'possibly-name-matched-id',
      sourcePortDeviceId: undefined,
    });
  });

  test('keeps an established source identity immutable when another same-name row arrives', () => {
    expect(sourcePortIdentityAfterCrossDeviceMatch({
      id: 'local-project',
      sourcePortId: 'trusted-remote',
      sourcePortDeviceId: 'trusted-device',
    }, {
      id: 'different-remote',
      sourceDeviceId: 'different-device',
      githubUrl: 'https://github.com/example/different',
    })).toEqual({
      sourcePortId: 'trusted-remote',
      sourcePortDeviceId: 'trusted-device',
    });
  });

  test('the existing-row merge path cannot fall back to a name-only remote identity', () => {
    const start = appSource.indexOf('const mergePortsFromOtherDevice');
    const end = appSource.indexOf('async function suppressVerifiedLegacyRemoteWorktreeRows', start);
    const mergeSource = appSource.slice(start, end);
    expect(mergeSource).toContain('sourcePortIdentityAfterCrossDeviceMatch(existing, r)');
    expect(mergeSource).toContain('githubFieldsAfterCrossDeviceMatch(existing, r, sourceIdentity)');
    expect(mergeSource).not.toContain('sourcePortId: existing.sourcePortId ?? r.id');
    expect(mergeSource).not.toContain('sourcePortDeviceId: existing.sourcePortDeviceId ?? r.sourceDeviceId');
    // Newly minted, explicitly imported clones still retain their exact source
    // identity so later deletion can be verified against the server row.
    expect(mergeSource).toContain('sourcePortId: r.id');
    expect(mergeSource).toContain('sourcePortDeviceId: r.sourceDeviceId');
    expect(mergeSource).toContain('sourcePortSyncGeneration: r.syncGeneration');
  });

  test('two consecutive name-only pulls cannot manufacture repository lineage or deletion authority', () => {
    const remote = {
      id: 'remote-project',
      sourceDeviceId: 'remote-device',
      githubUrl: 'https://github.com/example/unrelated',
    };
    let local: any = { id: 'local-project' };
    for (let pull = 0; pull < 2; pull += 1) {
      const identity = sourcePortIdentityAfterCrossDeviceMatch(local, remote);
      local = {
        ...local,
        ...githubFieldsAfterCrossDeviceMatch(local, remote, identity),
        ...identity,
      };
    }
    expect(local.githubUrl).toBeUndefined();
    expect(local.githubUrls).toBeUndefined();
    expect(local.sourcePortId).toBeUndefined();
    expect(local.sourcePortDeviceId).toBeUndefined();
  });
});
