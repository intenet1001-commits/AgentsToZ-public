import {expect, test} from 'bun:test';
import {createTeamExternalRuntime, TeamExternalRuntimeError, type TeamExternalCreatePlan, type TeamExternalJournal,
  type TeamExternalJournalRecord, type TeamExternalLaunchInput, type TeamExternalNativeRef, type TeamExternalPreparedPlan,
  type TeamExternalProbe, type TeamExternalRuntimeDeps, type TeamExternalSurface, type TeamExternalTargetPlan} from '../src/teamExternalRuntime';

const clone = <T>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
const input = (extra: Partial<TeamExternalLaunchInput> = {}): TeamExternalLaunchInput => ({executionId: 'exec-one', hostInstanceId: 'host-one',
  teamId: 'team-one', memberId: 'm1', targetId: 'rwt-member', cwd: '/repo/worktrees/member', generation: 1, agent: 'claude',
  surface: 'orca-worktree', operationId: 'launch-one', title: 'Member one', prompt: 'Implement the member task.', requested: {}, ...extra});
function nativeFor(plan: TeamExternalCreatePlan): TeamExternalNativeRef {
  const common = {hostInstanceId: plan.scope.hostInstanceId, runtimeInstanceId: 'external-runtime-one', cwd: plan.scope.cwd, agent: plan.scope.agent, owned: true};
  return plan.kind === 'orca-create' ? {...common, kind: 'orca', terminalHandle: 'orca:terminal:exact-one', worktreeId: plan.worktreeSelector}
    : {...common, kind: 'cmux', workspaceId: 'workspace-exact', surfaceId: 'surface-exact'};
}
function fixture(overrides: Partial<TeamExternalRuntimeDeps> = {}) {
  const records = new Map<string, TeamExternalJournalRecord>();
  const journal: TeamExternalJournal = {
    read: async id => clone(records.get(id) ?? null),
    compareAndSet: async (id, revision, next) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false;
      records.set(id, clone(next)); return true;
    },
  };
  const calls = {prepare: 0, create: [] as TeamExternalCreatePlan[], manual: 0, submit: [] as Array<TeamExternalTargetPlan & {text: string}>,
    read: [] as Array<TeamExternalTargetPlan & {cursor?: string; limit: number}>, reveal: [] as TeamExternalTargetPlan[], close: [] as TeamExternalTargetPlan[]};
  let current = true, native: TeamExternalNativeRef | null = null;
  const deps: TeamExternalRuntimeDeps = {journal, isCurrent: () => current,
    prepare: async request => {
      calls.prepare++;
      const applied: TeamExternalPreparedPlan['applied'] = {};
      for (const key of ['model', 'provider', 'accountId', 'effort', 'bypassPermissions'] as const) {
        if (request.requested[key] !== undefined) applied[key] = {mode: 'automatic', evidence: 'launch-argument'};
      }
      for (const key of ['bgMode', 'tmuxMode', 'reuse', 'appMode'] as const) {
        if (request.requested.launchOptions?.[key] !== undefined) applied[`launchOptions.${key}`] = {mode: 'automatic', evidence: 'launch-argument'};
      }
      return {kind: 'managed', planId: 'validated-host-plan', initialPrompt: 'launch', capabilityRevision: 'orca-public-cli-v1', applied,
        capabilities: {probe: true, read: true, submit: true, reveal: true, close: true}};
    },
    create: async plan => {calls.create.push(clone(plan)); native = nativeFor(plan); return {native, delivery: {outcome: 'written'}};},
    launchManual: async request => {calls.manual++; native = {kind: 'manual', launcherId: 'app-exact', hostInstanceId: request.scope.hostInstanceId, runtimeInstanceId: 'app-launch-one',
      cwd: request.scope.cwd, agent: request.scope.agent, owned: false}; return {opened: true, native, instruction: 'prefill-requested'};},
    probe: async () => ({native: native!, connection: 'connected', agentVerified: true, activity: 'idle'}),
    read: async plan => {calls.read.push(clone(plan)); return {native: native!, text: 'member output', cursor: 'cursor-next'};},
    submit: async plan => {calls.submit.push(clone(plan)); return {outcome: 'written'};},
    reveal: async plan => {calls.reveal.push(clone(plan));},
    close: async plan => {calls.close.push(clone(plan)); return {closed: true};},
    ...overrides,
  };
  return {records, journal, calls, deps, runtime: createTeamExternalRuntime(deps), setCurrent: (value: boolean) => {current = value;},
    setNative: (value: TeamExternalNativeRef) => {native = value;}};
}

