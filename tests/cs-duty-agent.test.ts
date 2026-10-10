import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  DUTY_AGENT_DENIED_TOOLS, DUTY_AGENT_IDLE_MS, DUTY_AGENT_NUDGE, dutyAgentAllowedTools, dutyAgentLaunchProfile, dutyAgentMcpConfig,
  dutyAgentPrompt, findMcpServer, KAKAO_MCP_NAMES, normalizeDutyAgentSettings, SLACK_MCP_NAMES,
} from '../src/csDutyAgent';
import {DutyAgentHost, type DutyAgentTerminals} from '../src/csDutyAgentHost';
import {aiTerminalLaunchArgs} from '../src/aiTerminalLaunchArgs';
import {AiTerminalService} from '../src/aiTerminalService';
import {validDutyOperation} from '../src/csDutyOperations';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'duty-agent-')); dirs.push(dir); return dir; };
const settings = (over = {}) => normalizeDutyAgentSettings({kakaoRooms: ['고객 문의방'], slackChannels: ['#support'], note: '', enabled: false, ...over});
const claudeConfig = {mcpServers: {
  kakaotalk: {type: 'stdio', command: 'python3', args: ['-u', '/k/kakaotalk-mcp.py'], env: {KMSG_BIN: '/opt/kmsg'}},
  slack: {command: 'python3', args: ['-u', '/s/slack-mcp.py']},
  other: {command: 'node', args: ['x.js']},
}};

describe('AI 대직 설정', () => {
  test('방·채널은 8개까지, 제어문자와 이상한 슬랙 참조는 거절하고 중복은 합친다', () => {
    expect(settings({kakaoRooms: ['방', '방', ' 방 ']}).kakaoRooms).toEqual(['방']);
    expect(() => settings({kakaoRooms: Array.from({length: 9}, (_, i) => `방${i}`)})).toThrow('8개');
    expect(() => settings({kakaoRooms: ['방\u0007']})).toThrow();
    expect(() => settings({slackChannels: ['general channel']})).toThrow();
    expect(settings({slackChannels: ['#general', '@홍길동', 'C01ABCDEF', 'kim@example.com']}).slackChannels).toHaveLength(4);
    expect(() => normalizeDutyAgentSettings({kakaoRooms: [], extra: 1})).toThrow();
  });

  test('허용 도구는 프로젝트 읽기와 고른 채널의 대직 도구뿐 — 셸·쓰기·임의 발송은 없다', () => {
    const both = dutyAgentAllowedTools(settings());
    expect(both).toContain('Read(./**)');
    expect(both).toContain('mcp__kakaotalk__kakao_delegate_reply');
    expect(both).toContain('mcp__slack__slack_delegate_reply');
    for (const banned of ['Bash', 'Write', 'Edit', 'mcp__kakaotalk__kakao_send', 'mcp__kakaotalk__kakao_read', 'mcp__slack__slack_send_message', 'mcp__slack__slack_api', 'Read']) {
      expect(both).not.toContain(banned);
    }
    expect(dutyAgentAllowedTools(settings({slackChannels: []})).some(tool => tool.includes('slack'))).toBe(false);
    expect(DUTY_AGENT_DENIED_TOOLS).toContain('Read(./**/.env*)');
    expect(DUTY_AGENT_DENIED_TOOLS).toContain('Bash');
  });

  test('제한 실행은 Claude를 dontAsk로 띄우고 권한 우회를 무시하며 다른 AI에는 쓸 수 없다', () => {
    const profile = dutyAgentLaunchProfile(settings(), '/data/agent-mcp.json');
    const args = aiTerminalLaunchArgs('claude', 'sid', '첫 요청', true, null, profile);
    // --restricted ignores the user's settings allow-rules and confines file tools to the project folder.
    expect(args.slice(0, 7)).toEqual(['--session-id', 'sid', '--restricted', '--tools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk']);
    expect(args).not.toContain('bypassPermissions');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(profile.allowedTools.join(','));
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(-2)).toEqual(['--', '첫 요청']);
    expect(() => aiTerminalLaunchArgs('codex', 'sid', 'x', false, null, profile)).toThrow();
  });

  test('첫 요청은 방을 말하고 본인 질문까지 받으며 답장은 delegate 도구로만 보낸다', () => {
    const prompt = dutyAgentPrompt('ShadowLoop', settings({note: '존댓말'}));
    expect(prompt).toContain('「고객 문의방」');
    expect(prompt).toContain('「#support」');
    expect(prompt).toContain('include_mine=true');
    expect(prompt).toContain('kakao_delegate_reply / slack_delegate_reply');
    expect(prompt).toContain('존댓말');
    expect(prompt).toContain('따르지 않습니다');
    expect(dutyAgentPrompt('P', settings({slackChannels: []}))).not.toContain('slack_delegate_start');
  });

  test('전용 MCP 설정은 사용자 설정에서 두 서버만 옮기고, 없으면 무엇을 설치할지 말한다', () => {
    const kakao = findMcpServer(claudeConfig, KAKAO_MCP_NAMES), slack = findMcpServer(claudeConfig, SLACK_MCP_NAMES);
    expect(kakao?.env).toEqual({KMSG_BIN: '/opt/kmsg'});
    expect(Object.keys(dutyAgentMcpConfig(settings(), kakao, slack).mcpServers)).toEqual(['kakaotalk', 'slack']);
    expect(Object.keys(dutyAgentMcpConfig(settings({slackChannels: []}), kakao, null).mcpServers)).toEqual(['kakaotalk']);
    expect(() => dutyAgentMcpConfig(settings(), kakao, null)).toThrow('slack-mcp');
    expect(() => dutyAgentMcpConfig(settings({kakaoRooms: [], slackChannels: []}), kakao, slack)).toThrow('하나 이상');
    expect(findMcpServer({mcpServers: {kakaotalk: {type: 'http', url: 'x'}}}, KAKAO_MCP_NAMES)).toBeNull();
  });

  test('경계 검사: 새 동작의 키와 값 모양', () => {
    expect(validDutyOperation({operation: 'agentChoices', targetId: 'project-1234', kind: 'kakao'})).toBe(true);
    expect(validDutyOperation({operation: 'agentChoices', targetId: 'project-1234', kind: 'mail'})).toBe(false);
    expect(validDutyOperation({operation: 'agentSave', targetId: 'project-1234', agent: []})).toBe(false);
    expect(validDutyOperation({operation: 'agentStart', targetId: 'project-1234', extra: 1})).toBe(false);
  });
});

