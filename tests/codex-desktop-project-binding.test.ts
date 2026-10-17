import { expect, test } from 'bun:test';
import { codexDesktopFolderOpenCommand, codexDesktopLaunchNotice, ensureCodexDesktopRegistration, isCodexDesktopProjectSelected,
  resolveCodexDesktopRegistration, verifyCodexDesktopThreadBinding } from '../src/codexDesktopProjectBinding';
import { parseChatGptThreadMetadata } from '../src/contextSessionMetadata';

const folderPath = '/Users/test/Projects/이현이열차';
const threadId = 'thread';
function fixture() {
  return {
    'local-projects': { train: { name: '이현이열차', rootPaths: [folderPath] } },
    'selected-project': { type: 'local', projectId: 'train' },
    'thread-project-assignments': { [threadId]: { projectKind: 'local', projectId: 'train' } },
    'electron-persisted-atom-state': { [`thread-workspace-state-v1:${threadId}`]: { applied: { cwd: folderPath } } },
  };
}

test('reuses the exact folder and host, regardless of label or Korean Unicode form', () => {
  const state = fixture();
  state['local-projects'].train.rootPaths[0] = folderPath.normalize('NFD');
  Object.assign(state['local-projects'], {
    other: { name: '이현이열차', rootPaths: ['/elsewhere/이현이열차'] },
    remote: { name: '이현이열차', rootPaths: [folderPath], hostId: 'remote' },
  });
  expect(resolveCodexDesktopRegistration(state, folderPath)).toEqual({ state: 'found', project: { projectId: 'train', hostId: 'local', folderPath } });
  expect(resolveCodexDesktopRegistration(state, folderPath, 'remote')).toMatchObject({ state: 'found', project: { projectId: 'remote' } });
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId })).toBe(true);
  expect(parseChatGptThreadMetadata(state).get(threadId)?.projectHint?.path).toBe(folderPath);
});

test('a same-name project or selected folder does not prove chat membership and cwd', () => {
  const state = fixture();
  expect(isCodexDesktopProjectSelected(state, { projectId: 'train', hostId: 'local', folderPath })).toBe(true);
  delete (state['thread-project-assignments'] as Record<string, unknown>)[threadId];
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId, executionCwd: folderPath })).toBe(false);
  state['local-projects'].train.rootPaths[0] = '/elsewhere/이현이열차';
  expect(resolveCodexDesktopRegistration(state, folderPath)).toEqual({ state: 'none' });
});

test('rejects missing registrations, duplicate paths, host conflicts, scratch cwd and pending moves', () => {
  for (const change of [
    (s: ReturnType<typeof fixture>) => { s['local-projects'] = {} as typeof s['local-projects']; },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['local-projects'], { duplicate: { rootPaths: [folderPath] } }); },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['thread-project-assignments'][threadId], { hostId: 'remote' }); },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['local-projects'].train, { hostId: 'remote' }); },
    (s: ReturnType<typeof fixture>) => { s['electron-persisted-atom-state'][`thread-workspace-state-v1:${threadId}`].applied.cwd = '/scratch'; },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['electron-persisted-atom-state'][`thread-workspace-state-v1:${threadId}`], { pending: { cwd: folderPath } }); },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['thread-project-assignments'][threadId], { pendingCoreUpdate: true }); },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['electron-persisted-atom-state'][`thread-workspace-state-v1:${threadId}`], { project: { projectKind: 'local', projectId: 'other' } }); },
    (s: ReturnType<typeof fixture>) => { Object.assign(s['electron-persisted-atom-state'][`thread-workspace-state-v1:${threadId}`], { project: { projectKind: 'local', projectId: 'train', hostId: 'remote' } }); },
  ]) {
    const state = fixture(); change(state);
    expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId, executionCwd: folderPath })).toBe(false);
  }
  expect(verifyCodexDesktopThreadBinding({ state: fixture(), folderPath, threadId, executionCwd: '/scratch' })).toBe(false);
});

test('an ID-only legacy assignment needs independent rollout cwd if no applied workspace exists', () => {
  const state = fixture();
  state['electron-persisted-atom-state'] = {} as typeof state['electron-persisted-atom-state'];
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId })).toBe(false);
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId, executionCwd: folderPath.normalize('NFD') })).toBe(true);
  state['local-projects'].train.rootPaths.push('/other');
  expect(parseChatGptThreadMetadata(state).get(threadId)?.projectHint?.path).toBeNull();
});

test('registration waits for actual desktop state; OS launch alone never succeeds or creates a fallback chat', async () => {
  let state: unknown = { 'local-projects': {} };
  let clock = 0, opens = 0;
  const input = {
    folderPath, read: () => state, openFolder: async () => { opens++; },
    now: () => clock, sleep: async (ms: number) => { clock += ms; }, timeoutMs: 1_000,
  };
  await expect(ensureCodexDesktopRegistration(input)).rejects.toMatchObject({ code: 'CODEX_PROJECT_REGISTRATION_UNVERIFIED' });
  expect(opens).toBe(1); expect(clock).toBe(1_000);
  clock = 0;
  const ready = await ensureCodexDesktopRegistration({ ...input, sleep: async ms => { clock += ms; if (clock >= 400) state = fixture(); } });
  expect(ready.projectId).toBe('train'); expect(clock).toBe(400);
  opens = 0;
  expect(await ensureCodexDesktopRegistration(input)).toEqual(ready); expect(opens).toBe(0);
});

