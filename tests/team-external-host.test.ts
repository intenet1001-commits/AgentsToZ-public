import {expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeamExternalFileJournal, createTeamExternalHost, createTeamExternalHostRuntime, type TeamExternalHostOptions,
  type TeamExternalAppLaunchPlan, type TeamExternalTerminalLaunchPlan} from '../src/teamExternalHost';
import {type TeamExternalJournalRecord, type TeamExternalLaunchInput, type TeamExternalNativeRef, type TeamExternalRef,
  type TeamExternalTargetPlan} from '../src/teamExternalRuntime';

const copy = <T>(value: T): T => structuredClone(value);
const input = (extra: Partial<TeamExternalLaunchInput> = {}): TeamExternalLaunchInput => ({executionId: 'execution-one', hostInstanceId: 'host-one',
  teamId: 'team-one', memberId: 'm1', targetId: 'rwt-one', cwd: '/repo/member', generation: 1, agent: 'claude', surface: 'orca-worktree',
  operationId: 'launch-one', requested: {}, title: 'Member', prompt: 'Implement this member task.', ...extra});
function target(ref: TeamExternalRef): TeamExternalTargetPlan & {text: string; limit: number} {
  if (ref.native?.kind !== 'orca') throw new Error('expected Orca');
  return {kind: 'orca-target', terminalHandle: ref.native.terminalHandle, executionRef: ref, operationId: 'next-operation', text: 'Next member task.', limit: 100};
}
function fixture(extra: Partial<TeamExternalHostOptions> = {}) {
  const records = new Map<string, TeamExternalJournalRecord>();
  const calls: Array<{args: string[]; options: {cwd: '/'; timeoutMs: number; attempts: 1}}> = [];
  const apps: TeamExternalAppLaunchPlan[] = [], terminals: TeamExternalTerminalLaunchPlan[] = [];
  const live = {runtimeId: 'orca-runtime-one', incarnationId: 'process-incarnation-one', agentIdentity: 'claude' as string | null,
    worktreePath: '/repo/member', worktreeId: 'repo::/repo/member', connected: true, writable: true, executionHostId: 'local', hostId: 'host-one', current: true,
    promptProvider: 'claude', turnStarted: true, lostCreateReply: false};
  const envelope = (result: unknown) => ({ok: true, result, _meta: {runtimeId: live.runtimeId}});
  const native = () => ({handle: 'term-exact', incarnationId: live.incarnationId, worktreeId: live.worktreeId, worktreePath: live.worktreePath,
    ptyId: 'pty-one', paneRuntimeId: 1, agentIdentity: live.agentIdentity, connected: live.connected, writable: live.writable, executionHostId: live.executionHostId});
  let screenRevision = 0;
  const options: TeamExternalHostOptions = {
    journal: {read: async id => copy(records.get(id) ?? null), compareAndSet: async (id, revision, next) => {
      if ((records.get(id)?.revision ?? null) !== revision) return false; records.set(id, copy(next)); return true;
    }},
    currentHostInstanceId: () => live.hostId, isCurrent: () => live.current,
    resolveAgentExecutable: agent => `/verified/${agent}`, resolveOrcaCli: () => '/verified/orca', platform: 'darwin',
    supportsManualLaunch: () => true,
    runOrca: async (_executable, argv, settings) => {
      calls.push({args: [...argv], options: settings});
      expect(settings.cwd).toBe('/'); expect(settings.attempts).toBe(1); expect(argv.at(-1)).toBe('--json');
      if (argv[0] === 'status') return envelope({status: 'running'});
      if (argv[1] === 'create') {if (live.lostCreateReply) throw new Error('transport lost'); return envelope({terminal: native()});}
      if (argv[1] === 'show') return envelope({terminal: native()});
      if (argv[1] === 'read') return envelope({terminal: {handle: 'term-exact', status: 'running', tail: ['member output', 'next line', `❯ screen ${screenRevision}`], nextCursor: '20'}});
      if (argv[1] === 'send') {if (/^\x1b\[[ABCD]$/.test(argv[argv.indexOf('--text') + 1] ?? '')) screenRevision++; return envelope({send: {handle: 'term-exact', accepted: true, prompt: {processIncarnation: live.incarnationId,
        provider: live.promptProvider, observation: live.promptProvider === 'unsupported' ? 'unsupported' : 'supported',
        stages: ['input_accepted', ...(live.turnStarted ? ['turn_started'] : [])]}}});}
      if (argv[1] === 'switch') return envelope({terminal: {handle: 'term-exact'}});
      if (argv[1] === 'close') return envelope({terminal: {handle: 'term-exact', closed: true}});
      throw new Error(`Unexpected fake CLI ${argv[0]} ${argv[1]}`);
    },
    openCodeApp: async plan => {apps.push(copy(plan)); return {opened: true, surface: 'app', taskApplied: plan.task ? 'prefilled' : false};},
    openTerminal: async plan => {terminals.push(copy(plan)); return {opened: true, surface: plan.scope.surface};}, ...extra,
  };
  return {options, runtime: createTeamExternalHostRuntime(options), host: createTeamExternalHost(options), records, calls, apps, terminals, live, envelope};
}

test('a connected cmux manual launcher receives the actual brief and options without claiming management',async()=>{
  const fake=fixture({cmuxConnection:async()=>true,supportsManualLaunch:async plan=>!!plan.initialPrompt&&plan.argv.includes(plan.initialPrompt)});
  const receipt=await fake.runtime.launch(input({surface:'cmux',requested:{launchOptions:{bgMode:false,tmuxMode:true,reuse:'new'}}}));
  expect(fake.terminals).toHaveLength(1);expect(fake.terminals[0]!.initialPrompt).toBe('Implement this member task.');
  expect(fake.terminals[0]!.requested.launchOptions).toEqual({bgMode:false,tmuxMode:true,reuse:'new'});
  expect(receipt.management).toBe('manual');expect(receipt.state).toBe('awaiting-manual-join');
  expect(receipt.capabilities.submit).toBe(false);expect(receipt.capabilities.close).toBe(false);
});
test('offline cmux and an asynchronously refused manual plan never create an alternative terminal',async()=>{
  for(const extra of [{cmuxConnection:async()=>false},{cmuxConnection:async()=>true,supportsManualLaunch:async()=>false}]){
    const fake=fixture(extra),receipt=await fake.runtime.launch(input({surface:'cmux'}));
    expect(fake.terminals).toHaveLength(0);expect(fake.calls.filter(c=>c.args.includes('create'))).toHaveLength(0);
    expect(receipt.state).toBe(extra.supportsManualLaunch?'awaiting-manual-join':'awaiting-connection');
  }
});

test('Orca actual command preserves canonical model/permission/effort flags and shell-quotes cwd and initial prompt once', async () => {
  const fake = fixture(); fake.live.worktreePath = "/repo/member's $(touch never)";
  const request = input({cwd: fake.live.worktreePath, prompt: "Explain 'quotes' and $(never-run).", requested: {model: 'claude-opus-5', effort: 'high', bypassPermissions: true}});
  const receipt = await fake.runtime.launch(request);
  expect(receipt.state).toBe('awaiting-ack'); expect(receipt.requested).toEqual(request.requested);
  expect(receipt.executionRef.native).toMatchObject({runtimeInstanceId: JSON.stringify(['orca-runtime-one', 'process-incarnation-one']), cwd: request.cwd, owned: true});
  const create = fake.calls.find(call => call.args[1] === 'create')!.args;
  expect(create).toContain(`path:${request.cwd}`); expect(create).not.toContain('worktree');
  const command = create[create.indexOf('--command') + 1]!;
  expect(command).toContain("cd -- '/repo/member'\"'\"'s $(touch never)' && exec '/verified/claude'");
  expect(command).toContain("'--permission-mode' 'bypassPermissions' '--model' 'claude-opus-5' '--effort' 'high'");
  expect(command).toContain("'--' 'Explain '\"'\"'quotes'\"'\"' and $(never-run).'");
  await fake.runtime.submit(receipt.executionRef, {operationId: 'second-send', text: request.prompt});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
  expect(JSON.stringify(receipt)).not.toContain('/verified/claude'); expect(JSON.stringify(receipt)).not.toContain('--command');
});

test('Orca Claude Max reaches the exact launch command with default or selected model; argument evidence does not prove application', async () => {
  for (const requested of [{effort:'max' as const}, {model:'claude-opus-5-5',effort:'max' as const}]) {
    const fake = fixture();
    const receipt = await fake.runtime.launch(input({requested}));
    const create = fake.calls.find(call => call.args[1] === 'create')!.args;
    const command = create[create.indexOf('--command') + 1]!;
    expect(command).toContain("'--effort' 'max'");
    if ('model' in requested) expect(command).toContain("'--model' 'claude-opus-5-5'");
    else expect(command).not.toContain("'--model'");
    expect(receipt.requested.effort).toBe('max');
    expect(receipt.applied.effort).toEqual({mode:'automatic',evidence:'launch-argument'});
    expect(receipt.state).toBe('awaiting-ack');
  }
});

test('normal permissions are explicit and a CLI account with no daemon child-env seam is preserved without launching', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input({agent: 'codex'}));
  const command = fake.calls.find(call => call.args[1] === 'create')!.args;
  expect(command[command.indexOf('--command') + 1]).toContain("'--ask-for-approval' 'on-request' '--sandbox' 'workspace-write'");
  expect(receipt.requested.bypassPermissions).toBe(false);
  const account = fixture(); const waiting = await account.runtime.launch(input({requested: {accountId: 'selected-account', model: 'claude-opus-5'}}));
  expect(waiting.requested.accountId).toBe('selected-account'); expect(waiting.state).toBe('awaiting-manual-join');
  expect(waiting.applied.accountId).toMatchObject({mode: 'manual-settings', reason: 'DAEMON_CHILD_ACCOUNT_ENV_UNVERIFIED'});
  expect(account.calls.filter(call => call.args[1] === 'create')).toHaveLength(0); expect(account.terminals).toHaveLength(0);
});

