import { describe, expect, test } from 'bun:test';
import { mergeLegacyPortSave, mergePortSnapshots, type PortRecord } from '../src/ports-merge';

type TestPort = PortRecord & {
  name: string;
  isRunning?: boolean;
  folderPath?: string;
  githubUrl?: string;
  favorite?: boolean;
  futureField?: string;
};

describe('ports persistence three-way merge', () => {
  test('preserves a project added by another stale browser tab', () => {
    const base: TestPort[] = [{ id: 'old', name: 'Old', isRunning: false }];
    const desired: TestPort[] = [{ id: 'old', name: 'Old', isRunning: true }];
    const current: TestPort[] = [
      { id: 'myjob1', name: 'myjob1', folderPath: '/work/myjob1' },
      ...base,
    ];

    expect(mergePortSnapshots(base, desired, current)).toEqual([
      { id: 'myjob1', name: 'myjob1', folderPath: '/work/myjob1' },
      { id: 'old', name: 'Old', isRunning: true },
    ]);
  });

  test('applies an intentional deletion from the baseline', () => {
    const base: TestPort[] = [{ id: 'delete-me', name: 'Delete' }, { id: 'keep', name: 'Keep' }];
    expect(mergePortSnapshots(base, [base[1]!], base)).toEqual([base[1]!]);
  });

  test('merges concurrent changes to different fields', () => {
    const base: TestPort[] = [{ id: 'p1', name: 'Project', githubUrl: '', favorite: false }];
    const desired: TestPort[] = [{ ...base[0]!, favorite: true }];
    const current: TestPort[] = [{ ...base[0]!, githubUrl: 'https://github.com/acme/project' }];

    expect(mergePortSnapshots(base, desired, current)).toEqual([
      {
        id: 'p1',
        name: 'Project',
        githubUrl: 'https://github.com/acme/project',
        favorite: true,
      },
    ]);
  });

  test('does not resurrect a record deleted by another window when untouched locally', () => {
    const base: TestPort[] = [{ id: 'gone', name: 'Gone' }];
    expect(mergePortSnapshots(base, base, [])).toEqual([]);
  });

  test('preserves unknown fields written by a newer client', () => {
    const base: TestPort[] = [{ id: 'p1', name: 'Project', favorite: false }];
    const desired: TestPort[] = [{ ...base[0]!, favorite: true }];
    const current: TestPort[] = [{ ...base[0]!, futureField: 'keep-me' }];

    expect(mergePortSnapshots(base, desired, current)[0]).toEqual({
      id: 'p1',
      name: 'Project',
      favorite: true,
      futureField: 'keep-me',
    });
  });

  test('legacy full-array saves cannot delete current-only projects', () => {
    expect(
      mergeLegacyPortSave(
        [{ id: 'old', name: 'Old edited' }],
        [{ id: 'myjob1', name: 'myjob1' }, { id: 'old', name: 'Old' }],
      ),
    ).toEqual([
      { id: 'old', name: 'Old edited' },
      { id: 'myjob1', name: 'myjob1' },
    ]);
  });
});
