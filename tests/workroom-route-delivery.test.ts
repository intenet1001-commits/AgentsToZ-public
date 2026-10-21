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
import {WorkroomLaunchUnsupportedError, WorkroomSubmissionUnsupportedError, type PendingWorkroomLaunch} from '../src/workroomSubmissionClient';
import {failedLegacyStartKey, legacyStartDigest, readFailedLegacyStart} from '../src/workroomLegacyStartGuard';

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
  test('a native confirmation gates both a new handoff and typing into an existing receiver',async()=>{
    for(const existing of [false,true])for(const approved of [false,true]){
      const receiver=summary('native-receiver',TARGET.targetId,'claude');
      const host=fakeHost({sessions:existing?[SOURCE,receiver]:[SOURCE]});
      let reply!:(value:boolean)=>void;
      const {run}=route(host,{confirm:()=>new Promise<boolean>(resolve=>{reply=resolve;})});
      const pending=run();
      for(let i=0;i<30&&!reply;i++)await new Promise(resolve=>setTimeout(resolve,0));
      expect(reply).toBeFunction();
      const mutations=()=>host.requests.filter(r=>r.operation==='start'||r.operation==='input'||r.operation==='submission');
      expect(mutations()).toHaveLength(0);
      reply(approved);const result=await pending;
      expect(result.status).toBe(approved?'delivered':'cancelled');
      if(!approved)expect(mutations()).toHaveLength(0);
      else if(!existing)expect(host.requests.filter(r=>r.operation==='start')).toHaveLength(1);
      else expect(typed(host,receiver.id)).toHaveLength(1);
    }
  });
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