test('Hermes canonical argv keeps provider/model/effort while unknown agent identity permits observation only', async () => {
  const fake = fixture(); fake.live.agentIdentity = null; fake.live.promptProvider = 'unsupported';
  const receipt = await fake.runtime.launch(input({agent: 'hermes', requested: {model: 'anthropic/claude-sonnet-4', provider: 'anthropic', effort: 'medium'}}));
  const create = fake.calls.find(call => call.args[1] === 'create')!.args;
  const command = create[create.indexOf('--command') + 1]!;
  expect(command).toContain("'/verified/hermes' 'chat' '-m' 'anthropic/claude-sonnet-4' '--provider' 'anthropic' '--cli' '--reasoning' 'medium' '-q'");
  const output = await fake.runtime.read(receipt.executionRef);
  expect(output.text).toContain('member output'); expect(output.receipt.agentVerified).toBe(false); expect(output.receipt.state).toBe('awaiting-ack');
  const revealed = await fake.runtime.reveal(receipt.executionRef, 'reveal-one'); expect(revealed.agentVerified).toBe(false);
  await expect(fake.host.submit(target(receipt.executionRef))).rejects.toMatchObject({code: 'EXTERNAL_BINDING_UNVERIFIED'});
  await expect(fake.host.close(target(receipt.executionRef))).rejects.toMatchObject({code: 'EXTERNAL_BINDING_UNVERIFIED'});
  expect(fake.calls.filter(call => ['send', 'close'].includes(call.args[1] ?? ''))).toHaveLength(0);
});

test('native global runtime, process incarnation, execution host and cwd changes prevent every subsequent send', async () => {
  for (const changed of ['runtimeId', 'incarnationId', 'executionHostId', 'worktreePath', 'hostId'] as const) {
    const fake = fixture(); const receipt = await fake.runtime.launch(input());
    fake.live[changed] = 'different';
    await expect(fake.host.submit(target(receipt.executionRef))).rejects.toBeDefined();
    expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
  }
});

test('Orca send recognizes the real submission receipt, and unsupported provider/input acceptance never proves a turn', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input());
  expect(await fake.host.submit(target(receipt.executionRef))).toEqual({outcome: 'written', turnStarted: true});
  const sent = fake.calls.find(call => call.args[1] === 'send')!.args;
  expect(sent).toEqual(['terminal', 'send', '--terminal', 'term-exact', '--text', 'Next member task.', '--enter', '--wait-submit', '2', '--json']);
  fake.live.promptProvider = 'unsupported'; fake.live.turnStarted = false;
  expect(await fake.host.submit(target(receipt.executionRef))).toEqual({outcome: 'written', turnStarted: false});
});

