import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {COMPUTER_USE_APPROVAL_LIMITS, ComputerApprovalVerifier} from '../src/computerUseApproval';
import {ComputerCallerRegistry, computerCallerGeneration} from '../src/computerUseCaller';
import {ComputerUseHost, type ComputerWorkerContext} from '../src/computerUseHost';
import {nativeComputerWorker} from '../src/computerUseNative';
import {parseComputerAgentRequest, parseComputerCaller, parseComputerTarget} from '../src/computerUseProtocol';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {testApprovalHelper, testComputerUseHost} from './computer-use-test-helper';

// The core hooks AgentsToZ Control's native adapter depends on (native/computer-use/CONTRACT.md section 10), and the
// values the TypeScript host produces checked against the shared XPC contract samples the Swift checks also read.
const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'native', 'computer-use', 'Tests', 'ControlContract', 'requests.json'), 'utf8'));
const target = {bundleId:'com.example.editor', teamId:'ABCDEFGHIJ', codeHash:'ab'.repeat(20), pid:100, processStart:'9007199254740995', windowId:321};
const issue = (sessionId = 'workroom_session_a', lane = 'leader') => {
  const registry = new ComputerCallerRegistry();
  return {registry, caller: registry.authenticate(registry.issue({sessionId, lane}))!};
};
const bound = {success:true, bound:true, protocolVersion:2};

describe('AgentsToZ Control core hooks', () => {
  test('a worker is created only after the signature check, for the redeemed approval, credential and target', async () => {
    const contexts: ComputerWorkerContext[] = [];
    const f = testComputerUseHost({createWorker: async (context: ComputerWorkerContext) => {contexts.push(context);
      return {close() {}, request: async () => bound};}});
    const {caller} = issue();
    const request = f.host.requestApproval(caller, target, 'Edit draft');
    // A forged or mismatched approval never reaches the factory.
    await expect(f.host.grant({...f.helper.approve(request), signature:Buffer.alloc(70).toString('base64')})).rejects.toThrow();
    await expect(f.host.grant(f.helper.approve(request, {caller:{sessionId:'workroom_session_a', lane:'member-2'}}))).rejects.toThrow();
    expect(contexts).toHaveLength(0);
    await f.host.grant(f.helper.approve(request));
    expect(contexts).toEqual([{approvalId:request.approvalId, caller:{sessionId:'workroom_session_a', lane:'leader'},
      generation:computerCallerGeneration(caller)!, target}]);
    const [context] = contexts;
    // The values match the formats AgentsToZ Control decodes.
    expect(context?.approvalId).toMatch(/^[a-f0-9]{64}$/);
    expect(context?.generation).toMatch(/^[a-f0-9]{32}$/);
    expect(request.expiresAt - Date.now()).toBeLessThanOrEqual(COMPUTER_USE_APPROVAL_LIMITS.approvalMs + COMPUTER_USE_APPROVAL_LIMITS.skewMs);
  });

  test('a known pre-dispatch bind refusal preserves approval, and simultaneous binds spend it only once', async () => {
    let workers=0,release!:()=>void;
    const gate=new Promise<void>(r=>{release=r;});
    const f=testComputerUseHost({createWorker:async()=>{
      const index=++workers;
      if(index===2)await gate;
      return {close(){},request:async()=>index===1?{success:false,notDispatched:true,code:'native-busy'}:bound};
    }});
    const {caller}=issue(),approval=f.helper.approve(f.host.requestApproval(caller,target,'Edit draft'));
    await expect(f.host.grant(approval)).rejects.toMatchObject({notDispatched:true});
    expect(f.host.list()).toHaveLength(0);
    const second=f.host.grant(approval);
    await expect(f.host.grant(approval)).rejects.toThrow('연결 준비가 진행 중');
    expect(workers).toBe(2);release();expect((await second).success).toBe(true);
    await expect(f.host.grant(approval)).rejects.toThrow('이미 사용한 승인');
    expect(workers).toBe(2);f.host.dispose();
  });

  test('a change carries the ledger request ID to the worker, nothing else new', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = testComputerUseHost({createWorker: async () => ({close() {}, async request(body) {bodies.push(body);
      if (body.operation === 'bind') return bound;
      if (body.operation === 'observe') return {success:true, snapshotId:'ps1_exact', truncated:false,
        elements:[{id:'elem_1', role:'button', label:'Send', value:'', enabled:true, settable:false}]};
      return {success:true, outcome:{state:'confirmed_change'}, humanStatePreserved:true};}})});
    const {caller} = issue();
    const g = await f.grantFor(caller, target);
    const obs = await f.host.agent(caller, {grant:g.grant, epoch:g.epoch, operation:'observe'});
    const answer = await f.host.agent(caller, {grant:g.grant, epoch:g.epoch, operation:'press', requestId:'press_request_01',
      observationId:obs.observationId, element:'elem_1'});
    expect(answer.receipt).toEqual({requestId:'press_request_01', state:'confirmed'});
    expect(bodies.at(-1)).toEqual({operation:'press', requestId:'press_request_01', snapshotId:'ps1_exact', element:'elem_1'});
  });
});

