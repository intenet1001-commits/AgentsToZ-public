import {describe, expect, test} from 'bun:test';
import {
  normalizeTeamLaunchOptions, parseTeamMemberSelection, parseTeamSelection, parseTeamSelectionBlock, teamLaunchDefaults, teamLaunchManagement,
  teamLaunchReuseAvailable, teamLaunchSupport, teamLaunchSurfacesFor, teamLaunchText, teamSelectionBlock, TEAM_LAUNCH_SURFACES, TEAM_SELECTION_KIND, type TeamSelection,
} from '../src/teamLaunchOptions';
import {teamLeaderInstruction, teamMemberLabel} from '../src/workroomTeamInstruction';
import {blankTeamRow, teamRowMember, type TeamBuilderRow} from '../src/WorkroomTeamBuilder';
import {hermesVariantItems} from '../src/hermesVariants';

// 팀 실행 계약 v1 (src/teamLaunchOptions.ts): the team builder and create_team share these choices, so each rule is pinned here.
const SESSION = 'session-abcdef12';
const parse = (raw: unknown) => parseTeamMemberSelection(raw, 0);
const refuse = (raw: unknown, message: RegExp) => expect(() => parse(raw)).toThrow(message);

describe('surfaces and what each takes', () => {
  test('the header terminals of each platform plus the Workroom and the desktop app, in contract order', () => {
    expect(teamLaunchSurfacesFor(false)).toEqual(['internal', 'orca-floating', 'orca-worktree', 'cmux', 'iterm', 'terminal', 'app']);
    expect(teamLaunchSurfacesFor(true)).toEqual(['internal', 'orca-floating', 'orca-worktree', 'powershell', 'wsl', 'app']);
    expect([...TEAM_LAUNCH_SURFACES]).toEqual(['internal', 'orca-floating', 'orca-worktree', 'cmux', 'iterm', 'terminal', 'powershell', 'wsl', 'app']);
  });

  test('model, effort and account ride a Workroom start only', () => {
    expect(teamLaunchSupport('internal', 'hermes')).toMatchObject({model: true, provider: true, effort: true, account: false, bypass: true});
    expect(teamLaunchSupport('internal', 'codex')).toMatchObject({model: true, provider: false, account: true});
    expect(teamLaunchSupport('internal', 'agy')).toMatchObject({model: true, effort: false, account: false});
    for (const surface of TEAM_LAUNCH_SURFACES.filter(surface => surface !== 'internal'))
      expect(teamLaunchSupport(surface, 'codex')).toMatchObject({model: false, provider: false, effort: false, account: false});
  });

  test('permission bypass follows project open: Hermes never on cmux or a terminal, every AI on Orca, only Claude in its app', () => {
    for (const surface of ['cmux', 'iterm', 'terminal', 'powershell', 'wsl'] as const) {
      expect(teamLaunchSupport(surface, 'hermes').bypass).toBe(false);
      expect(teamLaunchSupport(surface, 'codex').bypass).toBe(true);
    }
    expect(teamLaunchSupport('orca-floating', 'hermes').bypass).toBe(true);
    expect(teamLaunchSupport('orca-worktree', 'agy').bypass).toBe(true);
    expect(teamLaunchSupport('app', 'claude').bypass).toBe(true);
    expect(teamLaunchSupport('app', 'codex').bypass).toBe(false);
  });

  test('Claude --bg, tmux, reuse and app conversations exist only where their launch path does', () => {
    expect(teamLaunchSupport('iterm', 'claude')).toMatchObject({bg: true, tmux: true, reuse: true});
    expect(teamLaunchSupport('iterm', 'codex')).toMatchObject({bg: false, tmux: true});
    expect(teamLaunchSupport('iterm', 'hermes')).toMatchObject({bg: false, tmux: false});
    // cmux routes only Claude through tmux; Orca and PowerShell have none; the worktree Orca terminal has no --bg.
    expect([teamLaunchSupport('cmux', 'claude').tmux, teamLaunchSupport('cmux', 'codex').tmux, teamLaunchSupport('cmux', 'agy').tmux]).toEqual([true, false, false]);
    expect(teamLaunchSupport('orca-floating', 'claude')).toMatchObject({bg: true, tmux: false});
    expect(teamLaunchSupport('orca-worktree', 'claude')).toMatchObject({bg: false, tmux: false});
    expect(teamLaunchSupport('powershell', 'claude')).toMatchObject({bg: false, tmux: false});
    expect(teamLaunchSupport('internal', 'claude')).toMatchObject({bg: false, tmux: false, reuse: false});
    expect(teamLaunchSupport('app', 'codex').appModes).toEqual(['new', 'reopen']);
    expect(teamLaunchSupport('app', 'hermes').appModes).toEqual(['open', 'reopen']);
    expect([teamLaunchSupport('app', 'claude').appModes, teamLaunchSupport('app', 'agy').appModes, teamLaunchSupport('iterm', 'codex').appModes]).toEqual([[], [], []]);
  });

  test('a window is found again only through tmux or an Orca floating tab, never with --bg', () => {
    expect(teamLaunchReuseAvailable('iterm', 'codex', {tmuxMode: true})).toBe(true);
    expect(teamLaunchReuseAvailable('iterm', 'codex', {tmuxMode: false})).toBe(false);
    expect(teamLaunchReuseAvailable('orca-floating', 'codex')).toBe(true);
    expect(teamLaunchReuseAvailable('orca-worktree', 'codex')).toBe(false);
    expect(teamLaunchReuseAvailable('cmux', 'codex')).toBe(false);
    expect(teamLaunchReuseAvailable('orca-floating', 'claude', {bgMode: true})).toBe(false);
    expect(teamLaunchReuseAvailable('internal', 'codex')).toBe(false);
  });
});