// S3-3: a destination that advertises terminal-submission-v1 gets the handoff as one whole-request submission
// with a receipt — never as raw input parts. Anything short of `written` is reported, kept and never retyped.
describe('an @ route into a running receiver uses the whole-request submission receipt', () => {
  type Pending = {id: string; sessionId: string; receipt: any};
  function submissionHost(options: {sessions: AiTerminalSummary[]; screens?: Record<string, string>; lose?: (r: any) => 'drop-ack' | 'unknown' | null; refuseUnsupported?: boolean; newScreen?: string}) {
    const host = fakeHost({sessions: options.sessions, screens: options.screens, newScreen: options.newScreen});
    const base = host.request;
    const writes: {sessionId: string; text: string}[] = [];
    const assemblies = new Map<string, Buffer[]>();
    const receipt = (id: string, state: string) => ({id, storeId: 'fixture-store', epoch: 'fixture-epoch', revision: 0, state});
    const request = async (r: Omit<AiTerminalRequest, 'requestId'>): Promise<any> => {
      if (r.operation !== 'submission') return base(r);
      host.requests.push(r);
      if (options.refuseUnsupported) throw new Error('다른 기기에서는 워크룸 터미널만 제어할 수 있습니다.');
      const s = r.submission as any;
      const key = `${r.sessionId}:${s.id}`;
      let state = 'prepared';
      if (s.phase === 'single') {assemblies.set(key, [Buffer.from(s.data, 'base64')]); state = 'commit';}
      if (s.phase === 'begin') assemblies.set(key, [Buffer.from(s.firstData, 'base64')]);
      if (s.phase === 'chunk') {assemblies.get(key)![s.index] = Buffer.from(s.data, 'base64'); if (s.commit) state = 'commit';}
      if (state === 'commit') {
        const outcome = options.lose?.(r) ?? null;
        if (outcome === 'unknown') return {submission: receipt(s.id, 'unknown')};
        writes.push({sessionId: r.sessionId!, text: Buffer.concat(assemblies.get(key)!).toString('utf8')});
        if (outcome === 'drop-ack') throw new Error('연결이 끊겼습니다.');
        return {submission: receipt(s.id, 'written')};
      }
      return {submission: receipt(s.id, state)};
    };
    const store = new Map<string, Pending>();
    const remembered: (Pending | null)[] = [];
    const submission = {
      supported: true,
      pending: (sessionId: string) => store.get(sessionId) ?? null,
      remember: (sessionId: string, value: Pending | null) => {remembered.push(value); if (value) store.set(sessionId, value); else store.delete(sessionId);},
    };
    return {...host, request, writes, store, remembered, submission};
  }
  const RECEIVER = summary('beta-claude', 'fixture-target-beta', 'claude');
  const handoff = instructionFor('테스트를 실행해 주세요') + '\r';

  test('(1) an existing receiver gets exactly one submission and no raw input', async () => {
    const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    const result = await route(host as any, {request: host.request, submission: host.submission}).run();
    expect(result).toMatchObject({status: 'delivered', receiver: {id: RECEIVER.id}});
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
    const submissions = host.requests.filter(r => r.operation === 'submission');
    expect(submissions.map(r => r.submission.phase)).toEqual(['single']);
    expect(host.writes).toEqual([{sessionId: RECEIVER.id, text: handoff}]);
    expect(host.store.size).toBe(0);
    expect(host.remembered.at(-1)).toBeNull();
  });

  test('(1) a handoff over one chunk goes as begin..commit with references on the first request only', async () => {
    const task = '한'.repeat(3000);
    const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    const result = await route(host as any, {request: host.request, submission: host.submission, task, references: ['fixture-reference-1']}).run();
    expect(result.status).toBe('delivered');
    const submissions = host.requests.filter(r => r.operation === 'submission');
    expect(submissions[0].submission.phase).toBe('begin');
    expect(submissions[0].references).toEqual(['fixture-reference-1']);
    expect(submissions.slice(1).every(r => r.references === undefined)).toBe(true);
    expect(submissions.at(-1)!.submission.commit).toBe(true);
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
    expect(host.writes).toEqual([{sessionId: RECEIVER.id, text: instructionFor(task) + '\r'}]);
  });

  test('(2) a lost commit ack is uncertain: no second write, the draft stays and a pending record is left', async () => {
    for (const lose of ['drop-ack', 'unknown'] as const) {
      const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}, lose: () => lose});
      const result = await route(host as any, {request: host.request, submission: host.submission}).run();
      expect(result.status).toBe('uncertain');
      expect((result as {receipt: string}).receipt).toContain('전달 결과 미확정 · 자동으로 다시 보내지 않음');
      expect((result as {receipt: string}).receipt).toContain('작성 중인 내용은 유지했습니다');
      expect(host.writes.length).toBeLessThanOrEqual(1);
      expect(host.requests.filter(r => r.operation === 'submission')).toHaveLength(1);
      expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
      const pending = host.store.get(RECEIVER.id)!;
      expect(pending.sessionId).toBe(RECEIVER.id);
      expect(pending.id).toBe(host.requests.find(r => r.operation === 'submission').submission.id);
    }
  });

  test('(2) an unsettled record on the receiver refuses a second delivery before anything is sent', async () => {
    const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    host.store.set(RECEIVER.id, {id: 'fixture-earlier-1', sessionId: RECEIVER.id, receipt: null});
    const {run, confirms} = route(host as any, {request: host.request, submission: host.submission});
    await expect(run()).rejects.toThrow('전달 결과가 아직 미확정');
    expect(confirms).toEqual([]);
    expect(host.requests.filter(r => r.operation === 'submission' || r.operation === 'input')).toEqual([]);
  });

  // w4 review, findings 2 and 3: a record means a submission went out, whatever this connection can send right now —
  // the feature not known yet after a reconnect, or storage that reads but refuses new records. Raw input past it would
  // type the same handoff into a receiver that may already be running it.
  test('(2) an unsettled record on the receiver refuses the route even when a submission cannot be sent now', async () => {
    const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    host.store.set(RECEIVER.id, {id: 'fixture-earlier-1', sessionId: RECEIVER.id, receipt: null});
    const {run, confirms} = route(host as any, {request: host.request, submission: {...host.submission, supported: false}});
    await expect(run()).rejects.toThrow('전달 결과가 아직 미확정');
    expect(confirms).toEqual([]);
    expect(host.requests.filter(r => r.operation === 'submission' || r.operation === 'input')).toEqual([]);
  });

  test('(3) an unsupported destination keeps today\'s raw byte sequence', async () => {
    const task = '한'.repeat(3000);
    const raw = fakeHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    await route(raw, {task, references: ['fixture-reference-1']}).run();
    const off = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    await route(off as any, {request: off.request, task, references: ['fixture-reference-1'], submission: {...off.submission, supported: false}}).run();
    const sequence = (requests: any[]) => requests.filter(r => r.operation !== 'read');
    expect(sequence(off.requests)).toEqual(sequence(raw.requests));
    const parts = sequence(raw.requests);
    expect(parts.map(r => r.operation)).toEqual(['input', 'input', 'input']);
    expect(parts.map(r => r.data).join('')).toBe(instructionFor(task) + '\r');
    expect(parts.map(r => r.references ?? null)).toEqual([null, null, ['fixture-reference-1']]);
    // A short handoff stays the single raw input it always was.
    const short = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    await route(short as any, {request: short.request, submission: {...short.submission, supported: false}}).run();
    expect(sequence(short.requests)).toEqual([{operation: 'input', sessionId: RECEIVER.id, data: handoff}]);
  });

  test('(4) another AgentsToZ that advertises submission gets one submission with its references', async () => {
    const theirs = summary('their-claude', 'their-beta', 'claude');
    const host = submissionHost({sessions: [theirs], screens: {[theirs.id]: CODEX_IDLE}});
    const result = await route(host as any, {
      sessions: host.sessions, request: host.request, submission: host.submission, references: ['their-reference'],
      target: {targetId: 'their-beta', label: '아젠투지2호 · Beta'}, crossDevice: {sourceDeviceLabel: '아젠투지1호'},
    }).run();
    expect(result.status).toBe('delivered');
    const submissions = host.requests.filter(r => r.operation === 'submission');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].references).toEqual(['their-reference']);
    expect(host.writes[0]!.text).toContain('보낸 기기: 아젠투지1호');
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
  });

  test('(4) a receiver that advertised submission but refuses it before anything ran says so and clears the record', async () => {
    const theirs = summary('their-claude', 'their-beta', 'claude');
    const host = submissionHost({sessions: [theirs], screens: {[theirs.id]: CODEX_IDLE}, refuseUnsupported: true});
    await expect(route(host as any, {
      sessions: host.sessions, request: host.request, submission: host.submission,
      target: {targetId: 'their-beta', label: '아젠투지2호 · Beta'}, crossDevice: {sourceDeviceLabel: '아젠투지1호'},
    }).run()).rejects.toBeInstanceOf(WorkroomSubmissionUnsupportedError);
    expect(host.store.size).toBe(0);
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
  });

  test('(5) a receiver that turns into a question on the second read is refused before any submission', async () => {
    const host = submissionHost({sessions: [SOURCE, RECEIVER], screens: {[RECEIVER.id]: CLAUDE_IDLE}});
    const {run} = route(host as any, {request: host.request, submission: host.submission, confirm: () => {host.screens[RECEIVER.id] = CLAUDE_PERMISSION; return true;}});
    await expect(run()).rejects.toThrow('그 사이 질문이나 승인에 대한 답을 기다리는 화면으로 바뀌어');
    expect(host.requests.filter(r => r.operation === 'submission' || r.operation === 'input')).toEqual([]);
    expect(host.store.size).toBe(0);
  });

  test('a new session typed after it is ready also goes as one submission', async () => {
    const task = '한'.repeat(3700);
    const host = submissionHost({sessions: [SOURCE]});
    const result = await route(host as any, {request: host.request, submission: host.submission, transport: 'relay', task}).run();
    expect(result).toMatchObject({status: 'delivered', receiver: {id: 'fixture-started-1'}});
    expect(host.requests.filter(r => r.operation === 'input')).toEqual([]);
    expect(host.writes).toEqual([{sessionId: 'fixture-started-1', text: instructionFor(task) + '\r'}]);
  });
});

