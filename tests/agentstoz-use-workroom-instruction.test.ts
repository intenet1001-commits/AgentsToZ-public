import {afterEach, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {AiTerminalService} from '../src/aiTerminalService';
import {AgentsToZUseControlError} from '../src/agentstozUseControl';
import {AGENTSTOZ_USE_SUBMISSION_OWNER, deliverAgentsToZUseWorkroomInstruction} from '../src/agentstozUseWorkroomInstruction';

// S3-9: agentstoz_use instructions (send_workroom_instruction, start_workroom_session reuse+instruction) go
// through the host-only whole-request submission when this Mac has it: one durable receipt per requestId and
// session, never typed twice, and an outcome that is not `written` is reported as unknown (409), never retyped.
const dirs: string[] = [], stores: WorkroomConversationJournal[] = [], services: AiTerminalService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => {});
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

async function host(options: {submissions: boolean; corrections?: (cwd: string, targetId: string, text: string) => Promise<any>}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-instruction-')); chmodSync(dir, 0o700); dirs.push(dir);
  const store = new WorkroomConversationJournal(dir); stores.push(store);
  const writes: string[] = [];
  const control = {short: false};
  let finish!: (code: number) => void, exit: () => void = () => {};
  const service = new AiTerminalService({
    ...(options.submissions ? {submissions: () => store} : {}),
    ...(options.corrections ? {corrections: options.corrections} : {}),
    headlessScreen: false, resolveTarget: async () => ({cwd: dir}), executable: () => '/fixture/harmless',
    signalGroup: () => {exit(); finish(0);},
    spawn: (_args, spawnOptions) => {
      exit = (spawnOptions.terminal as {exit(): void}).exit;
      return {pid: 999999999, exited: new Promise<number>(resolve => {finish = resolve;}), kill: () => {},
        terminal: {write: (text: string) => {writes.push(text); return control.short ? 0 : Buffer.byteLength(text);}, resize: () => {}, close: () => {exit(); finish(0);}}};
    },
  });
  services.push(service);
  const session = (await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'fixture-project', agent: 'hermes', cols: 80, rows: 24})).session!;
  return {service, session, writes, control};
}

test('(1) the same requestId twice writes once, with a written receipt in the agentstoz_use namespace', async () => {
  const {service, session, writes} = await host({submissions: true});
  const input = {submissionId: 'sendsub_fixture_request_1', rawRequestId: 'fixture-mcp-request-1', sessionId: session.id, data: 'run the tests\r'};
  const first = await deliverAgentsToZUseWorkroomInstruction(service, input);
  expect(first).toMatchObject({delivered: true, via: 'submission', session: {id: session.id}});
  const second = await deliverAgentsToZUseWorkroomInstruction(service, input);
  expect(second).toMatchObject({delivered: true, via: 'submission'});
  expect(writes.join('')).toBe('run the tests\r');
  const status = await service.perform({operation: 'submission', requestId: crypto.randomUUID(), sessionId: session.id, submission: {phase: 'status', id: input.submissionId}}, undefined, {receiptOwner: AGENTSTOZ_USE_SUBMISSION_OWNER});
  expect(status.submission?.state).toBe('written');
  // Kept apart from this Mac's composer receipts.
  await expect(service.perform({operation: 'submission', requestId: crypto.randomUUID(), sessionId: session.id, submission: {phase: 'status', id: input.submissionId}})).rejects.toThrow();
  // The raw input path was not used: no input request carried the MCP requestId.
  expect(service.hasLocalRequest(input.rawRequestId)).toBe(false);
});

test('(2) an outcome that is not written is 409 AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN and a retry never writes again', async () => {
  const {service, session, writes, control} = await host({submissions: true});
  control.short = true;
  const input = {submissionId: 'sendsub_fixture_request_2', rawRequestId: 'fixture-mcp-request-2', sessionId: session.id, data: 'do not replay\r'};
  const failure = await deliverAgentsToZUseWorkroomInstruction(service, input).catch(error => error);
  expect(failure).toBeInstanceOf(AgentsToZUseControlError);
  expect(failure).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN', status: 409, details: {sessionId: session.id, submissionState: 'unknown'}});
  const count = writes.length;
  control.short = false;
  const retried = await deliverAgentsToZUseWorkroomInstruction(service, input).catch(error => error);
  expect(retried).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_REUSE_OUTCOME_UNKNOWN', status: 409});
  expect(writes.length).toBe(count);
});

