import {describe, expect, test} from 'bun:test';
import {Terminal as HeadlessTerminal} from '@xterm/headless';
import {
  deliverWorkroomRoute,
  readWorkroomScreen,
  renderWorkroomScreenLines,
  waitForWorkroomReady,
  WORKROOM_RELAY_REQUEST_MARGIN_BYTES,
  workroomRelayRequestBytes,
  workroomScreenAwaitsAnswer,
  workroomScreenExcerpt,
  workroomStartCarriesPrompt,
  workroomStartPromptRefused,
  type WorkroomRouteDeliveryInput,
} from '../src/workroomRouteDelivery';
import {AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR, AI_TERMINAL_PROMPT_REFUSED_ERROR, type AiTerminalRequest, type AiTerminalSummary} from '../src/aiTerminalProtocol';
import {REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES} from '../src/remoteControlRelayCrypto';
import {workroomDeliveryInstruction} from '../src/workroomProjectMention';
import {workroomSessionLabels} from '../src/workroomSessionLabel';

// Screens as the CLIs draw them (rows joined with CRLF, the way a PTY delivers them).
const screen = (...rows: string[]) => rows.join('\r\n');
const CLAUDE_TRUST = screen(
  '╭──────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?               │',
  '│                                                      │',
  '│ /Users/fixture/beta                                  │',
  '│                                                      │',
  '│ Claude Code may read, write, or execute files        │',
  '│ contained in this directory.                         │',
  '│                                                      │',
  '│ ❯ 1. Yes, proceed                                     │',
  '│   2. No, exit                                         │',
  '╰──────────────────────────────────────────────────────╯',
  '   Enter to confirm · Esc to exit',
);
const CLAUDE_PERMISSION = screen(
  '⏺ Bash(rm -rf build)',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again for rm commands in /Users/fixture/beta',
  '   3. No, and tell Claude what to do differently (esc)',
);
const CODEX_APPROVAL = screen(
  '  Would you like to run the following command?',
  '  $ rm -rf build',
  '› 1. Yes, proceed (y)',
  '  2. Yes, and don\'t ask again for this command (a)',
  '  3. No, and tell Codex what to do differently (esc)',
  '  Press enter to confirm or esc to cancel',
);
const CODEX_TRUST = screen(
  '> You are running Codex in /Users/fixture/beta',
  '  Since this folder is version controlled, you may wish to allow Codex to work in this folder without asking for approval.',
  '› 1. Yes, allow Codex to work in this folder without asking for approval',
  '  2. No, ask me to approve edits and commands',
  '  Press enter to continue',
);
const HERMES_YES_NO = screen('Hermes wants to run: npm test', 'Run this command? [y/N]');
const AGY_ALLOW = screen('? Allow agy to run `npm test`?', '❯ Allow once', '  Allow always', '  Deny');
const CLAUDE_IDLE = screen(
  '⏺ 작업을 마쳤습니다. 테스트 12개가 통과했습니다.',
  '╭──────────────────────────────────────────────────────╮',
  '│ >                                                    │',
  '╰──────────────────────────────────────────────────────╯',
  '  ? for shortcuts',
);
const CODEX_IDLE = screen('› Implement {feature}', '  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit');

const renderWith = (text: string, cols = 100, rows = 28) =>
  renderWorkroomScreenLines((c, r) => new HeadlessTerminal({cols: c, rows: r, allowProposedApi: true}), text, cols, rows);
const lines = async (text: string) => (await renderWith(text))!;