test('Orca launches the existing member checkout, persists before create, and never resends its launch prompt', async () => {
  const fake = fixture();
  const create = fake.deps.create;
  fake.deps.create = async plan => {
    const saved = fake.records.get(plan.scope.executionId)!;
    expect(saved.operations[0]?.status).toBe('reserved'); expect(saved.receipt.instruction.status).toBe('sending');
    expect(saved.receipt.requested).toEqual({bypassPermissions: false});
    return create(plan);
  };
  const receipt = await fake.runtime.launch(input());
  expect(fake.calls.create).toEqual([{kind: 'orca-create', operationId: 'launch-one', scope: inputScope(), planId: 'validated-host-plan',
    title: 'Member one', initialPrompt: 'Implement the member task.', worktreeSelector: 'path:/repo/worktrees/member'}]);
  expect(receipt.state).toBe('awaiting-ack'); expect(receipt.instruction.status).toBe('written');
  expect(receipt.applied.bypassPermissions).toEqual({mode: 'automatic', evidence: 'launch-argument'});
  expect(await fake.runtime.launch(input())).toEqual(receipt);
  expect(await fake.runtime.submit(receipt.executionRef, {operationId: 'submit-another', text: input().prompt})).toEqual(receipt);
  expect(fake.calls.create).toHaveLength(1); expect(fake.calls.submit).toHaveLength(0);
  expect(JSON.stringify(receipt)).not.toContain('Implement the member task.');
});
function inputScope() {
  const {operationId: _operationId, requested: _requested, title: _title, prompt: _prompt, ...scope} = input();
  return scope;
}

test('a successful reveal persists its own performed outcome and replays without a second external write', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  await fake.runtime.reveal(receipt.executionRef, 'reveal-success');
  const operation = () => fake.records.get('exec-one')!.operations.find(item => item.id === 'reveal-success')!;
  expect(operation()).toMatchObject({kind: 'reveal', status: 'settled', outcome: 'performed'});
  await fake.runtime.probe(receipt.executionRef);
  await createTeamExternalRuntime(fake.deps).reveal(receipt.executionRef, 'reveal-success');
  expect(operation().outcome).toBe('performed'); expect(fake.calls.reveal).toHaveLength(1);
  expect(fake.records.get('exec-one')!.operations.find(item => item.kind === 'launch')!.outcome).toBeUndefined();
});

test('a failed reveal stays unknown after probe recovery and same-ID replay, including a restarted runtime', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  fake.deps.reveal = async plan => {fake.calls.reveal.push(clone(plan)); throw Error('private command/brief is not evidence');};
  expect((await fake.runtime.reveal(receipt.executionRef, 'reveal-failed')).state).toBe('unknown');
  const operation = () => fake.records.get('exec-one')!.operations.find(item => item.id === 'reveal-failed')!;
  expect(operation()).toMatchObject({status: 'settled', outcome: 'unknown'});
  expect((await fake.runtime.probe(receipt.executionRef)).state).toBe('awaiting-ack');
  const restarted = createTeamExternalRuntime(fake.deps);
  expect((await restarted.reveal(receipt.executionRef, 'reveal-failed')).state).toBe('awaiting-ack');
  expect(operation().outcome).toBe('unknown'); expect(fake.calls.reveal).toHaveLength(1);
});

test('an old settled reveal without outcome is never upgraded by a fresh probe or replay', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  await fake.runtime.reveal(receipt.executionRef, 'legacy-reveal');
  const operation = fake.records.get('exec-one')!.operations.find(item => item.id === 'legacy-reveal')!;
  delete operation.outcome; // The exact shape an earlier v1 host persisted, success and failure indistinguishable.
  await fake.runtime.probe(receipt.executionRef);
  await createTeamExternalRuntime(fake.deps).reveal(receipt.executionRef, 'legacy-reveal');
  expect(fake.records.get('exec-one')!.operations.find(item => item.id === 'legacy-reveal')!.outcome).toBeUndefined();
  expect(fake.calls.reveal).toHaveLength(1);
});

test('late generation change prevents a completed callback from persisting performed evidence', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  fake.deps.reveal = async plan => {fake.calls.reveal.push(clone(plan)); fake.setCurrent(false);};
  const late = await fake.runtime.reveal(receipt.executionRef, 'late-reveal');
  expect(late.state).toBe('unknown'); expect(late.reason).toBe('EXTERNAL_GENERATION_STALE'); expect(late.retainWorktree).toBe(true);
  expect(fake.records.get('exec-one')!.operations.find(item => item.id === 'late-reveal')).toMatchObject({status: 'settled', outcome: 'unknown'});
  fake.setCurrent(true); await fake.runtime.probe(receipt.executionRef);
  await fake.runtime.reveal(receipt.executionRef, 'late-reveal');
  expect(fake.records.get('exec-one')!.operations.find(item => item.id === 'late-reveal')!.outcome).toBe('unknown');
  expect(fake.calls.reveal).toHaveLength(1);
});