test('(2) a refusal before anything was written is reported as itself, not as an unknown outcome', async () => {
  const {service, session, writes} = await host({submissions: true});
  const input = {submissionId: 'sendsub_fixture_request_3', rawRequestId: 'fixture-mcp-request-3', sessionId: session.id, data: 'first line\nsecond line\r'};
  const failure = await deliverAgentsToZUseWorkroomInstruction(service, input).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure.message)).toContain('여러 줄');
  // Not an unknown outcome: nothing was typed. The same requestId keeps answering this refusal (its derived
  // request IDs are fenced), so the error says so and asks for a new requestId instead of inviting a retry.
  expect(failure).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_INSTRUCTION_NOT_SENT', status: 409, details: {sessionId: session.id, written: false}});
  expect(String(failure.message)).toContain('새 requestId');
  const retried = await deliverAgentsToZUseWorkroomInstruction(service, input).catch(error => error);
  expect(retried).toMatchObject({code: 'AGENTSTOZ_USE_WORKROOM_INSTRUCTION_NOT_SENT'});
  expect(writes).toEqual([]);
});

test('(3) a host without whole-request submission keeps the raw input path unchanged', async () => {
  const {service, session, writes} = await host({submissions: false});
  const input = {submissionId: 'sendsub_fixture_request_4', rawRequestId: 'fixture-mcp-request-4', sessionId: session.id, data: 'run the tests\r'};
  const result = await deliverAgentsToZUseWorkroomInstruction(service, input);
  expect(result).toMatchObject({delivered: true, via: 'input', session: {id: session.id}});
  expect(writes.join('')).toBe('run the tests\r');
  expect(service.hasLocalRequest(input.rawRequestId)).toBe(true);
  await deliverAgentsToZUseWorkroomInstruction(service, input);
  expect(writes.join('')).toBe('run the tests\r');
});

test('(1) the same requestId with a different instruction is refused and nothing more is typed', async () => {
  const {service, session, writes} = await host({submissions: true});
  const input = {submissionId: 'sendsub_fixture_request_5', rawRequestId: 'fixture-mcp-request-5', sessionId: session.id, data: 'first\r'};
  await deliverAgentsToZUseWorkroomInstruction(service, input);
  await expect(deliverAgentsToZUseWorkroomInstruction(service, {...input, data: 'second\r'})).rejects.toThrow('같은 요청 ID');
  expect(writes.join('')).toBe('first\r');
});

test('(review) an agentstoz_use instruction is typed exactly as given: no correction suffix, and no correction lookup to refuse it', async () => {
  const calls: string[] = [];
  const guidance = {text: '[관련 프로젝트 교정 · fixture]', exposure: {memoryId: 'm', contextHash: 'h', sourceWithheld: false, entries: []}, validate() {}};
  const {service, session, writes} = await host({submissions: true, corrections: async (_cwd, _target, text) => {calls.push(text); return guidance;}});
  await deliverAgentsToZUseWorkroomInstruction(service, {submissionId: 'sendsub_fixture_request_6', rawRequestId: 'fixture-mcp-request-6', sessionId: session.id, data: '/compact\r'});
  expect(writes.join('')).toBe('/compact\r');
  expect(calls).toEqual([]);
  // An unreadable correction journal does not refuse it either (the raw path never consulted it).
  const failing = await host({submissions: true, corrections: async () => {throw new Error('교정 기록을 읽지 못해 요청을 보내지 않았습니다.');}});
  await deliverAgentsToZUseWorkroomInstruction(failing.service, {submissionId: 'sendsub_fixture_request_7', rawRequestId: 'fixture-mcp-request-7', sessionId: failing.session.id, data: 'run the tests\r'});
  expect(failing.writes.join('')).toBe('run the tests\r');
  // This Mac's own composer submissions keep their correction context.
  const composer = await host({submissions: true, corrections: async () => guidance});
  const bytes = Buffer.from('fix it\r');
  const digest = (await import('../src/workroomSubmissionProtocol')).submissionDigest(bytes);
  await composer.service.perform({operation: 'submission', requestId: crypto.randomUUID(), sessionId: composer.session.id, submission: {phase: 'single', id: 'composer_fixture_1', bytes: bytes.length, digest, data: bytes.toString('base64')}});
  expect(composer.writes.join('')).toContain('[관련 프로젝트 교정 · fixture]');
});