describe('what a receiving session is showing (M2)', () => {
  test('approval, trust, selection and yes/no prompts are recognized as waiting for an answer', async () => {
    for (const text of [CLAUDE_TRUST, CLAUDE_PERMISSION, CODEX_APPROVAL, CODEX_TRUST, HERMES_YES_NO, AGY_ALLOW]) {
      expect(workroomScreenAwaitsAnswer(await lines(text))).toBe(true);
    }
  });

  test('an idle composer is not a question, even with Allow, numbered lists or a question in the transcript', async () => {
    expect(workroomScreenAwaitsAnswer(await lines(CLAUDE_IDLE))).toBe(false);
    expect(workroomScreenAwaitsAnswer(await lines(CODEX_IDLE))).toBe(false);
    expect(workroomScreenAwaitsAnswer(await lines(screen('⏺ Allow users to sign in with Google.', '  1. Refactor the form', '  2. Rewrite the API', CLAUDE_IDLE)))).toBe(false);
    expect(workroomScreenAwaitsAnswer(await lines(screen('⏺ Would you like me to continue with the migration?', CLAUDE_IDLE)))).toBe(false);
    expect(workroomScreenAwaitsAnswer([])).toBe(false);
    expect(workroomScreenAwaitsAnswer(null)).toBe(false);
  });

  test('re-review N1: a prompt-like transcript line ABOVE an idle input box is not a question', async () => {
    // Claude repeats the user's last prompt after "> ": a numbered prompt must not read as a menu.
    const numberedPrompt = screen('> 1. 테스트를 실행해 주세요', '  2. 실패하면 원인을 요약해 주세요', '', '⏺ Bash(bun test)', '  ⎿  12 pass, 0 fail', '', '⏺ 테스트 12개가 모두 통과했습니다.', CLAUDE_IDLE);
    expect(workroomScreenAwaitsAnswer(await lines(numberedPrompt))).toBe(false);
    // An assistant question followed by a line that starts with Yes/No, then the idle composer.
    const yesLine = screen('⏺ Do you want me to proceed with the refactor?', '  Yes — it touches 3 files.', CLAUDE_IDLE);
    expect(workroomScreenAwaitsAnswer(await lines(yesLine))).toBe(false);
    // agy idle composer is an empty ">" row between rules; Codex shows a placeholder after "›".
    const agyIdle = screen('> 1. first step', '  2. second step', '⏺ Done.', '────────────────────', '>', '────────────────────', '? for shortcuts');
    expect(workroomScreenAwaitsAnswer(await lines(agyIdle))).toBe(false);
    expect(workroomScreenAwaitsAnswer(await lines(screen('› 1. run tests', '  2. summarize', '• All tests pass.', '', '› Ask Codex to do anything', '  ? for shortcuts')))).toBe(false);
    // A lone highlighted number with no sibling option is not a menu either.
    expect(workroomScreenAwaitsAnswer(await lines(screen('> 1. only item', '⏺ ok')))).toBe(false);
  });

  test('a real dialog BELOW an old idle composer still counts as waiting', async () => {
    expect(workroomScreenAwaitsAnswer(await lines(screen('⏺ earlier turn', '>', AGY_ALLOW)))).toBe(true);
    expect(workroomScreenAwaitsAnswer(await lines(screen(CLAUDE_IDLE, CLAUDE_PERMISSION)))).toBe(true);
  });

  test('only the bottom of the screen counts: an answered question scrolled up does not block', async () => {
    const answered = screen(CLAUDE_PERMISSION, ...Array.from({length: 12}, (_, i) => `⏺ line ${i}`), CLAUDE_IDLE);
    expect(workroomScreenAwaitsAnswer(await lines(answered))).toBe(false);
  });

  test('the excerpt is the last non-empty lines without box borders, bounded in count and width', async () => {
    const excerpt = workroomScreenExcerpt(await lines(CLAUDE_TRUST));
    expect(excerpt.at(-1)).toBe('Enter to confirm · Esc to exit');
    expect(excerpt).toContain('❯ 1. Yes, proceed');
    expect(excerpt.length).toBeLessThanOrEqual(8);
    expect(excerpt.every(line => !line.includes('│') && !line.includes('╭'))).toBe(true);
    const wide = workroomScreenExcerpt(['가'.repeat(300), '😀'.repeat(300)], 8, 40);
    expect(wide.map(line => [...line].length)).toEqual([40, 40]);
    expect(wide[1]!.endsWith('…')).toBe(true);
    expect(wide[1]).not.toContain('�');
  });
});