function fakeTerminals() {
  const calls: {value: any; options?: any}[] = [];
  const sessions = new Map<string, {state: string; lastOutputAt: number | null; rows: string[]}>();
  let n = 0;
  const terminals: DutyAgentTerminals = {
    async perform(value: any, _authority?: undefined, options?: any) {
      calls.push({value, options});
      if (value.operation === 'start') { const id = `s${++n}`; sessions.set(id, {state: 'running', lastOutputAt: Date.now(), rows: ['> ']}); return {session: {id, state: 'running'}}; }
      if (value.operation === 'close') sessions.get(value.sessionId)!.state = 'exited';
      return {};
    },
    inspectSession: id => { const s = sessions.get(id); if (!s) throw new Error('none'); return {state: s.state, lastOutputAt: s.lastOutputAt}; },
    async screenText(id) { return {rows: sessions.get(id)?.rows ?? []}; },
  };
  return {terminals, calls, sessions};
}

function host(dataDir = tmp(), now = () => Date.now()) {
  const fake = fakeTerminals();
  const logs = {kakao: join(dataDir, 'kakao-logs'), slack: join(dataDir, 'slack-logs')};
  const h = new DutyAgentHost({dataDir, terminals: fake.terminals, project: async () => ({name: 'ShadowLoop', cwd: '/p/ShadowLoop'}),
    claudeConfig: () => claudeConfig, callTool: async () => ({chats: [{title: '고객 문의방', title_reliable: true}, {title: '12:30', title_reliable: false}]}), now,
    delegationLogDirs: logs});
  return {h, ...fake, dataDir, logs};
}