describe('defaults and repairs', () => {
  test('a surface starts from project open’s own defaults, a new window and the app’s first conversation, never bypass', () => {
    expect(teamLaunchDefaults('internal', 'codex')).toEqual({});
    expect(teamLaunchDefaults('iterm', 'codex')).toEqual({tmuxMode: true, reuse: 'new'});
    expect(teamLaunchDefaults('cmux', 'claude')).toEqual({bgMode: true, tmuxMode: false, reuse: 'new'});
    expect(teamLaunchDefaults('orca-worktree', 'claude')).toEqual({reuse: 'new'});
    expect(teamLaunchDefaults('app', 'codex')).toEqual({appMode: 'new'});
    expect(teamLaunchDefaults('app', 'hermes')).toEqual({appMode: 'open'});
    expect(teamLaunchDefaults('app', 'claude')).toEqual({});
  });

  test('normalize keeps what the surface takes and resolves conflicts the way the launch does', () => {
    expect(normalizeTeamLaunchOptions('iterm', 'claude', {bgMode: true, tmuxMode: true})).toEqual({bgMode: true, tmuxMode: false, reuse: 'new'});
    expect(normalizeTeamLaunchOptions('iterm', 'codex', {tmuxMode: false, reuse: 'reuse-or-new'})).toEqual({tmuxMode: false, reuse: 'new'});
    expect(normalizeTeamLaunchOptions('iterm', 'codex', {tmuxMode: true, reuse: 'reuse-or-new'})).toEqual({tmuxMode: true, reuse: 'reuse-or-new'});
    expect(normalizeTeamLaunchOptions('iterm', 'codex', {bgMode: true})).toEqual({reuse: 'new'});
    expect(normalizeTeamLaunchOptions('app', 'codex', {appMode: 'open'})).toEqual({appMode: 'new'});
    expect(normalizeTeamLaunchOptions('internal', 'claude', {bgMode: true, tmuxMode: true, reuse: 'reuse-or-new', appMode: 'new'})).toEqual({});
  });
});