describe('reading a session screen through the ordinary read operation', () => {
  test('a rendered screen shows the final frame, not every redraw', async () => {
    const redraw = '⠋ Loading\r\x1b[2K⠙ Loading\r\x1b[2K' + CLAUDE_IDLE;
    const rendered = (await renderWith(redraw))!;
    expect(rendered.filter(line => line.includes('Loading'))).toEqual([]);
    expect(rendered.some(line => line.includes('? for shortcuts'))).toBe(true);
  });

  test('snapshot pages are joined; an older Mac that refuses snapshot is read without it', async () => {
    const reads: any[] = [];
    const paged = await readWorkroomScreen({
      sessionId: 'session-1',
      read: async request => {
        reads.push(request);
        return request.after === 0 ? {chunks: [{seq: 7, text: 'first '}], hasMore: true} : {chunks: [{seq: 8, text: 'second'}], hasMore: false};
      },
      render: async text => [text],
    });
    expect(paged).toEqual({lines: ['first second'], complete: true});
    expect(reads).toEqual([{operation: 'read', sessionId: 'session-1', after: 0, snapshot: true}, {operation: 'read', sessionId: 'session-1', after: 7, snapshot: true}]);

    const legacy: any[] = [];
    const refused = Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'), {code: 'TERMINAL_REQUEST_INVALID'});
    const old = await readWorkroomScreen({
      sessionId: 'session-1',
      read: async request => {legacy.push(request); if (request.snapshot) throw refused; return {chunks: [{seq: 1, text: 'whole history'}], hasMore: false};},
      render: async text => [text],
      snapshotUnsupported: error => (error as {code?: string}).code === 'TERMINAL_REQUEST_INVALID',
    });
    expect(old).toEqual({lines: ['whole history'], complete: true});
    expect(legacy.map(request => request.snapshot ?? null)).toEqual([true, null]);
  });

  test('a history longer than the read budget is reported as unknown instead of an old screen', async () => {
    let after = 0;
    const result = await readWorkroomScreen({
      sessionId: 'session-1', maxReads: 3,
      read: async () => ({chunks: [{seq: ++after, text: 'old output '}], hasMore: true}),
      render: async text => [text],
    });
    expect(result).toEqual({lines: null, complete: false});
  });
});