// w2-followups #14: a new session opened by an @ route rides a launch receipt where the destination advertises
// terminal-start-submission-v1 — its first request is a whole-request submission whose receipt names the session, so a
// lost answer is checked instead of starting a second CLI, and a relay request over 11,000 bytes needs no raw typing.
describe('an @ route opens a new session through a launch receipt', () => {
  type LaunchEntry = {state: string; sessionId: string; targetId: string; agent: string; text: string};
  function launchHost(options: {sessions: AiTerminalSummary[]; loseAnswer?: boolean; finalState?: 'unknown'; refuse?: string; unparsed?: boolean; statusLost?: boolean; rememberFails?: boolean}) {
    const host = fakeHost({sessions: options.sessions});
    const base = host.request;
    const launches = new Map<string, LaunchEntry>();
    const assemblies = new Map<string, Buffer[]>();
    let lostOnce = false;
    const receipt = (id: string, entry: LaunchEntry) => ({id, storeId: 'fixture-store', epoch: 'fixture-epoch', revision: 0, state: entry.state, sessionId: entry.sessionId, targetId: entry.targetId, agent: entry.agent});
    const request = async (r: Omit<AiTerminalRequest, 'requestId'>): Promise<any> => {
      if (r.operation !== 'submission') return base(r);
      host.requests.push(r);
      const s = r.submission as any;
      // A message typed into a session that already runs (the old path after a refused launch): written on commit.
      if (r.sessionId !== undefined) {
        const commits = s.phase === 'single' || s.commit === true;
        return {submission: {id: s.id, storeId: 'fixture-store', epoch: 'fixture-epoch', revision: 0, state: commits ? 'written' : 'prepared'}};
      }
      if (options.unparsed) throw Object.assign(new Error('터미널 세션 ID가 올바르지 않습니다.'), {code: 'TERMINAL_REQUEST_INVALID'});
      if (s.phase === 'status') {
        if (options.statusLost) throw new Error('연결이 끊겼습니다.');
        const entry = launches.get(s.id);
        if (!entry) throw new Error('같은 호스트 저장소의 제출 기록을 확인하지 못했습니다.');
        return {submission: receipt(s.id, entry), ...(entry.state === 'written' ? {session: host.sessions.find(x => x.id === entry.sessionId)} : {})};
      }
      const launch = s.launch;
      if (s.phase === 'single') assemblies.set(s.id, [Buffer.from(s.data, 'base64')]);
      if (s.phase === 'begin') assemblies.set(s.id, [Buffer.from(s.firstData, 'base64')]);
      if (s.phase === 'chunk') assemblies.get(s.id)![s.index] = Buffer.from(s.data, 'base64');
      const id = s.id, sessionId = `fixture-launched-${launches.size + 1}`;
      if (launch) launches.set(id, {state: 'prepared', sessionId, targetId: launch.targetId, agent: launch.agent, text: ''});
      const entry = launches.get(id)!;
      const commits = s.phase === 'single' || s.commit === true;
      if (!commits) return {submission: receipt(id, entry)};
      entry.text = Buffer.concat(assemblies.get(id)!).toString('utf8');
      if (options.refuse) {entry.state = 'rejected'; throw new Error(options.refuse);}
      if (options.finalState === 'unknown') {entry.state = 'unknown'; return {submission: receipt(id, entry)};}
      entry.state = 'written';
      const created: AiTerminalSummary = {id: entry.sessionId, targetId: entry.targetId, agent: entry.agent as AiTerminalSummary['agent'], state: 'running', createdAt: '2026-10-15T00:00:00Z', exitCode: null, cols: 100, rows: 28};
      host.sessions.push(created);
      if (options.loseAnswer && !lostOnce) {lostOnce = true; throw new Error('응답을 확인하지 못했습니다.');}
      return {submission: receipt(id, entry), session: created};
    };
    // The receiver's launch records, one per launch id (review 2026-10-15, finding 1).
    let pending: PendingWorkroomLaunch[] = [];
    const remembered: (PendingWorkroomLaunch | null)[] = [];
    const submission = {
      supported: true,
      pending: () => null,
      remember: () => {},
      launch: {
        pending: () => pending,
        remember: (id: string, value: PendingWorkroomLaunch | null) => {
          if (options.rememberFails) throw new Error('storage refused');
          remembered.push(value);
          pending = value ? [...pending.filter(item => item.id !== id), value] : pending.filter(item => item.id !== id);
        },
      },
    };
    const own = () => pending.filter(item => !item.id.startsWith('fixture-earlier'));
    return {...host, request, launches, submission, remembered, pendingLaunches: () => pending,
      pendingLaunch: () => own().at(-1) ?? null, setPending: (value: PendingWorkroomLaunch | null) => {pending = value ? [value] : [];}};
  }
  const nonLaunch = (host: {requests: any[]}) => host.requests.filter(r => r.operation === 'start' || r.operation === 'input');

  test('a relay request over 11,000 bytes is the new session\'s first request, in chunks that each fit the relay', async () => {
    const task = '한'.repeat(3700);
    const host = launchHost({sessions: [SOURCE]});
    const {run, confirms} = route(host as any, {request: host.request, submission: host.submission, transport: 'relay', task});
    const result = await run();
    expect(result).toMatchObject({status: 'delivered', receiver: {id: 'fixture-launched-1'}});
    expect(nonLaunch(host)).toEqual([]);
    const submissions = host.requests.filter(r => r.operation === 'submission');
    expect(submissions[0].submission.phase).toBe('begin');
    expect(submissions[0].submission.launch).toMatchObject({targetId: TARGET.targetId, agent: 'claude'});
    for (const r of submissions) expect(workroomRelayRequestBytes(r)).toBeLessThanOrEqual(REMOTE_CONTROL_RELAY_MAX_PLAINTEXT_BYTES - WORKROOM_RELAY_REQUEST_MARGIN_BYTES);
    expect([...host.launches.values()].map(entry => entry.text)).toEqual([instructionFor(task) + '\r']);
    expect(confirms[0]).not.toContain('준비되면 이 메시지를 입력할까요?');
    expect((result as {receipt: string}).receipt).toContain('첫 요청으로 전달했습니다');
    expect(host.remembered.at(-1)).toBeNull();
  });

  test('a lost answer is settled by one read-only status, and only one CLI starts', async () => {
    const host = launchHost({sessions: [SOURCE], loseAnswer: true});
    const result = await route(host as any, {request: host.request, submission: host.submission}).run();
    expect(result).toMatchObject({status: 'delivered', receiver: {id: 'fixture-launched-1'}});
    expect(host.launches.size).toBe(1);
    expect(host.requests.filter(r => r.operation === 'submission').map(r => r.submission.phase)).toEqual(['single', 'status']);
    expect(nonLaunch(host)).toEqual([]);
    expect(host.pendingLaunch()).toBeNull();
  });

  test('an unknown outcome keeps the draft and leaves a launch record for the receiver\'s banner; nothing is re-sent', async () => {
    for (const options of [{finalState: 'unknown' as const}, {loseAnswer: true, statusLost: true}]) {
      const host = launchHost({sessions: [SOURCE], ...options});
      const result = await route(host as any, {request: host.request, submission: host.submission}).run();
      expect(result.status).toBe('uncertain');
      expect((result as {receiver: unknown}).receiver).toBeNull();
      expect((result as {receipt: string}).receipt).toContain('세션 시작 결과 미확정 · 자동으로 다시 시작하지 않음');
      expect((result as {receipt: string}).receipt).toContain('작성 중인 내용은 유지했습니다');
      expect(host.pendingLaunch()).toMatchObject({targetId: TARGET.targetId, agent: 'claude'});
      expect(host.requests.filter(r => r.operation === 'submission' && r.submission.phase !== 'status')).toHaveLength(1);
      expect(nonLaunch(host)).toEqual([]);
    }
  });

  test('an unsettled launch of the same target and AI refuses another before asking; another target is not blocked', async () => {
    const host = launchHost({sessions: [SOURCE]});
    host.setPending({id: 'fixture-earlier-launch', targetId: TARGET.targetId, agent: 'claude', receipt: null});
    const {run, confirms} = route(host as any, {request: host.request, submission: host.submission});
    await expect(run()).rejects.toThrow('새 세션 시작 결과가 아직 미확정');
    expect(confirms).toEqual([]);
    expect(host.requests.filter(r => r.operation === 'submission' || r.operation === 'start')).toEqual([]);
    host.setPending({id: 'fixture-earlier-launch', targetId: 'fixture-target-other', agent: 'claude', receipt: null});
    expect((await route(host as any, {request: host.request, submission: host.submission}).run()).status).toBe('delivered');
    // The other target's unsettled launch survives this one: neither its start nor its success erases it.
    expect(host.pendingLaunches()).toEqual([{id: 'fixture-earlier-launch', targetId: 'fixture-target-other', agent: 'claude', receipt: null}]);
    expect(host.remembered.every(value => value === null || value.id !== 'fixture-earlier-launch')).toBe(true);
  });

  test('a launch record that cannot be kept refuses the launch before anything is sent', async () => {
    const host = launchHost({sessions: [SOURCE], rememberFails: true});
    await expect(route(host as any, {request: host.request, submission: host.submission}).run()).rejects.toThrow('새 세션 시작 기록을 보관하지 못해');
    expect(host.requests.filter(r => r.operation === 'submission' || r.operation === 'start' || r.operation === 'input')).toEqual([]);
  });

  test('an uncertain launch names its launch id, so the sender can tie its draft to it', async () => {
    const host = launchHost({sessions: [SOURCE], finalState: 'unknown'});
    const result = await route(host as any, {request: host.request, submission: host.submission}).run();
    expect(result.status).toBe('uncertain');
    expect((result as {launchId?: string}).launchId).toBe(host.pendingLaunch()!.id);
  });

  // Review 2026-10-15 (finding 2): the draft of an uncertain launch stays. Once that launch settles as written (here, or
  // on the receiver's own tab), sending the same draft again must not type the handoff into the session it opened.
  describe('sending the draft of an earlier uncertain launch again', () => {
    const earlier = async (finalState: 'written' | 'unknown' | 'rejected') => {
      const host = launchHost({sessions: [SOURCE], finalState: 'unknown'});
      const first = await route(host as any, {request: host.request, submission: host.submission}).run();
      const launchId = (first as {launchId: string}).launchId;
      const entry = host.launches.get(launchId)!;
      entry.state = finalState;
      if (finalState === 'written') host.sessions.push({id: entry.sessionId, targetId: entry.targetId, agent: entry.agent as AiTerminalSummary['agent'], state: 'running', createdAt: '2026-10-15T00:00:00Z', exitCode: null, cols: 100, rows: 28});
      host.requests.length = 0;
      return {host, launchId};
    };
    test('written: nothing is sent again, the record is settled, and the result clears the draft', async () => {
      const {host, launchId} = await earlier('written');
      const {run, confirms} = route(host as any, {request: host.request, submission: host.submission, sessions: [...host.sessions], earlierLaunchId: launchId});
      const result = await run();
      expect(result).toMatchObject({status: 'delivered', receiver: {id: host.launches.get(launchId)!.sessionId}});
      expect((result as {receipt: string}).receipt).toContain('다시 보내지 않았습니다');
      expect(confirms).toEqual([]);
      expect(host.requests.filter(r => r.operation !== 'submission' || r.submission.phase !== 'status')).toEqual([]);
      expect(host.pendingLaunches()).toEqual([]);
    });
    test('written after the receiver tab settled the record: still nothing is sent again', async () => {
      const {host, launchId} = await earlier('written');
      host.setPending(null);
      const result = await route(host as any, {request: host.request, submission: host.submission, sessions: [...host.sessions], earlierLaunchId: launchId}).run();
      expect(result.status).toBe('delivered');
      expect(host.requests.filter(r => r.operation === 'input' || r.operation === 'start' || r.operation === 'submission' && r.submission.phase !== 'status')).toEqual([]);
    });
    test('never started: the record goes and the draft is sent as usual', async () => {
      const {host, launchId} = await earlier('rejected');
      const result = await route(host as any, {request: host.request, submission: host.submission, earlierLaunchId: launchId}).run();
      expect(host.pendingLaunches().some(item => item.id === launchId)).toBe(false);
      expect(host.requests.filter(r => r.operation === 'submission' && r.submission.launch)).toHaveLength(1);
      expect(result.status).toBe('uncertain');
    });
    test('still unsettled and still recorded: refused, nothing sent', async () => {
      const {host, launchId} = await earlier('unknown');
      await expect(route(host as any, {request: host.request, submission: host.submission, earlierLaunchId: launchId}).run()).rejects.toThrow('미확정');
      expect(host.requests.filter(r => r.operation !== 'submission' || r.submission.phase !== 'status')).toEqual([]);
    });
    // Integration review w4 (finding 3): once session storage refuses writes the panel hands its readable launch records
    // as `launchRecords`, not `launch`. Still unsettled and still recorded must refuse then too — read as «dismissed», the
    // route typed the same handoff into the session that uncertain launch had opened.
    test('still unsettled and still recorded, where no new launch can be recorded now: refused, nothing typed', async () => {
      const {host, launchId} = await earlier('unknown');
      const entry = host.launches.get(launchId)!;
      // The launch did open its CLI; the receiver's list now holds it, so this route would deliver into it.
      host.sessions.push({id: entry.sessionId, targetId: entry.targetId, agent: entry.agent as AiTerminalSummary['agent'], state: 'running', createdAt: '2026-10-15T00:00:00Z', exitCode: null, cols: 100, rows: 28});
      const full = {supported: false, pending: () => null, remember: () => {}, launchRecords: host.submission.launch.pending};
      await expect(route(host as any, {request: host.request, submission: full, sessions: [...host.sessions], earlierLaunchId: launchId}).run()).rejects.toThrow('미확정');
      expect(host.requests.filter(r => r.operation !== 'submission' || r.submission.phase !== 'status')).toEqual([]);
      expect(typed(host as any, entry.sessionId)).toEqual([]);
      expect(host.pendingLaunches().some(item => item.id === launchId)).toBe(true);
    });
    test('unsettled but dismissed by the user on the receiver: sent as the user chose', async () => {
      const {host, launchId} = await earlier('unknown');
      host.setPending(null);
      await route(host as any, {request: host.request, submission: host.submission, earlierLaunchId: launchId}).run();
      expect(host.requests.filter(r => r.operation === 'submission' && r.submission.launch)).toHaveLength(1);
    });
    test('the status cannot be read: refused, nothing sent', async () => {
      const {host, launchId} = await earlier('unknown');
      host.setPending(null);
      const failing = async (r: Omit<AiTerminalRequest, 'requestId'>) => { if (r.operation === 'submission') throw new Error('연결이 끊겼습니다.'); return host.request(r); };
      await expect(route(host as any, {request: failing, submission: host.submission, earlierLaunchId: launchId}).run()).rejects.toThrow('확인하지 못해');
      expect(host.requests.filter(r => r.operation === 'input' || r.operation === 'start')).toEqual([]);
    });
  });

  test('a path that cannot parse a launch refuses before anything ran: unsupported, nothing recorded, no plain start', async () => {
    const host = launchHost({sessions: [SOURCE], unparsed: true});
    await expect(route(host as any, {request: host.request, submission: host.submission}).run()).rejects.toBeInstanceOf(WorkroomLaunchUnsupportedError);
    expect(host.pendingLaunch()).toBeNull();
    expect(nonLaunch(host)).toEqual([]);
  });

  test('L3 keeps working: reference folders past the limit are refused before the fence, then the message is typed', async () => {
    const host = launchHost({sessions: [SOURCE], refuse: AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR});
    const result = await route(host as any, {request: host.request, submission: {...host.submission, supported: false, launch: host.submission.launch}, references: ['fixture-reference-1']}).run();
    // `supported:false` turns launches off as well: today's path, byte for byte.
    expect(host.requests.filter(r => r.operation === 'submission')).toEqual([]);
    expect(result.status).toBe('delivered');
    const typedHost = launchHost({sessions: [SOURCE], refuse: AI_TERMINAL_PROMPT_REFERENCES_TOO_LARGE_ERROR});
    const typedResult = await route(typedHost as any, {request: typedHost.request, submission: typedHost.submission, references: ['fixture-reference-1']}).run();
    expect(typedResult).toMatchObject({status: 'delivered', receiver: {id: 'fixture-started-1'}});
    expect(typedHost.requests.filter(r => r.operation === 'start').map(r => r.prompt ?? null)).toEqual([null]);
    expect(typedHost.pendingLaunch()).toBeNull();
    expect((typedResult as {receipt: string}).receipt).toContain('화면이 준비된 뒤 메시지를 입력했습니다');
  });

  test('a launch refused before the fence for another reason is reported, and nothing else starts', async () => {
    const host = launchHost({sessions: [SOURCE], refuse: 'claude CLI가 설치되어 있지 않습니다.'});
    await expect(route(host as any, {request: host.request, submission: host.submission}).run()).rejects.toThrow('claude CLI가 설치되어 있지 않습니다.');
    expect(host.pendingLaunch()).toBeNull();
    expect(nonLaunch(host)).toEqual([]);
  });

  test('a handoff over 24,000 bytes keeps the old path, request for request, even where launches exist', async () => {
    const task = '한'.repeat(9000);
    const withLaunch = launchHost({sessions: [SOURCE]}), without = launchHost({sessions: [SOURCE]});
    const outcome = (promise: Promise<unknown>) => promise.then(value => ({value}), error => ({error: (error as Error).message}));
    const a = await outcome(route(withLaunch as any, {request: withLaunch.request, submission: withLaunch.submission, task}).run());
    const {launch: _unused, ...plain} = without.submission;
    const b = await outcome(route(without as any, {request: without.request, submission: plain, task}).run());
    expect(withLaunch.requests.filter(r => r.operation === 'submission' && r.submission.launch)).toEqual([]);
    expect(a).toEqual(b);
    const shape = (requests: any[]) => requests.map(r => ({...r, ...(r.submission ? {submission: {...r.submission, id: 'x'}} : {})}));
    expect(shape(withLaunch.requests)).toEqual(shape(without.requests));
    expect(withLaunch.requests.filter(r => r.operation === 'start').map(r => r.prompt ?? null)).toEqual([null]);
  });
});