describe('who carries a member’s instructions and reports', () => {
  test('managed, awaiting connection or manual join, with the reason', () => {
    expect(teamLaunchManagement('internal', 'agy')).toEqual({management: 'managed', reason: 'workroom'});
    expect(teamLaunchManagement('orca-worktree', 'hermes')).toEqual({management: 'managed', reason: 'orca-cli'});
    expect(teamLaunchManagement('orca-floating', 'claude', {bgMode: true})).toEqual({management: 'manual', reason: 'claude-bg'});
    expect(teamLaunchManagement('orca-floating', 'claude', {bgMode: false})).toEqual({management: 'managed', reason: 'orca-cli'});
    expect(teamLaunchManagement('cmux', 'codex')).toEqual({management: 'awaiting-connection', reason: 'cmux-control'});
    expect(teamLaunchManagement('app', 'codex')).toEqual({management: 'manual', reason: 'app-prefill'});
    expect(teamLaunchManagement('app', 'hermes')).toEqual({management: 'manual', reason: 'app-open'});
    expect(teamLaunchManagement('wsl', 'agy')).toEqual({management: 'manual', reason: 'terminal'});
    // --bg is ignored where the surface has none, so it never changes the state there.
    expect(teamLaunchManagement('cmux', 'codex', {bgMode: true})).toEqual({management: 'awaiting-connection', reason: 'cmux-control'});
  });
});

