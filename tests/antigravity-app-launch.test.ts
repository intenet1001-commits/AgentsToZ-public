import {describe, expect, test} from 'bun:test';
import {
  ANTIGRAVITY_APP_PROJECT_NOTE, ANTIGRAVITY_BUNDLE_ID,
  antigravityAppCandidatePaths, antigravityLaunchCommand, antigravityLaunchEnv, antigravityMdfindCommand,
  classifyAntigravityLaunch, createAntigravityAppLocator, findAntigravityApp,
} from '../src/antigravityAppLaunch';
import {
  CODE_APP_TASK_MAX_BYTES, CODE_APP_TASK_PREFILL_MAX_BYTES, CODEX_DEEP_LINK_MAX_CHARS, CodeAppTaskError,
  checkOpenCodeAppRequest, codexNewThreadLinkLength, codexTaskFitsDeepLink, normalizeCodeAppTask, planCodeAppTask,
} from '../src/codeAppTask';
import {buildCodeAppDeepLink} from '../code-app-links';
import {buildCodexDesktopDeepLinkCommand} from '../src/codexDesktopProjectSubmit';

// A realistic registered-project path (this worktree's own shape); the encoded path counts toward the link.
const FOLDER = '/Users/gwanli/product_2026/AgentsToZ_byCS/worktrees/project-search';

// Never launches the real Antigravity app: every decision is a pure function fed with fakes.
describe('findAntigravityApp', () => {
  test('prefers /Applications, then ~/Applications, without asking Spotlight', async () => {
    let asked = 0;
    const mdfind = () => { asked += 1; return null; };
    expect(await findAntigravityApp({home: '/Users/me', exists: p => p === '/Applications/Antigravity.app', mdfind})).toBe('/Applications/Antigravity.app');
    expect(await findAntigravityApp({home: '/Users/me/', exists: p => p === '/Users/me/Applications/Antigravity.app', mdfind})).toBe('/Users/me/Applications/Antigravity.app');
    expect(asked).toBe(0);
    expect(antigravityAppCandidatePaths('/Users/me')).toEqual(['/Applications/Antigravity.app', '/Users/me/Applications/Antigravity.app']);
  });

  test('falls back to a bounded Spotlight lookup and only accepts an existing .app bundle', async () => {
    const exists = (p: string) => p === '/Volumes/Tools/Antigravity.app';
    expect(await findAntigravityApp({home: '/Users/me', exists, mdfind: async () => 'garbage\n/Volumes/Tools/Antigravity.app\n'})).toBe('/Volumes/Tools/Antigravity.app');
    // A stale index entry that no longer exists, a relative path, or a non-bundle is not an install.
    expect(await findAntigravityApp({home: '/Users/me', exists, mdfind: () => '/Old/Antigravity.app\nAntigravity.app\n/Volumes/Tools/notes.txt'})).toBeNull();
    // Spotlight failed or timed out → not found (the button reports it; it is never hidden).
    expect(await findAntigravityApp({home: '/Users/me', exists, mdfind: () => null})).toBeNull();
    expect(antigravityMdfindCommand()).toEqual(['/usr/bin/mdfind', `kMDItemCFBundleIdentifier == '${ANTIGRAVITY_BUNDLE_ID}'`]);
  });
});

describe('Antigravity locator', () => {
  test('a Spotlight miss is remembered briefly; fixed locations are always rechecked; a hit is never cached', async () => {
    let clock = 1_000, asked = 0, installed: string | null = null, spotlight: string | null = null;
    const locate = createAntigravityAppLocator({
      home: () => '/Users/me', exists: p => p === installed || p === spotlight,
      mdfind: async () => { asked += 1; return spotlight; }, now: () => clock, missCacheMs: 30_000,
    });
    expect(await locate()).toBeNull();
    expect(asked).toBe(1);
    clock += 10_000;
    expect(await locate()).toBeNull();
    expect(asked).toBe(1); // repeated clicks within the window do not re-run mdfind
    installed = '/Applications/Antigravity.app';
    expect(await locate()).toBe('/Applications/Antigravity.app'); // seen at once, cache or not
    installed = null; spotlight = '/Volumes/Tools/Antigravity.app';
    clock += 30_001;
    expect(await locate()).toBe('/Volumes/Tools/Antigravity.app');
    expect(await locate()).toBe('/Volumes/Tools/Antigravity.app');
    expect(asked).toBe(3);
  });
});