test('a lost outcome CAS leaves the reservation unconfirmed and never repeats the reveal', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()), save = fake.deps.journal.compareAndSet;
  fake.deps.journal.compareAndSet = async (id, revision, next) => next.operations.some(item => item.id === 'lost-cas' && item.status === 'settled')
    ? false : save(id, revision, next);
  await fake.runtime.reveal(receipt.executionRef, 'lost-cas');
  const operation = () => fake.records.get('exec-one')!.operations.find(item => item.id === 'lost-cas')!;
  expect(operation()).toMatchObject({status: 'reserved'}); expect(operation().outcome).toBeUndefined();
  await fake.runtime.probe(receipt.executionRef); await fake.runtime.reveal(receipt.executionRef, 'lost-cas');
  expect(operation().outcome).toBeUndefined(); expect(fake.calls.reveal).toHaveLength(1);
});

test('a throwing outcome write cannot leak performed evidence and remains reserved if persistence stays unavailable', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()), save = fake.deps.journal.compareAndSet;
  fake.deps.journal.compareAndSet = async (id, revision, next) => {
    if (next.operations.some(item => item.id === 'disk-failed' && item.status === 'settled')) throw Error('disk unavailable');
    return save(id, revision, next);
  };
  await expect(fake.runtime.reveal(receipt.executionRef, 'disk-failed')).rejects.toThrow('disk unavailable');
  expect(fake.records.get('exec-one')!.operations.find(item => item.id === 'disk-failed')).toMatchObject({status: 'reserved'});
  expect(fake.records.get('exec-one')!.operations.find(item => item.id === 'disk-failed')!.outcome).toBeUndefined();
  await fake.runtime.reveal(receipt.executionRef, 'disk-failed'); expect(fake.calls.reveal).toHaveLength(1);
});

test('floating uses the global terminal context and still binds the exact member cwd; only actual turn proof is working', async () => {
  const fake = fixture();
  const create = fake.deps.create;
  fake.deps.create = async plan => ({...await create(plan), delivery: {outcome: 'written', turnStarted: true}});
  const receipt = await fake.runtime.launch(input({surface: 'orca-floating'}));
  expect(fake.calls.create[0]).toMatchObject({worktreeSelector: 'id:global-floating-terminal', scope: {cwd: '/repo/worktrees/member'}});
  expect(receipt.state).toBe('working');
});

test('submit route sends one exact handle once; accepted delivery waits for acknowledgement', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
  const receipt = await fake.runtime.launch(input());
  expect(fake.calls.create[0]?.initialPrompt).toBeUndefined(); expect(receipt.instruction.status).toBe('not-sent');
  const submit = fake.deps.submit;
  fake.deps.submit = async plan => {
    expect(fake.records.get('exec-one')!.operations.at(-1)).toMatchObject({id: 'send-one', status: 'reserved'});
    return submit(plan);
  };
  const sent = await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'member task'});
  expect(sent.state).toBe('awaiting-ack'); expect(fake.calls.submit[0]).toMatchObject({kind: 'orca-target', terminalHandle: 'orca:terminal:exact-one', text: 'member task'});
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'member task'});
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-two', text: 'member task'});
  expect(fake.calls.submit).toHaveLength(1);
  await expect(fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'changed brief'})).rejects.toMatchObject({code: 'EXTERNAL_OPERATION_CONFLICT'});
});

test('an explicit distinct follow-up is delivered once after a known launch; replay and indirect initial-prompt retries send nothing', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  const sent = await fake.runtime.submit(receipt.executionRef, {operationId: 'follow-up-one', text: 'Now inspect the changed files.'});
  expect(sent.instruction).toEqual({status: 'written', operationId: 'follow-up-one'}); expect(fake.calls.submit).toHaveLength(1);
  expect(fake.calls.submit[0]?.text).toBe('Now inspect the changed files.');
  await fake.runtime.submit(receipt.executionRef, {operationId: 'follow-up-one', text: 'Now inspect the changed files.'});
  await fake.runtime.submit(receipt.executionRef, {operationId: 'retry-as-new', text: ' Now inspect the changed files.\r\n'});
  await fake.runtime.submit(receipt.executionRef, {operationId: 'indirect-initial', text: ` ${input().prompt}\r\n`});
  expect(fake.calls.submit).toHaveLength(1);
  await expect(fake.runtime.submit(receipt.executionRef, {operationId: 'follow-up-one', text: 'Different instruction.'})).rejects.toMatchObject({code: 'EXTERNAL_OPERATION_CONFLICT'});
  await expect(fake.runtime.submit(receipt.executionRef, {operationId: 'invalid-follow-up', text: '\0'})).rejects.toMatchObject({code: 'EXTERNAL_PROMPT_INVALID'});
  expect(fake.records.get('exec-one')!.receipt.instruction.status).toBe('written');
});