describe('the strict member parser', () => {
  test('canonical: the Workroom surface and an off bypass are absent, the task is trimmed, fields come in one order', () => {
    expect(parse({surface: 'internal', bypassPermissions: false, task: '  결제 API  ', agent: 'codex', model: 'gpt-6-sol', effort: 'high'}))
      .toEqual({agent: 'codex', task: '결제 API', model: 'gpt-6-sol', effort: 'high'});
    expect(JSON.stringify(parse({launchOptions: {reuse: 'new', tmuxMode: true}, surface: 'iterm', bypassPermissions: true, role: 'reviewer', agent: 'agy', task: ' '})))
      .toBe('{"agent":"agy","role":"reviewer","bypassPermissions":true,"surface":"iterm","launchOptions":{"tmuxMode":true,"reuse":"new"}}');
    expect(parse({agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'})).toEqual({agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'});
    expect(parse({agent: 'claude', accountId: 'host-default'})).toEqual({agent: 'claude', accountId: 'host-default'});
    expect(parse({agent: 'codex', sessionId: SESSION, surface: 'internal', role: 'reviewer'})).toEqual({agent: 'codex', role: 'reviewer', sessionId: SESSION});
  });

  test('refuses what a surface or an open session would not run, instead of dropping it', () => {
    refuse({agent: 'codex', colour: 'red'}, /팀원 1: 알 수 없는 필드: colour/);
    refuse({agent: 'gemini'}, /AI는/);
    refuse({agent: 'codex', name: 'Bad Name'}, /이름은/);
    refuse({agent: 'codex', task: 'x'.repeat(4001)}, /4000바이트/);
    refuse({agent: 'codex', sessionId: SESSION, model: 'gpt-6-sol'}, /열린 세션.*model/);
    refuse({agent: 'codex', sessionId: SESSION, surface: 'iterm'}, /열린 세션.*surface/);
    refuse({agent: 'codex', sessionId: SESSION, bypassPermissions: false}, /bypassPermissions/);
    refuse({agent: 'codex', sessionId: 'short'}, /sessionId/);
    refuse({agent: 'codex', surface: 'iterm', model: 'gpt-6-sol'}, /iTerm에서는 모델/);
    refuse({agent: 'claude', surface: 'app', effort: 'high'}, /Claude 앱에서는 에포트/);
    refuse({agent: 'codex', provider: 'openai'}, /provider는 model과 함께/);
    refuse({agent: 'codex', model: 'gpt-6-sol', provider: 'openai'}, /provider는 Hermes에서만/);
    refuse({agent: 'agy', effort: 'high'}, /Antigravity는 에포트/);
    refuse({agent: 'hermes', accountId: 'host-default'}, /Codex·Claude만/);
    refuse({agent: 'codex', surface: 'cmux', accountId: 'host-default'}, /cmux에서는 계정/);
    refuse({agent: 'codex', accountId: 'acct_nope'}, /accountId/);
    refuse({agent: 'hermes', surface: 'iterm', bypassPermissions: true}, /권한 우회/);
    refuse({agent: 'codex', bypassPermissions: 'yes'}, /true 또는 false/);
    refuse({agent: 'codex', surface: 'galaxy'}, /실행 위치는/);
  });

  test('the explicit default Hermes marker is validated and omitted from canonical members', () => {
    for (const surface of TEAM_LAUNCH_SURFACES) {
      expect(parse({agent: 'hermes', surface, hermesVariant: 'default'}))
        .toEqual(parse({agent: 'hermes', surface}));
    }
    for (const agent of ['codex', 'claude', 'agy']) refuse({agent, hermesVariant: 'default'}, /hermesVariant/);
    for (const hermesVariant of ['claude', 'codex', 'DEFAULT', '', null, undefined, true, 1, {}, []])
      refuse({agent: 'hermes', hermesVariant}, /hermesVariant/);
    for (const modelChoice of [{model: 'claude-opus-5-5'}, {provider: 'anthropic'}, {model: 'claude-opus-5-5', provider: 'anthropic'}, {model: undefined}, {provider: undefined}])
      refuse({agent: 'hermes', hermesVariant: 'default', ...modelChoice}, /hermesVariant/);
    refuse({agent: 'hermes', sessionId: SESSION, hermesVariant: 'default'}, /열린 세션.*hermesVariant/);
  });

  test('launch options are checked against the surface and the AI', () => {
    refuse({agent: 'claude', surface: 'iterm', launchOptions: {bgMode: true, tmuxMode: true}}, /둘 중 하나만/);
    refuse({agent: 'codex', surface: 'iterm', launchOptions: {bgMode: false}}, /Claude --bg/);
    refuse({agent: 'hermes', surface: 'iterm', launchOptions: {tmuxMode: true}}, /tmux/);
    refuse({agent: 'codex', surface: 'cmux', launchOptions: {tmuxMode: true}}, /tmux/);
    refuse({agent: 'codex', surface: 'orca-worktree', launchOptions: {reuse: 'reuse-or-new'}}, /항상 새 창/);
    refuse({agent: 'codex', surface: 'iterm', launchOptions: {tmuxMode: false, reuse: 'reuse-or-new'}}, /항상 새 창/);
    refuse({agent: 'codex', launchOptions: {reuse: 'new'}}, /외부 터미널 경로에서만/);
    refuse({agent: 'claude', surface: 'app', launchOptions: {appMode: 'new'}}, /대화 선택을 받지 않습니다/);
    refuse({agent: 'codex', surface: 'app', launchOptions: {appMode: 'open'}}, /new·reopen/);
    refuse({agent: 'codex', surface: 'iterm', launchOptions: {window: 'big'}}, /알 수 없는 실행 옵션: window/);
    refuse({agent: 'codex', surface: 'iterm', launchOptions: []}, /launchOptions는 객체/);
    expect(parse({agent: 'codex', surface: 'iterm', launchOptions: {tmuxMode: true, reuse: 'reuse-or-new'}}).launchOptions).toEqual({tmuxMode: true, reuse: 'reuse-or-new'});
    expect(parse({agent: 'hermes', surface: 'app', launchOptions: {appMode: 'reopen'}}).launchOptions).toEqual({appMode: 'reopen'});
  });
});

describe('the versioned selection block', () => {
  const rawBlock = (block: string) => JSON.parse(block.split('\n').slice(1, -1).join('\n'));
  const members = [
    {agent: 'codex', task: '`rm -rf` 금지 — 결제 API', model: 'gpt-6-sol'},
    {agent: 'claude', surface: 'iterm', launchOptions: {bgMode: false, tmuxMode: true, reuse: 'reuse-or-new'}, bypassPermissions: true},
    {agent: 'codex', sessionId: SESSION, role: 'reviewer'},
  ];

  test('round-trips through the instruction text, and a backtick in a task cannot close the fence', () => {
    const block = teamSelectionBlock(members);
    expect(block.startsWith('```' + TEAM_SELECTION_KIND + '\n')).toBe(true);
    expect(block.slice(3 + TEAM_SELECTION_KIND.length, -3)).not.toContain('`');
    expect(block).toContain('\\u0060rm -rf\\u0060');
    const parsed = parseTeamSelectionBlock(`앞 글\n${block}\n뒤 글`);
    expect(parsed).toEqual(parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 1, members}));
    expect(parsed.members[0]!.task).toBe('`rm -rf` 금지 — 결제 API');
  });

  test('fresh JSON confirms the exact selected surface and plain Hermes default while attached sessions keep their settings', () => {
    for (const surface of TEAM_LAUNCH_SURFACES) {
      const chosen = [{agent: 'codex', surface}, {agent: 'hermes', surface},
        {agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'},
        {agent: 'hermes', sessionId: SESSION, surface: 'internal', role: 'reviewer'}];
      const block = teamSelectionBlock(chosen), raw = rawBlock(block);
      expect(raw.members).toEqual([{agent: 'codex', surface}, {agent: 'hermes', surface, hermesVariant: 'default'},
        {agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic', surface: 'internal'},
        {agent: 'hermes', role: 'reviewer', sessionId: SESSION}]);
      const canonical = parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 1, members: chosen});
      expect(parseTeamSelectionBlock(block)).toEqual(canonical);
      expect(JSON.stringify(parseTeamSelectionBlock(block))).toBe(JSON.stringify(canonical));
      expect(teamSelectionBlock(raw.members)).toBe(block);
    }
  });

  test('legacy v1 defaults still parse, while invalid explicit markers are refused before serialization', () => {
    const legacy: TeamSelection = {kind: TEAM_SELECTION_KIND, version: 1, members: [{agent: 'codex'}, {agent: 'hermes'}, {agent: 'hermes', sessionId: SESSION}]};
    expect(parseTeamSelectionBlock('```agentstoz-team-selection\n' + JSON.stringify(legacy) + '\n```')).toEqual(legacy);
    const raw = rawBlock(teamSelectionBlock(legacy.members));
    expect(raw.members).toEqual([{agent: 'codex', surface: 'internal'}, {agent: 'hermes', surface: 'internal', hermesVariant: 'default'}, {agent: 'hermes', sessionId: SESSION}]);
    for (const invalid of [{agent: 'claude', hermesVariant: 'default'}, {agent: 'hermes', hermesVariant: null},
      {agent: 'hermes', hermesVariant: 'claude'}, {agent: 'hermes', hermesVariant: 'default', model: 'claude-opus-5-5'},
      {agent: 'hermes', hermesVariant: 'default', sessionId: SESSION}]) {
      expect(() => teamSelectionBlock([invalid])).toThrow(/hermesVariant/);
      expect(() => parseTeamSelectionBlock('```agentstoz-team-selection\n' + JSON.stringify({...legacy, members: [invalid]}) + '\n```')).toThrow(/hermesVariant/);
    }
  });

  test('none, two, an unreadable or a newer block is refused', () => {
    const block = teamSelectionBlock([{agent: 'codex'}]);
    expect(() => parseTeamSelectionBlock('블록 없음')).toThrow('팀 선택 블록이 없습니다.');
    expect(() => parseTeamSelectionBlock(`${block}\n${block}`)).toThrow('팀 선택 블록이 둘 이상입니다.');
    expect(() => parseTeamSelectionBlock('```agentstoz-team-selection\n{nope\n```')).toThrow('JSON을 읽지 못했습니다');
    expect(() => parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 2, members: [{agent: 'codex'}]})).toThrow(/버전 2/);
    expect(() => parseTeamSelection({kind: 'other', version: 1, members: [{agent: 'codex'}]})).toThrow(/종류/);
    expect(() => parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 1, members: [], extra: 1})).toThrow(/알 수 없는 필드: extra/);
    expect(() => parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 1, members: []})).toThrow(/1명부터 6명/);
    expect(() => parseTeamSelection({kind: TEAM_SELECTION_KIND, version: 1, members: Array.from({length: 7}, () => ({agent: 'codex'}))})).toThrow(/1명부터 6명/);
    expect(() => teamSelectionBlock([{agent: 'codex', sessionId: SESSION}, {agent: 'claude', sessionId: SESSION}])).toThrow(/같은 열린 세션/);
  });
});

