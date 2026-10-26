/**
 * 「에포트 자동」 on screen (w16 Build B): one pure module turns the host's record into the badge, the advice line and the
 * options-button suffix, and checks what a Mac answers. The same strings show on the Mac (main window, pop-out) and on
 * the phone (「새 작업」 sheet, full-screen session view), so they are fixed here.
 */
import {expect, test} from 'bun:test';
import {AI_TERMINAL_REQUEST_INVALID_CODE, AI_TERMINAL_UNKNOWN_REQUEST_ERROR} from '../src/aiTerminalProtocol';
import {
  WORKROOM_EFFORT_COMMUNITY_REFUSAL,
  normalizeWorkroomEffortView,
  workroomEffortAdviceText,
  workroomEffortBadgeText,
  workroomEffortOptionsSuffix,
  workroomEffortUnsupported,
  workroomEffortView,
  type WorkroomEffortSessionView,
} from '../src/workroomEffortView';

const session = (over: Partial<WorkroomEffortSessionView>): WorkroomEffortSessionView => ({agent: 'claude', manual: false, ...over});

test('the badge says what the session was started with, and why', () => {
  const rows: [Partial<WorkroomEffortSessionView>, string | null][] = [
    [{tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch'}, '에포트 자동 · 높음 (동시성)'],
    [{tier: 'high', reason: 'security', level: 'high', origin: 'launch'}, '에포트 자동 · 높음 (보안·권한)'],
    [{tier: 'high', reason: 'migration', level: 'high', origin: 'launch'}, '에포트 자동 · 높음 (데이터 마이그레이션)'],
    [{tier: 'high', reason: 'unclear-failure', level: 'high', origin: 'launch'}, '에포트 자동 · 높음 (원인 불명 실패)'],
    [{tier: 'high', reason: 'design-review', level: 'high', origin: 'restart'}, '에포트 자동 · 높음 (설계·리뷰)'],
    [{tier: 'medium', reason: 'standard', level: 'medium', origin: 'launch'}, '에포트 자동 · 보통'],
    [{tier: 'low', reason: 'typo', level: 'low', origin: 'launch'}, '에포트 자동 · 낮음 (오타)'],
    [{tier: 'low', reason: 'wording', level: 'low', origin: 'launch'}, '에포트 자동 · 낮음 (문구)'],
    [{tier: 'low', reason: 'rename', level: 'low', origin: 'launch'}, '에포트 자동 · 낮음 (이름 바꾸기)'],
    [{tier: 'low', reason: 'translate', level: 'low', origin: 'launch'}, '에포트 자동 · 낮음 (번역)'],
    [{tier: 'low', reason: 'format', level: 'low', origin: 'launch'}, '에포트 자동 · 낮음 (서식)'],
    // The CLI clamped it: shown, not «fixed».
    [{tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', seen: 'medium'}, '에포트 자동 · 높음 (동시성) · CLI 표시 medium'],
    [{tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', seen: 'high'}, '에포트 자동 · 높음 (동시성)'],
    // The person took over: auto stopped for this session, whatever it started with.
    [{tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', manual: true}, '에포트 직접 설정 · 다음 요청에서 자동 판단'],
    [{manual: true, skipped: 'manual'}, '에포트 직접 설정 · 다음 요청에서 자동 판단'],
    [{skipped: 'off'}, '에포트 미선택 · CLI 기본값'],
    [{skipped: 'no-request'}, '에포트 자동 · 첫 요청이 없어 CLI 기본값'],
    [{skipped: 'unclassified'}, '에포트 자동 · 명령으로 시작해 CLI 기본값'],
    [{agent: 'agy', skipped: 'unsupported'}, '에포트 자동 · Antigravity는 지원 안 함'],
    [{skipped: 'restricted'}, '에포트 자동 · 대직 세션은 적용 안 함'],
    [{skipped: 'history-resume'}, '에포트 자동 · 기록에서 이어 열어 CLI 기본값'],
    [{tier: 'high', reason: 'security', skipped: 'env-override'}, '에포트 자동 · CLAUDE_CODE_EFFORT_LEVEL 설정이 우선'],
    [{agent: 'codex', tier: 'high', reason: 'security', skipped: 'model-unknown'}, '에포트 자동 · 모델을 확인하지 못해 CLI 기본값'],
    // A level without a tier was pinned by the person (팀 작전 member); the Mac's mode does not apply to it.
    [{level: 'high', origin: 'launch'}, '에포트 고정 · 높음'],
    [{level: 'low', origin: 'restart', mode: 'off'}, '에포트 고정 · 낮음'],
    [{level: 'medium', origin: 'launch', manual: true}, '에포트 직접 설정'],
    // A session with no decision at all says nothing.
    [{}, null],
  ];
  for (const [over, text] of rows) expect(workroomEffortBadgeText(session(over))).toBe(text);
  expect(workroomEffortBadgeText(undefined)).toBeNull();
});

test('advice names the level a request needs, what runs now and how this CLI changes it — nothing is typed for the person', () => {
  const advice = (agent: WorkroomEffortSessionView['agent'], over: Partial<WorkroomEffortSessionView> = {}) =>
    workroomEffortAdviceText(session({agent, tier: 'medium', reason: 'standard', level: 'medium', origin: 'launch', advice: {tier: 'high', reason: 'design-review'}, ...over}));
  expect(advice('claude')).toBe('이번 요청은 높음이 맞아 보입니다 (설계·리뷰) · 지금 보통 · 바꾸려면 「에포트 변경」');
  expect(advice('codex')).toBe('이번 요청은 높음이 맞아 보입니다 (설계·리뷰) · 지금 보통 · 바꾸려면 「모델·에포트 변경」');
  expect(advice('hermes')).toBe('이번 요청은 높음이 맞아 보입니다 (설계·리뷰) · 지금 보통 · 바꾸려면 터미널에서 /reasoning');
  // What the CLI shows wins over the launch level; a word outside the three tiers is shown as the CLI wrote it.
  expect(advice('claude', {seen: 'xhigh', advice: {tier: 'low', reason: 'typo'}})).toBe('이번 요청은 낮음이 맞아 보입니다 (오타) · 지금 xhigh · 바꾸려면 「에포트 변경」');
  expect(advice('claude', {level: undefined, tier: undefined, reason: undefined, skipped: 'no-request', advice: {tier: 'low', reason: 'standard'}}))
    .toBe('이번 요청은 낮음이 맞아 보입니다 · 바꾸려면 「에포트 변경」');
  expect(workroomEffortAdviceText(session({manual: true, advice: {tier: 'high', reason: 'security'}}))).toBeNull();
  expect(workroomEffortAdviceText(session({agent: 'agy', advice: {tier: 'high', reason: 'security'}}))).toBeNull();
  expect(workroomEffortAdviceText(session({level: 'high'}))).toBeNull();
  expect(workroomEffortAdviceText(undefined)).toBeNull();
});

test('the options button says whether auto is on only once the Mac has answered', () => {
  expect(workroomEffortOptionsSuffix(true, true)).toBe(' · 에포트 자동');
  expect(workroomEffortOptionsSuffix(true, false)).toBe(' · 에포트 자동 꺼짐');
  expect(workroomEffortOptionsSuffix(null, null)).toBe('');
  expect(workroomEffortOptionsSuffix(false, null)).toBe('');
});

test('the wire view is strict: exactly these keys and values, nothing a phone could not render', () => {
  expect(normalizeWorkroomEffortView({auto: true})).toEqual({auto: true});
  const full = {auto: false, session: {agent: 'codex', tier: 'high', reason: 'security', level: 'high', origin: 'restart', seen: 'high', manual: false, advice: {tier: 'low', reason: 'typo'}}};
  expect(normalizeWorkroomEffortView(full)).toEqual(full as never);
  expect(normalizeWorkroomEffortView({auto: true, session: {agent: 'agy', skipped: 'unsupported', manual: false}})).toEqual({auto: true, session: {agent: 'agy', skipped: 'unsupported', manual: false}});
  const bad: unknown[] = [
    null, [], {}, {auto: 'yes'}, {auto: true, extra: 1},
    {auto: true, session: {agent: 'claude'}}, // manual is required
    {auto: true, session: {agent: 'gpt', manual: false}},
    {auto: true, session: {agent: 'claude', manual: false, tier: 'max'}},
    {auto: true, session: {agent: 'claude', manual: false, level: 'xhigh'}},
    {auto: true, session: {agent: 'claude', manual: false, reason: 'because'}},
    {auto: true, session: {agent: 'claude', manual: false, skipped: 'later'}},
    {auto: true, session: {agent: 'claude', manual: false, origin: 'voice'}},
    {auto: true, session: {agent: 'claude', manual: false, seen: 'High Effort'}},
    {auto: true, session: {agent: 'claude', manual: false, seen: 'x'.repeat(17)}},
    {auto: true, session: {agent: 'claude', manual: false, advice: {tier: 'high'}}},
    {auto: true, session: {agent: 'claude', manual: false, advice: {tier: 'high', reason: 'security', at: '2026-10-16T00:00:00Z'}}},
    {auto: true, session: {agent: 'claude', manual: false, sessionId: 'session-1234'}},
    {auto: true, session: {agent: 'claude', manual: false, phraseLines: []}},
  ];
  for (const value of bad) expect(() => normalizeWorkroomEffortView(value)).toThrow();
});

test('the host view drops what stays on the Mac (session id, advice time, change-line baseline) and a seen word it cannot vouch for', () => {
  const view = workroomEffortView(true, {sessionId: 'session-1234', agent: 'claude', tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch',
    seen: 'high', manual: false, advice: {tier: 'low', reason: 'typo', at: '2026-10-16T00:00:00Z'}});
  expect(view).toEqual({auto: true, session: {agent: 'claude', tier: 'high', reason: 'concurrency', level: 'high', origin: 'launch', seen: 'high', manual: false, advice: {tier: 'low', reason: 'typo'}}});
  expect(normalizeWorkroomEffortView(JSON.parse(JSON.stringify(view)))).toEqual(view);
  expect(workroomEffortView(false, {sessionId: 'session-1234', agent: 'claude', manual: false, seen: 'Very High'} as never).session).toEqual({agent: 'claude', manual: false});
  expect(workroomEffortView(false)).toEqual({auto: false});
});

test('an older Mac or sidecar is recognised by its refusal — never by a network failure', () => {
  for (const message of ['모바일 작업 요청 형식이 올바르지 않습니다.', '지원하지 않는 모바일 작업입니다.', '원격 터미널 요청이 올바르지 않습니다.',
    '터미널 요청 형식이 올바르지 않습니다.', AI_TERMINAL_UNKNOWN_REQUEST_ERROR])
    expect(workroomEffortUnsupported(new Error(message))).toBe(true);
  expect(workroomEffortUnsupported(Object.assign(new Error('x'), {code: AI_TERMINAL_REQUEST_INVALID_CODE}))).toBe(true);
  for (const error of [new Error('Load failed'), new Error('모바일 조회 요청이 많습니다. 잠시 후 다시 확인하세요.'), new Error(WORKROOM_EFFORT_COMMUNITY_REFUSAL), null, 'text'])
    expect(workroomEffortUnsupported(error)).toBe(false);
});

test('rolling upgrades keep legacy phone responses within the old strict effort schema', () => {
  const record = {sessionId:'session-legacy',agent:'codex' as const,manual:false,level:'high' as const,origin:'runtime' as const,runtimeStatus:'applied' as const};
  expect(workroomEffortView(true,record)).toEqual({auto:true,session:{agent:'codex',level:'high',manual:false}});
  expect(workroomEffortView(true,record,'auto').session).toMatchObject({mode:'auto',origin:'runtime',runtimeStatus:'applied'});
  expect(workroomEffortView(false,{...record,skipped:'recommend'}).session).not.toHaveProperty('skipped');
  expect(workroomEffortView(false,{...record,skipped:'recommend'},'recommend').session).toHaveProperty('skipped','recommend');
});
