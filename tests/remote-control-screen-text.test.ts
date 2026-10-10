import { describe, expect, test } from 'bun:test';
import { REMOTE_CONTROL_MOBILE_JS } from '../src/remoteControlMobilePage';
import { opsStatusText, remoteActionErrorHint, remoteControlActionLabel, remoteProjectStatusLabel, workroomSessionStateLabel } from '../src/remoteControlScreenText';

// The internet portal and the same-Wi-Fi QR page drew these separately and drifted (2026-10-07 audit).
describe('one set of words for both phone surfaces', () => {
  test('the QR page embeds the exact functions the portal uses', () => {
    for (const [name, fn] of [['actionLabel', remoteControlActionLabel], ['statusLabel', remoteProjectStatusLabel],
      ['errorNextStep', remoteActionErrorHint], ['sessionStateLabel', workroomSessionStateLabel], ['opsStatusLine', opsStatusText]] as const) {
      expect(REMOTE_CONTROL_MOBILE_JS).toContain(`const ${name}=${fn.toString()}`);
    }
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('ACTION_LABELS');
    expect(REMOTE_CONTROL_MOBILE_JS).not.toContain('ERROR_NEXT_STEPS');
  });

  test('the embedded functions run on their own — no module scope', () => {
    for (const fn of [remoteControlActionLabel, remoteProjectStatusLabel, remoteActionErrorHint, workroomSessionStateLabel, opsStatusText]) {
      const isolated = new Function(`return (${fn.toString()})`)();
      expect(typeof isolated).toBe('function');
    }
    const label = new Function(`return (${remoteControlActionLabel.toString()})`)();
    expect(label('orca.open')).toBe('Orca localhost');
    expect(label('git.merge')).toBe('기본 브랜치에 Merge');
  });

  test('the portal lists the files a dirty-tree refusal names, like the QR page', () => {
    const portal = require('node:fs').readFileSync(new URL('../src/remote-control-portal-main.tsx', import.meta.url), 'utf8') as string;
    expect(portal).toContain('value instanceof RemoteControlRelayRequestError ? value.changedPaths.slice(0, 12) : []');
    expect(portal).toContain('data-testid="remote-alert-paths"');
  });

  test('what used to differ now reads the same everywhere', () => {
    expect(remoteProjectStatusLabel({ status: 'unknown', port: 5173 })).toBe('포트 5173 · 상태 확인 필요');
    expect(remoteProjectStatusLabel({ kind: 'worktree' })).toBe('워크트리 · 포트 없음');
    expect(workroomSessionStateLabel({ state: 'running' })).toBe('실행 중');
    expect(workroomSessionStateLabel({ state: 'exited', exitCode: 0 })).toBe('종료 0');
    expect(workroomSessionStateLabel({ state: 'exited' })).toBe('종료');
    expect(opsStatusText({ state: 'mystery', pendingCount: 2 })).toBe('상태 확인 필요 · 저장 후보 2개');
    expect(remoteActionErrorHint('GIT_WORKTREE_DIRTY')).toContain('Commit');
    expect(remoteActionErrorHint('SOMETHING_ELSE')).toBeNull();
    expect(remoteControlActionLabel('unknown.action')).toBe('unknown.action');
  });
});