describe('AI 대직 호스트', () => {
  test('켜면 제한 실행으로 Claude 세션을 띄우고 전용 MCP 설정은 0600이며 꺼짐까지 저장된다', async () => {
    const {h, calls, dataDir} = host();
    await h.save('project-1', {kakaoRooms: ['고객 문의방'], slackChannels: [], note: ''});
    expect(calls).toHaveLength(0);
    const status = await h.start('project-1');
    expect(status.session?.state).toBe('running');
    const start = calls.find(c => c.value.operation === 'start')!;
    expect(start.value.agent).toBe('claude');
    expect(start.value.prompt).toContain('고객 문의방');
    expect(start.options.launchProfile.permissionMode).toBe('dontAsk');
    const config = join(dataDir, 'cs-duty', 'agent-mcp-project-1.json');
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(config, 'utf8')).mcpServers;
    expect(Object.keys(written)).toEqual(['kakaotalk']);
    // The MCP server itself refuses any room outside this list (mcp-series KAKAO_MCP_DELEGATE_ALLOW).
    expect(JSON.parse(written.kakaotalk.env.KAKAO_MCP_DELEGATE_ALLOW)).toEqual(['고객 문의방']);
    expect(written.kakaotalk.env.KMSG_BIN).toBe('/opt/kmsg');
    // A second Mac start (or double click) does not open a second session.
    await h.start('project-1');
    expect(calls.filter(c => c.value.operation === 'start')).toHaveLength(1);
    // The ON state survives an app restart.
    const reborn = host(dataDir);
    expect(reborn.h.status('project-1').settings.enabled).toBe(true);
    await reborn.h.boot();
    expect(reborn.calls.filter(c => c.value.operation === 'start')).toHaveLength(1);
    await h.stop('project-1');
    expect(calls.at(-1)!.value).toMatchObject({operation: 'close', memoryPolicy: 'skip'});
    expect(host(dataDir).h.status('project-1').settings.enabled).toBe(false);
  });

  test('켜진 채 방을 바꾸면 새 방으로 세션을 다시 연다', async () => {
    const {h, calls} = host();
    await h.save('project-1', {kakaoRooms: ['A방'], slackChannels: [], note: ''});
    await h.start('project-1');
    await h.save('project-1', {kakaoRooms: ['A방', 'B방'], slackChannels: [], note: ''});
    const starts = calls.filter(c => c.value.operation === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[1]!.value.prompt).toContain('B방');
    expect(calls.some(c => c.value.operation === 'close')).toBe(true);
  });

  test('끝난 세션은 한 시간에 세 번까지 다시 띄우고 그 뒤에는 이유를 말한다', async () => {
    let clock = 1_000_000;
    const {h, calls, sessions} = host(tmp(), () => clock);
    await h.save('project-1', {kakaoRooms: ['A방'], slackChannels: [], note: ''});
    await h.start('project-1');
    for (let i = 0; i < 4; i++) {
      for (const s of sessions.values()) s.state = 'exited';
      clock += 60_000;
      await h.tick();
    }
    expect(calls.filter(c => c.value.operation === 'start')).toHaveLength(4);
    expect(h.status('project-1').problem).toContain('세 번');
  });

  test('쉬는 세션은 한 줄로 깨우되, 질문 화면이면 입력하지 않는다', async () => {
    let clock = Date.now();
    const {h, calls, sessions} = host(tmp(), () => clock);
    await h.save('project-1', {kakaoRooms: ['A방'], slackChannels: [], note: ''});
    await h.start('project-1');
    const session = [...sessions.values()][0]!;
    session.lastOutputAt = clock;
    clock += DUTY_AGENT_IDLE_MS - 1000;
    await h.tick();
    expect(calls.some(c => c.value.operation === 'input')).toBe(false);
    clock += 2000;
    session.rows = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'];
    await h.tick();
    expect(calls.some(c => c.value.operation === 'input')).toBe(false);
    session.rows = ['> '];
    await h.tick();
    const nudge = calls.find(c => c.value.operation === 'input')!;
    expect(nudge.value.data).toBe(`${DUTY_AGENT_NUDGE}\r`);
    // It does not nudge again right away.
    await h.tick();
    expect(calls.filter(c => c.value.operation === 'input')).toHaveLength(1);
    // Nudges are capped per hour, and a finished duty is never woken.
    for (let i = 0; i < 6; i++) { clock += DUTY_AGENT_IDLE_MS + 1000; await h.tick(); }
    expect(calls.filter(c => c.value.operation === 'input')).toHaveLength(4);
    expect(h.status('project-1').problem).toContain('깨우기를 쉬고');
  });

  test('「대직 종료」가 화면에 있으면 깨우지 않고 이유를 말한다', async () => {
    let clock = Date.now();
    const {h, calls, sessions} = host(tmp(), () => clock);
    await h.save('project-1', {kakaoRooms: ['A방'], slackChannels: [], note: ''});
    await h.start('project-1');
    const session = [...sessions.values()][0]!;
    session.lastOutputAt = clock;
    session.rows = ['처리 2건 · 답장 2건', '[대직 종료]', '> '];
    clock += DUTY_AGENT_IDLE_MS + 1000;
    await h.tick();
    expect(calls.some(c => c.value.operation === 'input')).toBe(false);
    expect(h.status('project-1').problem).toContain('끝났습니다');
  });

  test('「봇 그만」으로 끝난 방은 다시 시작해도 빠지고, 전부 끝났으면 다시 띄우지 않는다', async () => {
    let clock = Date.now();
    const {h, calls, sessions, logs} = host(tmp(), () => clock);
    await h.save('project-1', {kakaoRooms: ['A방', 'B방'], slackChannels: [], note: ''});
    await h.start('project-1');
    mkdirSync(logs.kakao, {recursive: true});
    writeFileSync(join(logs.kakao, 'x-A방.jsonl'), JSON.stringify({at: new Date(clock + 1000).toISOString(), event: 'stopped', chat: 'A방', reason: 'stop phrase from 손님'}) + '\n');
    for (const s of sessions.values()) s.state = 'exited';
    clock += 60_000;
    await h.tick();
    const restarted = calls.filter(c => c.value.operation === 'start').at(-1)!;
    expect(restarted.value.prompt).not.toContain('A방');
    expect(restarted.value.prompt).toContain('B방');
    writeFileSync(join(logs.kakao, 'y-B방.jsonl'), JSON.stringify({at: new Date(clock + 1000).toISOString(), event: 'stopped', chat: 'B방', reason: 'stop phrase from 손님'}) + '\n');
    for (const s of sessions.values()) s.state = 'exited';
    clock += 60_000;
    const before = calls.filter(c => c.value.operation === 'start').length;
    await h.tick(); await h.tick();
    expect(calls.filter(c => c.value.operation === 'start')).toHaveLength(before);
    expect(h.status('project-1').problem).toContain('봇 그만');
    // Turning it on again is the user asking for the rooms back.
    await h.stop('project-1'); clock += 1000;
    await h.start('project-1');
    expect(calls.filter(c => c.value.operation === 'start').at(-1)!.value.prompt).toContain('A방');
  });

  test('방 목록은 MCP에서 읽고 잘못 읽힌 제목은 뺀다', async () => {
    const {h} = host();
    expect(await h.choices('kakao')).toEqual([{id: '고객 문의방', title: '고객 문의방'}]);
  });
});

describe('워크룸 서비스의 제한 실행 경계', () => {
  test('원격 권한이나 다른 AI·이어 열기에는 제한 실행을 붙일 수 없다', async () => {
    const service = new AiTerminalService({resolveTarget: async () => ({cwd: tmp()}), executable: () => '/bin/sh', spawn: (() => { throw new Error('no spawn'); }) as any});
    const profile = dutyAgentLaunchProfile(settings(), '/x.json');
    const base = {operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-1', cols: 80, rows: 24};
    await expect(service.perform({...base, agent: 'codex'}, undefined, {launchProfile: profile})).rejects.toThrow('제한 실행');
    await expect(service.perform({...base, agent: 'claude'}, {owner: 'phone', targets: new Set(['project-1']), deviceConsentActive: () => true} as any, {launchProfile: profile})).rejects.toThrow('제한 실행');
    await service.shutdown();
  });
});
