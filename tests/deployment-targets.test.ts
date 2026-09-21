import { describe, expect, test } from 'bun:test';
import { buildDeploymentTargets } from '../src/deploymentTargets';

describe('deployment target aggregation', () => {
  test('keeps the header useful when this device has no local deploy URLs', () => {
    const targets = buildDeploymentTargets(
      [{ id: 'local-only', name: '로컬 프로젝트' }],
      [{ id: 'auto:deploy:shared-project', name: '공유 배포본', type: 'web', url: 'https://shared.example.test' }],
    );
    expect(targets).toEqual([expect.objectContaining({
      id: 'shared-project',
      name: '공유 배포본',
      deployUrl: 'https://shared.example.test/',
      source: 'portal',
    })]);
  });

  test('uses a matching local project name and path for a shared portal deployment', () => {
    const targets = buildDeploymentTargets(
      [{ id: 'p1', name: '새 이름', folderPath: '/work/p1' }],
      [{ id: 'auto:deploy:p1', name: '옛 이름', type: 'web', url: 'https://p1.example.test' }],
    );
    expect(targets[0]).toEqual(expect.objectContaining({ name: '새 이름', folderPath: '/work/p1' }));
  });

  test('prefers the current local URL and rejects non-web or unsafe portal rows', () => {
    const targets = buildDeploymentTargets(
      [{ id: 'p1', name: '현재', deployUrl: 'https://new.example.test/app' }],
      [
        { id: 'auto:deploy:p1', name: '옛 값', type: 'web', url: 'https://old.example.test' },
        { id: 'auto:deploy:file', name: '파일', type: 'web', url: 'file:///tmp/secret' },
        { id: 'manual', name: '수동 북마크', type: 'web', url: 'https://manual.example.test' },
      ],
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.deployUrl).toBe('https://new.example.test/app');
    expect(targets[0]?.source).toBe('project');
  });

  test('deduplicates old shared rows that point at the same deployment', () => {
    const targets = buildDeploymentTargets([], [
      { id: 'auto:deploy:old-a', name: 'A', type: 'web', url: 'https://same.example.test/' },
      { id: 'auto:deploy:old-b', name: 'B', type: 'web', url: 'https://same.example.test' },
    ]);
    expect(targets).toHaveLength(1);
  });
});