test('unknown follow-up delivery fences every later instruction, including a new payload after a fresh status probe', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  fake.deps.submit = async plan => {fake.calls.submit.push(plan); return {outcome: 'unknown'};};
  const uncertain = await fake.runtime.submit(receipt.executionRef, {operationId: 'follow-up-one', text: 'Inspect the new issue.'});
  expect(uncertain.instruction.status).toBe('unknown');
  await fake.runtime.probe(receipt.executionRef);
  await fake.runtime.submit(receipt.executionRef, {operationId: 'another-request', text: 'A different new instruction.'});
  expect(fake.calls.submit).toHaveLength(1);
});

test('uncertain initial delivery survives restart and cannot be resent with any operation id', async () => {
  const fake = fixture(); const create = fake.deps.create;
  fake.deps.create = async plan => ({...await create(plan), delivery: {outcome: 'unknown'}});
  const receipt = await fake.runtime.launch(input());
  expect(receipt.state).toBe('unknown'); expect(receipt.retainWorktree).toBe(true);
  const restarted = createTeamExternalRuntime(fake.deps);
  expect((await restarted.launch(input())).instruction.status).toBe('unknown');
  await restarted.submit(receipt.executionRef, {operationId: 'retry-as-new', text: input().prompt});
  expect(fake.calls.create).toHaveLength(1); expect(fake.calls.submit).toHaveLength(0);
});

test('a lost send reply never retransmits, and errors never expose host command/environment details', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
  fake.deps.submit = async plan => {fake.calls.submit.push(plan); throw new Error('SECRET=host-credential /private/account-home command');};
  const receipt = await fake.runtime.launch(input());
  const failed = await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'});
  expect(failed.instruction.status).toBe('unknown'); expect(failed.state).toBe('unknown');
  expect(JSON.stringify(failed)).not.toContain('SECRET'); expect(JSON.stringify(failed)).not.toContain('/private/account-home');
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-two', text: 'brief'});
  expect(fake.calls.submit).toHaveLength(1);
});

test('durable reservation handles concurrent instances and crash windows before the final save', async () => {
  const gate = deferred<{native: TeamExternalNativeRef; delivery: {outcome: 'written'}}>();
  const entered = deferred<void>(); const fake = fixture();
  fake.deps.create = async plan => {fake.calls.create.push(plan); entered.resolve(); return gate.promise;};
  const first = fake.runtime.launch(input()); await entered.promise;
  const secondRuntime = createTeamExternalRuntime(fake.deps);
  const pending = await secondRuntime.launch(input());
  expect(pending.state).toBe('unknown'); expect(pending.instruction.status).toBe('unknown');
  expect(fake.calls.create).toHaveLength(1);
  gate.resolve({native: nativeFor(fake.calls.create[0]!), delivery: {outcome: 'written'}});
  const finished = await first; expect(finished.state).toBe('awaiting-ack');
  await expect(secondRuntime.launch(input({generation: 2}))).rejects.toMatchObject({code: 'EXTERNAL_LAUNCH_CONFLICT'});
});

test('receipt persistence failure prevents the external side effect', async () => {
  const fake = fixture({journal: {read: async () => null, compareAndSet: async () => {throw new Error('disk unavailable');}}});
  await expect(fake.runtime.launch(input())).rejects.toThrow('disk unavailable');
  expect(fake.calls.prepare).toBe(0); expect(fake.calls.create).toHaveLength(0);
});

test('two adapter instances cannot concurrently submit a member brief twice', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
  const receipt = await fake.runtime.launch(input()); const other = createTeamExternalRuntime(fake.deps);
  const results = await Promise.all([fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'}),
    other.submit(receipt.executionRef, {operationId: 'send-two', text: 'brief'})]);
  expect(fake.calls.submit).toHaveLength(1);
  expect(results.some(result => result.instruction.status === 'written')).toBe(true);
});