describe('Antigravity launch', () => {
  test('opens by bundle id and strips every SSH_* variable (SSH env leaks into the app)', () => {
    expect(antigravityLaunchCommand()).toEqual(['/usr/bin/open', '-b', 'com.google.antigravity']);
    expect(antigravityLaunchEnv({PATH: '/usr/bin', HOME: '/Users/me', SSH_CONNECTION: '1 2 3 4', SSH_CLIENT: 'x', SSH_TTY: '/dev/ttys1', SSH_AUTH_SOCK: '/tmp/s', LANG: undefined}))
      .toEqual({PATH: '/usr/bin', HOME: '/Users/me'});
  });

  test('exit 0 is verified, a non-zero exit or spawn error fails, silence is unverified (never failure)', () => {
    expect(classifyAntigravityLaunch({kind: 'exited', exitCode: 0})).toEqual({status: 'verified'});
    const failed = classifyAntigravityLaunch({kind: 'exited', exitCode: 1});
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') { expect(failed.code).toBe('ANTIGRAVITY_APP_LAUNCH_FAILED'); expect(failed.error).toContain('1'); }
    expect(classifyAntigravityLaunch({kind: 'exited', exitCode: null}).status).toBe('failed');
    expect(classifyAntigravityLaunch({kind: 'spawn-error'}).status).toBe('failed');
    const silent = classifyAntigravityLaunch({kind: 'timeout'});
    expect(silent.status).toBe('unverified');
    if (silent.status === 'unverified') expect(silent.warning).toContain('확인하지 못했습니다');
  });

  test('the note says only that the project is chosen in the app — never that the app opened', () => {
    expect(ANTIGRAVITY_APP_PROJECT_NOTE).toBe('프로젝트는 앱에서 선택하세요');
    expect(ANTIGRAVITY_APP_PROJECT_NOTE).not.toContain('열었습니다');
  });
});