test('floating is needs-setup unless actual process observation proves cwd, never by copying worktreePath', async () => {
  const fake = fixture({supportsManualLaunch: () => false}); const receipt = await fake.runtime.launch(input({surface: 'orca-floating'}));
  expect(receipt.state).toBe('awaiting-manual-join'); expect(receipt.reason).toBe('EXTERNAL_NATIVE_PROOF_REQUIRED');
  expect(receipt.capabilities).toEqual({probe: false, read: false, submit: false, reveal: false, close: false});
  expect(fake.calls.filter(call => call.args[1] === 'create')).toHaveLength(0);
  const observed = fixture({observeOrcaExecution: async () => ({cwd: '/repo/member', agent: 'claude'})});
  observed.live.worktreePath = '/global-floating-workspace'; observed.live.worktreeId = 'global-floating-terminal';
  const launched = await observed.runtime.launch(input({surface: 'orca-floating'}));
  expect(launched.executionRef.native?.cwd).toBe('/repo/member');
  expect(observed.calls.find(call => call.args[1] === 'create')?.args).toContain('id:global-floating-terminal');
});

test('a verified manual launcher opens floating with bg/model/effort/prompt while exposing no managed identity or write capability', async () => {
  const fake = fixture({revealManual: async () => {}, openTerminal: async plan => {
    fake.terminals.push(copy(plan)); return {opened: true, surface: plan.scope.surface, launcherId: 'unverified-window-handle'};
  }});
  const request = input({surface: 'orca-floating', requested: {model: 'claude-opus-5', effort: 'high', bypassPermissions: true, launchOptions: {bgMode: true, reuse: 'new'}}});
  const receipt = await fake.runtime.launch(request);
  expect(fake.terminals).toHaveLength(1); expect(fake.terminals[0]?.scope.surface).toBe('orca-floating');
  expect(fake.terminals[0]?.requested).toEqual(request.requested); expect(fake.terminals[0]?.argv).toContain(request.prompt);
  expect(fake.terminals[0]?.argv).toContain('claude-opus-5'); expect(fake.terminals[0]?.command).toContain("cd -- '/repo/member'");
  expect(receipt.state).toBe('awaiting-manual-join'); expect(receipt.management).toBe('manual'); expect(receipt.instruction.status).toBe('unknown');
  expect(receipt.reason).toBe('EXTERNAL_NATIVE_PROOF_REQUIRED'); expect(receipt.executionRef.native).toBeNull();
  expect(receipt.capabilities).toEqual({probe: false, read: false, submit: false, reveal: false, close: false});
  await fake.runtime.submit(receipt.executionRef, {operationId: 'send-again', text: request.prompt});
  await fake.runtime.closeOwned(receipt.executionRef, 'close-one');
  expect((await fake.runtime.read(receipt.executionRef)).text).toBe('');
  expect(fake.calls.filter(call => ['create', 'send', 'close'].includes(call.args[1] ?? ''))).toHaveLength(0);
});

test('manual launcher support is an explicit exact-option capability and cannot bypass an unverified CLI account', async () => {
  const fake = fixture({supportsManualLaunch: () => false});
  const receipt = await fake.runtime.launch(input({surface: 'terminal', requested: {launchOptions: {tmuxMode: true}}}));
  expect(receipt.reason).toBe('EXTERNAL_LAUNCHER_CAPABILITY_REQUIRED'); expect(fake.terminals).toHaveLength(0);
  const account = fixture({supportsManualLaunch: () => true});
  const waiting = await account.runtime.launch(input({surface: 'orca-floating', requested: {accountId: 'selected-account', launchOptions: {bgMode: true}}}));
  expect(waiting.applied.accountId?.mode).toBe('manual-settings'); expect(account.terminals).toHaveLength(0);
  const fallback = fixture({openTerminal: async () => ({opened: true, surface: 'terminal'})});
  const rejected = await fallback.runtime.launch(input({surface: 'orca-floating'}));
  expect(rejected.state).toBe('unknown'); expect(rejected.executionRef.surface).toBe('orca-floating');
});

test('generation changes during manual capability resolution prevent the actual launcher callback', async () => {
  let release!: (supported: boolean) => void, enter!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  const support = new Promise<boolean>(resolve => {release = resolve;});
  const fake = fixture({supportsManualLaunch: async () => {enter(); return support;}});
  const starting = fake.runtime.launch(input({surface: 'orca-floating'})); await entered;
  fake.live.current = false; release(true);
  const receipt = await starting; expect(receipt.state).toBe('unknown'); expect(fake.terminals).toHaveLength(0);
});

test('Codex reopen is preserved without forcing a new thread or submitting a prefill; new uses prefill only', async () => {
  const reopen = fixture(); const receipt = await reopen.runtime.launch(input({surface: 'app', agent: 'codex', requested: {launchOptions: {appMode: 'reopen'}, model: 'gpt-6.1-sol'}}));
  expect(reopen.apps[0]).toMatchObject({mode: 'reopen', scope: {surface: 'app', cwd: '/repo/member'}}); expect(reopen.apps[0]?.task).toBeUndefined();
  expect(receipt.state).toBe('awaiting-manual-join'); expect(receipt.instruction.status).toBe('manual-transfer-ready');
  expect(receipt.applied.model?.mode).toBe('manual-settings');
  const fresh = fixture(); const prefilled = await fresh.runtime.launch(input({surface: 'app', agent: 'codex', requested: {launchOptions: {appMode: 'new'}}}));
  expect(fresh.apps[0]?.task).toBe(input().prompt); expect(prefilled.instruction.status).toBe('prefill-requested'); expect(prefilled.state).toBe('awaiting-manual-join');
  const unavailable = fixture(); const waiting = await unavailable.runtime.launch(input({surface: 'app', agent: 'claude', requested: {launchOptions: {appMode: 'new'}}}));
  expect(waiting.state).toBe('awaiting-manual-join'); expect(unavailable.apps).toHaveLength(0);
});

