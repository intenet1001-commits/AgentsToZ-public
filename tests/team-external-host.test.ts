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
      if (argv[1] === 'read') return envelope({terminal: {handle: 'term-exact', status: 'running', tail: ['member output', 'next line'], nextCursor: '20'}});
      if (argv[1] === 'send') return envelope({send: {handle: 'term-exact', accepted: true, prompt: {processIncarnation: live.incarnationId,
        provider: live.promptProvider, observation: live.promptProvider === 'unsupported' ? 'unsupported' : 'supported',
        stages: ['input_accepted', ...(live.turnStarted ? ['turn_started'] : [])]}}});
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