describe('code app task', () => {
  test('normalizes like a Workroom instruction and refuses controls, empty text and a leading !', () => {
    expect(normalizeCodeAppTask(undefined)).toBeUndefined();
    expect(normalizeCodeAppTask('  첫 줄\r\n둘째 줄  ')).toBe('첫 줄\n둘째 줄');
    expect(normalizeCodeAppTask('/review 해줘')).toBe('/review 해줘');
    for (const bad of ['', '   ', 5, 'a\u0007b', 'a\0b', '  !rm -rf /']) {
      expect(() => normalizeCodeAppTask(bad)).toThrow(CodeAppTaskError);
    }
    expect(() => normalizeCodeAppTask('가'.repeat(9_000))).toThrow(CodeAppTaskError);
  });

  test('Codex prefills a task that fits the deep link, otherwise reports too-large', () => {
    expect(planCodeAppTask('codex', '테스트 고쳐줘', FOLDER)).toEqual({prompt: '테스트 고쳐줘', taskApplied: 'prefilled'});
    const exact = 'a'.repeat(CODE_APP_TASK_PREFILL_MAX_BYTES);
    expect(planCodeAppTask('codex', exact, FOLDER).taskApplied).toBe('prefilled');
    expect(planCodeAppTask('codex', exact + 'a', FOLDER).taskApplied).toBe(false);
    // 1,334 Hangul syllables = 4,002 UTF-8 bytes: over the byte bound.
    const big = planCodeAppTask('codex', '가'.repeat(1_334), FOLDER);
    expect(big).toMatchObject({taskApplied: false, taskReason: 'too-large'});
    expect(big.prompt).toBeUndefined();
  });

  test('the prefill decision is made on the encoded link: the length helper equals the real builder', () => {
    for (const prompt of [undefined, 'fix it', '테스트 고쳐줘 & 확인 #1', '가'.repeat(900)]) {
      expect(codexNewThreadLinkLength(FOLDER, prompt)).toBe(buildCodeAppDeepLink('codex', FOLDER, prompt === undefined ? {} : {prompt}).url.length);
    }
  });

  test('a ~3,000-byte Korean task is not prefilled, and the real Codex command builds for every plan', () => {
    // Regression: 900 Hangul (2,700 bytes) used to pass the 4,000-byte check and make an 8,211-char URL,
    // which buildCodexDesktopDeepLinkCommand refuses (CODEX_DESKTOP_DEEP_LINK_INVALID → generic 500).
    for (const count of [900, 1_000, 1_300]) {
      const task = '가'.repeat(count);
      const plan = planCodeAppTask('codex', task, FOLDER);
      expect(plan).toMatchObject({taskApplied: false, taskReason: 'too-large'});
      const url = buildCodeAppDeepLink('codex', FOLDER, plan.prompt === undefined ? {} : {prompt: plan.prompt}).url;
      expect(() => buildCodexDesktopDeepLinkCommand(url, 'darwin')).not.toThrow();
    }
    // The largest Korean task that is prefilled still builds a valid command.
    let fits = 0;
    while (planCodeAppTask('codex', '가'.repeat(fits + 1), FOLDER).taskApplied === 'prefilled') fits += 1;
    expect(fits).toBeGreaterThan(700);
    const largest = planCodeAppTask('codex', '가'.repeat(fits), FOLDER);
    expect(largest.taskApplied).toBe('prefilled');
    const url = buildCodeAppDeepLink('codex', FOLDER, {prompt: largest.prompt}).url;
    expect(url.length).toBeLessThanOrEqual(CODEX_DEEP_LINK_MAX_CHARS);
    expect(buildCodexDesktopDeepLinkCommand(url, 'darwin')).toEqual(['/usr/bin/open', '-b', 'com.openai.codex', url]);
  });

  test('without a folder path the client keeps a reserve, so it never promises more than the server', () => {
    for (let count = 600; count <= 1_000; count += 20) {
      const task = '가'.repeat(count);
      if (codexTaskFitsDeepLink(task)) expect(codexTaskFitsDeepLink(task, FOLDER)).toBe(true);
    }
  });

  test('Claude, Hermes and Antigravity apps never claim to have received the task', () => {
    for (const agent of ['claude', 'hermes', 'agy'] as const) {
      const plan = planCodeAppTask(agent, '작업', FOLDER);
      expect(plan).toMatchObject({taskApplied: false, taskReason: 'unsupported-app'});
      expect(plan.prompt).toBeUndefined();
      expect(plan.taskNote).toContain('첫 요청을 받지 않습니다');
    }
  });
});