test('malformed ownership or unexpected native payload fields cannot enter the execution receipt', async () => {
  for (const extra of [{owned: 'true'}, {env: {SECRET: 'credential'}}]) {
    const fake = fixture();
    fake.deps.create = async plan => ({native: {...nativeFor(plan), ...extra} as TeamExternalNativeRef, delivery: {outcome: 'written'}});
    const receipt = await fake.runtime.launch(input());
    expect(receipt.state).toBe('unknown'); expect(receipt.executionRef.native).toBeNull(); expect(receipt.retainWorktree).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain('SECRET');
  }
});

test('generation changes while preparing do not launch; late create preserves only the old unknown binding', async () => {
  const fake = fixture(); const prepared = deferred<TeamExternalPreparedPlan>(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async () => prepared.promise;
  const launch = fake.runtime.launch(input());
  await Promise.resolve(); await Promise.resolve();
  fake.setCurrent(false); prepared.resolve(await prepare(input()));
  expect((await launch).state).toBe('unknown'); expect(fake.calls.create).toHaveLength(0);
  const second = fixture(); const gate = deferred<{native: TeamExternalNativeRef; delivery: {outcome: 'written'}}>(); const entered = deferred<void>();
  second.deps.create = async plan => {second.calls.create.push(plan); entered.resolve(); return gate.promise;};
  const late = second.runtime.launch(input()); await entered.promise; second.setCurrent(false);
  gate.resolve({native: nativeFor(second.calls.create[0]!), delivery: {outcome: 'written'}});
  const receipt = await late;
  expect(receipt.state).toBe('unknown'); expect(receipt.reason).toBe('EXTERNAL_GENERATION_STALE'); expect(receipt.executionRef.native?.kind).toBe('orca');
  expect(receipt.retainWorktree).toBe(true);
  await second.runtime.closeOwned(receipt.executionRef, 'close-stale'); expect(second.calls.close).toHaveLength(0);
});

test('native handle/cwd/agent/host identities cannot be swapped, including a late probe before submit', async () => {
  for (const change of [{terminalHandle: 'other'}, {cwd: '/repo'}, {agent: 'codex'}, {hostInstanceId: 'restarted-host'}, {runtimeInstanceId: 'restarted-orca'}]) {
    const fake = fixture(); const prepare = fake.deps.prepare;
    fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
    const receipt = await fake.runtime.launch(input());
    fake.deps.probe = async () => ({native: {...receipt.executionRef.native!, ...change} as TeamExternalNativeRef, connection: 'connected', agentVerified: true, activity: 'idle'});
    const blocked = await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'});
    expect(blocked.state).toBe('unknown'); expect(fake.calls.submit).toHaveLength(0);
    await expect(fake.runtime.reveal({...receipt.executionRef, targetId: 'another-member'}, 'reveal-forged')).rejects.toBeInstanceOf(TeamExternalRuntimeError);
  }
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
  const receipt = await fake.runtime.launch(input()); const pending = deferred<TeamExternalProbe>();
  fake.deps.probe = async () => pending.promise;
  const submit = fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'});
  await Promise.resolve(); fake.setCurrent(false);
  pending.resolve({native: receipt.executionRef.native!, connection: 'connected', agentVerified: true, activity: 'idle'});
  expect((await submit).state).toBe('unknown'); expect(fake.calls.submit).toHaveLength(0);
});

test('all requested options survive missing account/model application; no wrong-account fallback process is launched', async () => {
  const requested = {accountId: 'cli-account-2', model: 'custom-model', provider: 'provider', effort: 'high' as const, bypassPermissions: true,
    launchOptions: {bgMode: true, tmuxMode: false, reuse: 'new' as const}};
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), applied: {bypassPermissions: {mode: 'automatic', evidence: 'launch-argument'}}});
  const receipt = await fake.runtime.launch(input({requested}));
  expect(receipt.requested).toEqual(requested); expect(receipt.state).toBe('awaiting-manual-join');
  expect(receipt.applied.accountId).toMatchObject({mode: 'manual-settings'}); expect(receipt.applied.model).toMatchObject({mode: 'manual-settings'});
  expect(fake.calls.create).toHaveLength(0); expect(fake.calls.manual).toBe(0);
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'}); expect(fake.calls.submit).toHaveLength(0);
});

