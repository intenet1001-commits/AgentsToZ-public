import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {normalizeAiTerminalRequest, normalizeAiTerminalResponse, type AiTerminalRequest} from '../src/aiTerminalProtocol';
import type {AiTerminalResume, AiTerminalResumeSource} from '../src/aiTerminalResume';

// 「다시 시작」 (VOC 2026-10-02): a real PTY, a fake CLI that records its argv and locale.
const services: AiTerminalService[] = []; const dirs: string[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown())); for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true}); });
const req = (r: Omit<AiTerminalRequest, 'requestId'>): AiTerminalRequest => ({...r, requestId: crypto.randomUUID()});
const targetId = 'project-restart-123';
const THREAD = '01a0fa13-f333-7e31-a9a8-7f685b13f5f2';

function fixture(options: {resume?: (source: AiTerminalResumeSource) => Promise<AiTerminalResume | null>; env?: Record<string, string | undefined>; remembered?: string[]} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentstoz-restart-')); dirs.push(dir);
  const executable = join(dir, 'cli');
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/args-$AGENTSTOZ_WORKROOM_SESSION_ID"
printf 'READY LANG=%s SSH=%s/%s/%s\\n' "\${LANG-unset}" "\${SSH_CONNECTION-unset}" "\${SSH_CLIENT-unset}" "\${SSH_TTY-unset}"
while IFS= read -r line; do printf 'GOT:%s\\n' "$line"; done
`); chmodSync(executable, 0o755);
  const sources: AiTerminalResumeSource[] = [];
  const service = new AiTerminalService({
    resolveTarget: async id => { if (id !== targetId) throw new Error('unregistered'); return {cwd: dir}; },
    executable: () => executable,
    env: options.env ?? {PATH: process.env.PATH, HOME: process.env.HOME},
    rememberEnded: job => options.remembered?.push(job.sessionId),
    resume: async source => { sources.push(source); return options.resume ? options.resume(source) : null; },
  });
  services.push(service);
  return {service, dir, sources};
}
async function output(service: AiTerminalService, id: string, contains: string) {
  const deadline = Date.now() + 4000; let text = '', cursor = 0;
  while (Date.now() < deadline) {
    const r = await service.perform(req({operation: 'read', sessionId: id, after: cursor}));
    for (const c of r.chunks ?? []) { text += c.text; cursor = c.seq; }
    if (text.includes(contains)) return text;
    await Bun.sleep(15);
  }
  throw new Error('Missing output ' + contains + ': ' + text);
}
const args = (dir: string, id: string) => readFileSync(join(dir, `args-${id}`), 'utf8').trim().split('\n').filter(Boolean);
const start = (service: AiTerminalService, agent: 'codex' | 'claude' | 'hermes', bypassPermissions?: boolean) =>
  service.perform(req({operation: 'start', targetId, agent, cols: 90, rows: 30, ...(bypassPermissions === undefined ? {} : {bypassPermissions})}));

/**
 * These cases drive a POSIX shell fake CLI (`stty`, `read`), which Windows
 * cannot execute at all: CreateProcess fails with error 193
 * (ERROR_BAD_EXE_FORMAT) before any assertion runs, so every case here was a
 * red failure there that hid real regressions. The Windows PTY backend is
 * covered by `tests/windows-pty.test.ts` and `tests/windows-workroom-session.test.ts`
 * against a real ConPTY session. Skipped with a reason rather than failed.
 */
const ptyDescribe = process.platform === 'win32' ? describe.skip : describe;

ptyDescribe('restart through start + resumeFrom', () => {
  test('a running Codex ends after its thread is read, and the new CLI resumes it in the same permission mode', async () => {
    const remembered: string[] = [];
    const {service, dir, sources} = fixture({remembered, resume: async () => ({agent: 'codex', conversationId: THREAD})});
    const old = (await start(service, 'codex', true)).session!;
    await output(service, old.id, 'READY');
    const restarted = await service.perform(req({operation: 'start', targetId, agent: 'codex', cols: 120, rows: 40, resumeFrom: old.id}));
    normalizeAiTerminalResponse(restarted);
    expect(restarted.resumed).toBe(true);
    // The thread was read while the old CLI still ran (its process group was known).
    expect(sources).toHaveLength(1);
    expect(sources[0]!.processGroup).toBeGreaterThan(1);
    const next = restarted.session!;
    expect(next.id).not.toBe(old.id);
    await output(service, next.id, 'READY');
    expect(args(dir, next.id)).toEqual(['resume', THREAD, '-c', 'tui.status_line=["context-remaining"]', '--dangerously-bypass-approvals-and-sandbox']);
    const list = await service.perform(req({operation: 'list'}));
    expect(list.sessions!.find(s => s.id === old.id)!.state).toBe('exited');
    expect(list.sessions!.find(s => s.id === next.id)!.state).toBe('running');
    // A continued conversation did not end, so it is not queued for a memory save.
    expect(remembered).not.toContain(old.id);
  });

  test('Claude continues its own --session-id conversation, and a second restart continues the same one', async () => {
    const {service, dir, sources} = fixture({resume: async source => source.conversationId ? {agent: 'claude', conversationId: source.conversationId} : null});
    const first = (await start(service, 'claude')).session!;
    await output(service, first.id, 'READY');
    expect(args(dir, first.id)).toEqual(['--session-id', first.id]);
    const second = (await service.perform(req({operation: 'start', targetId, agent: 'claude', cols: 80, rows: 24, resumeFrom: first.id}))).session!;
    await output(service, second.id, 'READY');
    expect(args(dir, second.id)).toEqual(['--resume', first.id]);
    const third = (await service.perform(req({operation: 'start', targetId, agent: 'claude', cols: 80, rows: 24, resumeFrom: second.id}))).session!;
    await output(service, third.id, 'READY');
    // The conversation is still the first one, not the second Workroom session's id.
    expect(args(dir, third.id)).toEqual(['--resume', first.id]);
    expect(sources.map(source => source.conversationId)).toEqual([first.id, first.id]);
  });

  test('nothing to continue: a fresh CLI, and the ended one is remembered like an ordinary close', async () => {
    const remembered: string[] = [];
    const {service, dir} = fixture({remembered});
    const old = (await start(service, 'codex')).session!;
    await output(service, old.id, 'READY');
    const restarted = await service.perform(req({operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: old.id}));
    expect(restarted.resumed).toBe(false);
    await output(service, restarted.session!.id, 'READY');
    expect(args(dir, restarted.session!.id)).toEqual(['-c', 'tui.status_line=["context-remaining"]']);
    expect(remembered).toContain(old.id);
  });

  test('an ended session restarts too, with its exit time for the rollout window', async () => {
    const {service, sources} = fixture();
    const old = (await start(service, 'codex')).session!;
    await output(service, old.id, 'READY');
    await service.perform(req({operation: 'close', sessionId: old.id}));
    const restarted = await service.perform(req({operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: old.id}));
    expect(restarted.session!.state).toBe('running');
    expect(sources[0]!.processGroup).toBeUndefined();
    expect(Date.parse(sources[0]!.exitedAt!)).toBeGreaterThanOrEqual(Date.parse(old.createdAt));
  });

  test('a restart is refused for another project, another AI, an unknown session or a phone', async () => {
    const {service} = fixture();
    const old = (await start(service, 'codex')).session!;
    await output(service, old.id, 'READY');
    await expect(service.perform(req({operation: 'start', targetId, agent: 'claude', cols: 80, rows: 24, resumeFrom: old.id}))).rejects.toThrow('다시 시작할 세션');
    await expect(service.perform(req({operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: 'missing-session-1'}))).rejects.toThrow('다시 시작할 세션');
    service.setRemoteAccess('internet:phone', true);
    await expect(service.perform(req({operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: old.id}), {owner: 'internet:phone', targets: new Set([targetId])})).rejects.toThrow('Mac의 워크룸에서만');
    const list = await service.perform(req({operation: 'list'}));
    expect(list.sessions!.find(s => s.id === old.id)!.state).toBe('running');
  });

  test('the protocol keeps a restart as it was: no request, references or new permission mode', () => {
    const base = {requestId: crypto.randomUUID(), operation: 'start', targetId, agent: 'codex', cols: 80, rows: 24, resumeFrom: 'session-abc-123'};
    expect(normalizeAiTerminalRequest(base).resumeFrom).toBe('session-abc-123');
    for (const extra of [{prompt: 'x'}, {bypassPermissions: true}, {resumeFrom: '../x'}]) expect(() => normalizeAiTerminalRequest({...base, ...extra})).toThrow();
    const session = {id: 'session-abc-123', targetId, agent: 'codex', state: 'running', createdAt: new Date().toISOString(), exitCode: null, cols: 80, rows: 24};
    expect(normalizeAiTerminalResponse({session, resumed: true}).resumed).toBe(true);
    expect(() => normalizeAiTerminalResponse({sessions: [session], resumed: true})).toThrow();
    expect(() => normalizeAiTerminalResponse({session, resumed: 'yes'})).toThrow();
  });
});

ptyDescribe('Workroom CLI locale', () => {
  test('an app opened from the Dock has no locale; the CLI gets UTF-8 instead of C', async () => {
    const {service} = fixture({env: {PATH: process.env.PATH, HOME: process.env.HOME}});
    const id = (await start(service, 'codex')).session!.id;
    await output(service, id, 'READY LANG=en_US.UTF-8');
  });
  test('a locale the user already has is kept', async () => {
    const {service} = fixture({env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'ko_KR.UTF-8'}});
    const id = (await start(service, 'codex')).session!.id;
    await output(service, id, 'READY LANG=ko_KR.UTF-8');
    const {service: other} = fixture({env: {PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: 'ko_KR.UTF-8'}});
    const second = (await start(other, 'codex')).session!.id;
    await output(other, second, 'READY LANG=unset');
  });
});

describe('Workroom CLI and the SSH session that launched the app', () => {
  // 3호 (2026-10-08): the app was relaunched by `open` over SSH, so every Workroom CLI inherited
  // SSH_CONNECTION/SSH_CLIENT. Antigravity then skipped the keychain and showed 「not signed in」 while the
  // same agy in a local terminal was signed in. A Workroom is a local terminal; it must not look remote.
  test('SSH_* from the app launch is not passed to the CLI', async () => {
    const {service} = fixture({env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'ko_KR.UTF-8', SSH_CONNECTION: '100.64.83.5 51000 100.64.0.2 22', SSH_CLIENT: '100.64.83.5 51000 22', SSH_TTY: '/dev/ttys009'}});
    const id = (await start(service, 'claude')).session!.id;
    await output(service, id, 'READY LANG=ko_KR.UTF-8 SSH=unset/unset/unset');
  });
});
