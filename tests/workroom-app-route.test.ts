import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  WORKROOM_APP_AGENTS, WORKROOM_APP_DISPATCH_MAX_REQUEST_BYTES, WORKROOM_APP_DISPATCH_PATH, WORKROOM_APP_DISPATCH_PRE_SEND_ERRORS,
  WORKROOM_APP_PREFILL_MAX_BYTES,
  normalizeWorkroomAppDispatchRequest, normalizeWorkroomAppDispatchResult,
  workroomAppAgentOf, workroomAppChoice, workroomAppConfirmMessage, workroomAppDispatchPublicBody,
  workroomAppDispatchRefusedBeforeSend, workroomAppFailureText, workroomAppOpenCodeAppBody,
  workroomAppReceipt, workroomAppRoutePreview, workroomAppRoutesAvailable, workroomAppSendLabel, workroomAppTakesTask,
  workroomAppTaskKept, workroomCliAgentOf,
} from '../src/workroomAppRoute';
import {CODE_APP_TASK_PREFILL_MAX_BYTES} from '../src/codeAppTask';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('workroom app route — choice values', () => {
  test('app values never collide with CLI agent values', () => {
    for (const agent of WORKROOM_APP_AGENTS) {
      const choice = workroomAppChoice(agent);
      expect(workroomAppAgentOf(choice)).toBe(agent);
      expect(workroomCliAgentOf(choice)).toBeNull();
      expect(workroomCliAgentOf(agent)).toBe(agent);
      expect(workroomAppAgentOf(agent)).toBeNull();
    }
    expect(workroomAppAgentOf('app:gpt')).toBeNull();
    expect(workroomAppAgentOf('')).toBeNull();
  });

  test('apps are offered only on the local Mac panel', () => {
    expect(workroomAppRoutesAvailable({remote: false, routeDeviceId: ''})).toBe(true);
    expect(workroomAppRoutesAvailable({remote: true, routeDeviceId: ''})).toBe(false);
    expect(workroomAppRoutesAvailable({remote: false, routeDeviceId: 'device-2'})).toBe(false);
  });

  test('the prefill bound matches the sidecar', () => {
    expect(WORKROOM_APP_PREFILL_MAX_BYTES).toBe(CODE_APP_TASK_PREFILL_MAX_BYTES);
  });
});