test('unreadable or ambiguous inventory prevents any registration request', async () => {
  for (const state of [null, {}, { 'local-projects': { a: { rootPaths: [folderPath] }, b: { rootPaths: [folderPath] } } }]) {
    let opens = 0;
    await expect(ensureCodexDesktopRegistration({ folderPath, read: () => state, openFolder: async () => { opens++; },
      now: () => 0, sleep: async () => {}, timeoutMs: 0 })).rejects.toMatchObject({ code: 'CODEX_PROJECT_REGISTRATION_UNVERIFIED' });
    expect(opens).toBe(0);
  }
});

test('folder opening uses existing files and the exact installed bundle; unsupported platforms fail explicitly', () => {
  expect(codexDesktopFolderOpenCommand(folderPath, 'darwin')).toEqual(['/usr/bin/open', '-b', 'com.openai.codex', folderPath]);
  for (const platform of ['win32', 'linux']) expect(() => codexDesktopFolderOpenCommand(folderPath, platform)).toThrow('프로젝트 자동 등록');
});

test('desktop and MCP callers warn about draft selection rather than reporting a linked conversation', () => {
  for (const projectApplied of [false, undefined, 'requested']) {
    expect(codexDesktopLaunchNotice({ projectApplied })).toMatchObject({ severity: 'warning' });
  }
  expect(codexDesktopLaunchNotice({ projectApplied: false, projectNote: '선택만 확인됨' })).toEqual({ severity: 'warning', message: '선택만 확인됨' });
  expect(codexDesktopLaunchNotice({ projectApplied: true }).severity).toBe('success');
});

test('API registration is distinguished from desktop visibility and its ID is retained on a pending catalog', async () => {
  let clock = 0, registrations = 0, opens = 0;
  await expect(ensureCodexDesktopRegistration({ folderPath, read: () => ({ 'local-projects': {} }),
    registerBackend: async () => { registrations++; return { backendRegistered: true, backendProjectId: 'retained' }; },
    openFolder: async () => { opens++; }, now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 400,
  })).rejects.toMatchObject({ code: 'CODEX_DESKTOP_PROJECT_CATALOG_PENDING', details: {
    backendRegistered: true, backendProjectId: 'retained', desktopProjectVisible: false,
  } });
  expect(registrations).toBe(1); expect(opens).toBe(1);
});

test('unavailable project API does not fall through to opening a projectless conversation', async () => {
  let opens = 0;
  await expect(ensureCodexDesktopRegistration({ folderPath, read: () => ({ 'local-projects': {} }),
    registerBackend: async () => { throw new Error('unsupported API'); },
    openFolder: async () => { opens++; }, now: () => 0, sleep: async () => {}, timeoutMs: 0,
  })).rejects.toMatchObject({ code: 'CODEX_PROJECT_API_UNAVAILABLE' });
  expect(opens).toBe(0);
});

test('uses a real selection or assignment to resolve plain NFC/NFD folder aliases without guessing another project', () => {
  const state = fixture();
  Object.assign(state['local-projects'], { decomposed: { name: '이현이열차'.normalize('NFD'), rootPaths: [folderPath.normalize('NFD')] } });
  state['selected-project'].projectId = 'decomposed';
  expect(resolveCodexDesktopRegistration(state, folderPath)).toMatchObject({ state: 'found', project: { projectId: 'decomposed' } });
  // The assigned chat can belong to the other encoding alias; its cwd still needs independent proof.
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId })).toBe(true);
  state['electron-persisted-atom-state'][`thread-workspace-state-v1:${threadId}`].applied.cwd = '/scratch';
  expect(verifyCodexDesktopThreadBinding({ state, folderPath, threadId })).toBe(false);
  state['selected-project'].projectId = 'unrelated';
  expect(resolveCodexDesktopRegistration(state, folderPath)).toEqual({ state: 'ambiguous' });
});

test('an encoding difference never resolves distinct labels, backing or extra project sources', () => {
  for (const extra of [{ name: 'different' }, { chatGptBacking: {} }, { rootPaths: [folderPath.normalize('NFD'), '/other'] }]) {
    const state = fixture();
    Object.assign(state['local-projects'], { decomposed: { name: '이현이열차'.normalize('NFD'), rootPaths: [folderPath.normalize('NFD')], ...extra } });
    state['selected-project'].projectId = 'decomposed';
    expect(resolveCodexDesktopRegistration(state, folderPath)).toEqual({ state: 'ambiguous' });
  }
});
