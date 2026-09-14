import { describe, expect, test } from 'bun:test';
import { findPortUploadMetadataConflicts, mergePortUploadFields, portUploadMetadataFromRemote,
  PORT_UPLOAD_METADATA_SELECT, type PortUploadMetadataRow } from '../src/portUploadConflict';
import { buildPortUploadRow } from '../src/portUploadPayload';

describe('port metadata disagreement before automatic upload', () => {
  test('an explicit port clear survives Pull while an unknown port still adopts remote data', () => {
    const base = { id: 'project', name: 'Project', syncGeneration: '3' };
    const cleared = { ...base, port: 0 };
    const remote = { ...base, port: 9000 };
    expect(findPortUploadMetadataConflicts([cleared], [remote])).toEqual([{ id: 'project', fields: ['port'] }]);
    expect(mergePortUploadFields(cleared, remote).port).toBe(0);
    expect(findPortUploadMetadataConflicts([cleared], [{ ...base, port: null, syncGeneration: '4' }])).toEqual([]);
    expect(mergePortUploadFields<PortUploadMetadataRow>(base, remote).port).toBe(9000);
    expect(buildPortUploadRow(cleared, { deviceId: 'mac', deviceName: null }).port).toBe(0);
  });
  test('preserves stale local URL bytes and the old generation instead of authorizing their replay', () => {
    const local = { id: 'project', name: 'Project', deployUrl: 'https://old.example.test', syncGeneration: '0' };
    const remote = { ...local, deployUrl: 'https://new.example.test', syncGeneration: '1' };
    expect(findPortUploadMetadataConflicts([local], [remote])).toEqual([{ id: 'project', fields: ['deployUrl'] }]);
    const merged = { ...local, ...remote, ...mergePortUploadFields(local, remote) };
    expect(merged.deployUrl).toBe(local.deployUrl);
    expect(merged.syncGeneration).toBe('0');
    expect(buildPortUploadRow(merged, { deviceId: 'mac', deviceName: null })).toMatchObject({
      deploy_url: local.deployUrl, sync_generation: '0',
    });
    expect(remote.deployUrl).toBe('https://new.example.test');
  });

  test('covers every actual upload value with the shared remote preflight projection', () => {
    const local = {
      id: 'project', name: 'Project', port: 9000, commandPath: '/fixture/start.command', terminalCommand: 'bun run start',
      folderPath: '/fixture/project', worktreeParentId: 'parent', deployUrl: 'https://deploy.example.test',
      githubUrl: 'git@github.com:example/project.git', githubUrls: ['https://github.com/example/second'],
      manualPath: '/fixture/manual.md', logFilePath: '/fixture/log.md', favorite: true,
      category: 'category', description: 'description', syncGeneration: '9007199254740993',
    };
    const memo = { content: 'separate memo', updatedAt: '2026-09-10T00:00:00Z' };
    const uploaded = buildPortUploadRow(local, { deviceId: 'mac', deviceName: 'Mac' }, memo);
    const projected = portUploadMetadataFromRemote(uploaded);
    expect(findPortUploadMetadataConflicts([{ ...local, memo: memo.content, memoUpdatedAt: memo.updatedAt }], [projected])).toEqual([]);
    // Identity/device metadata is governed by the RPC/config gate. All editable
    // values sent by the production builder must be included in preflight.
    expect(Object.keys(uploaded).filter(column => !['device_id', 'device_name'].includes(column)).sort())
      .toEqual(PORT_UPLOAD_METADATA_SELECT.split(',').sort());
    const alternatives: Partial<PortUploadMetadataRow> = {
      name: 'Changed', port: 9010, commandPath: '/different/start.command', terminalCommand: 'bun run changed',
      folderPath: '/different/project', worktreeParentId: 'different-parent', deployUrl: 'https://other.example.test',
      githubUrl: 'https://github.com/example/other', githubUrls: ['https://github.com/example/other'],
      manualPath: '/different/manual.md', logFilePath: '/different/log.md', favorite: false,
      category: 'changed category', description: 'changed description', memo: 'changed memo',
    };
    const conflict = findPortUploadMetadataConflicts([{ ...local, memo: memo.content }], [{ ...projected, ...alternatives }])[0]!;
    expect([...conflict.fields].sort() as string[]).toEqual(Object.keys(alternatives).filter(field => field !== 'githubUrl').sort());
    const merged = { ...local, ...alternatives, ...mergePortUploadFields(local, { ...local, ...alternatives } as typeof local) };
    for (const field of ['name', 'port', 'commandPath', 'terminalCommand', 'folderPath', 'worktreeParentId', 'deployUrl',
      'manualPath', 'logFilePath', 'favorite', 'category', 'description'] as const) expect(merged[field]).toBe(local[field]);
    expect(merged.githubUrls).toEqual(['https://github.com/example/project', 'https://github.com/example/second']);
  });

  test('newer remote clears cannot erase known local fields, including port/name/favorite', () => {
    const local = { id: 'project', name: 'Local name', port: 9000, favorite: true, deployUrl: 'https://local.example.test',
      githubUrls: ['https://github.com/example/project'], category: 'local', syncGeneration: '0' };
    const remote: PortUploadMetadataRow = { id: local.id, name: null, port: null, favorite: null,
      deployUrl: null, githubUrls: null, category: null, syncGeneration: '1' };
    expect(findPortUploadMetadataConflicts([local], [remote])[0]?.fields)
      .toEqual(['name', 'port', 'deployUrl', 'githubUrls', 'favorite', 'category']);
    expect({ ...local, ...remote, ...mergePortUploadFields<PortUploadMetadataRow>(local, remote) }).toMatchObject(local);
  });

  test('nonconflicting missing fields adopt remote values and the fresh exact generation', () => {
    const local: PortUploadMetadataRow = { id: 'project', name: 'Project', syncGeneration: '0' };
    const remote = { ...local, port: 9000, favorite: true, deployUrl: 'https://fresh.example.test',
      githubUrls: ['https://github.com/example/fresh'], category: 'fresh', syncGeneration: '9007199254740993' };
    expect(findPortUploadMetadataConflicts([local], [remote])).toEqual([]);
    expect(mergePortUploadFields(local, remote)).toMatchObject({
      name: 'Project', port: 9000, favorite: true, deployUrl: remote.deployUrl,
      githubUrls: remote.githubUrls, category: 'fresh', syncGeneration: '9007199254740993',
    });
  });

  test('legacy absent fields at generation zero backfill without clearing known local values', () => {
    const local = { id: 'project', name: 'Project', port: 9000, favorite: true, deployUrl: 'https://local.example.test', syncGeneration: '0' };
    const remote: PortUploadMetadataRow = { id: 'project', syncGeneration: '0', name: null, port: null, favorite: null, deployUrl: null };
    expect(findPortUploadMetadataConflicts([local], [remote])).toEqual([]);
    expect(mergePortUploadFields<PortUploadMetadataRow>(local, remote)).toMatchObject({ name: local.name, port: local.port,
      favorite: local.favorite, deployUrl: local.deployUrl, syncGeneration: '0' });
  });

  test('an older remote read cannot lower local CAS authority, even with identical data', () => {
    const local = { id: 'project', name: 'Project', syncGeneration: '9007199254740993' };
    const remote = { ...local, syncGeneration: '9007199254740992' };
    expect(findPortUploadMetadataConflicts([local], [remote])).toEqual([]);
    expect(mergePortUploadFields(local, remote).syncGeneration).toBe(local.syncGeneration);
  });

  test('a conflicting row retains missing local fields and existing generated-worktree provenance', () => {
    const local: PortUploadMetadataRow = { id: 'project', name: 'Local', syncGeneration: '0' };
    const remote = { ...local, name: 'Remote', folderPath: '/fixture/child', worktreeParentId: 'parent', syncGeneration: '1' };
    expect({ ...local, ...remote, ...mergePortUploadFields(local, remote) }).toMatchObject({
      name: 'Local', folderPath: undefined, worktreeParentId: undefined, syncGeneration: '0',
    });
    expect(mergePortUploadFields({ ...local, worktreeParentId: 'parent' }, local).worktreeParentId).toBe('parent');
  });

  test('invalid remote editable values fail before merging or displaying a partial row', () => {
    for (const fields of [{ port: -1 }, { port: 65_536 }, { favorite: 'false' }, { github_urls: [42] }, { category: {} }]) {
      const remote = portUploadMetadataFromRemote({ id: 'project', sync_generation: '1', ...fields });
      expect(() => findPortUploadMetadataConflicts([], [remote])).toThrow('PORT_AUTO_UPLOAD_METADATA_ROW_INVALID');
    }
  });

  test('equivalent optional empty/NULL clears and canonical GitHub URLs can resolve a review', () => {
    expect(findPortUploadMetadataConflicts([{
      id: 'project', category: '', description: '', deployUrl: '', githubUrls: [], memo: '', favorite: false, syncGeneration: '0',
    }], [{ id: 'project', category: null, description: null, deployUrl: null, githubUrls: null, memo: null, favorite: null, syncGeneration: '1' }])).toEqual([]);
    expect(findPortUploadMetadataConflicts([{ id: 'project', githubUrl: 'git@github.com:example/repo.git' }], [
      { id: 'project', githubUrls: ['https://github.com/example/repo'] },
    ])).toEqual([]);
    expect(findPortUploadMetadataConflicts([{ id: 'project', githubUrls: [] }], [
      { id: 'project', githubUrls: ['https://github.com/example/repo'] },
    ])).toEqual([{ id: 'project', fields: ['githubUrls'] }]);
  });

  test('separate memo content conflicts even when the remote timestamp is newer, while same content does not', () => {
    const local = { id: 'project', memo: 'local memo', memoUpdatedAt: '2026-09-01T00:00:00Z', syncGeneration: '0' };
    const remote = { ...local, memo: 'remote memo', memoUpdatedAt: '2026-09-02T00:00:00Z', syncGeneration: '1' };
    expect(findPortUploadMetadataConflicts([local], [remote])).toEqual([{ id: 'project', fields: ['memo'] }]);
    expect(findPortUploadMetadataConflicts([local], [{ ...remote, memo: local.memo }])).toEqual([]);
    expect(findPortUploadMetadataConflicts([local], [{ ...remote, memo: null }])).toEqual([{ id: 'project', fields: ['memo'] }]);
  });
  test('blocks differing known metadata at equal, newer and older remote generations', () => {
    for (const [localGeneration, remoteGeneration] of [['0', '0'], ['0', '1'], ['2', '1']]) {
      expect(findPortUploadMetadataConflicts([
        { id: 'project', syncGeneration: localGeneration, category: '로컬', description: '로컬 설명' },
      ], [
        { id: 'project', syncGeneration: remoteGeneration, category: '원격', description: '원격 설명' },
      ])).toEqual([{ id: 'project', fields: ['category', 'description'] }]);
    }
  });

  test('recognizes a newer remote clear while allowing initial legacy backfill', () => {
    const local = [{ id: 'project', syncGeneration: '0', category: '로컬', description: '설명' }];
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project', syncGeneration: '1' }]))
      .toEqual([{ id: 'project', fields: ['category', 'description'] }]);
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project', syncGeneration: '1', description: null }]))
      .toEqual([{ id: 'project', fields: ['category', 'description'] }]);
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project', syncGeneration: '0' }])).toEqual([]);
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project' }])).toEqual([]);
  });

  test('missing local fields adopt remote metadata without manufacturing a conflict', () => {
    expect(findPortUploadMetadataConflicts([
      { id: 'project', syncGeneration: '0' },
      { id: 'only-local', category: 'local' },
    ], [
      { id: 'project', syncGeneration: '10', category: '원격', description: '설명' },
      { id: 'only-remote', category: 'remote' },
    ])).toEqual([]);
    expect(findPortUploadMetadataConflicts([{ id: 'project', category: null }], [
      { id: 'project', category: 'remote' },
    ])).toEqual([]);
  });

  test('keeps exact bigint ordering beyond JavaScript number precision', () => {
    const local = [{ id: 'project', syncGeneration: '9007199254740992', category: '보존' }];
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project', syncGeneration: '9007199254740993' }]))
      .toEqual([{ id: 'project', fields: ['category'] }]);
    expect(findPortUploadMetadataConflicts(local, [{ id: 'project', syncGeneration: '9007199254740991' }]))
      .toEqual([]);
  });

  test('returns only disagreeing fields and IDs without mutating either input', () => {
    const local = Object.freeze([
      Object.freeze({ id: 'z', category: '', description: 'same', syncGeneration: '0' }),
      Object.freeze({ id: 'a', category: 'same', description: 'local', syncGeneration: '0' }),
    ]);
    const remote = Object.freeze([
      Object.freeze({ id: 'z', category: 'remote', description: 'same', syncGeneration: '1' }),
      Object.freeze({ id: 'a', category: 'same', description: 'remote', syncGeneration: '1' }),
    ]);
    expect(findPortUploadMetadataConflicts(local, remote)).toEqual([
      { id: 'a', fields: ['description'] }, { id: 'z', fields: ['category'] },
    ]);
    expect(local[0]?.category).toBe('');
    expect(remote[1]?.description).toBe('remote');
  });

  test('malformed generations and ambiguous or oversized input fail closed', () => {
    for (const syncGeneration of ['invalid', '-1', '01', '9223372036854775808', NaN, 9007199254740992]) {
      expect(() => findPortUploadMetadataConflicts([{ id: 'project', syncGeneration }], []))
        .toThrow('PORT_FENCE_INVALID_GENERATION');
      expect(() => findPortUploadMetadataConflicts([], [{ id: 'project', syncGeneration }]))
        .toThrow('PORT_FENCE_INVALID_GENERATION');
    }
    expect(() => findPortUploadMetadataConflicts([{ id: 'duplicate' }, { id: 'duplicate' }], []))
      .toThrow('PORT_AUTO_UPLOAD_METADATA_ROW_INVALID');
    expect(() => findPortUploadMetadataConflicts([], [{ id: 'a'.repeat(513) }]))
      .toThrow('PORT_AUTO_UPLOAD_METADATA_ROW_INVALID');
    expect(() => findPortUploadMetadataConflicts(Array(10_001).fill({ id: 'project' }), []))
      .toThrow('PORT_AUTO_UPLOAD_METADATA_ROWS_INVALID');
  });
});
