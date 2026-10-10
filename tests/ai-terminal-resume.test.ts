import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {claudeConversationSaved, codexThreadFromOpenFiles, codexThreadSaved, processGroupOpenFiles, resolveAiTerminalResume} from '../src/aiTerminalResume';
import {claudeProjectSlug} from '../src/sessionTranscript';
import {workroomRestartNotice} from '../src/workroomRestart';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'agentstoz-resume-')); dirs.push(dir); return dir; };
const THREAD = '01a0fa13-f333-7e31-a9a8-7f685b13f5f2';
const OTHER = '01a0f9ba-1897-73e1-8773-73093a280139';

function rollout(codexHome: string, day: string, id: string, meta: Partial<{cwd: string; timestamp: string; source: string; originator: string}>) {
  const dir = join(codexHome, 'sessions', ...day.split('-'));
  mkdirSync(dir, {recursive: true});
  const payload = {id, session_id: id, timestamp: meta.timestamp ?? '2026-10-02T00:46:46.605Z', cwd: meta.cwd ?? '/work/p', source: meta.source ?? 'cli', originator: meta.originator ?? 'codex-tui', base_instructions: 'x'.repeat(60_000)};
  writeFileSync(join(dir, `rollout-${day}T09-46-46-${id}.jsonl`), JSON.stringify({type: 'session_meta', payload}) + '\n' + JSON.stringify({type: 'event_msg', payload: {type: 'user_message', message: 'hi'}}) + '\n');
}

describe('restart launch arguments', () => {
  test('Claude resumes its own conversation without forking or a second session id', () => {
    expect(aiTerminalLaunchArgs('claude', 'new-session-id', undefined, true, {agent: 'claude', conversationId: 'old-session-id'}))
      .toEqual(['--resume', 'old-session-id', '--permission-mode', 'bypassPermissions']);
    expect(aiTerminalLaunchArgs('claude', 'new-session-id')).toEqual(['--session-id', 'new-session-id']);
  });
  test('Codex runs its resume subcommand with the same options as a new session', () => {
    expect(aiTerminalLaunchArgs('codex', 'x', undefined, true, {agent: 'codex', conversationId: THREAD}))
      .toEqual(['resume', THREAD, '-c', 'tui.status_line=["context-remaining"]', '--dangerously-bypass-approvals-and-sandbox']);
    expect(aiTerminalLaunchArgs('codex', 'x', undefined, false, null)).toEqual(['-c', 'tui.status_line=["context-remaining"]']);
  });
  test('a resume for another agent is ignored, and Hermes/Antigravity always start fresh', () => {
    expect(aiTerminalLaunchArgs('codex', 'x', undefined, false, {agent: 'claude', conversationId: 'old-session-id'})).toEqual(['-c', 'tui.status_line=["context-remaining"]']);
    expect(aiTerminalLaunchArgs('hermes', 'x', undefined, true, {agent: 'codex', conversationId: THREAD})).toEqual(['chat', '--yolo']);
    expect(aiTerminalLaunchArgs('agy', 'x', undefined, false, {agent: 'codex', conversationId: THREAD})).toEqual([]);
  });
});