describe('the leader instruction', () => {
  test('a plain Workroom member reads exactly as before, and the block follows', () => {
    const text = teamLeaderInstruction({goal: '결제 오류를 고친다', members: [{agent: 'codex', model: 'gpt-7-nova', effort: 'high', task: 'API와 테스트'}, {agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'}]});
    expect(text).toContain('- 팀원 1: Codex (gpt-7-nova) · 에포트 고정 high — API와 테스트\n- 팀원 2: Hermes (anthropic/claude-opus-5-5) · 에포트 자동 — 작업은 리더가 배분\n\n진행:');
    expect(text).not.toContain('실행 위치·옵션:');
    expect(parseTeamSelectionBlock(text).members).toEqual([{agent: 'codex', task: 'API와 테스트', model: 'gpt-7-nova', effort: 'high'}, {agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'}]);
  });

  test('every launch choice is named on the member’s line, with how the team carries it', () => {
    const text = teamLeaderInstruction({goal: '목표', members: [
      {agent: 'codex', surface: 'iterm', launchOptions: {tmuxMode: true, reuse: 'reuse-or-new'}, bypassPermissions: true, task: '화면'},
      {agent: 'codex', surface: 'app', launchOptions: {appMode: 'reopen'}, role: 'reviewer'},
      {agent: 'claude', accountId: 'host-default', accountLabel: '회사 계정'},
      {agent: 'agy', surface: 'cmux'},
      {agent: 'hermes', surface: 'orca-worktree', launchOptions: {reuse: 'new'}},
    ]});
    expect(text).toContain('- 팀원 1: Codex · 실행 위치 iTerm(iterm) · 권한 우회 · tmux · 기존 창 재사용 · 수동 합류: 터미널 창에는 지시·결과 연결이 없습니다 — 화면');
    expect(text).toContain('- 팀원 2: Codex · 실행 위치 Codex 앱(app) · 최근 대화 다시 열기 · 수동 합류: Codex 앱 입력칸에 채우기만 하고 보내지 않습니다 · 검토 담당');
    expect(text).toContain('- 팀원 3: Claude Code · 에포트 자동 · 계정 「회사 계정」(accountId host-default) — 작업은 리더가 배분');
    expect(text).toContain('- 팀원 4: Antigravity · 실행 위치 cmux(cmux) · 연결 대기: cmux 제어 연결이 확인된 뒤에 지시합니다');
    expect(text).toContain('- 팀원 5: Hermes · 실행 위치 Orca 사이드바(orca-worktree) · 새 창 · 자동 관리: Orca CLI로 지시하고 화면을 읽습니다');
    expect(text).toContain('실행 위치·옵션:\n- 팀원마다 고른 실행 위치·계정·권한 우회·실행 옵션을 그대로 지킵니다. 다른 값으로 바꾸거나 워크룸으로 대신 시작하지 않습니다.');
    // The account label is for the person; the block carries only what create_team takes.
    const selection = parseTeamSelectionBlock(text);
    expect(selection.members[2]).toEqual({agent: 'claude', accountId: 'host-default'});
    expect(selection.members.map(member => member.surface ?? 'internal')).toEqual(['iterm', 'app', 'internal', 'cmux', 'orca-worktree']);
  });

  test('an invalid member composes nothing', () => {
    expect(() => teamLeaderInstruction({goal: '목표', members: [{agent: 'codex', surface: 'iterm', model: 'gpt-6-sol'}]})).toThrow(/팀원 1: iTerm에서는 모델/);
  });

  test('labels and launch text', () => {
    expect(teamMemberLabel({agent: 'codex', surface: 'iterm'})).toBe('Codex · iTerm');
    expect(teamMemberLabel({agent: 'claude', surface: 'app', role: 'reviewer'})).toBe('Claude Code · Claude 앱 · 검토 담당');
    expect(teamMemberLabel({agent: 'claude', effort: 'low'})).toBe('Claude Code · 에포트 고정 low');
    expect(teamLaunchText({agent: 'codex'})).toBe('');
    expect(teamLaunchText({agent: 'codex', sessionId: SESSION})).toBe('');
    expect(teamLaunchText({agent: 'claude', surface: 'terminal', launchOptions: {bgMode: true, tmuxMode: false, reuse: 'new'}}))
      .toBe('실행 위치 Terminal(terminal) · Claude --bg · tmux 끔 · 새 창 · 수동 합류: Claude --bg는 고정 문구로 시작하고 상태만 보입니다');
  });
});

// The builder's row → member step (src/WorkroomTeamBuilder.tsx): a choice is carried as made or refused, never replaced.
describe('the builder row', () => {
  const ACCOUNT = 'acct_12345678-1234-4123-8123-123456789abc', OTHER = 'acct_87654321-4321-4321-8321-cba987654321';
  const accounts = {codex: [{id: 'host-default', label: '현재 CLI 계정'}, {id: ACCOUNT, label: '회사 계정'}]};
  const variants = hermesVariantItems(new Set(['anthropic']));
  const row = (patch: Partial<TeamBuilderRow>): TeamBuilderRow => ({...blankTeamRow(0, 'codex'), ...patch});
  const member = (value: TeamBuilderRow, context: Partial<Parameters<typeof teamRowMember>[1]> = {}) => teamRowMember(value, {accounts, variants, ...context});
  const block = (value: TeamBuilderRow) => {
    const result = member(value);
    if (!result.member) throw new Error(result.problem);
    return parseTeamSelectionBlock(teamLeaderInstruction({goal: '목표', members: [result.member]})).members[0];
  };

  test('regression: a chosen account that is not listed, an unreadable list or a place without accounts is refused, not dropped to the default login', () => {
    const unlisted = Object.freeze(row({accountId: OTHER}));
    expect(member(unlisted)).toEqual({problem: 'account-unlisted'});
    expect(unlisted.accountId).toBe(OTHER);
    expect(member(row({accountId: ACCOUNT}), {accounts: undefined})).toEqual({problem: 'accounts-unavailable'});
    expect(member(row({agent: 'claude', accountId: ACCOUNT}))).toEqual({problem: 'accounts-unavailable'});
    expect(member(row({agent: 'hermes', accountId: ACCOUNT}))).toEqual({problem: 'account-not-here'});
    expect(member(row({surface: 'iterm', options: {tmuxMode: true, reuse: 'new'}, accountId: ACCOUNT}))).toEqual({problem: 'account-not-here'});
    expect(member(row({accountId: ACCOUNT, agent: 'codex'}), {accounts: {codex: []}})).toEqual({problem: 'account-unlisted'});
  });

  test('a listed account rides to the block; no account names none (the member starts on this Mac’s default login)', () => {
    expect(member(row({accountId: ACCOUNT})).member).toEqual({agent: 'codex', accountId: ACCOUNT, accountLabel: '회사 계정'});
    expect(block(row({accountId: ACCOUNT}))).toEqual({agent: 'codex', accountId: ACCOUNT});
    expect(block(row({accountId: 'host-default'}))).toEqual({agent: 'codex', accountId: 'host-default'});
    expect(block(row({}))).toEqual({agent: 'codex'});
  });

  test('false options, a typed provider and a Hermes variant reach the block as chosen', () => {
    expect(block(row({agent: 'claude', surface: 'cmux', options: {bgMode: false, tmuxMode: true, reuse: 'new'}})))
      .toEqual({agent: 'claude', surface: 'cmux', launchOptions: {bgMode: false, tmuxMode: true, reuse: 'new'}});
    expect(block(row({surface: 'iterm', options: {tmuxMode: false, reuse: 'new'}}))).toEqual({agent: 'codex', surface: 'iterm', launchOptions: {tmuxMode: false, reuse: 'new'}});
    expect(block(row({agent: 'hermes', variant: 'claude', model: 'claude-sonnet-5-5', provider: 'anthropic'}))).toEqual({agent: 'hermes', model: 'claude-sonnet-5-5', provider: 'anthropic'});
    expect(block(row({agent: 'hermes', variant: 'claude', custom: true, model: ''}))).toEqual({agent: 'hermes', model: 'claude-opus-5-5', provider: 'anthropic'});
    expect(member(row({agent: 'hermes', variant: 'codex', model: 'gpt-6.1-sol', provider: 'openai-codex'}))).toEqual({problem: 'variant-missing'});
    // A provider without a model is refused by the shared parser, not silently left out.
    const provider = member(row({agent: 'hermes', custom: true, model: '', provider: 'anthropic'}));
    expect(provider.member?.provider).toBe('anthropic');
    expect(() => teamLeaderInstruction({goal: '목표', members: [provider.member!]})).toThrow(/provider는 model과 함께/);
    expect(member(row({custom: true, model: 'gpt 5; rm'}))).toEqual({problem: 'invalid-model'});
  });

  test('every surface and its options reach the block; a bypass the place does not take is refused', () => {
    for (const surface of TEAM_LAUNCH_SURFACES) for (const agent of ['codex', 'claude', 'hermes', 'agy'] as const) {
      const options = teamLaunchDefaults(surface, agent);
      expect(block(row({agent, surface, options}))).toEqual({agent, ...(surface === 'internal' ? {} : {surface}), ...(Object.keys(options).length ? {launchOptions: options} : {})});
    }
    const bypass = member(row({agent: 'hermes', surface: 'iterm', options: {reuse: 'new'}, bypass: true}));
    expect(bypass.member?.bypassPermissions).toBe(true);
    expect(() => teamLeaderInstruction({goal: '목표', members: [bypass.member!]})).toThrow(/권한 우회/);
  });

  test('a Hermes variant on any external surface is refused without replacing that surface or dropping the provider', () => {
    const available = hermesVariantItems(new Set(['anthropic', 'openai-codex']));
    for (const surface of TEAM_LAUNCH_SURFACES.filter(surface => surface !== 'internal')) for (const variant of ['claude', 'codex'] as const) {
      const selected = Object.freeze(row({agent: 'hermes', variant, surface, options: teamLaunchDefaults(surface, 'hermes')}));
      expect(member(selected, {variants: available})).toEqual({problem: 'variant-workroom-only'});
      expect(selected.surface).toBe(surface);
      expect(selected.variant).toBe(variant);
      expect(member({...selected, surface: 'internal', options: {}}, {variants: available}).member)
        .toMatchObject({agent: 'hermes', provider: variant === 'claude' ? 'anthropic' : 'openai-codex'});
      // Explicitly returning to plain Hermes keeps exactly the previously selected external location.
      expect(block({...selected, variant: ''})).toEqual({agent: 'hermes', surface,
        ...(Object.keys(selected.options).length ? {launchOptions: selected.options} : {})});
    }
  });

  test('an open session joins as it runs, whatever launch choices the row still holds', () => {
    const open = {id: SESSION, agent: 'codex' as const, label: 'Demo · codex', linked: true};
    expect(member(row({sessionId: SESSION, accountId: OTHER, bypass: true, surface: 'iterm', task: ' API '}), {open}).member)
      .toEqual({agent: 'codex', sessionId: SESSION, sessionLabel: 'Demo · codex', task: 'API'});
  });
});
