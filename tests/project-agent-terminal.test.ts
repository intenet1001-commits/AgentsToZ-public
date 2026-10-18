import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProjectAgentTerminal, WorkroomConversationJournal} from '../packages/runtime-sdk';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {for (const clean of cleanups.splice(0).reverse()) await clean();});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-agent-terminal-'));
  const journal = new WorkroomConversationJournal(root);
  const mode = createWorkroomEffortSetting(root);
  const launches: string[][] = [], writes: string[] = [], controls: string[] = [];
  let frame: (value: string) => void = () => {};
  const service = createProjectAgentTerminal({appDataDir: root, dependencies: {
    submissions: () => journal,
    resolveTarget: async id => {if (id !== 'registered-project') throw Error('unregistered'); return {cwd: root};},
    executable: () => '/fixture/codex',
    codexEffortModel: () => ({ok: true, model: 'gpt-6.1-sol', allowed: ['low','medium','high']}),
    activitySampler: false,
    effortRuntimeSupport: () => ({claudeSessionPicker: true, codexDefaultKeys: true}),
    effortRuntime: async control => {controls.push(control.level); await control.write('native-effort:' + control.level); return 'applied';},
    spawn: (args, options: any) => {
      launches.push(args);
      let exited!: (code: number) => void;
      const exit = new Promise<number>(resolve => {exited = resolve;});
      frame = value => options.terminal.data(null, new TextEncoder().encode(value));
      const level = args.find(arg => arg.startsWith('model_reasoning_effort='))?.match(/"(\w+)"/)?.[1] ?? 'medium';
      queueMicrotask(() => frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol ' + level + '\r\n› '));
      return {pid: 700002, exited: exit, kill: () => exited(143), terminal: {
        write: (text: string) => {writes.push(text); if (text.startsWith('native-effort:')) frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol ' + text.split(':')[1] + '\r\n› '); return Buffer.byteLength(text);},
        resize() {}, close() {exited(0);},
      }} as any;
    },
  }});
  cleanups.push(async () => {await service.shutdown(); journal.close(); rmSync(root, {recursive: true, force: true});});
  return {service, mode, launches, writes, controls};
}

test('a Workroom-free external CLI host reads the same mode at launch and before later requests', async () => {
  const f = fixture();
  const started = await f.service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'registered-project', agent: 'codex', prompt: '문구만 수정', cols: 100, rows: 28});
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(f.launches[0]).toContain('model_reasoning_effort="low"');
  const send = (text: string) => f.service.submitHostInstruction({id: crypto.randomUUID(), sessionId: started.session!.id, data: text + '\r', receiptOwner: 'external-cli', active: () => true});
  await send('보안 설계 검토');
  expect(f.controls).toEqual(['high']);
  f.mode.setMode!('recommend');
  await send('오타 수정');
  expect(f.controls).toEqual(['high']);
  f.mode.setMode!('off');
  await send('오타 수정');
  expect(f.controls).toEqual(['high']);
  expect(f.writes.some(value => value.includes('오타 수정'))).toBe(true);
});

test('external registered-project terminals preserve native manual effort selection', async () => {
  const f = fixture();
  const started = await f.service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'registered-project', agent: 'codex', prompt: '일반 작업', cols: 100, rows: 28});
  await new Promise(resolve => setTimeout(resolve, 10));
  await f.service.perform({operation: 'input', requestId: crypto.randomUUID(), sessionId: started.session!.id, data: '/model\r'});
  await f.service.submitHostInstruction({id: crypto.randomUUID(), sessionId: started.session!.id, data: '보안 검토\r', receiptOwner: 'external-cli', active: () => true});
  expect(f.controls).toEqual([]);
});

test('the external factory cannot start a CLI for a project its host has not registered', async () => {
  const f = fixture();
  await expect(f.service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'unknown-project', agent: 'codex', prompt: '작업', cols: 100, rows: 28})).rejects.toThrow('unregistered');
  expect(f.launches).toEqual([]);
});