test('Hermes project app launch remains manual and idempotent without claiming delivery or model verification', async () => {
  const fake = fixture();
  const request = input({surface: 'app', agent: 'hermes', requested: {model: 'opus-5.5', provider: 'anthropic', effort: 'high',
    launchOptions: {appMode: 'open'}}});
  const receipt = await fake.runtime.launch(request);
  expect(fake.apps).toHaveLength(1);
  expect(fake.apps[0]).toMatchObject({agent: 'hermes', mode: 'open', scope: {cwd: '/repo/member'}});
  expect(fake.apps[0]?.task).toBeUndefined();
  expect(receipt.management).toBe('manual');
  expect(receipt.state).toBe('awaiting-manual-join');
  expect(receipt.instruction.status).toBe('manual-transfer-ready');
  expect(receipt.applied.model?.mode).toBe('manual-settings');
  expect(receipt.applied.provider?.mode).toBe('manual-settings');
  expect(receipt.applied.effort?.mode).toBe('manual-settings');
  expect(receipt.executionRef.native).toBeNull();
  expect(receipt.capabilities.submit).toBe(false);
  expect(await fake.runtime.launch(request)).toEqual(receipt);
  await fake.runtime.submit(receipt.executionRef, {operationId: 'retry-instruction', text: request.prompt});
  expect(fake.apps).toHaveLength(1);
  expect(fake.calls).toHaveLength(0);
});

test('Hermes team app opens a fresh worktree by default and preserves explicit reopen without duplicate launches', async () => {
  const fresh = fixture();
  const request = input({surface: 'app', agent: 'hermes', requested: {}});
  const receipt = await fresh.runtime.launch(request);
  expect(fresh.apps).toHaveLength(1);
  expect(fresh.apps[0]).toMatchObject({agent: 'hermes', mode: 'open', scope: {cwd: '/repo/member'}});
  expect(receipt.state).toBe('awaiting-manual-join');
  expect(receipt.instruction.status).toBe('manual-transfer-ready');
  expect(receipt.capabilities.submit).toBe(false);
  expect(await fresh.runtime.launch(request)).toEqual(receipt);
  expect(fresh.apps).toHaveLength(1);

  const reopen = fixture();
  const reopened = await reopen.runtime.launch(input({surface: 'app', agent: 'hermes', requested: {launchOptions: {appMode: 'reopen'}}}));
  expect(reopen.apps).toHaveLength(1);
  expect(reopen.apps[0]).toMatchObject({agent: 'hermes', mode: 'reopen'});
  expect(reopened.instruction.status).toBe('manual-transfer-ready');
});

test('plain terminal launcher keeps bg/tmux and the actual member prompt, while delivery remains unverified', async () => {
  for (const launchOptions of [{bgMode: true}, {tmuxMode: true}]) {
    const fake = fixture(); const receipt = await fake.runtime.launch(input({surface: 'iterm', requested: {model: 'claude-opus-5', effort: 'low', launchOptions}}));
    expect(fake.terminals[0]?.requested.launchOptions).toEqual(launchOptions);
    expect(fake.terminals[0]?.command).toContain("'--model' 'claude-opus-5' '--effort' 'low'");
    expect(fake.terminals[0]?.argv).toContain(input().prompt); expect(fake.terminals[0]?.command).toContain(input().prompt);
    expect(fake.terminals[0]?.initialPrompt).toBe(input().prompt); expect(receipt.state).toBe('awaiting-manual-join');
    expect(receipt.instruction.status).toBe('unknown'); expect(fake.calls).toHaveLength(0);
  }
});

test('cmux offline is connection waiting without launcher substitution', async () => {
  const fake = fixture(); const receipt = await fake.runtime.launch(input({surface: 'cmux', requested: {model: 'claude-opus-5'}}));
  expect(receipt.state).toBe('awaiting-connection'); expect(receipt.requested.model).toBe('claude-opus-5');
  expect(fake.calls).toHaveLength(0); expect(fake.apps).toHaveLength(0); expect(fake.terminals).toHaveLength(0);
});

test('a connected cmux callback receives the private canonical launch plan with the selected model', async () => {
  const received: TeamExternalTerminalLaunchPlan[] = [];
  const native: TeamExternalNativeRef = {kind: 'cmux', hostInstanceId: 'host-one', runtimeInstanceId: 'cmux-runtime-one', cwd: '/repo/member', agent: 'claude',
    owned: true, workspaceId: 'workspace-one', surfaceId: 'surface-one'};
  const fake = fixture({cmux: {connected: async () => true,
    create: async (_plan, launch) => {received.push(launch); return {native, delivery: {outcome: 'not-sent'}};},
    probe: async () => ({native, connection: 'connected', agentVerified: true, activity: 'idle'}),
    read: async () => ({native, text: 'cmux output'}), submit: async () => ({outcome: 'written'}), reveal: async () => {}, close: async () => ({closed: true})}});
  const receipt = await fake.runtime.launch(input({surface: 'cmux', requested: {model: 'claude-opus-5', effort: 'high'}}));
  expect(received[0]?.argv).toContain('claude-opus-5'); expect(received[0]?.argv).toContain('high');
  expect(received[0]?.argv).not.toContain(input().prompt); expect(received[0]?.initialPrompt).toBeUndefined();
  expect(received[0]?.scope.cwd).toBe('/repo/member'); expect(receipt.instruction.status).toBe('not-sent');
  expect(fake.calls).toHaveLength(0);
});

test('discarded raw runtime metadata and a runtime restart before create never produce a new terminal', async () => {
  const missing = fixture({supportsManualLaunch: () => false, runOrca: async () => ({ok: true, result: {status: 'running'}})});
  expect((await missing.runtime.launch(input())).state).toBe('awaiting-connection');
  const fake = fixture(); const prepared = await fake.host.prepare(input()); fake.live.runtimeId = 'replacement-runtime';
  await expect(fake.host.create({kind: 'orca-create', scope: input(), operationId: 'launch-one', title: input().title, initialPrompt: input().prompt,
    planId: prepared.planId, worktreeSelector: 'path:/repo/member'})).rejects.toMatchObject({code: 'EXTERNAL_NATIVE_GENERATION_STALE'});
  expect(fake.calls.filter(call => call.args[1] === 'create')).toHaveLength(0);
});

test('a lost create response is attempted once and replays the unknown journal rather than starting another terminal', async () => {
  const fake = fixture(); fake.live.lostCreateReply = true;
  const receipt = await fake.runtime.launch(input()); expect(receipt.state).toBe('unknown');
  await fake.runtime.launch(input()); expect(fake.calls.filter(call => call.args[1] === 'create')).toHaveLength(1);
});