describe('workroom app route — honest wording', () => {
  test('only Codex takes the task, judged on the encoded link (Korean is 9 URL chars a syllable)', () => {
    expect(workroomAppTakesTask('codex', '짧은 작업')).toBe(true);
    expect(workroomAppTakesTask('codex', 'a'.repeat(4_000))).toBe(true);
    expect(workroomAppTakesTask('codex', 'a'.repeat(4_001))).toBe(false); // byte bound
    // 900 Hangul = 2,700 bytes, well under 4,000 bytes, but ~8,100 encoded characters: not prefilled.
    expect(workroomAppTakesTask('codex', '가'.repeat(900))).toBe(false);
    expect(workroomAppTakesTask('codex', '가'.repeat(700))).toBe(true);
    for (const agent of ['claude', 'hermes', 'agy'] as const) expect(workroomAppTakesTask(agent, '짧은 작업')).toBe(false);
  });

  test('the first line of the confirm and the button verb say what happens — not «send»', () => {
    const codex = workroomAppConfirmMessage('codex', '기억 B', '작업');
    expect(codex.split('\n')[0]).toBe('‘기억 B’ 작업으로 새 Codex 앱 대화를 엽니다.');
    expect(codex).toContain('채우도록 요청합니다');
    expect(codex).toContain('클립보드에도 복사해 둡니다');
    expect(workroomAppConfirmMessage('codex', '기억 B', 'x'.repeat(5000)).split('\n')[0]).toContain('클립보드에 복사합니다');
    expect(workroomAppConfirmMessage('claude', '기억 B', '작업').split('\n')[0]).toBe('Claude 앱을 열고 ‘기억 B’ 작업을 클립보드에 복사합니다.');
    expect(workroomAppConfirmMessage('hermes', '기억 B', '작업').split('\n')[0]).toBe('Hermes 앱을 열고 ‘기억 B’ 작업을 클립보드에 복사합니다.');
    const agy = workroomAppConfirmMessage('agy', '기억 B', '작업');
    expect(agy.split('\n')[0]).toBe('Antigravity 앱을 열고 ‘기억 B’ 작업을 클립보드에 복사합니다.');
    expect(agy).toContain('프로젝트는 앱에서 선택');
    for (const agent of WORKROOM_APP_AGENTS) expect(workroomAppConfirmMessage(agent, '기억 B', '작업')).not.toContain('보냅니다');
    expect(workroomAppSendLabel('codex', '작업')).toBe('Codex 앱 입력칸에 채우기');
    expect(workroomAppSendLabel('codex', '가'.repeat(900))).toBe('Codex 앱 열고 작업 복사');
    expect(workroomAppSendLabel('claude', '작업')).toBe('Claude 앱 열고 작업 복사');
    expect(workroomAppSendLabel('agy', '작업')).toBe('Antigravity 앱 열고 작업 복사');
  });

  test('preview never promises Antigravity applies the project, nor that Codex filled the composer', () => {
    expect(workroomAppRoutePreview('agy', '기억 B', '작업')).toContain('프로젝트는 앱에서 선택');
    expect(workroomAppRoutePreview('codex', '기억 B', '작업')).toContain('채우도록 요청합니다');
    expect(workroomAppRoutePreview('claude', '기억 B', '작업')).toContain('클립보드');
  });

  test('# references are said to be dropped before the user confirms, not only after', () => {
    for (const agent of WORKROOM_APP_AGENTS) {
      expect(workroomAppRoutePreview(agent, '기억 B', '작업', 2)).toContain('# 언급은 앱에 폴더로 전달되지 않고');
      expect(workroomAppConfirmMessage(agent, '기억 B', '작업', 1)).toContain('# 언급은 앱에 폴더로 전달되지 않고');
      expect(workroomAppConfirmMessage(agent, '기억 B', '작업')).not.toContain('# 언급');
    }
  });
});