test('ordinary apps and terminals delegate the selected launcher and remain manual even if a process is visible', async () => {
  for (const surface of ['app', 'terminal', 'iterm', 'powershell', 'wsl'] as TeamExternalSurface[]) {
    const fake = fixture(); const prepare = fake.deps.prepare;
    fake.deps.prepare = async request => ({...await prepare(request), kind: 'manual', readiness: 'ready'});
    const receipt = await fake.runtime.launch(input({surface, requested: {launchOptions: surface === 'app' ? {appMode: 'reopen'} : {tmuxMode: true}}}));
    expect(receipt.executionRef.surface).toBe(surface); expect(receipt.state).toBe('awaiting-manual-join');
    expect(receipt.instruction.status).toBe('prefill-requested'); expect(fake.calls.manual).toBe(1); expect(fake.calls.create).toHaveLength(0);
    fake.deps.probe = async () => ({native: receipt.executionRef.native!, connection: 'connected', agentVerified: true, activity: 'working'});
    expect((await fake.runtime.probe(receipt.executionRef)).state).toBe('awaiting-manual-join');
    await fake.runtime.submit(receipt.executionRef, {operationId: 'send-not-allowed', text: 'brief'}); expect(fake.calls.submit).toHaveLength(0);
    await fake.runtime.reveal(receipt.executionRef, 'reveal-one'); expect(fake.calls.reveal).toHaveLength(1);
    expect((await fake.runtime.closeOwned(receipt.executionRef, 'close-one')).retainWorktree).toBe(true); expect(fake.calls.close).toHaveLength(0);
  }
});

test('needs-setup keeps the app selection and request without opening the wrong runtime', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'manual', readiness: 'needs-setup'});
  const receipt = await fake.runtime.launch(input({surface: 'app', requested: {accountId: 'selected-cli-account', effort: 'high'}}));
  expect(receipt.state).toBe('awaiting-manual-join'); expect(receipt.requested.accountId).toBe('selected-cli-account'); expect(fake.calls.manual).toBe(0);
});

test('offline cmux is connection waiting with zero instruction; a verified connected cmux uses exact workspace/surface', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'awaiting-connection'});
  const offline = await fake.runtime.launch(input({surface: 'cmux', requested: {model: 'requested-model'}}));
  expect(offline.state).toBe('awaiting-connection'); expect(offline.requested.model).toBe('requested-model'); expect(offline.instruction.status).toBe('not-sent');
  expect(fake.calls.create).toHaveLength(0); expect(fake.calls.manual).toBe(0);
  fake.deps.probe = async () => ({native: null, connection: 'connected', agentVerified: false, activity: 'unknown'});
  const nowConnected = await fake.runtime.probe(offline.executionRef);
  expect(nowConnected.state).toBe('awaiting-connection'); expect(nowConnected.reason).toBe('EXTERNAL_CONNECTION_READY_REQUIRES_LAUNCH');
  expect(fake.calls.create).toHaveLength(0); expect(fake.calls.submit).toHaveLength(0);
  const connected = fixture(); const ready = await connected.runtime.launch(input({surface: 'cmux'}));
  await connected.runtime.read(ready.executionRef); await connected.runtime.reveal(ready.executionRef, 'reveal-one');
  expect(connected.calls.read[0]).toMatchObject({kind: 'cmux-target', workspaceId: 'workspace-exact', surfaceId: 'surface-exact'});
  expect(connected.calls.reveal[0]).toMatchObject({kind: 'cmux-target', workspaceId: 'workspace-exact', surfaceId: 'surface-exact'});
});

test('bounded read uses exact terminal cursor and drops late output after the member generation changes', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  const read = await fake.runtime.read(receipt.executionRef, {cursor: 'cursor-before', limit: 6});
  expect(fake.calls.read[0]).toMatchObject({terminalHandle: 'orca:terminal:exact-one', cursor: 'cursor-before', limit: 6});
  expect(read.text).toBe('output'); expect(read.cursor).toBe('cursor-next');
  const gate = deferred<{native: TeamExternalNativeRef; text: string}>(); const entered = deferred<void>();
  fake.deps.read = async () => {entered.resolve(); return gate.promise;};
  const late = fake.runtime.read(receipt.executionRef); await entered.promise; fake.setCurrent(false);
  gate.resolve({native: receipt.executionRef.native!, text: 'old member output'});
  const dropped = await late; expect(dropped.text).toBe(''); expect(dropped.receipt.state).toBe('unknown');
  expect(read.outcome).toBe('read'); expect(dropped.outcome).toBe('unconfirmed');
});

