import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CONTROL_SYNC_ATTENTION_TEXT, controlProfileWaiting} from '../src/ControlProfilePanel';
import {ProjectMemoryPanel} from '../src/ProjectMemoryPanel';
import {CONTROL_SYNC_CONFLICT_PROBLEM, createControlProfileHost} from '../control-profile-server';
import {initializeProjectMemory, detectProjectMemory, readMemoryDocument} from '../project-memory-server';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });

const none = {pending: 0, attention: 0, restoreOffer: false, otherControls: 0};
const sync = (state: 'not-configured' | 'current' | 'needs-attention', problem: string | null = null) => ({state, lastCheckedAt: '2026-10-28T00:00:00.000Z', problem});

// Review 2026-10-28: an OPS memory sync conflict was shown as a plain line, and with nothing else waiting the card said
// 「기다리는 후보나 연결 확인이 없습니다.」 right under it (the user's screenshot of 2026-10-27 shows exactly that).
describe('아젠투지 설정 counts an OPS memory sync problem as something to do', () => {
  test('a sync that needs attention is waiting even with no candidate, connection, restore or other folder', () => {
    expect(controlProfileWaiting({...none, sync: sync('needs-attention', '로컬과 원격 운영 기억이 다릅니다. 장기기억의 충돌 검토에서 확인하세요.')}))
      .toEqual({sync: true, waiting: true});
    expect(controlProfileWaiting({...none, sync: sync('needs-attention', '원격 운영 기억을 확인하지 못했습니다. 로컬 기억은 유지됩니다. 연결 후 다시 확인하세요.')}))
      .toEqual({sync: true, waiting: true});
  });

  test('a current, unconfigured or unread sync adds nothing, and the other to-dos keep counting', () => {
    for (const value of [sync('current'), sync('not-configured'), undefined]) expect(controlProfileWaiting({...none, sync: value})).toEqual({sync: false, waiting: false});
    for (const other of [{pending: 1}, {attention: 2}, {restoreOffer: true}, {otherControls: 1}])
      expect(controlProfileWaiting({...none, ...other, sync: sync('current')})).toEqual({sync: false, waiting: true});
  });

  test('its action only navigates: the app opens the 장기기억 tab and the panel sends no request for it', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain("onOpenMemoryStatus={()=>{setShowControlProfile(false);setActiveTab('memory');}}");
    const panel = readFileSync(new URL('../src/ControlProfilePanel.tsx', import.meta.url), 'utf8');
    const block = panel.slice(panel.indexOf('data-testid="control-profile-sync-attention"'));
    const end = block.indexOf('</div>}');
    expect(end).toBeGreaterThan(0);
    const item = block.slice(0, end);
    expect(item).toContain('onClick={onOpenMemoryStatus}');
    const navigation=item.slice(item.indexOf('{onOpenMemoryStatus&&'));
    expect(navigation).not.toContain('requestControlProfile');
    expect(item).not.toContain('operate(');
  });
});

// Review 2026-10-28: the conflict line said 「장기기억의 충돌 검토에서 확인하세요」, but the project memory panel deliberately does
// not mount the DEV editor (which holds 「동기화 충돌 검토」) for the OPS role, so that screen never opens for OPS. The copy and
// the to-do item now name only what is true and what exists: nothing was overwritten, local memory stays, there is no
// comparison screen for OPS yet, the per-device board, and the re-check. No new resolution UI and no automatic resolution.
describe('the OPS memory sync conflict copy names only what the person can do today', () => {
  test('a Pull that finds the two memories apart reports that copy and keeps the local memory in use', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'control-sync-copy-'));dirs.push(dir);
    const root = join(dir, 'AgentsToZ-OPS');mkdirSync(root);writeFileSync(join(root, 'CONTROL.md'), 'Control');
    initializeProjectMemory({folderPath: root, projectName: 'Control', agent: 'codex', autoBackup: true});
    const memory = detectProjectMemory(root), saved = readMemoryDocument(memory.projectRoot, memory.memoryPath!);
    let pulls = 0;
    const host = createControlProfileHost({appDataDir: join(dir, 'data'), portalDataFile: join(dir, 'portal.json'), gitPath: 'git', ghPath: 'gh',
      registered: async () => [{id: 'ops', name: 'AgentsToZ-OPS', folderPath: root}], register: async () => 'ops', lease: async (_r, _l, op) => op(),
      pullMemory: async () => { pulls++; return {success: false} as any; }});
    const prepared = await host.prepare();
    expect(pulls).toBeGreaterThan(0);
    expect(prepared.state).toBe('ready');
    expect(prepared.sync).toMatchObject({state: 'needs-attention', problem: CONTROL_SYNC_CONFLICT_PROBLEM});
    expect(readMemoryDocument(memory.projectRoot, memory.memoryPath!)).toBe(saved);
    expect(controlProfileWaiting({...none, sync: prepared.sync})).toEqual({sync: true, waiting: true});
  });

  test('it points at the dedicated OPS comparison while the DEV editor stays separate', () => {
    for (const text of [CONTROL_SYNC_CONFLICT_PROBLEM, CONTROL_SYNC_ATTENTION_TEXT]) {
      expect(text).not.toContain('화면은 아직 없습니다');
      expect(text).toContain('운영 기억');
    }
    expect(CONTROL_SYNC_CONFLICT_PROBLEM).toContain('어느 쪽도 덮어쓰지 않았고 로컬 기억은 유지됩니다');
    // The reason: for the OPS role the panel renders only its role notice, never the editor that holds 「동기화 충돌 검토」.
    const ops = renderToStaticMarkup(createElement(ProjectMemoryPanel, {projectRole: 'ops', projectName: 'AgentsToZ-OPS', folderPath: '/fixture/AgentsToZ-OPS'} as any));
    expect(ops).toContain('data-project-role="ops"');
    expect(ops).not.toContain('동기화 충돌 검토');
    expect(ops).not.toContain('Supabase 동기화');
  });

  test('the to-do item offers a bounded comparison and the existing re-check', () => {
    expect(CONTROL_SYNC_ATTENTION_TEXT).toContain('어느 쪽도 자동으로 덮어쓰지 않았습니다');
    expect(CONTROL_SYNC_ATTENTION_TEXT).toContain('장기기억 현황에서는 기기별 상태를 볼 수 있고');
    expect(CONTROL_SYNC_ATTENTION_TEXT).toContain('「아젠투지 준비·연결 다시 확인」');
    expect(CONTROL_SYNC_ATTENTION_TEXT).toContain('운영 기억 비교');
    expect(CONTROL_SYNC_ATTENTION_TEXT).not.toContain('맞춘 뒤');
    const panel = readFileSync(new URL('../src/ControlProfilePanel.tsx', import.meta.url), 'utf8');
    const block = panel.slice(panel.indexOf('data-testid="control-profile-sync-attention"'));
    expect(block.slice(0, block.indexOf('</div>}'))).toContain('{CONTROL_SYNC_ATTENTION_TEXT}');
    // The Playwright fixture renders the server's real copy, so the layout scenario checks what a person actually sees.
    const fixture = readFileSync(new URL('./control-profile-layout-ui.mjs', import.meta.url), 'utf8');
    expect(fixture).toContain(`const SYNC_CONFLICT = '${CONTROL_SYNC_CONFLICT_PROBLEM}';`);
  });
});
