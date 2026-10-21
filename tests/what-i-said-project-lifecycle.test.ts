import {mergePortUploadFields} from '../src/portUploadConflict';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  revokeWhatISaidBeforeProjectRemoval,
  whatISaidProjectPathChanged,
} from '../src/whatISaidProjectLifecycle';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('What-I-said project registration lifecycle', () => {
  test('revokes the exact worktree-scoped source before project removal', async () => {
    const paths: string[] = [];
    const result = await revokeWhatISaidBeforeProjectRemoval({
      folderPath: '/project',
      worktreePath: ' /external/worktree ',
    }, async path => { if (path) paths.push(path); });
    expect(result).toEqual({ ok: true, folderPath: '/external/worktree' });
    expect(paths).toEqual(['/external/worktree']);
  });

  test('fails closed when source revocation fails and delegates pathless revocation by registration', async () => {
    const failure = new Error('sidecar unavailable');
    expect(await revokeWhatISaidBeforeProjectRemoval({ folderPath: '/project' }, async () => {
      throw failure;
    })).toEqual({ ok: false, folderPath: '/project', error: failure });

    const paths: Array<string | null> = [];
    const pathless = await revokeWhatISaidBeforeProjectRemoval({}, async path => { paths.push(path); });
    expect(pathless).toEqual({ ok: true, folderPath: null });
    expect(paths).toEqual([null]);
  });

  test('treats removal or replacement of the effective local path as a sharing boundary', () => {
    expect(whatISaidProjectPathChanged({ folderPath: '/project' }, {})).toBe(true);
    expect(whatISaidProjectPathChanged({ folderPath: '/project' }, { folderPath: '/moved' })).toBe(true);
    expect(whatISaidProjectPathChanged(
      { folderPath: '/project', worktreePath: '/worktree' },
      { folderPath: '/moved', worktreePath: '/worktree' },
    )).toBe(false);
  });

  test('both project removal flows await revocation before dropping registration', () => {
    const directStart = appSource.indexOf('const handleConfirmDelete = async');
    const cleanupStart = appSource.indexOf('const cleanupProject = async');
    const direct = appSource.slice(directStart, cleanupStart);
    const cleanup = appSource.slice(cleanupStart, appSource.indexOf('const handleSaveMemo', cleanupStart));
    expect(direct.indexOf('await revokeWhatISaidSharingBeforeRemoval')).toBeGreaterThan(-1);
    expect(direct.indexOf('await revokeWhatISaidSharingBeforeRemoval')).toBeLessThan(direct.indexOf('removeProjectFamilyLocally(id)'));
    expect(cleanup.indexOf('await revokeWhatISaidSharingBeforeRemoval')).toBeGreaterThan(-1);
    expect(cleanup.indexOf('await revokeWhatISaidSharingBeforeRemoval')).toBeLessThan(cleanup.indexOf('removeProjectFamilyLocally(item.id)'));
    const saveEdit = appSource.slice(appSource.indexOf('const saveEdit = async'), appSource.indexOf('const toggleFavorite'));
    expect(saveEdit.indexOf('whatISaidProjectPathChanged')).toBeGreaterThan(-1);
    expect(saveEdit.indexOf('await revokeWhatISaidSharingBeforeRemoval')).toBeLessThan(saveEdit.indexOf('setPorts(edited)'));
    expect(appSource).not.toContain("code === 'PROJECT_MEMORY_NOT_INITIALIZED'");
  });

  test('a standalone worktree registration revokes sharing before the Git path disappears', () => {
    const start = appSource.indexOf('const executeWorktreeDelete = useCallback');
    const end = appSource.indexOf('const handleWorktreeMerge', start);
    const removal = appSource.slice(start, end);
    const revokeAt = removal.indexOf('await revokeWhatISaidSharingBeforeRemoval');
    expect(removal).toContain('wtPortEntry.id === item.id || item.folderPath === wt.path');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeLessThan(removal.indexOf('await API.gitWorktreeRemove'));
    expect(revokeAt).toBeLessThan(removal.indexOf('setPorts(nextPorts)'));
  });

  test('cross-device path attachment revokes an old source before persisting the new path', () => {
    const start = appSource.indexOf('const saveRemappedProjectPaths = async');
    const end = appSource.indexOf('async function openPortsHistory', start);
    const remap = appSource.slice(start, end);
    const revokeAt = remap.indexOf('await whatISaidApi.disableSource(folderPath, project.id)');
    expect(revokeAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeLessThan(remap.indexOf('setPorts(updated)'));
    expect(revokeAt).toBeLessThan(remap.indexOf('await API.savePorts(updated)'));

    const mergeStart = appSource.indexOf('const mergePortsFromOtherDevice');
    const mergeEnd = appSource.indexOf('const isWinPath', mergeStart);
    const merge = appSource.slice(mergeStart, mergeEnd);
    expect(merge).toContain('folderPath: undefined');
    expect(merge).toContain('worktreePath: undefined');
    expect(appSource.includes('...mergePortUploadFields(p, r)')).toBe(true);
    expect(mergePortUploadFields({id:'child',worktreeParentId:'parent'}, {id:'child'})).toMatchObject({worktreeParentId:'parent'});
    expect(appSource).toContain('withoutVerifiedLegacyGeneratedRemoteRows({');
  });
});