// w4 L1: a Mac without launch receipts. An @ route's plain start whose answer was lost may still have opened the CLI with
// the handoff as its first request; sending the same draft again would open a second CLI (or type it into the one that
// opened). The route keeps the same digest-and-session-id record as the panel's own start and asks first.
describe('an @ route to a Mac without launch receipts remembers a failed plain start', () => {
  class MemoryStorage {
    items = new Map<string, string>();
    getItem(key: string) { return this.items.get(key) ?? null; }
    setItem(key: string, value: string) { this.items.set(key, String(value)); }
    removeItem(key: string) { this.items.delete(key); }
  }
  /** The CLI starts, but the answer to the first start is lost on the way back. */
  function losingHost(sessions: AiTerminalSummary[]) {
    const host = fakeHost({sessions});
    const base = host.request;
    let lost = false;
    const request = async (r: Omit<AiTerminalRequest, 'requestId'>): Promise<any> => {
      if (r.operation === 'list') { host.requests.push(r); return {sessions: [...host.sessions]}; }
      const answer = await base(r);
      if (r.operation === 'start' && !lost) { lost = true; throw new Error('응답을 확인하지 못했습니다. 입력이 전달되었을 수 있으므로 화면을 확인하세요.'); }
      return answer;
    };
    return {...host, request};
  }
  const instruction = instructionFor('테스트를 실행해 주세요');

  test('the lost start is remembered by digest, and the retry asks before sending again; declining sends nothing', async () => {
    const storage = new MemoryStorage();
    const host = losingHost([SOURCE]);
    const legacyStart = {storage, scope: 'fixture-scope'};
    // The panel lists only the source session when the first start goes out.
    const first = route(host, {sessions: [SOURCE], request: host.request, legacyStart});
    await expect(first.run()).rejects.toThrow('응답을 확인하지 못했습니다');
    const raw = storage.getItem(failedLegacyStartKey('fixture-scope'))!;
    expect(raw).toContain(legacyStartDigest(TARGET.targetId, 'claude', instruction));
    expect(raw).not.toContain('테스트를 실행해');
    expect(host.sessions.filter(s => s.id.startsWith('fixture-started-'))).toHaveLength(1);

    // The same draft again, with the panel's list still stale. The fresh list shows the session that opened.
    const before = host.requests.length;
    const retry = route(host, {sessions: [SOURCE], request: host.request, legacyStart, confirm: message => { retry.confirms.push(message); return false; }});
    const result = await retry.run();
    expect(retry.confirms).toHaveLength(1);
    expect(retry.confirms[0]).toContain('앞서 보낸 전달은 실패로 보였지만');
    expect(retry.confirms[0]).toContain('받는 세션: Beta · claude');
    expect(result).toMatchObject({status: 'held', receiver: {id: 'fixture-started-1'}});
    expect((result as {receipt: string}).receipt).toContain('보내지 않았습니다');
    const after = host.requests.slice(before);
    expect(after.filter(r => r.operation !== 'list' && r.operation !== 'read')).toEqual([]);
    expect(host.sessions.filter(s => s.id.startsWith('fixture-started-'))).toHaveLength(1);
  });

  test('when the panel already lists the opened session, the retry still asks before typing into it', async () => {
    const storage = new MemoryStorage();
    const host = losingHost([SOURCE]);
    const legacyStart = {storage, scope: 'fixture-scope'};
    await expect(route(host, {sessions: [SOURCE], request: host.request, legacyStart}).run()).rejects.toThrow();
    const confirms: string[] = [];
    const result = await route(host, {sessions: [...host.sessions], request: host.request, legacyStart, confirm: message => { confirms.push(message); return false; }}).run();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('앞서 보낸 전달은 실패로 보였지만');
    expect(result.status).toBe('held');
    expect(typed(host, 'fixture-started-1')).toEqual([]);
  });

  test('accepting goes on as the user chose; a later success forgets only this request', async () => {
    const storage = new MemoryStorage();
    const host = losingHost([SOURCE]);
    const legacyStart = {storage, scope: 'fixture-scope'};
    await expect(route(host, {sessions: [SOURCE], request: host.request, legacyStart}).run()).rejects.toThrow();
    const result = await route(host, {sessions: [SOURCE], request: host.request, legacyStart}).run();
    expect(result.status).toBe('delivered');
    expect(host.requests.filter(r => r.operation === 'start')).toHaveLength(2);
    expect(readFailedLegacyStart(storage, 'fixture-scope', Date.now(), {targetId: TARGET.targetId, agent: 'claude', prompt: instruction})).toBeNull();
  });

  test('no session opened since the failure: no question, a plain start as before', async () => {
    const storage = new MemoryStorage();
    const host = fakeHost({sessions: [SOURCE]});
    const legacyStart = {storage, scope: 'fixture-scope'};
    let refused = true;
    const request = async (r: Omit<AiTerminalRequest, 'requestId'>): Promise<any> => {
      if (r.operation === 'list') return {sessions: [...host.sessions]};
      if (r.operation === 'start' && refused) { refused = false; throw new Error('claude CLI가 설치되어 있지 않습니다.'); }
      return host.request(r);
    };
    await expect(route(host, {request, legacyStart}).run()).rejects.toThrow('설치되어 있지 않습니다');
    expect(storage.getItem(failedLegacyStartKey('fixture-scope'))).not.toBeNull();
    const {run, confirms} = route(host, {request, legacyStart});
    const result = await run();
    expect(confirms.every(message => !message.includes('앞서 보낸 전달은 실패로'))).toBe(true);
    expect(result.status).toBe('delivered');
    expect(storage.getItem(failedLegacyStartKey('fixture-scope'))).toBeNull();
  });

  // w4 review, finding 1: the caller is told whenever a handoff may have reached a session it cannot name — on a lost
  // start answer and on a declined retry — with the session ids known when it went out, so it can keep protecting the
  // draft after the @ chip is gone (the panel's composer, the LAN page's 「전송」).
  test('the caller hears of a lost start and of a declined retry, with the sessions known when the handoff went out', async () => {
    const storage = new MemoryStorage();
    const host = losingHost([SOURCE]);
    const heard: (readonly string[])[] = [];
    const legacyStart = {storage, scope: 'fixture-scope', onUncertain: (known: readonly string[]) => { heard.push([...known]); }};
    await expect(route(host, {sessions: [SOURCE], request: host.request, legacyStart}).run()).rejects.toThrow();
    expect(heard).toEqual([[SOURCE.id]]);
    const result = await route(host, {sessions: [SOURCE], request: host.request, legacyStart, confirm: () => false}).run();
    expect(result.status).toBe('held');
    expect(heard).toEqual([[SOURCE.id], [SOURCE.id]]);
    // Accepted and delivered: nothing more is reported.
    await route(host, {sessions: [SOURCE], request: host.request, legacyStart}).run();
    expect(heard).toHaveLength(2);
  });

  test('a definitive refusal of the first request records nothing (nothing ran with it)', async () => {
    const storage = new MemoryStorage();
    const host = fakeHost({sessions: [SOURCE], refuseStart: r => r.prompt !== undefined ? new Error(AI_TERMINAL_PROMPT_REFUSED_ERROR) : null});
    await route(host, {agent: 'hermes', legacyStart: {storage, scope: 'fixture-scope'}}).run();
    expect(storage.getItem(failedLegacyStartKey('fixture-scope'))).toBeNull();
  });
});