test('private launch plans cannot be used for another member or consumed twice', async () => {
  const fake = fixture(); const planned = await fake.host.prepare(input());
  const scope = {...input(), requested: undefined, operationId: undefined, title: undefined, prompt: undefined};
  const command = {kind: 'orca-create' as const, operationId: 'launch-one', planId: planned.planId, scope: input(), title: input().title,
    initialPrompt: input().prompt, worktreeSelector: 'path:/repo/member'};
  await expect(fake.host.create({...command, scope: {...scope, memberId: 'm2'}})).rejects.toMatchObject({code: 'EXTERNAL_LAUNCH_PLAN_INVALID'});
  const created = await fake.host.create(command); expect(created.native.kind).toBe('orca');
  await expect(fake.host.create(command)).rejects.toMatchObject({code: 'EXTERNAL_LAUNCH_PLAN_INVALID'});
  expect(fake.calls.filter(call => call.args[1] === 'create')).toHaveLength(1);
});

test('file journal writes 0600 atomically, rejects stale revisions and preserves reservations across instances', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'team-host-journal-')), 'journal.json');
  const one = createTeamExternalFileJournal(path), two = createTeamExternalFileJournal(path);
  const fake = fixture(); await fake.runtime.launch(input()); const record = copy(fake.records.get('execution-one')!);
  record.revision = 1; record.operations[0]!.status = 'reserved';
  expect(await one.compareAndSet('execution-one', null, record)).toBe(true); expect(statSync(path).mode & 0o777).toBe(0o600);
  expect((await two.read('execution-one'))?.operations[0]?.status).toBe('reserved');
  const next = {...record, revision: 2};
  expect(await Promise.all([one.compareAndSet('execution-one', 1, next), two.compareAndSet('execution-one', 1, next)])).toEqual([true, false]);
  expect(JSON.parse(readFileSync(path, 'utf8')).records['execution-one'].revision).toBe(2);
});

test('journal capacity never evicts an active/unknown receipt or a closed dedupe record', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'team-host-cap-')), 'journal.json');
  const journal = createTeamExternalFileJournal(path, {maxRecords: 1}); const fake = fixture(); await fake.runtime.launch(input());
  const record = copy(fake.records.get('execution-one')!); record.revision = 1; record.receipt.state = 'unknown';
  await journal.compareAndSet('execution-one', null, record);
  const other = copy(record); other.receipt.executionRef.executionId = 'execution-two';
  await expect(journal.compareAndSet('execution-two', null, other)).rejects.toMatchObject({code: 'EXTERNAL_JOURNAL_CAPACITY'});
  expect((await journal.read('execution-one'))?.receipt.state).toBe('unknown');
  const closed = copy(record); closed.revision = 2; closed.receipt.state = 'closed'; closed.receipt.retainWorktree = false;
  await journal.compareAndSet('execution-one', 1, closed);
  await expect(journal.compareAndSet('execution-two', null, other)).rejects.toMatchObject({code: 'EXTERNAL_JOURNAL_CAPACITY'});
  expect((await journal.read('execution-one'))?.receipt.state).toBe('closed');
});

test('journal lock and unsafe file permissions/symlinks fail before changing any record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-host-lock-')), path = join(dir, 'journal.json');
  const journal = createTeamExternalFileJournal(path, {lockWaitMs: 0}); const fake = fixture(); await fake.runtime.launch(input());
  const record = copy(fake.records.get('execution-one')!); record.revision = 1;
  writeFileSync(`${path}.lock`, JSON.stringify({pid: process.pid}), {mode: 0o600});
  await expect(journal.compareAndSet('execution-one', null, record)).rejects.toMatchObject({code: 'EXTERNAL_JOURNAL_LOCKED'});
  expect(await journal.read('execution-one')).toBeNull();
  const target = join(dir, 'unrelated.json'); writeFileSync(target, '{}', {mode: 0o600});
  const link = join(dir, 'link.json'); symlinkSync(target, link);
  await expect(createTeamExternalFileJournal(link).read('anything')).rejects.toMatchObject({code: 'EXTERNAL_JOURNAL_FILE_UNSAFE'});
  expect(readFileSync(target, 'utf8')).toBe('{}');
});

test('a proven dead lock owner can be recovered without deleting its uncertain execution record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-host-dead-lock-')), path = join(dir, 'journal.json');
  const journal = createTeamExternalFileJournal(path, {processAlive: () => false}); const fake = fixture(); await fake.runtime.launch(input());
  const record = copy(fake.records.get('execution-one')!); record.revision = 1; record.receipt.state = 'unknown';
  await journal.compareAndSet('execution-one', null, record);
  writeFileSync(`${path}.lock`, JSON.stringify({pid: 12345}), {mode: 0o600});
  const next = {...record, revision: 2}; expect(await journal.compareAndSet('execution-one', 1, next)).toBe(true);
  expect((await journal.read('execution-one'))?.receipt.state).toBe('unknown');
  const changed = copy(next); changed.revision = 3; changed.receipt.executionRef.cwd = '/different-member';
  await expect(journal.compareAndSet('execution-one', 2, changed)).rejects.toMatchObject({code: 'EXTERNAL_JOURNAL_REVISION_INVALID'});
  expect((await journal.read('execution-one'))?.receipt.executionRef.cwd).toBe('/repo/member');
});


test('a connected writable Orca PTY does not prove an idle composer',async()=>{
  const f=fixture();const receipt=await f.runtime.launch(input());
  expect(await f.host.probe(receipt.executionRef)).toMatchObject({connection:'connected',agentVerified:true,activity:'unknown'});
  f.live.connected=false;
  expect(await f.host.probe(receipt.executionRef)).toMatchObject({connection:'disconnected',activity:'exited'});
});

test('keys reach only a verified managed Orca worktree member, one raw send per key, and one requestId never types twice', async () => {
  const fake = fixture({keyIntervalMs: 0}), receipt = await fake.runtime.launch(input());
  const sends = () => fake.calls.filter(call => call.args[1] === 'send').map(call => call.args);
  expect(sends()).toHaveLength(0);
  const done = await fake.runtime.keys(receipt.executionRef, 'keys-request-one', ['down', 'enter']);
  // Raw bytes, no --enter or --retry-request (Orca takes those only for a prompt), and the instruction receipt is untouched.
  expect(sends()).toEqual([['terminal', 'send', '--terminal', 'term-exact', '--text', '\x1b[B', '--json'], ['terminal', 'send', '--terminal', 'term-exact', '--text', '\r', '--json']]);
  expect(done.instruction).toEqual(receipt.instruction); expect(done.reason).toBe(receipt.reason);
  expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'keys-request-one')).toMatchObject({kind: 'keys', status: 'settled', outcome: 'performed'});
  await fake.runtime.keys(receipt.executionRef, 'keys-request-one', ['down', 'enter']);
  expect(sends()).toHaveLength(2);
  await expect(fake.runtime.keys(receipt.executionRef, 'keys-request-one', ['esc'])).rejects.toThrow('EXTERNAL_OPERATION_CONFLICT');
  await expect(fake.runtime.keys(receipt.executionRef, 'keys-request-two', ['shift-tab'])).rejects.toThrow('EXTERNAL_KEYS_INVALID');
  expect(sends()).toHaveLength(2);
});