describe('/api/open-code-app request checks (the function the sidecar runs)', () => {
  test('a bad task is refused with a code before any app is touched', () => {
    expect(checkOpenCodeAppRequest({agent: 'codex', task: '!ls'})).toMatchObject({ok: false, status: 400, code: 'CODE_APP_TASK_SHELL_PREFIX'});
    expect(checkOpenCodeAppRequest({agent: 'claude', task: 'a\u0007b'})).toMatchObject({ok: false, status: 400, code: 'CODE_APP_TASK_INVALID'});
    expect(checkOpenCodeAppRequest({agent: 'agy', task: 'a'.repeat(CODE_APP_TASK_MAX_BYTES + 1)})).toMatchObject({ok: false, status: 400, code: 'CODE_APP_TASK_TOO_LARGE'});
    expect(checkOpenCodeAppRequest({agent: 'gpt'})).toMatchObject({ok: false, status: 400});
    expect(checkOpenCodeAppRequest({agent: 'codex', mode: 'later'})).toMatchObject({ok: false, status: 400});
  });

  test('Codex + task is always a new conversation; modes that cannot carry it are refused', () => {
    expect(checkOpenCodeAppRequest({agent: 'codex', task: '작업'})).toEqual({ok: true, agent: 'codex', mode: 'new', task: '작업'});
    // The desktop button's default `reopen` is turned into a new conversation.
    expect(checkOpenCodeAppRequest({agent: 'codex', mode: 'reopen', task: '작업'})).toMatchObject({ok: true, mode: 'new'});
    for (const mode of ['prepare', 'open']) {
      expect(checkOpenCodeAppRequest({agent: 'codex', mode, task: '작업'})).toMatchObject({ok: false, code: 'CODE_APP_TASK_MODE_INVALID'});
    }
    expect(checkOpenCodeAppRequest({agent: 'codex'})).toEqual({ok: true, agent: 'codex'});
  });

  test('mode rules per app are unchanged', () => {
    expect(checkOpenCodeAppRequest({agent: 'hermes', mode: 'open'})).toMatchObject({ok: true, mode: 'open'});
    expect(checkOpenCodeAppRequest({agent: 'claude', mode: 'new'}).ok).toBe(false);
    expect(checkOpenCodeAppRequest({agent: 'agy', mode: 'prepare'}).ok).toBe(false);
    expect(checkOpenCodeAppRequest({agent: 'codex', mode: 'open'}).ok).toBe(false);
    expect(checkOpenCodeAppRequest({agent: 'agy', task: '작업'})).toEqual({ok: true, agent: 'agy', task: '작업'});
  });

  test('the sidecar uses these functions and codes a Codex link failure instead of a bare 500', async () => {
    const api = await Bun.file(new URL('../api-server.ts', import.meta.url)).text();
    const fn = api.slice(api.indexOf('async function openCodeAppResponse'), api.indexOf('const server = Bun.serve('));
    expect(fn).toContain('checkOpenCodeAppRequest(');
    expect(fn).toContain('planCodeAppTask(agent, task, resolvedFolderPath)');
    expect(fn).toContain("code: invalid ? 'CODEX_DESKTOP_DEEP_LINK_INVALID' : 'CODEX_DESKTOP_OPEN_FAILED'");
    // Spotlight never blocks the sidecar.
    expect(fn).toContain('await locateAntigravityApp()');
    expect(fn).not.toContain('spawnSync(antigravityMdfindCommand');
  });
});

describe('surfaces', () => {
  test('the sidecar answers agy honestly and every app surface offers the button, gated by AI visibility', async () => {
    const [api, app] = await Promise.all([
      Bun.file(new URL('../api-server.ts', import.meta.url)).text(),
      Bun.file(new URL('../src/App.tsx', import.meta.url)).text(),
    ]);
    const branch = api.slice(api.indexOf("if (agent === 'agy') {"), api.indexOf("if (mode === 'prepare') {", api.indexOf("if (agent === 'agy') {")));
    expect(branch).toContain("code: 'ANTIGRAVITY_APP_UNSUPPORTED_PLATFORM'");
    expect(branch).toContain("code: 'ANTIGRAVITY_APP_NOT_FOUND'");
    expect(branch).toContain('antigravityLaunchEnv(process.env)');
    expect(branch).toContain('projectApplied: false');
    expect(branch).not.toContain('.kill(');
    expect(app.match(/data-testid="worktree-agy-app"/g)?.length).toBe(2);
    for (const id of ['project-agy-app', 'detail-agy-app']) expect(app).toContain(`data-testid="${id}"`);
    for (const line of app.split('\n').filter(l => l.includes('data-testid="worktree-agy-app"'))) expect(line).toContain("agentShown('agy')");
  });
});