describe('deferred helper key (AgentsToZ Control creates it at the first human approval)', () => {
  test('requests open before any key exists; the key is read only at the signature check of a first approval', () => {
    const helper = testApprovalHelper();
    let point: Uint8Array | undefined, reads = 0;
    const verifier = new ComputerApprovalVerifier({helperPublicKey: () => {reads++; if (!point) throw Error('no approval yet'); return point;}});
    const {caller} = issue();
    const request = verifier.request(caller, target, 'Edit draft');
    expect(reads).toBe(0);
    // Before Control answered with its key: refused, and the request is kept for the real answer.
    expect(() => verifier.redeem(helper.approve(request))).toThrow('승인 키를 확인하지 못해');
    expect(reads).toBe(1);
    point = helper.publicKey;
    const redeemed = verifier.redeem(helper.approve(request));
    expect(redeemed).toMatchObject({approvalId:request.approvalId, generation:computerCallerGeneration(caller)!, label:'Edit draft'});
    expect(reads).toBe(2);
    // One use, whatever the key does afterwards.
    expect(() => verifier.redeem(helper.approve(request))).toThrow('이미 사용한 승인');
  });

  test('a key that cannot be read, does not parse or does not match refuses, and no earlier check is skipped', () => {
    const helper = testApprovalHelper(), other = testApprovalHelper();
    let source: () => unknown = () => {throw Error('link lost');};
    let reads = 0;
    const verifier = new ComputerApprovalVerifier({helperPublicKey: () => {reads++; return source() as Uint8Array;}});
    const {caller} = issue();
    const request = verifier.request(caller, target, 'Edit draft');
    // Booleans, unknown requests, other callers, other targets and lifetimes are refused before any key is read.
    expect(() => verifier.redeem(true)).toThrow('사람 승인 서명이 필요합니다');
    expect(() => verifier.redeem(helper.approve({...request, approvalId:'cd'.repeat(32)}))).toThrow('요청이 없습니다');
    expect(() => verifier.redeem(helper.approve(request, {caller:{sessionId:'workroom_session_a', lane:'member-2'}}))).toThrow('작업 세션이 요청과 다릅니다');
    expect(() => verifier.redeem(helper.approve(request, {target:{...target, windowId:322}}))).toThrow('대상이나 작업 세션');
    expect(() => verifier.redeem(helper.approve(request, {expiresAt:request.expiresAt + 1}))).toThrow('승인 시간');
    expect(reads).toBe(0);
    for (const broken of [() => {throw Error('link lost');}, () => new Uint8Array(65), () => 'BJ' as unknown, () => undefined]) {
      source = broken;
      expect(() => verifier.redeem(helper.approve(request))).toThrow('승인 키를 확인하지 못해');
    }
    source = () => other.publicKey;
    expect(() => verifier.redeem(helper.approve(request))).toThrow('사람 승인을 확인하지 못했습니다');
    // None of these consumed the request; the genuine key still redeems it once.
    source = () => helper.publicKey;
    expect(verifier.redeem(helper.approve(request)).approvalId).toBe(request.approvalId);
  });

  test('a host with a deferred key makes no worker until the key and signature check pass', async () => {
    const helper = testApprovalHelper();
    let point: Uint8Array | undefined, workers = 0;
    const approvals = new ComputerApprovalVerifier({helperPublicKey: () => {if (!point) throw Error('no key'); return point;}});
    const host = new ComputerUseHost({approvals, recovery:new ComputerUseRecovery(':memory:'),
      createWorker: async () => {workers++; return {close() {}, request: async () => bound};}});
    const {caller} = issue();
    const request = host.requestApproval(caller, target, 'Edit draft');
    await expect(host.grant(helper.approve(request))).rejects.toThrow('승인 키를 확인하지 못해');
    expect(workers).toBe(0);
    point = helper.publicKey;
    const granted = await host.grant(helper.approve(request));
    expect(granted.success).toBe(true);
    expect(workers).toBe(1);
  });

  test('a fixed key is still parsed when the verifier is made', () => {
    expect(() => new ComputerApprovalVerifier({helperPublicKey:new Uint8Array(65)})).toThrow();
    expect(() => new ComputerApprovalVerifier({helperPublicKey:testApprovalHelper().publicKey})).not.toThrow();
  });
});