test('a changed process, another agent, a floating terminal or an exit choice is never typed into', async () => {
  const keyed = (fake: ReturnType<typeof fixture>) => fake.calls.filter(call => call.args[1] === 'send');
  for (const change of [(live: ReturnType<typeof fixture>['live']) => {live.incarnationId = 'process-incarnation-two';}, (live: ReturnType<typeof fixture>['live']) => {live.agentIdentity = 'codex';}]) {
    const fake = fixture({keyIntervalMs: 0}), receipt = await fake.runtime.launch(input());
    change(fake.live);
    expect((await fake.runtime.keys(receipt.executionRef, 'keys-binding-one', ['enter'])).reason).toBe('EXTERNAL_BINDING_UNVERIFIED');
    expect(keyed(fake)).toHaveLength(0); expect(fake.records.get('execution-one')!.operations.some(op => op.kind === 'keys')).toBe(false);
  }
  const floating = fixture({keyIntervalMs: 0, observeOrcaExecution: async () => ({cwd: '/repo/member', agent: 'claude'})});
  const loose = await floating.runtime.launch(input({surface: 'orca-floating'}));
  expect(loose.management).toBe('managed');
  expect((await floating.runtime.keys(loose.executionRef, 'keys-floating-one', ['enter'])).reason).toBe('EXTERNAL_KEYS_UNAVAILABLE');
  expect(keyed(floating)).toHaveLength(0);
  const app = fixture({keyIntervalMs: 0}), opened = await app.runtime.launch(input({surface: 'app', agent: 'codex'}));
  expect((await app.runtime.keys(opened.executionRef, 'keys-app-one', ['enter'])).reason).toBe('EXTERNAL_KEYS_UNAVAILABLE');
  // Claude's trust screen highlights 「No, exit」: Enter there is refused before anything is typed.
  const exit = fixture({keyIntervalMs: 0}), trust = await exit.runtime.launch(input()), run = exit.options.runOrca;
  exit.options.runOrca = async (executable, argv, settings) => argv[1] === 'read'
    ? exit.envelope({terminal: {handle: 'term-exact', tail: ['Do you trust the files in this folder?', '  1. Yes, proceed', '❯ 2. No, exit'], nextCursor: '3'}}) : run(executable, argv, settings);
  expect((await exit.runtime.keys(trust.executionRef, 'keys-exit-one', ['enter'])).reason).toBe('EXTERNAL_KEYS_WOULD_EXIT');
  expect(exit.records.get('execution-one')!.operations.find(op => op.id === 'keys-exit-one')).toMatchObject({status: 'settled', outcome: 'not-sent'});
  expect(keyed(exit)).toHaveLength(0);
});

test('an Enter or digit after an arrow is checked against the redrawn screen, so a moved highlight on 「No, exit」 is never chosen', async () => {
  // The arrow moves Claude's trust highlight from 「Yes, proceed」 onto 「No, exit」; the Enter after it would end the member CLI.
  const trustScreen = (onExit: boolean) => ['Do you trust the files in this folder?', `${onExit ? ' ' : '❯'} 1. Yes, proceed`, `${onExit ? '❯' : ' '} 2. No, exit`];
  for (const [keys, unreadable] of [[['down', 'enter'], false], [['down', '2'], false], [['down', 'enter'], true]] as const) {
    const fake = fixture({keyIntervalMs: 0, keyRedrawMs: 0}), receipt = await fake.runtime.launch(input()), run = fake.options.runOrca;
    let onExit = false;
    const typed: string[] = [];
    fake.options.runOrca = async (executable, argv, settings) => {
      if (argv[1] === 'read') {
        if (unreadable && onExit) throw new Error('read lost');
        return fake.envelope({terminal: {handle: 'term-exact', tail: trustScreen(onExit), nextCursor: '3'}});
      }
      if (argv[1] === 'send') {typed.push(argv[argv.indexOf('--text') + 1]!); if (argv.includes('\x1b[B')) onExit = true;}
      return run(executable, argv, settings);
    };
    const result = await fake.runtime.keys(receipt.executionRef, 'keys-moved-exit', keys);
    // Only the arrow was typed: the request is unknown (never typed again), and the reason names the withheld exit choice.
    expect(typed).toEqual(['\x1b[B']);
    expect(result.reason).toBe(unreadable ? 'EXTERNAL_KEYS_UNKNOWN' : 'EXTERNAL_KEYS_WOULD_EXIT');
    expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'keys-moved-exit')).toMatchObject({kind: 'keys', status: 'settled', outcome: 'unknown'});
    await fake.runtime.keys(receipt.executionRef, 'keys-moved-exit', keys);
    expect(typed).toEqual(['\x1b[B']);
  }
  // Moving the highlight from exit to 「Yes, proceed」 lets the Enter through.
  const safe = fixture({keyIntervalMs: 0, keyRedrawMs: 0}), started = await safe.runtime.launch(input()), base = safe.options.runOrca;
  let safeOnExit = true;
  safe.options.runOrca = async (executable, argv, settings) => {
    if (argv[1] === 'read') return safe.envelope({terminal: {handle: 'term-exact', tail: trustScreen(safeOnExit), nextCursor: '3'}});
    if (argv[1] === 'send' && argv.includes('\x1b[A')) safeOnExit = false;
    return base(executable, argv, settings);
  };
  await safe.runtime.keys(started.executionRef, 'keys-moved-safe', ['up', 'enter']);
  expect(safe.records.get('execution-one')!.operations.find(op => op.id === 'keys-moved-safe')).toMatchObject({status: 'settled', outcome: 'performed'});
  expect(safe.calls.filter(call => call.args[1] === 'send')).toHaveLength(2);
});