test('a completed empty read is read evidence while unknown agent identity remains unknown', async () => {
  for (const agentVerified of [true, false]) {
    const fake = fixture(), receipt = await fake.runtime.launch(input());
    fake.deps.probe = async () => ({native: receipt.executionRef.native!, connection: 'connected', agentVerified, activity: 'idle'});
    fake.deps.read = async plan => {fake.calls.read.push(clone(plan)); return {native: receipt.executionRef.native!, text: '', cursor: 'empty-next'};};
    const result = await fake.runtime.read(receipt.executionRef);
    expect(result).toMatchObject({outcome: 'read', text: '', cursor: 'empty-next', receipt: {agentVerified}});
    expect(fake.calls.read).toHaveLength(1);
    if (!agentVerified) expect(result.receipt.reason).toBe('EXTERNAL_AGENT_IDENTITY_UNVERIFIED');
  }
});

test('read capability absence is unavailable without invoking the underlying reader', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  fake.records.get('exec-one')!.receipt.capabilities.read = false;
  const result = await fake.runtime.read(receipt.executionRef);
  expect(result).toMatchObject({outcome: 'unavailable', text: '', receipt: {reason: 'EXTERNAL_CAPABILITY_UNAVAILABLE'}});
  expect(fake.calls.read).toHaveLength(0);
});

test('an actual operation in flight produces an unconfirmed read, not an empty successful read', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()), entered = deferred<void>(), gate = deferred<void>();
  fake.deps.reveal = async plan => {fake.calls.reveal.push(clone(plan)); entered.resolve(); await gate.promise;};
  const revealing = fake.runtime.reveal(receipt.executionRef, 'pending-reveal'); await entered.promise;
  const result = await fake.runtime.read(receipt.executionRef);
  expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_OPERATION_PENDING'}});
  expect(fake.calls.read).toHaveLength(0);
  gate.resolve(); await revealing;
});

test('a stale scope refuses read before the native reader and preserves its checkout', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()); fake.setCurrent(false);
  const result = await fake.runtime.read(receipt.executionRef);
  expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_GENERATION_STALE', retainWorktree: true}});
  expect(fake.calls.read).toHaveLength(0);
});

test('missing/disconnected native binding is unconfirmed and never calls the reader', async () => {
  for (const connection of ['missing', 'disconnected'] as const) {
    const fake = fixture(), receipt = await fake.runtime.launch(input());
    fake.deps.probe = async () => ({native: null, connection, agentVerified: false, activity: 'unknown'});
    const result = await fake.runtime.read(receipt.executionRef);
    expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_BINDING_UNVERIFIED', agentVerified: false}});
    expect(fake.calls.read).toHaveLength(0);
  }
});

test('an interrupted asynchronous read returns explicit uncertainty without leaking the aborted content', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()), entered = deferred<void>(), abort = deferred<void>();
  fake.deps.read = async plan => {fake.calls.read.push(clone(plan)); entered.resolve(); await abort.promise; throw new DOMException('SECRET=private interrupted request', 'AbortError');};
  const reading = fake.runtime.read(receipt.executionRef); await entered.promise; abort.resolve();
  const result = await reading;
  expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_READ_UNKNOWN', retainWorktree: true}});
  expect(JSON.stringify(result)).not.toContain('SECRET'); expect(fake.calls.read).toHaveLength(1);
});

test('a reader result from a recycled native handle cannot become read evidence', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input());
  fake.deps.read = async plan => {fake.calls.read.push(clone(plan)); return {native: {...receipt.executionRef.native!, runtimeInstanceId: 'recycled-process'}, text: 'foreign output', cursor: 'foreign-cursor'};};
  const result = await fake.runtime.read(receipt.executionRef);
  expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_BINDING_UNVERIFIED', agentVerified: false}});
  expect(result.cursor).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('foreign output');
});

test('a real concurrent journal update drops late output and cannot report a successful empty read', async () => {
  const fake = fixture(), receipt = await fake.runtime.launch(input()), entered = deferred<void>();
  const gate = deferred<{native: TeamExternalNativeRef; text: string; cursor: string}>();
  fake.deps.read = async plan => {fake.calls.read.push(clone(plan)); entered.resolve(); return gate.promise;};
  const reading = fake.runtime.read(receipt.executionRef); await entered.promise;
  await fake.runtime.reveal(receipt.executionRef, 'concurrent-journal-update');
  gate.resolve({native: receipt.executionRef.native!, text: 'superseded output', cursor: 'old-cursor'});
  const result = await reading;
  expect(result).toMatchObject({outcome: 'unconfirmed', text: '', receipt: {reason: 'EXTERNAL_READ_SUPERSEDED'}});
  expect(result.cursor).toBeUndefined(); expect(fake.calls.read).toHaveLength(1);
});

