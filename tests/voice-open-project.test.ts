import {expect, test} from 'bun:test';
import type {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime, type VoiceRuntimeDependencies} from '../src/voiceRuntimeBinding';
import {VOICE_TARGET_CALL_GUIDANCE} from '../src/voiceOrchestrationGuidance';

// 「<프로젝트> 열어/보여줘」 by OPS voice shows the project in the app. It is navigation only: the
// terminal below throws on any use, so the test fails if opening a project starts or reads a Workroom.
const TARGET = '0b7a2c1e-2222-4a4a-8b8b-000000000002';
const untouchable = new Proxy({}, {get: (_target, property) => { throw new Error(`terminal.${String(property)} must not be used`); }}) as AiTerminalService;

function deps(focused: string[], extra: Partial<VoiceRuntimeDependencies> = {}): VoiceRuntimeDependencies {
  return {
    terminal: untouchable,
    targets: async () => [{id: TARGET, name: 'vibe2', role: 'managed', scope: 'main'}],
    target: async id => { if (id !== TARGET) throw new Error('등록된 음성 대상을 확인하세요.'); return {label: 'vibe2', fingerprint: 'registered:' + id}; },
    ops: () => ({fingerprint: 'ops-fixture', projectId: 'ops-project-1234'}),
    recall: () => ({hits: []}),
    projectRecall: async () => ({hits: []}),
    propose: async () => ({state: 'pending'}),
    focusProject: async id => { focused.push(id); },
    ...extra,
  };
}
const authority = {owner: 'local', active: () => true};

test('OPS voice open_project focuses the resolved project in the app and runs nothing', async () => {
  const focused: string[] = [];
  const binding = await bindVoiceRuntime(deps(focused), {kind: 'ops'}, authority);
  const tool = binding.tools.find(candidate => candidate.name === 'open_project');
  expect(tool?.parameters).toEqual({type: 'object', properties: {targetId: {type: 'string'}}, required: ['targetId'], additionalProperties: false});
  expect(tool?.description).toContain('resolve_target_alias');
  expect(await binding.run('open_project', {targetId: TARGET}, crypto.randomUUID()))
    .toMatchObject({state: 'project-opened', completed: true, targetId: TARGET, project: 'vibe2'});
  expect(focused).toEqual([TARGET]);
  await expect(binding.run('open_project', {targetId: TARGET, agent: 'claude'}, crypto.randomUUID())).rejects.toThrow('허용되지 않은');
  await expect(binding.run('open_project', {targetId: 'not a target id'}, crypto.randomUUID())).rejects.toThrow();
  expect(focused).toEqual([TARGET]);
});

test('open_project respects the remote grant and exists only where the host can navigate', async () => {
  const focused: string[] = [];
  const remote = await bindVoiceRuntime(deps(focused), {kind: 'ops'}, {owner: 'remote-device', active: () => true, allowedTargets: new Set(['ops-project-1234'])});
  await expect(remote.run('open_project', {targetId: TARGET}, crypto.randomUUID())).rejects.toThrow('허용된 프로젝트');
  expect(focused).toEqual([]);
  // Without the host dependency (an older host wiring) the tool is not offered at all.
  const withoutHost = await bindVoiceRuntime(deps(focused, {focusProject: undefined}), {kind: 'ops'}, authority);
  expect(withoutHost.tools.some(candidate => candidate.name === 'open_project')).toBe(false);
});

test('the OPS voice guidance routes 「열어/보여줘」 to open_project and 「담당자 불러/연결」 to connect_project_delegate', () => {
  expect(VOICE_TARGET_CALL_GUIDANCE).toContain('“<프로젝트> 열어”, “<프로젝트> 보여줘”는 resolve_target_alias로 확정한 뒤 open_project');
  expect(VOICE_TARGET_CALL_GUIDANCE).toContain('“<프로젝트> 담당자 불러줘”, “<프로젝트> 담당자 연결해”');
  expect(VOICE_TARGET_CALL_GUIDANCE).toContain('connect_project_delegate');
  // App, folder and dashboard openings still go to the OPS workroom.
  expect(VOICE_TARGET_CALL_GUIDANCE).toContain('prepare_ops_instruction');
});