test('delayed Orca redraw is observed before choosing, while unchanged screens time out without replay', async () => {
  for (const changed of [true, false]) {
    const fake = fixture({keyIntervalMs: 0, keyRedrawMs: changed ? 700 : 80}), receipt = await fake.runtime.launch(input()), run = fake.options.runOrca;
    let arrowAt = 0, reads = 0;
    const typed: string[] = [];
    fake.options.runOrca = async (executable, argv, settings) => {
      if (argv[1] === 'read') {
        const exit = changed && arrowAt !== 0 && performance.now() - arrowAt >= 250;
        // Unrelated output changes immediately; it must not count as the delayed highlight redraw.
        return fake.envelope({terminal: {handle: 'term-exact', tail: [`Trust this folder? ${reads++}`, `${exit ? ' ' : '❯'} 1. Yes, proceed`, `${exit ? '❯' : ' '} 2. No, exit`]}});
      }
      if (argv[1] === 'send') {typed.push(argv[argv.indexOf('--text') + 1]!); arrowAt = performance.now();}
      return run(executable, argv, settings);
    };
    const result = await fake.runtime.keys(receipt.executionRef, 'redraw-delayed', ['down', 'enter']);
    expect(result.reason).toBe(changed ? 'EXTERNAL_KEYS_WOULD_EXIT' : 'EXTERNAL_KEYS_UNKNOWN');
    expect(typed).toEqual(['\x1b[B']);
    expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'redraw-delayed')).toMatchObject({status: 'settled', outcome: 'unknown'});
    await fake.runtime.keys(receipt.executionRef, 'redraw-delayed', ['down', 'enter']);
    expect(typed).toEqual(['\x1b[B']);
  }
});

test('separate arrow and Enter requests wait for the selection redraw; uncertainty blocks new requests even after host restart', async () => {
  for (const changed of [true, false]) {
    const fake = fixture({keyIntervalMs: 0, keyRedrawMs: changed ? 700 : 80}), receipt = await fake.runtime.launch(input()), run = fake.options.runOrca;
    let arrowAt = 0;
    const typed: string[] = [];
    fake.options.runOrca = async (executable, argv, settings) => {
      if (argv[1] === 'read') {
        const exit = changed && arrowAt !== 0 && performance.now() - arrowAt >= 250;
        return fake.envelope({terminal: {handle: 'term-exact', tail: ['Trust this folder?', `${exit ? ' ' : '❯'} 1. Yes, proceed`, `${exit ? '❯' : ' '} 2. No, exit`]}});
      }
      if (argv[1] === 'send') {typed.push(argv[argv.indexOf('--text') + 1]!); arrowAt = performance.now();}
      return run(executable, argv, settings);
    };
    const first = await fake.runtime.keys(receipt.executionRef, 'separate-arrow', ['down']);
    expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'separate-arrow')?.outcome).toBe(changed ? 'performed' : 'unknown');
    if (!changed) expect(first.reason).toBe('EXTERNAL_KEYS_UNKNOWN');
    const restarted = createTeamExternalHostRuntime(fake.options);
    const second = await restarted.keys(receipt.executionRef, 'separate-enter', ['enter']);
    expect(second.reason).toBe(changed ? 'EXTERNAL_KEYS_WOULD_EXIT' : 'EXTERNAL_KEYS_NOT_SENT');
    expect(typed).toEqual(['\x1b[B']);
    await restarted.keys(receipt.executionRef, 'separate-arrow', ['down']);
    await restarted.keys(receipt.executionRef, 'separate-enter', ['enter']);
    expect(typed).toEqual(['\x1b[B']);
    if (!changed) {
      // Older settled records may omit the outcome; their uncertainty must also block new input.
      delete fake.records.get('execution-one')!.operations.find(op => op.id === 'separate-arrow')!.outcome;
      expect((await restarted.keys(receipt.executionRef, 'legacy-enter', ['enter'])).reason).toBe('EXTERNAL_KEYS_NOT_SENT');
      expect(typed).toEqual(['\x1b[B']);
    }
  }
});

test('an ordinary prompt with no visible selected row refuses an arrow before typing and does not poison later requests', async () => {
  for (const rows of [['Normal input prompt'], ['❯ ']]) {
    const fake = fixture({keyIntervalMs: 0, keyRedrawMs: 0}), receipt = await fake.runtime.launch(input()), run = fake.options.runOrca;
    fake.options.runOrca = async (executable, argv, settings) => argv[1] === 'read'
      ? fake.envelope({terminal: {handle: 'term-exact', tail: rows}}) : run(executable, argv, settings);
    const result = await fake.runtime.keys(receipt.executionRef, 'normal-arrow', ['down']);
    expect(result.reason).toBe('EXTERNAL_KEYS_NOT_SENT');
    expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'normal-arrow')?.outcome).toBe('not-sent');
    expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
    await fake.runtime.keys(receipt.executionRef, 'normal-escape', ['esc']);
    expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(1);
  }
});

test('a key whose delivery is unclear makes the whole request unknown, drops the rest and is never typed again', async () => {
  const fake = fixture({keyIntervalMs: 0}), receipt = await fake.runtime.launch(input()), run = fake.options.runOrca;
  let sends = 0;
  fake.options.runOrca = async (executable, argv, settings) => {
    if (argv[1] === 'send' && ++sends === 2) throw new Error('transport lost');
    return run(executable, argv, settings);
  };
  const unknown = await fake.runtime.keys(receipt.executionRef, 'keys-unknown-one', ['down', 'down', 'enter']);
  expect(unknown.reason).toBe('EXTERNAL_KEYS_UNKNOWN'); expect(sends).toBe(2);
  expect(fake.records.get('execution-one')!.operations.find(op => op.id === 'keys-unknown-one')).toMatchObject({status: 'settled', outcome: 'unknown'});
  await fake.runtime.keys(receipt.executionRef, 'keys-unknown-one', ['down', 'down', 'enter']);
  expect(sends).toBe(2);
  // Refused by Orca before anything was typed is positive evidence of not-sent.
  const refused = fixture({keyIntervalMs: 0}), started = await refused.runtime.launch(input()), base = refused.options.runOrca;
  let attempts = 0;
  refused.options.runOrca = async (executable, argv, settings) => argv[1] === 'send' ? (attempts++, refused.envelope({send: {handle: 'term-exact', accepted: false}})) : base(executable, argv, settings);
  await refused.runtime.keys(started.executionRef, 'keys-refused-one', ['esc', 'enter']);
  expect(refused.records.get('execution-one')!.operations.find(op => op.id === 'keys-refused-one')).toMatchObject({status: 'settled', outcome: 'not-sent'});
  expect(attempts).toBe(1);
});