// w4 review, finding 3: a launch record that can still be read blocks a new session of the same target and AI, even where
// this page cannot keep a new launch record (storage full) and so starts plainly — as the panel's own start button does.
describe('unsettled launch records block a plain start where no launch can be recorded now', () => {
  const unsettled: PendingWorkroomLaunch = {id: 'fixture-launch-0001', targetId: TARGET.targetId, agent: 'claude', receipt: null};
  test('the same target and AI: refused before any question or start', async () => {
    const host = fakeHost({sessions: [SOURCE]});
    const {run, confirms} = route(host, {submission: {supported: false, pending: () => null, remember: () => {}, launchRecords: () => [unsettled]}});
    await expect(run()).rejects.toThrow('새 세션 시작 결과가 아직 미확정');
    expect(confirms).toEqual([]);
    expect(host.requests.filter(r => r.operation === 'start' || r.operation === 'input')).toEqual([]);
  });

  test('another target or AI: the plain start goes on as before', async () => {
    const host = fakeHost({sessions: [SOURCE]});
    const other: PendingWorkroomLaunch = {...unsettled, agent: 'codex'};
    const result = await route(host, {submission: {supported: false, pending: () => null, remember: () => {}, launchRecords: () => [other]}}).run();
    expect(result.status).toBe('delivered');
    expect(host.requests.filter(r => r.operation === 'start')).toHaveLength(1);
  });
});