describe('the shared XPC samples', () => {
  test('hold values the TypeScript host accepts and produces', () => {
    const open = contract.valid.agent['open-grant'];
    expect(parseComputerTarget(open.target)).toEqual(contract.inputs.target);
    expect(parseComputerCaller({sessionId:open.caller.sessionId, lane:open.caller.lane})).toEqual(contract.inputs.caller);
    expect(open.caller.generation).toMatch(/^[a-f0-9]{32}$/);
    const press = contract.valid.agent.press;
    expect(() => parseComputerAgentRequest({grant:'ab'.repeat(32), epoch:1, operation:'press', requestId:press.requestId,
      observationId:'observation_01', element:press.element})).not.toThrow();
    expect(() => parseComputerAgentRequest({grant:'ab'.repeat(32), epoch:1, operation:'receipt', requestId:'short'})).toThrow();
    // The engine only on the agent path; catalog, the approval list and withdrawals only for a person's management UI.
    const agent = Object.keys(contract.valid.agent), management = Object.keys(contract.valid.management);
    for (const op of ['open-grant', 'observe', 'capture', 'click', 'press', 'set-value', 'receipt']) {
      expect(agent).toContain(op); expect(management).not.toContain(op);
    }
    for (const op of ['catalog', 'approvals', 'cancel-approval']) {expect(management).toContain(op); expect(agent).not.toContain(op);}
    expect(contract.valid.agent['disconnect-owner']).toEqual({v:1, channel:'agent', op:'disconnect-owner'});
    expect(contract.valid.management['disconnect-owner']).toEqual({v:1, channel:'management', op:'disconnect-owner'});
  });

  // The adapter's requests, after the Rust bridge's own mapping (operation→op, plus v and channel; pinned against the
  // same samples in computer_use_bridge.rs), are exactly the samples the Swift checks decode. Field names cannot drift.
  const bridged = ({operation, ...rest}: Record<string, unknown>) => ({v:1, channel:'agent', op:operation, ...rest});
  test('the native adapter sends exactly the agent samples, capture and click included', async () => {
    const sent: Record<string, unknown>[] = [];
    const reply: Record<string, Record<string, unknown>> = {'open-grant':contract.replies['open-grant'], capture:contract.replies.capture,
      click:contract.replies.click, press:contract.replies.click, 'set-value':contract.replies.click, observe:{success:true, halted:false},
      receipt:{success:true, halted:false}};
    const channel = {available:true, dispose() {}, async request(body: Record<string, unknown>) {sent.push(body); return reply[String(body.operation)]!;}};
    const {inputs} = contract;
    const worker = nativeComputerWorker(channel, {approvalId:inputs.approvalId, caller:inputs.caller, generation:inputs.generation, target:inputs.target});
    expect(await worker.request({operation:'bind', target:inputs.target})).toEqual({success:true, bound:true, protocolVersion:2});
    expect(worker.supports?.('capture')).toBe(true);
    const click = contract.valid.agent.click;
    expect(await worker.request({operation:'capture', snapshotId:inputs.snapshotId})).toEqual(contract.replies.capture);
    expect(await worker.request({operation:'click', requestId:inputs.requestId, snapshotId:inputs.snapshotId, x:click.x, y:click.y}))
      .toEqual(contract.replies.click);
    await worker.request({operation:'observe'});
    await worker.request({operation:'press', requestId:inputs.requestId, snapshotId:inputs.snapshotId, element:inputs.element});
    await worker.request({operation:'set-value', requestId:inputs.requestId, snapshotId:inputs.snapshotId, element:inputs.element, value:inputs.value});
    await worker.request({operation:'receipt', requestId:inputs.requestId});
    // The sample's grant is the one open-grant answered with; every later request carries it.
    expect(sent.map(bridged)).toEqual(['open-grant', 'capture', 'click', 'observe', 'press', 'set-value', 'receipt'].map(op => contract.valid.agent[op]));
  });

  test('the shared reply samples are what the TypeScript host accepts for capture and click', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = testComputerUseHost({createWorker: async () => ({close() {}, supports: () => true, async request(body) {bodies.push(body);
      if (body.operation === 'bind') return bound;
      if (body.operation === 'observe') return {success:true, snapshotId:contract.inputs.snapshotId, truncated:false,
        elements:[{id:contract.inputs.element, role:'AXButton', label:'Send', value:'', enabled:true, settable:false}]};
      return contract.replies[String(body.operation)];}})});
    const {caller} = issue();
    const g = await f.grantFor(caller, target);
    const obs = await f.host.agent(caller, {grant:g.grant, epoch:g.epoch, operation:'observe'});
    const captured = await f.host.agent(caller, {grant:g.grant, epoch:g.epoch, operation:'capture', observationId:obs.observationId});
    const {success, halted, ...image} = contract.replies.capture;
    expect(success && !halted).toBe(true);
    expect(captured).toEqual({success:true, observationId:obs.observationId, image});
    const clicked = await f.host.agent(caller, {grant:g.grant, epoch:g.epoch, operation:'click', requestId:contract.inputs.requestId,
      observationId:obs.observationId, x:contract.valid.agent.click.x, y:contract.valid.agent.click.y});
    expect(clicked).toEqual({success:true, receipt:{requestId:contract.inputs.requestId, state:'confirmed'}});
    expect(bodies.at(-1)).toEqual({operation:'click', requestId:contract.inputs.requestId, snapshotId:contract.inputs.snapshotId,
      x:contract.valid.agent.click.x, y:contract.valid.agent.click.y});
    f.host.dispose();
  });
});