describe('workroom app route — request contract', () => {
  test('exact keys, no path', () => {
    expect(normalizeWorkroomAppDispatchRequest({targetId: ' fixture-target ', agent: 'agy', task: 'x', bypass: false}))
      .toEqual({targetId: 'fixture-target', agent: 'agy', task: 'x', bypass: false});
    for (const bad of [
      null, [], {}, {targetId: 'fixture-target'}, {targetId: 'fixture-target', agent: 'gpt'},
      {targetId: 'fixture-target', agent: 'codex', folderPath: '/etc'},
      {targetId: 'fixture-target', agent: 'codex', task: 5},
      {targetId: 'fixture-target', agent: 'codex', bypass: 'yes'},
      {targetId: '', agent: 'codex'},
    ]) expect(() => normalizeWorkroomAppDispatchRequest(bad)).toThrow();
  });

  test('open-code-app body: Hermes opens the project app, Codex always a new conversation, only Codex gets the task, only Claude bypass', () => {
    const cwd = '/fixture/project';
    expect(workroomAppOpenCodeAppBody({targetId: 't', agent: 'hermes', task: 'x', bypass: true}, cwd))
      .toEqual({agent: 'hermes', folderPath: cwd, mode: 'open'});
    expect(workroomAppOpenCodeAppBody({targetId: 't', agent: 'claude', task: 'x', bypass: true}, cwd))
      .toEqual({agent: 'claude', folderPath: cwd, bypass: true});
    expect(workroomAppOpenCodeAppBody({targetId: 't', agent: 'codex', task: 'x', bypass: true}, cwd))
      .toEqual({agent: 'codex', folderPath: cwd, mode: 'new', task: 'x'});
    // A task too long for the link is not sent; Codex still opens a *new* conversation, never the old one.
    expect(workroomAppOpenCodeAppBody({targetId: 't', agent: 'codex'}, cwd)).toEqual({agent: 'codex', folderPath: cwd, mode: 'new'});
    expect(workroomAppOpenCodeAppBody({targetId: 't', agent: 'agy', task: 'x'}, cwd)).toEqual({agent: 'agy', folderPath: cwd});
  });

  test('the public body never carries the folder path, even inside a sentence', () => {
    const target = {targetId: 'target-1', projectLabel: '기억 B', cwd: '/Users/me/secret/project'};
    const out = workroomAppDispatchPublicBody({success: false, folderPath: target.cwd, error: `폴더를 찾을 수 없습니다: ${target.cwd}`, warning: `${target.cwd} 확인`, taskNote: 'x'}, target, 'codex');
    expect(JSON.stringify(out)).not.toContain(target.cwd);
    expect(out).toMatchObject({agent: 'codex', targetId: 'target-1', projectLabel: '기억 B', error: '폴더를 찾을 수 없습니다: ‘기억 B’'});
    expect(out).not.toHaveProperty('folderPath');
  });

  test('a request the proxy refuses before sending is a failure, not «unconfirmed»; the size limit matches Rust', () => {
    const rust = read('src-tauri/src/lib.rs');
    expect(rust).toContain(`const AGENT_RUNTIME_APP_DISPATCH_REQUEST_MAX_BYTES: usize = ${WORKROOM_APP_DISPATCH_MAX_REQUEST_BYTES / 1024} * 1024;`);
    for (const phrase of WORKROOM_APP_DISPATCH_PRE_SEND_ERRORS) expect(rust).toContain(phrase);
    expect(workroomAppDispatchRefusedBeforeSend('에이전트 런타임 요청이 너무 큽니다.')).toBe('에이전트 런타임 요청이 너무 큽니다.');
    expect(workroomAppDispatchRefusedBeforeSend(new Error('AgentsToZ 로컬 API 연결 실패: refused'))).toContain('연결 실패');
    // A read timeout after the request was written: the app may have opened.
    expect(workroomAppDispatchRefusedBeforeSend('Resource temporarily unavailable (os error 35)')).toBeNull();
    const client = read('src/aiTerminalClient.ts');
    expect(client).toContain("code:'WORKROOM_APP_DISPATCH_TOO_LARGE'");
    expect(client).toContain("code:'WORKROOM_APP_DISPATCH_NOT_SENT'");
  });

  test('results: failures keep the server message, unknown values are dropped', () => {
    expect(normalizeWorkroomAppDispatchResult(409, {success: false, code: 'ANTIGRAVITY_APP_NOT_FOUND', error: '찾지 못했습니다'}))
      .toEqual({ok: false, code: 'ANTIGRAVITY_APP_NOT_FOUND', error: '찾지 못했습니다'});
    expect(normalizeWorkroomAppDispatchResult(200, {success: false}).ok).toBe(false);
    expect(normalizeWorkroomAppDispatchResult(200, {success: true, taskApplied: 'submitted', projectApplied: 'maybe', launchVerified: false, folderPath: '/x'}))
      .toEqual({ok: true, launchVerified: false});
  });
});