describe('which conversation a restart continues', () => {
  test('Claude: only a transcript with a user turn can be resumed', () => {
    const h = home(), cwd = '/Users/me/forcs/work/금소메뉴개편';
    const dir = join(h, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'with-turn-123.jsonl'), '{"type":"summary"}\n{"type":"user","message":{"content":"안녕"}}\n');
    writeFileSync(join(dir, 'no-turn-1234.jsonl'), '{"type":"file-history-snapshot"}\n');
    expect(claudeConversationSaved(cwd, 'with-turn-123', {home: h})).toBe(true);
    expect(claudeConversationSaved(cwd, 'no-turn-1234', {home: h})).toBe(false);
    expect(claudeConversationSaved(cwd, 'missing-12345', {home: h})).toBe(false);
    expect(claudeConversationSaved(cwd, '../../etc/passwd', {home: h})).toBe(false);
    // The legacy slug is still found.
    const ascii = '/Users/me/p_1', legacy = join(h, '.claude', 'projects', claudeProjectSlug(ascii));
    mkdirSync(legacy, {recursive: true});writeFileSync(join(legacy, 'legacy-1234.jsonl'), '{"type":"user"}\n');
    expect(claudeConversationSaved(ascii, 'legacy-1234', {home: h})).toBe(true);
  });

  test('Claude resolves through the conversation the session ran', async () => {
    const h = home(), cwd = '/w/p', dir = join(h, '.claude', 'projects', '-w-p');
    mkdirSync(dir, {recursive: true});writeFileSync(join(dir, 'conversation-1.jsonl'), '{"type":"user"}\n');
    expect(await resolveAiTerminalResume({agent: 'claude', cwd, createdAt: new Date().toISOString(), conversationId: 'conversation-1'}, {home: h}))
      .toEqual({agent: 'claude', conversationId: 'conversation-1'});
    expect(await resolveAiTerminalResume({agent: 'claude', cwd, createdAt: new Date().toISOString()}, {home: h})).toBeNull();
    expect(await resolveAiTerminalResume({agent: 'hermes', cwd, createdAt: new Date().toISOString(), conversationId: 'conversation-1'}, {home: h})).toBeNull();
  });

  test('Codex: the thread named by the writer lock the process group holds', () => {
    const codexHome = '/h/.codex';
    expect(codexThreadFromOpenFiles([`/h/.codex/logs_2.sqlite`, `/h/.codex/thread-writer-locks/${THREAD}.lock`], codexHome)).toBe(THREAD);
    expect(codexThreadFromOpenFiles([`/h/.codex/thread-writer-locks/${THREAD}.lock`, `/h/.codex/thread-writer-locks/${OTHER}.lock`], codexHome)).toBeNull();
    expect(codexThreadFromOpenFiles([`/elsewhere/thread-writer-locks/${THREAD}.lock`, `/h/.codex/thread-writer-locks/nope.lock`], codexHome)).toBeNull();
  });

  test('Codex: a resumed thread is found in any older day folder', () => {
    const h = home(), codexHome = join(h, '.codex');
    rollout(codexHome, '2026-08-01', THREAD, {});
    expect(codexThreadSaved(codexHome, THREAD)).toBe(true);
    expect(codexThreadSaved(codexHome, OTHER)).toBe(false);
    expect(codexThreadSaved(codexHome, 'not-a-uuid')).toBe(false);
  });

  test('Codex: the running process decides; no rollout yet means nothing to continue', async () => {
    const h = home(), codexHome = join(h, '.codex');
    // A neighbour's rollout in the same folder must not be picked when the process names its own thread.
    rollout(codexHome, '2026-10-02', OTHER, {cwd: '/work/p', timestamp: '2026-10-02T00:46:50.000Z'});
    const source = {agent: 'codex' as const, cwd: '/work/p', createdAt: '2026-10-02T00:46:45.000Z', processGroup: 4242};
    const openFiles = async (group: number) => group === 4242 ? [join(codexHome, 'thread-writer-locks', `${THREAD}.lock`)] : [];
    const env = {home: h, codexHome, openFiles, now: () => Date.parse('2026-10-02T01:00:00Z')};
    expect(await resolveAiTerminalResume(source, env)).toBeNull();
    rollout(codexHome, '2026-10-02', THREAD, {cwd: '/work/p'});
    expect(await resolveAiTerminalResume(source, env)).toEqual({agent: 'codex', conversationId: THREAD});
  });

  test('Codex: an ended session continues only the one rollout that can be its own', async () => {
    const h = home(), codexHome = join(h, '.codex');
    const ended = {agent: 'codex' as const, cwd: '/work/p', createdAt: '2026-10-02T00:46:40.000Z', exitedAt: '2026-10-02T01:10:00.000Z'};
    const env = {home: h, codexHome};
    rollout(codexHome, '2026-10-02', THREAD, {cwd: '/work/p', timestamp: '2026-10-02T00:46:46.605Z'});
    // Not candidates: another folder, the ChatGPT app, and a thread started long before this session.
    rollout(codexHome, '2026-10-02', '01a0fa13-0000-7e31-a9a8-7f685b13f5f2', {cwd: '/work/other', timestamp: '2026-10-02T00:47:00.000Z'});
    rollout(codexHome, '2026-10-02', '01a0fa13-1111-7e31-a9a8-7f685b13f5f2', {cwd: '/work/p', timestamp: '2026-10-02T00:48:00.000Z', source: 'vscode', originator: 'Codex Desktop'});
    rollout(codexHome, '2026-10-01', '01a0fa13-2222-7e31-a9a8-7f685b13f5f2', {cwd: '/work/p', timestamp: '2026-10-01T03:00:00.000Z'});
    expect(await resolveAiTerminalResume(ended, env)).toEqual({agent: 'codex', conversationId: THREAD});
    // A second CLI thread in the same folder during that time makes it ambiguous: start fresh rather than guess.
    rollout(codexHome, '2026-10-02', '01a0fa13-3333-7e31-a9a8-7f685b13f5f2', {cwd: '/work/p', timestamp: '2026-10-02T00:50:00.000Z'});
    expect(await resolveAiTerminalResume(ended, env)).toBeNull();
  });

  test('Codex on Windows continues through the rollout, since there is no lsof', async () => {
    // Windows has no process group and no lsof, so `processGroupOpenFiles`
    // answers nothing there and resolution falls through to the rollout match --
    // the same evidence the POSIX path uses for a session that already ended.
    // Nothing is lost by that: a live Codex at its composer has no thread lock
    // file yet (measured), so a lock only exists once a message has been sent,
    // which is exactly when a rollout exists too.
    expect(await processGroupOpenFiles(4242)).toEqual(process.platform === 'win32' ? [] : expect.any(Array));

    const h = home(), codexHome = join(h, '.codex');
    const live = {agent: 'codex' as const, cwd: '/work/p', createdAt: '2026-10-02T00:46:40.000Z', processGroup: 4242};
    // No openFiles supplied at all: exactly the Windows shape.
    const env = {home: h, codexHome, now: () => Date.parse('2026-10-02T01:00:00.000Z')};
    rollout(codexHome, '2026-10-02', THREAD, {cwd: '/work/p', timestamp: '2026-10-02T00:46:46.605Z'});
    expect(await resolveAiTerminalResume(live, env)).toEqual({agent: 'codex', conversationId: THREAD});

    // A second CLI thread in the same folder in that window is ambiguous, so a
    // Windows restart opens a fresh conversation rather than guessing. This is
    // the one place Windows is less precise than the lsof path.
    rollout(codexHome, '2026-10-02', '01a0fa13-4444-7e31-a9a8-7f685b13f5f2', {cwd: '/work/p', timestamp: '2026-10-02T00:50:00.000Z'});
    expect(await resolveAiTerminalResume(live, env)).toBeNull();
  });

  test('the Codex lock path is matched whatever separators and case the platform uses', () => {
    // `lsof` reports POSIX paths while `join(codexHome, …)` yields backslashes on
    // Windows, so the old `join(...) + '/'` prefix could never match there. A
    // Windows path may also be spelled with a different drive or directory case.
    const posix = codexThreadFromOpenFiles([`/h/.codex/thread-writer-locks/${THREAD}.lock`], '/h/.codex');
    expect(posix).toBe(THREAD);
    expect(codexThreadFromOpenFiles([`C:\\h\\.codex\\thread-writer-locks\\${THREAD}.lock`], 'C:\\h\\.codex')).toBe(THREAD);
    expect(codexThreadFromOpenFiles([`c:/H/.CODEX/thread-writer-locks/${THREAD}.lock`], 'C:\\h\\.codex')).toBe(THREAD);
    // The id itself still has to be a lowercase UUID; a path outside the lock
    // directory is never adopted however it is spelled.
    expect(codexThreadFromOpenFiles([`C:\\h\\.codex\\thread-writer-locks\\${THREAD.toUpperCase()}.lock`], 'C:\\h\\.codex')).toBeNull();
    expect(codexThreadFromOpenFiles([`C:\\h\\.codex\\other\\${THREAD}.lock`], 'C:\\h\\.codex')).toBeNull();
  });

  test('the notice says what happened, including an older Mac server', () => {
    expect(workroomRestartNotice('claude', true)).toContain('이어서');
    expect(workroomRestartNotice('codex', false)).toContain('/resume');
    expect(workroomRestartNotice('hermes', false)).toContain('이어 열지 않습니다');
    expect(workroomRestartNotice('codex', undefined)).toContain('이전 버전');
  });
});