test('unverified agent identity permits exact-binding observation/reveal while blocking submit, close and working claims', async () => {
  const fake = fixture(); const prepare = fake.deps.prepare;
  fake.deps.prepare = async request => ({...await prepare(request), kind: 'managed', initialPrompt: 'submit'});
  const receipt = await fake.runtime.launch(input());
  fake.deps.probe = async () => ({native: receipt.executionRef.native!, connection: 'connected', agentVerified: false, activity: 'working'});
  const observed = await fake.runtime.read(receipt.executionRef);
  expect(observed.text).toBe('member output'); expect(observed.receipt.agentVerified).toBe(false); expect(observed.receipt.state).toBe('awaiting-ack');
  const probed = await fake.runtime.probe(receipt.executionRef); expect(probed.agentVerified).toBe(false); expect(probed.state).toBe('awaiting-ack');
  await fake.runtime.reveal(receipt.executionRef, 'reveal-one'); expect(fake.calls.reveal).toHaveLength(1);
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-one', text: 'brief'});
  await fake.runtime.closeOwned(receipt.executionRef, 'close-one');
  expect(fake.calls.submit).toHaveLength(0); expect(fake.calls.close).toHaveLength(0);
  fake.deps.probe = async () => ({native: {...receipt.executionRef.native!, runtimeInstanceId: 'changed-native-generation'}, connection: 'connected', agentVerified: false, activity: 'working'});
  expect((await fake.runtime.read(receipt.executionRef)).text).toBe('');
  await fake.runtime.reveal(receipt.executionRef, 'reveal-two'); expect(fake.calls.reveal).toHaveLength(1);
});

test('only exact team-owned executions close; unknown close keeps worktree and never retries', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  const closed = await fake.runtime.closeOwned(receipt.executionRef, 'close-one');
  expect(closed.state).toBe('closed'); expect(closed.retainWorktree).toBe(false);
  expect(fake.calls.close[0]).toMatchObject({kind: 'orca-target', terminalHandle: 'orca:terminal:exact-one'});
  await fake.runtime.closeOwned(receipt.executionRef, 'close-two'); expect(fake.calls.close).toHaveLength(1);
  const uncertain = fixture(); const started = await uncertain.runtime.launch(input());
  uncertain.deps.close = async command => {uncertain.calls.close.push(command); throw new Error('transport lost');};
  const unknown = await uncertain.runtime.closeOwned(started.executionRef, 'close-one');
  expect(unknown.state).toBe('unknown'); expect(unknown.retainWorktree).toBe(true);
  await uncertain.runtime.closeOwned(started.executionRef, 'close-one'); expect(uncertain.calls.close).toHaveLength(1);
  await uncertain.runtime.closeOwned(started.executionRef, 'close-as-new'); expect(uncertain.calls.close).toHaveLength(1);
});

test('a late close cannot release a stale member worktree, and output pending at close cannot restore the old active receipt', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  const closeGate = deferred<{closed: boolean}>(); const closeEntered = deferred<void>();
  fake.deps.close = async () => {closeEntered.resolve(); return closeGate.promise;};
  const closing = fake.runtime.closeOwned(receipt.executionRef, 'close-one'); await closeEntered.promise;
  fake.setCurrent(false); closeGate.resolve({closed: true});
  const stale = await closing; expect(stale.state).toBe('unknown'); expect(stale.retainWorktree).toBe(true);

  const other = fixture(); const started = await other.runtime.launch(input());
  const readGate = deferred<{native: TeamExternalNativeRef; text: string}>(); const readEntered = deferred<void>();
  other.deps.read = async () => {readEntered.resolve(); return readGate.promise;};
  const reading = other.runtime.read(started.executionRef); await readEntered.promise;
  await other.runtime.closeOwned(started.executionRef, 'close-one');
  readGate.resolve({native: started.executionRef.native!, text: 'late output'});
  const output = await reading; expect(output.text).toBe(''); expect(output.receipt.state).toBe('closed');
  expect(output.outcome).toBe('unconfirmed');
});

test('unknown options, raw environments and invalid surfaces are refused before persistence or launch', async () => {
  for (const bad of [{env: {SECRET: 'x'}}, {requested: {env: {SECRET: 'x'}}}, {surface: 'internal'}, {requested: {launchOptions: {shell: 'arbitrary'}}}, {requested: {bypassPermissions: 'true'}}]) {
    const fake = fixture(); await expect(fake.runtime.launch({...input(), ...bad} as TeamExternalLaunchInput)).rejects.toBeInstanceOf(TeamExternalRuntimeError);
    expect(fake.records.size).toBe(0); expect(fake.calls.create).toHaveLength(0);
  }
});