describe('workroom app route — receipt and draft', () => {
  test('the draft is cleared only when the clipboard surely holds the task (a prefill is never confirmed)', () => {
    expect(workroomAppTaskKept({ok: true, taskApplied: 'prefilled'}, 'failed')).toBe(false);
    expect(workroomAppTaskKept({ok: true, taskApplied: 'prefilled'}, 'copied')).toBe(true);
    expect(workroomAppTaskKept({ok: true, taskApplied: false}, 'copied')).toBe(true);
    expect(workroomAppTaskKept({ok: true, taskApplied: false}, 'failed')).toBe(false);
  });

  test('a failure says the clipboard now holds the handoff', () => {
    expect(workroomAppFailureText({ok: false, error: '찾지 못했습니다.'}, 'copied')).toBe('찾지 못했습니다. · 작업 내용은 클립보드에 복사돼 있고, 입력칸의 글도 그대로입니다.');
    expect(workroomAppFailureText({ok: false, error: '찾지 못했습니다.'}, 'failed')).toBe('찾지 못했습니다.');
  });

  test('receipts state the true result', () => {
    const codex = workroomAppReceipt({agent: 'codex', targetLabel: '기억 B', result: {ok: true, taskApplied: 'prefilled'}, clipboard: 'copied', bypassRequested: true});
    expect(codex).toContain('입력칸에 채우도록 요청했습니다');
    expect(codex).toContain('클립보드에도 복사해 두었습니다');
    expect(codex).not.toContain('채웠습니다');
    expect(codex).toContain('권한 우회는 Claude 앱에만');
    expect(codex).not.toContain('보냈습니다');
    const tooLong = workroomAppReceipt({agent: 'codex', targetLabel: '기억 B', result: {ok: true, taskApplied: false}, clipboard: 'copied', bypassRequested: false});
    expect(tooLong).toContain('입력칸에 채우지 않았습니다');

    const agy = workroomAppReceipt({agent: 'agy', targetLabel: '기억 B', result: {ok: true, launchVerified: true, projectApplied: false, taskApplied: false}, clipboard: 'copied', bypassRequested: false});
    expect(agy).toContain('프로젝트는 앱에서 선택하세요');
    expect(agy).toContain('클립보드에 복사했습니다');

    const unverified = workroomAppReceipt({agent: 'agy', targetLabel: '기억 B', result: {ok: true, launchVerified: false, warning: '응답이 늦습니다.'}, clipboard: 'failed', bypassRequested: false});
    expect(unverified).toContain('확인하지 못했습니다');
    expect(unverified).toContain('복사하지 못했습니다');

    const claude = workroomAppReceipt({agent: 'claude', targetLabel: '기억 B', result: {ok: true, taskApplied: false}, clipboard: 'copied', bypassRequested: true, droppedReferences: 1});
    expect(claude).not.toContain('권한 우회');
    expect(claude).toContain('# 언급');
  });
});

describe('workroom app route — wiring contracts', () => {
  const server = read('api-server.ts');
  const panel = read('src/AiTerminalPanel.tsx');

  test('the sidecar route is management-gated and resolves the target fresh', () => {
    const gate = server.slice(server.indexOf('function isAllowedAgentRuntimeManagementRoute'), server.indexOf('function isAgentRuntimeManagementOrigin'));
    expect(gate).toContain('WORKROOM_APP_DISPATCH_PATH');
    const route = server.slice(server.indexOf('if (url.pathname === WORKROOM_APP_DISPATCH_PATH)'));
    const body = route.slice(0, route.indexOf('// Workroom images'));
    expect(body).toContain('await resolveAgentRuntimeRegisteredTarget(request.targetId)');
    expect(body).toContain('openCodeAppResponse(');
    expect(body).toContain('workroomAppDispatchPublicBody(body,target,request.agent)');
    expect(body).not.toContain('fetch(');
    expect(WORKROOM_APP_DISPATCH_PATH).toBe('/api/agent-runtime/app-dispatch');
  });

  test('the Rust proxy allows exactly this route', () => {
    const rust = read('src-tauri/src/lib.rs');
    expect(rust).toContain('const AGENT_RUNTIME_APP_DISPATCH_PATH: &str = "/api/agent-runtime/app-dispatch";');
    expect(rust).toContain('if path == AGENT_RUNTIME_APP_DISPATCH_PATH { return method == "POST"; }');
  });

  test('no remote, LAN or community path can reach the app dispatch', () => {
    for (const file of [
      'src/remoteControlMobilePage.ts', 'src/agentDialogueControl.ts', 'src/remoteControlCore.ts',
      'src/remoteControlInternetAgent.ts', 'src/remoteControlRelayController.ts', 'src/workroomRouteDelivery.ts',
      'src/workroomProjectMention.ts',
    ]) {
      // A renamed file must fail here, not silently pass with nothing checked.
      const text = read(file);
      expect(text).not.toContain('app-dispatch');
      expect(text).not.toContain('workroomAppRoute');
    }
  });

  test('the panel hides app destinations on remote and community routes', () => {
    expect(panel).toContain('workroomAppRoutesAvailable({remote,routeDeviceId})');
    // Same label as the LAN QR page when only AIs can be chosen.
    expect(panel).toContain("appRoutesAvailable?'받는 곳':'받는 AI'");
    expect(read('src/remoteControlMobilePage.ts')).toContain('받는 AI');
    expect(panel).toContain('data-testid="workroom-app-route-receipt"');
    expect(panel).toContain('<optgroup label="워크룸 CLI">');
    expect(panel).toContain('<optgroup label="앱">');
  });
});