describe('the first request of a new session fits its connection (H1/M1)', () => {
  const start = (prompt: string, references?: string[]) => ({operation: 'start' as const, targetId: 'fixture-target-beta', agent: 'claude' as const, cols: 100, rows: 28, bypassPermissions: true, prompt, ...(references ? {references} : {})});

  test('the relay estimate is the exact plaintext the phone portal encrypts', () => {
    const request = start('한'.repeat(100), ['fixture-reference-1']);
    const plaintext = JSON.stringify({type: 'terminal.request', sessionToken: 'T'.repeat(43), request: {...request, requestId: crypto.randomUUID()}});
    expect(workroomRelayRequestBytes(request)).toBe(new TextEncoder().encode(plaintext).length);
  });

  test('a handoff between the relay limit and 24,000 bytes starts with its request only on the Mac itself', () => {
    const task = '한'.repeat(3700);
    expect(new TextEncoder().encode(task).length).toBeGreaterThan(REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES);
    expect(new TextEncoder().encode(task).length).toBeLessThan(24_000);
    expect(workroomStartCarriesPrompt(start(task), 'local')).toBe(true);
    expect(workroomStartCarriesPrompt(start(task), 'relay')).toBe(false);
    expect(workroomStartCarriesPrompt(start('한'.repeat(9000)), 'local')).toBe(false);
    expect(workroomStartCarriesPrompt(start('nul\0byte'), 'local')).toBe(false);
    // The largest relay-carried request stays under the relay's own limit with the margin to spare
    // (one ASCII character is one byte, so the boundary is found directly).
    const budget = REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES - WORKROOM_RELAY_REQUEST_MARGIN_BYTES;
    const size = budget - workroomRelayRequestBytes(start(''));
    expect(workroomRelayRequestBytes(start('a'.repeat(size)))).toBe(budget);
    expect(workroomStartCarriesPrompt(start('a'.repeat(size)), 'relay')).toBe(true);
    expect(workroomStartCarriesPrompt(start('a'.repeat(size + 1)), 'relay')).toBe(false);
  });

  test('refusals that mean "this Mac cannot take the first request" are told apart from real failures', () => {
    expect(workroomStartPromptRefused(new Error(AI_TERMINAL_PROMPT_REFUSED_ERROR))).toBe(true);
    expect(workroomStartPromptRefused(new Error(AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR))).toBe(true);
    expect(workroomStartPromptRefused(Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'), {code: 'TERMINAL_REQUEST_INVALID'}))).toBe(true);
    expect(workroomStartPromptRefused(new Error('agy CLI가 설치되어 있지 않습니다.'))).toBe(false);
    expect(workroomStartPromptRefused(new Error('실행 중인 터미널은 최대 12개입니다.'))).toBe(false);
  });
});

// A fake Mac behind the panel's request function: sessions, per-session screens and refusals.
function fakeHost(options: {sessions: AiTerminalSummary[]; screens?: Record<string, string>; refuseStart?: (request: any) => Error | null; newScreen?: string}) {
  const sessions = options.sessions.map(session => ({...session}));
  const screens: Record<string, string> = {...options.screens};
  const requests: any[] = [];
  let started = 0;
  const request = async (r: Omit<AiTerminalRequest, 'requestId'>) => {
    requests.push(r);
    if (r.operation === 'start') {
      const refusal = options.refuseStart?.(r);
      if (refusal) throw refusal;
      const session: AiTerminalSummary = {id: `fixture-started-${++started}`, targetId: r.targetId!, agent: r.agent!, state: 'running', createdAt: `2026-09-29T09:0${started}:00Z`, exitCode: null, cols: r.cols!, rows: r.rows!};
      sessions.push(session);
      screens[session.id] = options.newScreen ?? CLAUDE_IDLE;
      return {session};
    }
    const session = sessions.find(s => s.id === r.sessionId);
    if (!session) throw new Error('터미널을 찾을 수 없거나 접근 권한이 없습니다.');
    if (r.operation === 'read') {
      const text = screens[session.id] ?? '';
      return {session, chunks: r.after! < 1 && text ? [{seq: 1, text}] : [], nextCursor: Math.max(1, r.after!), truncated: false, hasMore: false};
    }
    return {session};
  };
  return {request, requests, sessions, screens};
}
const summary = (id: string, targetId: string, agent: AiTerminalSummary['agent'], createdAt = '2026-09-29T00:00:00Z'): AiTerminalSummary =>
  ({id, targetId, agent, state: 'running', createdAt, exitCode: null, cols: 100, rows: 28});
const SOURCE = summary('ops-agy', 'fixture-target-ops', 'agy');
const TARGET = {targetId: 'fixture-target-beta', label: 'Beta'};
const labelOf = (id: string) => ({'fixture-target-ops': 'OPS', 'fixture-target-beta': 'Beta'} as Record<string, string>)[id];

function route(host: ReturnType<typeof fakeHost>, overrides: Partial<WorkroomRouteDeliveryInput> = {}) {
  const confirms: string[] = [];
  let clock = 0;
  const input: WorkroomRouteDeliveryInput = {
    sessions: host.sessions, source: SOURCE, sourceLabel: 'OPS', target: TARGET, agent: 'claude', task: '테스트를 실행해 주세요', references: [],
    transport: 'local', bypassPermissions: true,
    sessionLabel: (sessions, id) => workroomSessionLabels(sessions, labelOf).get(id),
    request: host.request, confirm: message => {confirms.push(message); return true;},
    render: (text, cols, rows) => renderWith(text, cols, rows),
    now: () => clock, sleep: async ms => {clock += ms;},
    ...overrides,
  };
  return {input, confirms, run: () => deliverWorkroomRoute(input)};
}
const typed = (host: ReturnType<typeof fakeHost>, sessionId: string) => host.requests.filter(r => r.operation === 'input' && r.sessionId === sessionId);
const instructionFor = (task: string) => workroomDeliveryInstruction({task, sourceLabel: 'OPS', sourceAgentLabel: 'Antigravity', targetLabel: 'Beta'});

describe('an @ route from the Workroom panel', () => {
  test('M1: a handoff too long for the relay opens the session plainly and types it once the screen is ready', async () => {
    const task = '한'.repeat(3700);
    const host = fakeHost({sessions: [SOURCE]});
    const {run, confirms} = route(host, {transport: 'relay', task});
    const result = await run();
    const starts = host.requests.filter(r => r.operation === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0].prompt).toBeUndefined();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('준비되면 이 메시지를 입력할까요?');
    const inputs = typed(host, 'fixture-started-1');
    expect(inputs.map(r => r.data).join('')).toBe(instructionFor(task) + '\r');
    for (const r of inputs) expect(new TextEncoder().encode(r.data).length).toBeLessThanOrEqual(4096);
    expect(result).toMatchObject({status: 'delivered', receiver: {id: 'fixture-started-1'}});
    expect((result as {receipt: string}).receipt).toContain('화면이 준비된 뒤 메시지를 입력했습니다');
    expect((result as {receipt: string}).receipt).toContain('메시지가 길어');
  });

  test('M1: the same handoff on the Mac itself is still the new session\'s first request', async () => {
    const task = '한'.repeat(3700);
    const host = fakeHost({sessions: [SOURCE]});
    const result = await route(host, {transport: 'local', task}).run();
    expect(host.requests.filter(r => r.operation === 'start').map(r => r.prompt)).toEqual([instructionFor(task)]);
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
    expect(result).toMatchObject({status: 'delivered'});
  });

  test('M1: the Mac path stays generous above 24,000 bytes by typing after start', async () => {
    const task = '한'.repeat(9000);
    const host = fakeHost({sessions: [SOURCE]});
    const result = await route(host, {transport: 'local', task}).run();
    expect(host.requests.filter(r => r.operation === 'start').map(r => r.prompt ?? null)).toEqual([null]);
    expect(typed(host, 'fixture-started-1').map(r => r.data).join('')).toBe(instructionFor(task) + '\r');
    expect(result).toMatchObject({status: 'delivered'});
  });

  test('L6: a Mac that refuses a first request for this AI still gets the message, typed after start', async () => {
    for (const refusal of [new Error(AI_TERMINAL_PROMPT_REFUSED_ERROR), Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'), {code: 'TERMINAL_REQUEST_INVALID'})]) {
      const host = fakeHost({sessions: [SOURCE], refuseStart: r => r.prompt !== undefined ? refusal : null});
      const result = await route(host, {agent: 'hermes'}).run();
      expect(host.requests.filter(r => r.operation === 'start').map(r => r.prompt === undefined)).toEqual([false, true]);
      expect(typed(host, 'fixture-started-1').map(r => r.data).join('')).toBe(instructionFor('테스트를 실행해 주세요') + '\r');
      expect((result as {receipt: string}).receipt).toContain('이 Mac 버전은 새 세션의 첫 요청으로 받지 못했습니다');
    }
  });

  test('an older Mac that refuses # references on start still gets the request, names only', async () => {
    const host = fakeHost({sessions: [SOURCE], refuseStart: r => r.references ? new Error('허용되지 않은 터미널 요청입니다.') : null});
    const result = await route(host, {references: ['fixture-reference-1']}).run();
    expect(host.requests.filter(r => r.operation === 'start').map(r => r.references ?? null)).toEqual([['fixture-reference-1'], null]);
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
    expect((result as {receipt: string}).receipt).toContain('프로젝트 이름만 전달했습니다');
  });

  test('L3: when reference folders push the first request over the limit, it is typed with its references', async () => {
    const host = fakeHost({sessions: [SOURCE], refuseStart: r => r.prompt !== undefined ? new Error(AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR) : null});
    const result = await route(host, {references: ['fixture-reference-1']}).run();
    const inputs = typed(host, 'fixture-started-1');
    expect(inputs.at(-1)!.references).toEqual(['fixture-reference-1']);
    expect(inputs.slice(0, -1).every(r => r.references === undefined)).toBe(true);
    expect(result).toMatchObject({status: 'delivered'});
  });

  test('M2/L4: delivering to a live session says Enter is pressed, names the session and shows its last lines', async () => {
    const host = fakeHost({
      sessions: [SOURCE, summary('beta-claude-old', 'fixture-target-beta', 'claude', '2026-09-28T00:00:00Z'), summary('beta-claude-new', 'fixture-target-beta', 'claude', '2026-09-29T01:00:00Z')],
      screens: {'beta-claude-new': CLAUDE_IDLE},
    });
    const {run, confirms} = route(host);
    const result = await run();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('실행 중인 Claude Code 워크룸 세션으로 이 메시지를 전달할까요?');
    expect(confirms[0]).toContain('받는 세션: Beta · claude #2');
    expect(confirms[0]).toContain('Enter를 누릅니다');
    expect(confirms[0]).toContain('│ ? for shortcuts');
    expect(typed(host, 'beta-claude-new').map(r => r.data).join('')).toBe(instructionFor('테스트를 실행해 주세요') + '\r');
    expect(host.requests.filter(r => r.operation === 'start')).toEqual([]);
    expect((result as {receipt: string}).receipt).toBe('‘Beta’의 Claude Code 세션에 전달했습니다. 받는 세션: Beta · claude #2');
  });

  test('M2: a live session waiting on an approval is never typed into; the dialog offers a new session instead', async () => {
    for (const waiting of [CLAUDE_TRUST, CLAUDE_PERMISSION]) {
      const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')], screens: {'beta-claude': waiting}});
      const {run, confirms} = route(host);
      const result = await run();
      expect(typed(host, 'beta-claude')).toEqual([]);
      expect(confirms[0]).toContain('질문이나 승인에 대한 답을 기다리는 화면입니다');
      expect(confirms[0]).toContain('│ ❯ 1. Yes');
      expect(confirms[0]).toContain('대신 ‘Beta’ 프로젝트에 Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?');
      expect(host.requests.filter(r => r.operation === 'start').map(r => r.prompt)).toEqual([instructionFor('테스트를 실행해 주세요')]);
      expect(result).toMatchObject({status: 'delivered', receiver: {id: 'fixture-started-1'}});
    }
  });

  test('M2: declining the new-session offer keeps the draft and sends nothing', async () => {
    const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')], screens: {'beta-claude': CODEX_APPROVAL}});
    const result = await route(host, {confirm: () => false}).run();
    expect(result).toEqual({status: 'cancelled'});
    expect(host.requests.filter(r => r.operation === 'start' || r.operation === 'input')).toEqual([]);
  });

  test('M2: a session that turns into a question while the dialog is open is not typed into', async () => {
    const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')], screens: {'beta-claude': CLAUDE_IDLE}});
    const {run} = route(host, {confirm: () => {host.screens['beta-claude'] = CLAUDE_PERMISSION; return true;}});
    await expect(run()).rejects.toThrow('그 사이 질문이나 승인에 대한 답을 기다리는 화면으로 바뀌어');
    expect(typed(host, 'beta-claude')).toEqual([]);
  });

  test('M2: a failed or incomplete screen recheck after confirmation never types into the receiver', async () => {
    for (const failure of ['error', 'incomplete'] as const) {
      const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')], screens: {'beta-claude': CLAUDE_IDLE}});
      let reads = 0;
      const {run} = route(host, {request: async r => {
        if (r.operation === 'read' && ++reads > 1) {
          if (failure === 'error') throw new Error('연결이 끊겼습니다.');
          return {chunks: [], hasMore: true};
        }
        return host.request(r);
      }});
      await expect(run()).rejects.toThrow('현재 화면을 다시 확인하지 못해 입력하지 않았습니다');
      expect(typed(host, 'beta-claude')).toEqual([]);
    }
  });

  test('M2: a failed render of the second screen also keeps the draft and types nothing', async () => {
    const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')], screens: {'beta-claude': CLAUDE_IDLE}});
    let renders = 0;
    const {run} = route(host, {render: async (text, cols, rows) => ++renders === 1 ? renderWith(text, cols, rows) : null});
    await expect(run()).rejects.toThrow('현재 화면을 다시 확인하지 못해 입력하지 않았습니다');
    expect(typed(host, 'beta-claude')).toEqual([]);
  });

  test('M2: when the screen cannot be read the dialog explains the risk, then refuses an unverified recheck', async () => {
    const host = fakeHost({sessions: [SOURCE, summary('beta-claude', 'fixture-target-beta', 'claude')]});
    const reads = host.request;
    const {run, confirms} = route(host, {request: async r => {if (r.operation === 'read') throw new Error('Mac의 연결이 갱신되었습니다.'); return reads(r);}});
    await expect(run()).rejects.toThrow('현재 화면을 다시 확인하지 못해 입력하지 않았습니다');
    expect(confirms[0]).toContain('그 세션 화면을 확인하지 못했습니다');
    expect(confirms[0]).toContain('Enter를 누릅니다');
    expect(typed(host, 'beta-claude')).toEqual([]);
  });

  test('a new session that opens on a question keeps the draft and types nothing', async () => {
    const host = fakeHost({sessions: [SOURCE], newScreen: CLAUDE_TRUST});
    const result = await route(host, {transport: 'relay', task: '한'.repeat(3700)}).run();
    expect(result).toMatchObject({status: 'held', receiver: {id: 'fixture-started-1'}});
    expect(typed(host, 'fixture-started-1')).toEqual([]);
    expect((result as {receipt: string}).receipt).toContain('답한 뒤 다시 전달하세요');
    expect((result as {receipt: string}).receipt).toContain('작성 중인 내용은 유지했습니다');
  });

  test('a new session whose screen never settles is not typed into', async () => {
    const host = fakeHost({sessions: [SOURCE], newScreen: ''});
    const result = await route(host, {transport: 'relay', task: '한'.repeat(3700), readyTimeoutMs: 5_000}).run();
    expect(result).toMatchObject({status: 'held'});
    expect(typed(host, 'fixture-started-1')).toEqual([]);
    expect((result as {receipt: string}).receipt).toContain('화면이 준비되지 않아');
  });

  test('a start refused for another reason is reported, and nothing is typed', async () => {
    const host = fakeHost({sessions: [SOURCE], refuseStart: () => new Error('agy CLI가 설치되어 있지 않습니다.')});
    await expect(route(host, {agent: 'agy'}).run()).rejects.toThrow('agy CLI가 설치되어 있지 않습니다.');
    expect(host.requests.filter(r => r.operation === 'start')).toHaveLength(1);
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
  });
});

describe('waiting for a freshly started CLI', () => {
  test('settles only after output has been quiet, and reports the rendered screen', async () => {
    let clock = 0, reads = 0;
    const result = await waitForWorkroomReady({
      sessionId: 'session-1', quietMs: 1_000, pollMs: 250, timeoutMs: 10_000,
      now: () => clock, sleep: async ms => {clock += ms;},
      read: async request => {reads++; return request.after < 2 ? {chunks: [{seq: request.after + 1, text: `frame ${request.after + 1}\r\n`}], hasMore: false} : {chunks: [], hasMore: false};},
      render: async text => text.split('\r\n'),
    });
    expect(result.state).toBe('settled');
    expect(result.lines).toEqual(['frame 1', 'frame 2', '']);
    expect(clock).toBeGreaterThanOrEqual(1_000);
    expect(reads).toBeGreaterThan(2);
  });

  test('an exited session is reported as exited', async () => {
    const result = await waitForWorkroomReady({
      sessionId: 'session-1', now: () => 0, sleep: async () => {},
      read: async () => ({chunks: [{seq: 1, text: 'crash'}], hasMore: false, session: {state: 'exited'}}),
      render: async text => [text],
    });
    expect(result).toEqual({state: 'exited', lines: ['crash']});
  });
});

describe('an @ route to another AgentsToZ in the community (2026-10-05)', () => {
  // `sessions` and `request` already belong to the other Mac, so the sender is not among them.
  test('never reads as the current conversation, even when a targetId and AI happen to match', async () => {
    const theirs = summary('their-agy', SOURCE.targetId, SOURCE.agent);
    const host = fakeHost({sessions: [theirs], screens: {[theirs.id]: CODEX_IDLE}});
    const {run, confirms} = route(host, {
      sessions: host.sessions, agent: SOURCE.agent,
      target: {targetId: SOURCE.targetId, label: '아젠투지2호 · OPS'},
      crossDevice: {sourceDeviceLabel: '아젠투지1호'},
    });
    const result = await run();
    // Without crossDevice this same input would have thrown 「같은 프로젝트·같은 AI는 현재 세션으로 보냅니다.」
    expect(result.status).toBe('delivered');
    expect(confirms[0]).toContain('아젠투지2호 · OPS');
    expect(typed(host, theirs.id).map(r => r.data).join('')).toContain('보낸 기기: 아젠투지1호');
  });

  test('a new session on that Mac carries the handoff with the sending device named', async () => {
    const host = fakeHost({sessions: []});
    const result = await route(host, {
      sessions: host.sessions, target: {targetId: 'their-beta', label: '아젠투지2호 · Beta'},
      crossDevice: {sourceDeviceLabel: '아젠투지1호'},
    }).run();
    expect(result.status).toBe('delivered');
    const start = host.requests.find(r => r.operation === 'start');
    expect(start.prompt).toContain('보낸 기기: 아젠투지1호');
    expect(start.prompt).toContain('받는 프로젝트: 아젠투지2호 · Beta');
    expect(result.status === 'delivered' && result.receipt).toContain('아젠투지2호 · Beta');
  });
});