test('Orca follow-up is not typed into an approval screen, and unreadable screens are refused without losing earlier delivery', async () => {
  for (const screen of ['approval', 'unreadable', 'empty'] as const) {
    const fake = fixture(), initial = await fake.runtime.launch(input()), base = fake.options.runOrca;
    const previous = copy(initial.instruction);
    fake.options.runOrca = async (executable, argv, settings) => {
      if (argv[1] === 'read') {
        if (screen === 'unreadable') throw new Error('read lost');
        const tail = screen === 'empty' ? [] : ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'];
        return fake.envelope({terminal: {handle: 'term-exact', tail}});
      }
      return base(executable, argv, settings);
    };
    const result = await fake.runtime.submit(initial.executionRef, {operationId: `screen-${screen}`, text: '1'});
    expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
    expect(result.instruction).toEqual(previous);
    expect(result.reason).toBe(screen === 'approval' ? 'EXTERNAL_PROMPT_AWAITS_ANSWER' : 'EXTERNAL_SCREEN_UNAVAILABLE');
    await fake.runtime.submit(initial.executionRef, {operationId: `screen-${screen}`, text: '1'});
    expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
  }
});

test('Orca follow-up still types once on a readable ordinary composer screen', async () => {
  const fake = fixture(), initial = await fake.runtime.launch(input());
  const result = await fake.runtime.submit(initial.executionRef, {operationId: 'normal-screen-send', text: 'Inspect the project status.'});
  expect(result.instruction).toMatchObject({status: 'written', operationId: 'normal-screen-send'});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(1);
});

test('a refused approval-screen instruction cannot replay the original and a fresh request can send after the screen clears', async () => {
  const fake = fixture(), initial = await fake.runtime.launch(input()), base = fake.options.runOrca;
  let approval = true;
  fake.options.runOrca = async (executable, argv, settings) => {
    if (argv[1] === 'read' && approval) return fake.envelope({terminal: {handle: 'term-exact', tail: ['Proceed with command?', '❯ 1. Yes', '  2. No']}});
    return base(executable, argv, settings);
  };
  await fake.runtime.submit(initial.executionRef, {operationId: 'declined-send', text: '1'});
  approval = false;
  await fake.runtime.submit(initial.executionRef, {operationId: 'declined-send', text: '1'});
  await fake.runtime.submit(initial.executionRef, {operationId: 'duplicate-original', text: input().prompt});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
  const sent = await fake.runtime.submit(initial.executionRef, {operationId: 'new-after-resolution', text: '1'});
  expect(sent.instruction).toEqual({status: 'written', operationId: 'new-after-resolution'});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(1);
});

test('a changed Orca agent after screen read refuses the unsent follow-up', async () => {
  const fake = fixture(), initial = await fake.runtime.launch(input()), base = fake.options.runOrca;
  fake.options.runOrca = async (executable, argv, settings) => {
    const result = await base(executable, argv, settings);
    if (argv[1] === 'read') fake.live.agentIdentity = 'codex';
    return result;
  };
  const result = await fake.runtime.submit(initial.executionRef, {operationId: 'agent-changed-after-read', text: 'Inspect the status.'});
  expect(result.instruction).toEqual(initial.instruction);
  expect(result.reason).toBe('EXTERNAL_BINDING_UNVERIFIED');
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
});

test('a refused follow-up preserves the earlier working state and distinguishes stale questions from a live approval', async () => {
  const fake = fixture(), initial = await fake.runtime.launch(input()), base = fake.options.runOrca;
  fake.records.get('execution-one')!.receipt.state = 'working';
  let screen = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'];
  fake.options.runOrca = async (executable, argv, settings) => argv[1] === 'read'
    ? fake.envelope({terminal: {handle: 'term-exact', tail: screen}}) : base(executable, argv, settings);
  const blocked = await fake.runtime.submit(initial.executionRef, {operationId: 'working-but-approval', text: 'Inspect status.'});
  expect(blocked.state).toBe('working');
  expect(blocked.reason).toBe('EXTERNAL_PROMPT_AWAITS_ANSWER');
  expect(blocked.instruction).toEqual(initial.instruction);
  screen = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit', '❯'];
  const sent = await fake.runtime.submit(initial.executionRef, {operationId: 'old-answer-above-composer', text: 'Inspect status.'});
  expect(sent.instruction).toMatchObject({status: 'written', operationId: 'old-answer-above-composer'});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(1);
});

test('a persisted unsent submit remains unsent after runtime restart and can be deliberately retried with a new ID', async () => {
  const fake = fixture(), initial = await fake.runtime.launch(input()), base = fake.options.runOrca;
  const path = join(mkdtempSync(join(tmpdir(), 'team-submit-refusal-')), 'journal.json');
  const journal = createTeamExternalFileJournal(path);
  const original = copy(fake.records.get('execution-one')!); original.revision = 1;
  expect(await journal.compareAndSet(initial.executionRef.executionId, null, original)).toBe(true);
  let approval = true;
  fake.options.journal = journal;
  fake.options.runOrca = async (executable, argv, settings) => argv[1] === 'read' && approval
    ? fake.envelope({terminal: {handle: 'term-exact', tail: ['Do you trust the files in this folder?', '❯ 1. Yes', '  2. No']}})
    : base(executable, argv, settings);
  const first = createTeamExternalHostRuntime(fake.options);
  await first.submit(initial.executionRef, {operationId: 'persisted-refusal', text: 'Inspect status.'});
  expect((await journal.read('execution-one'))!.operations.find(op => op.id === 'persisted-refusal')).toMatchObject({status: 'settled', outcome: 'not-sent', reason: 'EXTERNAL_PROMPT_AWAITS_ANSWER'});
  approval = false;
  const restarted = createTeamExternalHostRuntime(fake.options);
  await restarted.submit(initial.executionRef, {operationId: 'persisted-refusal', text: 'Inspect status.'});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(0);
  const result = await restarted.submit(initial.executionRef, {operationId: 'deliberate-fresh-request', text: 'Inspect status.'});
  expect(result.instruction).toMatchObject({status: 'written', operationId: 'deliberate-fresh-request'});
  expect(fake.calls.filter(call => call.args[1] === 'send')).toHaveLength(1);
});
