/** Host-only wiring for teamExternalRuntime. External commands are delegated to injected, single-attempt runners. */
import {randomUUID} from 'node:crypto';
import {closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {aiTerminalLaunchArgs} from './aiTerminalLaunchArgs';
import {normalizeCodeAppTask, checkOpenCodeAppRequest, type OpenCodeAppMode} from './codeAppTask';
import type {AiTerminalAgent} from './aiTerminalProtocol';
import {WORKROOM_KEY_INTERVAL_MS, workroomKeyChoosesExit, workroomKeySequence} from './workroomOrchestration';
import {workroomScreenAwaitsAnswer} from './workroomRouteDelivery';
import {createTeamExternalRuntime, TeamExternalRuntimeError, type TeamExternalApplication, type TeamExternalCapabilities,
  type TeamExternalCreatePlan, type TeamExternalJournal, type TeamExternalJournalRecord, type TeamExternalLaunchInput,
  type TeamExternalNativeRef, type TeamExternalOption, type TeamExternalPreparedPlan, type TeamExternalProbe,
  type TeamExternalRef, type TeamExternalRequested, type TeamExternalRuntimeDeps, type TeamExternalScope,
  type TeamExternalTargetPlan} from './teamExternalRuntime';

const copy = <T>(value: T): T => structuredClone(value);
const error = (code: string): never => {throw new TeamExternalRuntimeError(code);};
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const scopeOf = (input: TeamExternalScope): TeamExternalScope => ({executionId: input.executionId, hostInstanceId: input.hostInstanceId,
  teamId: input.teamId, memberId: input.memberId, targetId: input.targetId, cwd: input.cwd, generation: input.generation, agent: input.agent, surface: input.surface});
const scopeEqual = (a: TeamExternalScope, b: TeamExternalScope) => JSON.stringify(scopeOf(a)) === JSON.stringify(scopeOf(b));
const NONE: TeamExternalCapabilities = {probe: false, read: false, submit: false, reveal: false, close: false};

/** Fixed host launch plan, never accepted from a wire API. No credentials, account homes or environment values. */
export interface TeamExternalTerminalLaunchPlan {
  scope: TeamExternalScope; requested: TeamExternalRequested; title: string; executable: string; argv: string[]; command: string;
  /** Present on every manual openTerminal plan. Managed cmux create omits it and uses the separate submit route once. */
  initialPrompt?: string;
}
export interface TeamExternalAppLaunchPlan {
  scope: TeamExternalScope; requested: TeamExternalRequested; title: string; agent: AiTerminalAgent; mode?: OpenCodeAppMode; task?: string;
}
export interface TeamExternalManualLaunchResult {
  opened: boolean; surface: TeamExternalScope['surface']; launcherId?: string; taskApplied?: 'prefilled' | false;
}
/** The raw envelope is required: nodeOrcaRunJson's current result-only projection drops _meta.runtimeId. */
export type TeamExternalOrcaRunner = (executable: string, argv: readonly string[], options: {
  cwd: '/'; timeoutMs: number; attempts: 1;
}) => Promise<unknown>;
export interface TeamExternalOrcaObservation {
  /** Actual process/cwd evidence, not a copy of the requested scope or a terminal title. */
  cwd: string; agent: AiTerminalAgent | null; activity?: TeamExternalProbe['activity'];
}
export interface TeamExternalHostOptions {
  journal: TeamExternalJournal; isCurrent(scope: TeamExternalScope): boolean; currentHostInstanceId(): string;
  resolveAgentExecutable(agent: AiTerminalAgent): string | null | Promise<string | null>;
  resolveOrcaCli(): string | null | Promise<string | null>;
  runOrca: TeamExternalOrcaRunner;
  openCodeApp(plan: TeamExternalAppLaunchPlan): Promise<TeamExternalManualLaunchResult>;
  /** Uses the selected existing launcher including bg/tmux/reuse, with this validated command; no surface fallback. */
  openTerminal(plan: TeamExternalTerminalLaunchPlan): Promise<TeamExternalManualLaunchResult>;
  /** Pure capability declaration: this exact surface, canonical argv and every requested option are consumed without fallback. */
  supportsManualLaunch?(plan: TeamExternalTerminalLaunchPlan): boolean | Promise<boolean>;
  revealManual?(ref: TeamExternalRef): Promise<void>;
  observeOrcaExecution?(scope: TeamExternalScope, terminal: Readonly<Record<string, unknown>>): Promise<TeamExternalOrcaObservation | null>;
  /** Current local Orca execution host, not inferred from a title or the requested cwd. */
  orcaExecutionHostId?: string;
  platform?: NodeJS.Platform; maxPreparedPlans?: number; submitObserveSeconds?: number;
  /** Pause between two keys so a TUI reads each as its own event (default WORKROOM_KEY_INTERVAL_MS). */
  keyIntervalMs?: number;
  /** Maximum wait for an observable screen change after an arrow before sending the next key (default 2000ms). */
  keyRedrawMs?: number;
  /** Connection-only adapter: a connected cmux may launch manually without claiming native process control. */
  cmuxConnection?(): Promise<boolean>;
  cmux?: {connected(): Promise<boolean>; create(plan: TeamExternalCreatePlan, launch: TeamExternalTerminalLaunchPlan): ReturnType<TeamExternalRuntimeDeps['create']>}
    & Pick<TeamExternalRuntimeDeps, 'probe' | 'read' | 'submit' | 'reveal' | 'close'>;
}
interface PrivatePlan {
  scope: TeamExternalScope; input: TeamExternalLaunchInput; executable: string | null; cli: string | null; runtimeId: string | null;
  kind: TeamExternalPreparedPlan['kind']; sessionId: string; app?: TeamExternalAppLaunchPlan; terminal?: TeamExternalTerminalLaunchPlan;
}
interface OrcaShown {
  terminal: Record<string, unknown>; runtimeId: string; incarnationId: string; handle: string; worktreeId: string;
  worktreePath: string | null; executionHostId: string | null; agent: AiTerminalAgent | null; connected: boolean; writable: boolean;
}
function envelope(raw: unknown): {body: Record<string, unknown>; runtimeId: string | null} {
  const root = object(raw);
  if (!root || root.ok === false) return error('EXTERNAL_ORCA_RESPONSE_UNCERTAIN');
  return {body: object(root.result) ?? root, runtimeId: string(object(root._meta)?.runtimeId)};
}
function shown(raw: unknown, handle: string): OrcaShown {
  const parsed = envelope(raw), terminal = object(parsed.body.terminal);
  const incarnationId = string(terminal?.incarnationId), worktreeId = string(terminal?.worktreeId);
  if (!terminal || terminal.handle !== handle || !incarnationId || !worktreeId || !parsed.runtimeId) return error('EXTERNAL_ORCA_BINDING_UNVERIFIED');
  const agent = ['codex', 'claude', 'hermes', 'agy'].includes(String(terminal.agentIdentity)) ? terminal.agentIdentity as AiTerminalAgent : null;
  return {terminal, runtimeId: parsed.runtimeId, incarnationId, handle, worktreeId, worktreePath: string(terminal.worktreePath),
    executionHostId: string(terminal.executionHostId), agent, connected: terminal.connected === true, writable: terminal.writable === true};
}
const incarnation = (value: OrcaShown) => JSON.stringify([value.runtimeId, value.incarnationId]);
function requestedEntries(requested: TeamExternalRequested): TeamExternalOption[] {
  return [...(['model', 'provider', 'accountId', 'effort', 'bypassPermissions'] as const).filter(key => requested[key] !== undefined),
    ...(['bgMode', 'tmuxMode', 'reuse', 'appMode'] as const).filter(key => requested.launchOptions?.[key] !== undefined).map(key => `launchOptions.${key}` as const)];
}

export function createTeamExternalHost(options: TeamExternalHostOptions): TeamExternalRuntimeDeps {
  const plans = new Map<string, PrivatePlan>(), platform = options.platform ?? process.platform;
  const valid = (scope: TeamExternalScope) => scope.hostInstanceId === options.currentHostInstanceId() && options.isCurrent(copy(scopeOf(scope)));
  const assertCurrent = (scope: TeamExternalScope) => {if (!valid(scope)) error('EXTERNAL_GENERATION_STALE');};
  const call = async (cli: string, args: string[]) => options.runOrca(cli, [...args, '--json'], {cwd: '/', timeoutMs: 15_000, attempts: 1});
  async function inspect(ref: TeamExternalRef): Promise<{shown: OrcaShown; agentVerified: boolean; activity: TeamExternalProbe['activity']}> {
    assertCurrent(ref);
    if (ref.native?.kind !== 'orca') return error('EXTERNAL_BINDING_MISMATCH');
    const cli = await options.resolveOrcaCli(); assertCurrent(ref);
    if (!cli) return error('EXTERNAL_CONNECTION_REQUIRED');
    const live = shown(await call(cli, ['terminal', 'show', '--terminal', ref.native.terminalHandle]), ref.native.terminalHandle);
    assertCurrent(ref);
    if (incarnation(live) !== ref.native.runtimeInstanceId || live.worktreeId !== ref.native.worktreeId
      || live.executionHostId !== (options.orcaExecutionHostId ?? 'local')) return error('EXTERNAL_NATIVE_GENERATION_STALE');
    const observation = options.observeOrcaExecution ? await options.observeOrcaExecution(copy(scopeOf(ref)), copy(live.terminal)) : null;
    assertCurrent(ref);
    const cwd = observation?.cwd ?? (ref.surface === 'orca-worktree' ? live.worktreePath : null);
    if (cwd !== ref.cwd) return error('EXTERNAL_CWD_UNVERIFIED');
    return {shown: live, agentVerified: (observation?.agent ?? live.agent) === ref.agent,
      // A connected PTY may be awaiting approval, collecting a draft or running a turn.
      // Connection and writability alone cannot establish that the composer is idle.
      activity: observation?.activity ?? (live.connected ? 'unknown' : 'exited')};
  }
  function takePlan(planId: string, scope: TeamExternalScope): PrivatePlan {
    const plan = plans.get(planId);
    if (!plan || !scopeEqual(plan.scope, scope)) return error('EXTERNAL_LAUNCH_PLAN_INVALID');
    plans.delete(planId); assertCurrent(scope); return plan;
  }
  const deps: TeamExternalRuntimeDeps = {
    journal: options.journal, isCurrent: valid,
    async prepare(input) {
      assertCurrent(input);
      const normalizedPrompt = normalizeCodeAppTask(input.prompt);
      if (!normalizedPrompt) return error('EXTERNAL_PROMPT_INVALID');
      const requested = {...copy(input.requested), bypassPermissions: input.requested.bypassPermissions === true};
      const scope = scopeOf(input), applied: Partial<Record<TeamExternalOption, TeamExternalApplication>> = {};
      for (const key of requestedEntries(requested)) applied[key] = {mode: 'automatic', evidence: 'launch-argument'};
      const planId = `txp_${randomUUID()}`, caps = {...NONE};
      let result: TeamExternalPreparedPlan;
      const plan: PrivatePlan = {scope, input: copy({...input, requested, prompt: normalizedPrompt}), executable: null, cli: null, runtimeId: null, kind: 'manual', sessionId: randomUUID()};
      if (input.surface === 'app') {
        for (const key of requestedEntries(requested)) applied[key] = {mode: 'manual-settings', reason: 'DESKTOP_APP_SETTINGS_REQUIRED'};
        // A team member normally starts in a fresh worktree with no Hermes
        // conversation yet. Match the builder's first Hermes choice when an
        // API caller omits appMode; keep an explicit reopen unchanged.
        const mode = requested.launchOptions?.appMode ?? (input.agent === 'hermes' ? 'open' : undefined);
        // A requested reopen/open is never silently turned into a new Codex thread by its task-prefill helper.
        const task = input.agent === 'codex' && (mode === undefined || mode === 'new') ? normalizedPrompt : undefined;
        const checked = checkOpenCodeAppRequest({agent: input.agent, mode, task});
        if (checked.ok) {
          plan.app = {scope, requested, title: input.title, agent: input.agent, ...(checked.mode ? {mode: checked.mode} : {}), ...(checked.task ? {task: checked.task} : {})};
          if (requested.launchOptions?.appMode !== undefined) applied['launchOptions.appMode'] = {mode: 'automatic', evidence: 'launch-argument'};
        }
        caps.reveal = !!options.revealManual;
        result = {planId, kind: 'manual', readiness: checked.ok ? 'ready' : 'needs-setup', capabilityRevision: 'external-app-launch-v1', applied, capabilities: caps};
      } else {
        const executable = await options.resolveAgentExecutable(input.agent); assertCurrent(scope); plan.executable = executable;
        let argv: string[] = [];
        try {argv = aiTerminalLaunchArgs(input.agent, plan.sessionId, input.surface === 'cmux' ? undefined : normalizedPrompt, requested.bypassPermissions, null, null, false, requested.effort,
          requested.model ? {model: requested.model, ...(requested.provider ? {provider: requested.provider} : {})} : null);}
        catch {for (const key of requestedEntries(requested)) applied[key] = {mode: 'manual-settings', reason: 'LAUNCH_OPTION_VALIDATION_REQUIRED'};}
        if (requested.accountId) applied.accountId = {mode: 'manual-settings', reason: 'DAEMON_CHILD_ACCOUNT_ENV_UNVERIFIED'};
        if (requested.provider && !requested.model) applied.provider = {mode: 'manual-settings', reason: 'PROVIDER_REQUIRES_MODEL'};
        if (requested.effort && input.agent === 'agy') applied.effort = {mode: 'manual-settings', reason: 'EFFORT_REQUIRES_MODEL_VARIANT'};
        const command = executable ? `cd -- ${quote(scope.cwd)} && exec ${[executable, ...argv].map(quote).join(' ')}` : '';
        if (executable) plan.terminal = {scope, requested, title: input.title, executable, argv, command, ...(input.surface === 'cmux' ? {} : {initialPrompt: normalizedPrompt})};
        const requiresSetup = !executable || requestedEntries(requested).some(key => applied[key]?.mode !== 'automatic');
        const manualSupported = !requiresSetup && plan.terminal && options.supportsManualLaunch ? await options.supportsManualLaunch(copy(plan.terminal)) : false;
        assertCurrent(scope);
        if (input.surface === 'cmux') {
          const connected = options.cmux ? await options.cmux.connected() : options.cmuxConnection ? await options.cmuxConnection() : false; assertCurrent(scope);
          const manualMode=!options.cmux||requested.launchOptions?.bgMode===true||requested.launchOptions?.tmuxMode===true;
          if(manualMode&&executable){
            const manualArgv=aiTerminalLaunchArgs(input.agent,plan.sessionId,normalizedPrompt,requested.bypassPermissions,null,null,false,requested.effort,
              requested.model?{model:requested.model,...(requested.provider?{provider:requested.provider}:{})}:null);
            plan.terminal={scope,requested,title:input.title,executable,argv:manualArgv,initialPrompt:normalizedPrompt,
              command:`cd -- ${quote(scope.cwd)} && exec ${[executable,...manualArgv].map(quote).join(' ')}`};
          }
          const manualReady=!requiresSetup&&plan.terminal&&options.supportsManualLaunch?await options.supportsManualLaunch(copy(plan.terminal)):false;assertCurrent(scope);
          plan.kind = connected && !requiresSetup&&!manualMode ? 'managed' : connected ? 'manual' : 'awaiting-connection';
          result = plan.kind === 'managed' ? {planId, kind: 'managed', initialPrompt: 'submit', capabilityRevision: 'cmux-verified-host-v1', applied,
            capabilities: {probe: true, read: true, submit: true, reveal: true, close: true}}
            : plan.kind === 'manual' ? {planId, kind: 'manual', readiness: manualReady?'ready':'needs-setup', capabilityRevision: 'cmux-host-v1', applied, capabilities: { ...NONE, probe: true}}
            : {planId, kind: 'awaiting-connection', capabilityRevision: 'cmux-host-v1', applied, capabilities: {...NONE, probe: true}};
        } else if (input.surface === 'orca-floating' || input.surface === 'orca-worktree') {
          plan.cli = await options.resolveOrcaCli(); assertCurrent(scope);
          try {plan.runtimeId = plan.cli ? envelope(await call(plan.cli, ['status'])).runtimeId : null;} catch {plan.runtimeId = null;}
          assertCurrent(scope);
          const unsupportedMode = requested.launchOptions?.bgMode === true || requested.launchOptions?.tmuxMode === true || requested.launchOptions?.appMode !== undefined;
          const cwdUnobservable = input.surface === 'orca-floating' && !options.observeOrcaExecution;
          const canManage = plan.cli && plan.runtimeId && !requiresSetup && !unsupportedMode && !cwdUnobservable && platform !== 'win32';
          result = canManage ? {planId, kind: 'managed', initialPrompt: 'launch', capabilityRevision: 'orca-public-cli-v1', applied,
              capabilities: {probe: true, read: true, submit: true, reveal: true, close: true}}
            : requiresSetup ? {planId, kind: 'manual', readiness: 'needs-setup', capabilityRevision: 'orca-public-cli-v1', applied, capabilities: {...NONE}, reason: 'EXTERNAL_MANUAL_SETTINGS_REQUIRED'}
            : manualSupported ? {planId, kind: 'manual', readiness: 'ready', capabilityRevision: 'orca-manual-launch-v1', applied, capabilities: {...NONE},
              reason: cwdUnobservable ? 'EXTERNAL_NATIVE_PROOF_REQUIRED' : 'EXTERNAL_MANUAL_LAUNCH_UNVERIFIED'}
            : !plan.cli || !plan.runtimeId ? {planId, kind: 'awaiting-connection', capabilityRevision: 'orca-public-cli-v1', applied, capabilities: {...NONE, probe: true}}
            : {planId, kind: 'manual', readiness: 'needs-setup', capabilityRevision: 'orca-public-cli-v1', applied, capabilities: {...NONE},
              reason: cwdUnobservable ? 'EXTERNAL_NATIVE_PROOF_REQUIRED' : 'EXTERNAL_LAUNCHER_CAPABILITY_REQUIRED'};
        } else {
          caps.reveal = !!options.revealManual;
          result = {planId, kind: 'manual', readiness: !requiresSetup && manualSupported ? 'ready' : 'needs-setup', capabilityRevision: 'project-terminal-launch-v1', applied, capabilities: caps,
            ...(!requiresSetup && manualSupported ? {} : {reason: requiresSetup ? 'EXTERNAL_MANUAL_SETTINGS_REQUIRED' : 'EXTERNAL_LAUNCHER_CAPABILITY_REQUIRED'})};
        }
      }
      plan.kind = result.kind;
      // Only plans that can actually launch are retained. Waiting/setup receipts cannot fill the private command cache.
      if (result.kind === 'managed' || result.kind === 'manual' && result.readiness === 'ready') {
        if (plans.size >= (options.maxPreparedPlans ?? 128)) return error('EXTERNAL_PREPARED_PLAN_CAPACITY');
        plans.set(planId, plan);
      }
      return result;
    },
    async create(command) {
      const plan = takePlan(command.planId, command.scope);
      if (command.kind === 'cmux-create') {
        if (!options.cmux || !await options.cmux.connected()) return error('EXTERNAL_CONNECTION_REQUIRED');
        assertCurrent(command.scope); if (!plan.terminal) return error('EXTERNAL_LAUNCH_PLAN_INVALID');
        return options.cmux.create(command, copy(plan.terminal));
      }
      if (plan.kind !== 'managed' || !plan.cli || !plan.runtimeId || !plan.executable || !plan.terminal) return error('EXTERNAL_LAUNCH_PLAN_INVALID');
      const expectedSelector = command.scope.surface === 'orca-floating' ? 'id:global-floating-terminal' : `path:${command.scope.cwd}`;
      if (command.worktreeSelector !== expectedSelector || command.title !== plan.input.title || normalizeCodeAppTask(command.initialPrompt) !== plan.input.prompt) return error('EXTERNAL_LAUNCH_PLAN_INVALID');
      const status = envelope(await call(plan.cli, ['status'])); assertCurrent(command.scope);
      if (status.runtimeId !== plan.runtimeId) return error('EXTERNAL_NATIVE_GENERATION_STALE');
      const argv = aiTerminalLaunchArgs(command.scope.agent, plan.sessionId, plan.input.prompt, plan.input.requested.bypassPermissions === true, null, null, false,
        plan.input.requested.effort, plan.input.requested.model ? {model: plan.input.requested.model, ...(plan.input.requested.provider ? {provider: plan.input.requested.provider} : {})} : null);
      const shell = `cd -- ${quote(command.scope.cwd)} && exec ${[plan.executable, ...argv].map(quote).join(' ')}`;
      const created = envelope(await call(plan.cli, ['terminal', 'create', '--worktree', expectedSelector, '--title', command.title, '--command', shell]));
      const handle = string(object(created.body.terminal)?.handle);
      if (!handle || created.runtimeId !== plan.runtimeId) return error('EXTERNAL_ORCA_BINDING_UNVERIFIED');
      const live = shown(await call(plan.cli, ['terminal', 'show', '--terminal', handle]), handle);
      if (live.runtimeId !== plan.runtimeId || live.executionHostId !== (options.orcaExecutionHostId ?? 'local')) return error('EXTERNAL_NATIVE_GENERATION_STALE');
      const observation = options.observeOrcaExecution ? await options.observeOrcaExecution(copy(command.scope), copy(live.terminal)) : null;
      const cwd = observation?.cwd ?? (command.scope.surface === 'orca-worktree' ? live.worktreePath : null);
      if (cwd !== command.scope.cwd) return error('EXTERNAL_CWD_UNVERIFIED');
      return {native: {kind: 'orca', hostInstanceId: command.scope.hostInstanceId, runtimeInstanceId: incarnation(live), cwd,
        agent: command.scope.agent, owned: true, terminalHandle: handle, worktreeId: live.worktreeId}, delivery: {outcome: 'written', turnStarted: false}};
    },
    async launchManual(request) {
      const plan = takePlan(request.planId, request.scope);
      if (plan.kind !== 'manual') return error('EXTERNAL_LAUNCH_PLAN_INVALID');
      const result = plan.app ? await options.openCodeApp(copy(plan.app)) : plan.terminal ? await options.openTerminal(copy(plan.terminal)) : error('EXTERNAL_LAUNCH_PLAN_INVALID');
      if (result.surface !== request.scope.surface) return error('EXTERNAL_SURFACE_SUBSTITUTED');
      const native: TeamExternalNativeRef | undefined = result.launcherId && options.revealManual && !['orca-floating', 'orca-worktree', 'cmux'].includes(request.scope.surface) ? {kind: 'manual', hostInstanceId: request.scope.hostInstanceId,
        runtimeInstanceId: result.launcherId, cwd: request.scope.cwd, agent: request.scope.agent, owned: false, launcherId: result.launcherId} : undefined;
      return {opened: result.opened, ...(native ? {native} : {}), instruction: plan.terminal ? 'unknown'
        : plan.app?.task && result.taskApplied === 'prefilled' ? 'prefill-requested' : 'manual-transfer-ready'};
    },
    async probe(ref) {
      assertCurrent(ref);
      if (ref.surface === 'cmux') {
        if (options.cmux && ref.native) return options.cmux.probe(ref);
        const connected=options.cmux?await options.cmux.connected():options.cmuxConnection?await options.cmuxConnection():false;
        return {native: null, connection: connected ? 'connected' : 'disconnected', agentVerified: false, activity: 'unknown'};
      }
      if (!ref.surface.startsWith('orca-')) return {native: copy(ref.native), connection: 'disconnected', agentVerified: false, activity: 'unknown'};
      if (!ref.native) {
        const cli = await options.resolveOrcaCli(); assertCurrent(ref);
        try {return {native: null, connection: cli && envelope(await call(cli, ['status'])).runtimeId ? 'connected' : 'disconnected', agentVerified: false, activity: 'unknown'};}
        catch {return {native: null, connection: 'disconnected', agentVerified: false, activity: 'unknown'};}
      }
      const evidence = await inspect(ref);
      return {native: copy(ref.native), connection: evidence.shown.connected ? 'connected' : 'disconnected', agentVerified: evidence.agentVerified, activity: evidence.activity};
    },
    async read(command) {
      if (command.kind === 'cmux-target' && options.cmux) return options.cmux.read(command);
      const evidence = await inspect(command.executionRef);
      if (command.kind !== 'orca-target' || command.terminalHandle !== evidence.shown.handle) return error('EXTERNAL_BINDING_MISMATCH');
      const cli = await options.resolveOrcaCli(); assertCurrent(command.executionRef);
      if (!cli) return error('EXTERNAL_CONNECTION_REQUIRED');
      const read = envelope(await call(cli, ['terminal', 'read', '--terminal', command.terminalHandle,
        ...(command.cursor !== undefined ? ['--cursor', command.cursor] : []), '--limit', String(Math.max(1, Math.min(1_000, command.limit)))]));
      const terminal = object(read.body.terminal);
      if (!terminal || terminal.handle !== command.terminalHandle || read.runtimeId !== evidence.shown.runtimeId
        || !Array.isArray(terminal.tail) || !terminal.tail.every(line => typeof line === 'string')) return error('EXTERNAL_ORCA_READ_UNVERIFIED');
      await inspect(command.executionRef); // A process restart during the read cannot lend its output to the old binding.
      return {native: copy(command.executionRef.native!), text: terminal.tail.join('\n'), ...(typeof terminal.nextCursor === 'string' ? {cursor: terminal.nextCursor} : {})};
    },
    async submit(command) {
      if (command.kind === 'cmux-target' && options.cmux) return options.cmux.submit(command);
      const evidence = await inspect(command.executionRef);
      if (command.kind !== 'orca-target' || command.terminalHandle !== evidence.shown.handle || !evidence.agentVerified || !evidence.shown.connected || !evidence.shown.writable) return error('EXTERNAL_BINDING_UNVERIFIED');
      const text = normalizeCodeAppTask(command.text); if (!text) return error('EXTERNAL_PROMPT_INVALID');
      const cli = await options.resolveOrcaCli(); assertCurrent(command.executionRef); if (!cli) return error('EXTERNAL_CONNECTION_REQUIRED');
      // The trailing Enter on a normal instruction would also answer a waiting trust/approval menu. Read this
      // exact member before typing; an unreadable or empty screen is not evidence that the composer is safe.
      let rows: string[] | null = null;
      try {
        const screen = envelope(await call(cli, ['terminal', 'read', '--terminal', command.terminalHandle, '--limit', '1000']));
        const terminal = object(screen.body.terminal);
        if (screen.runtimeId === evidence.shown.runtimeId && terminal?.handle === command.terminalHandle
          && Array.isArray(terminal.tail) && terminal.tail.every(line => typeof line === 'string')
          && terminal.tail.some(line => line.trim())) rows = terminal.tail as string[];
      } catch {/* no text has been sent */}
      if (!rows) return {outcome: 'not-sent', reason: 'EXTERNAL_SCREEN_UNAVAILABLE'};
      if (workroomScreenAwaitsAnswer(rows)) return {outcome: 'not-sent', reason: 'EXTERNAL_PROMPT_AWAITS_ANSWER'};
      try {
        const current = await inspect(command.executionRef);
        if (!current.agentVerified || !current.shown.connected || !current.shown.writable) return {outcome: 'not-sent', reason: 'EXTERNAL_BINDING_UNVERIFIED'};
      } catch {return {outcome: 'not-sent', reason: 'EXTERNAL_BINDING_UNVERIFIED'};}
      const sent = envelope(await call(cli, ['terminal', 'send', '--terminal', command.terminalHandle, '--text', text, '--enter',
        '--wait-submit', String(Math.max(0, Math.min(10, options.submitObserveSeconds ?? 2)))]));
      const send = object(sent.body.send), prompt = object(send?.prompt);
      if (sent.runtimeId !== evidence.shown.runtimeId || send?.handle !== command.terminalHandle || prompt?.processIncarnation !== evidence.shown.incarnationId) return {outcome: 'unknown'};
      if (send.accepted !== true) return {outcome: send.accepted === false ? 'not-sent' : 'unknown'};
      const stages = Array.isArray(prompt.stages) ? prompt.stages : [];
      return {outcome: 'written', turnStarted: stages.includes('turn_started') && prompt.provider === command.executionRef.agent && prompt.observation === 'supported'};
    },
    /**
     * One raw `terminal send --text <key bytes>` per key (no --enter, no --retry-request: Orca takes those only for a
     * prompt), each accepted by the same runtime and the same process incarnation it was verified on. Anything that
     * fails before the first key was typed is `not-sent`; anything after it is `unknown`, and the rest is dropped.
     */
    async keys(command) {
      // Only this member's own Orca worktree terminal: never the floating terminal, a cmux surface or another window.
      if (command.kind !== 'orca-target' || command.executionRef.surface !== 'orca-worktree') return error('EXTERNAL_BINDING_MISMATCH');
      // A prior uncertain key could still redraw after this request starts. The durable operation journal survives
      // host restarts; without explicit reconciliation, never let a new request type on that uncertain screen.
      try {
        const record = await options.journal.read(command.executionRef.executionId);
        if (!record || record.operations.some(op => op.kind === 'keys' && op.id !== command.operationId
          && (op.status === 'reserved' || op.outcome === 'unknown' || op.outcome === undefined))) return {outcome: 'not-sent'};
      } catch {return {outcome: 'not-sent'};}
      let evidence: Awaited<ReturnType<typeof inspect>>, cli: string | null;
      try {evidence = await inspect(command.executionRef); cli = await options.resolveOrcaCli(); assertCurrent(command.executionRef);}
      catch {return {outcome: 'not-sent'};}
      if (!cli || command.terminalHandle !== evidence.shown.handle || !evidence.agentVerified || !evidence.shown.connected || !evidence.shown.writable) return {outcome: 'not-sent'};
      const orca = cli, pause = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
      /** The member's current tail from the same runtime and handle, or null when it cannot be read. */
      const screen = async (): Promise<string[] | null> => {
        try {
          const read = envelope(await call(orca, ['terminal', 'read', '--terminal', command.terminalHandle, '--limit', '40']));
          const terminal = object(read.body.terminal);
          return read.runtimeId === evidence.shown.runtimeId && terminal?.handle === command.terminalHandle && Array.isArray(terminal.tail)
            && terminal.tail.every(line => typeof line === 'string') ? terminal.tail as string[] : null;
        } catch {return null;}
      };
      const selected = (rows: string[]) => rows.map(row => row.replace(/[│┃║╭╮╰╯─━═┌┐└┘├┤┬┴┼▌▐]/g, ' ').trim())
        .filter(row => /^[❯›>▶➤]\s*\S/.test(row)).at(-1) ?? null;
      let typed = 0;
      for (let index = 0; index < command.keys.length; index++) {
        const key = command.keys[index]!;
        // Enter or a digit that would pick a row ending the CLI (「No, exit」 is highlighted on Claude's trust screen) is
        // refused at any position, as for the voice dock (VOC 2026-09-30): an arrow before it moves the highlight, so the
        // screen is read again right before that key, after the redraw. An unreadable screen refuses it too.
        const choosing = key === 'enter' || /^[1-9]$/.test(key);
        if (typed) {
          await pause(options.keyIntervalMs ?? WORKROOM_KEY_INTERVAL_MS);
          try {evidence = await inspect(command.executionRef);} catch {return {outcome: 'unknown'};}
          if (!evidence.shown.connected || !evidence.shown.writable) return {outcome: 'unknown'};
        }
        if (choosing) {
          const rows = await screen();
          // Keys before this one were typed, so the request as a whole is unknown — never typed again.
          if (!rows) return {outcome: typed ? 'unknown' : 'not-sent'};
          if (workroomKeyChoosesExit(rows, key)) return {outcome: typed ? 'unknown' : 'not-sent', reason: 'EXTERNAL_KEYS_WOULD_EXIT'};
        }
        // A fixed delay cannot show that a TUI has processed an arrow. Capture the actual pre-key screen and
        // require an observable change before sending any following key; a no-op or unreadable redraw fails closed.
        const arrow = ['up', 'down', 'left', 'right'].includes(key);
        const before = arrow ? await screen() : null;
        // If no selected row is visible, do not send an arrow that cannot be verified afterwards.
        if (arrow && (!before || !selected(before))) return {outcome: typed ? 'unknown' : 'not-sent'};
        const bytes = workroomKeySequence(key);
        let sent: ReturnType<typeof envelope>;
        // A call that failed or timed out may still have typed.
        try {sent = envelope(await call(orca, ['terminal', 'send', '--terminal', command.terminalHandle, '--text', bytes]));} catch {return {outcome: 'unknown'};}
        const send = object(sent.body.send);
        if (sent.runtimeId !== evidence.shown.runtimeId || send?.handle !== command.terminalHandle) return {outcome: 'unknown'};
        if (send.accepted !== true) return {outcome: send.accepted === false && !typed ? 'not-sent' : 'unknown'};
        if (send.bytesWritten !== undefined && send.bytesWritten !== Buffer.byteLength(bytes)) return {outcome: 'unknown'};
        typed++;
        if (before) {
          const deadline = performance.now() + Math.max(0, options.keyRedrawMs ?? 2_000);
          // A separate request can select immediately after this one, so a final arrow needs the same proof.
          const selectingLater = index + 1 === command.keys.length || command.keys.slice(index + 1).some(next => next === 'enter' || /^[1-9]$/.test(next));
          // On a selection path, unrelated output is not evidence that the selected row changed.
          const beforeSelection = selectingLater ? selected(before) : null;
          let changed = false;
          do {
            const rows = await screen();
            if (!rows) return {outcome: 'unknown'};
            const selection = selectingLater ? selected(rows) : null;
            if (selectingLater ? !!beforeSelection && !!selection && selection !== beforeSelection : JSON.stringify(rows) !== JSON.stringify(before)) {changed = true; break;}
            if (performance.now() >= deadline) break;
            await pause(Math.min(50, Math.max(0, deadline - performance.now())));
          } while (performance.now() <= deadline);
          if (!changed) return {outcome: 'unknown'};
          // A replacement process must never receive the following key, even if its screen changed.
          try {evidence = await inspect(command.executionRef);} catch {return {outcome: 'unknown'};}
          if (!evidence.agentVerified || !evidence.shown.connected || !evidence.shown.writable) return {outcome: 'unknown'};
        }
      }
      // A process restart during the keys cannot lend them to this member's binding.
      try {await inspect(command.executionRef);} catch {return {outcome: 'unknown'};}
      return {outcome: 'performed'};
    },
    async reveal(command) {
      if (command.kind === 'manual-target' && options.revealManual) {assertCurrent(command.executionRef); return options.revealManual(copy(command.executionRef));}
      if (command.kind === 'cmux-target' && options.cmux) return options.cmux.reveal(command);
      const evidence = await inspect(command.executionRef);
      if (command.kind !== 'orca-target' || command.terminalHandle !== evidence.shown.handle) return error('EXTERNAL_BINDING_MISMATCH');
      const cli = await options.resolveOrcaCli(); assertCurrent(command.executionRef); if (!cli) return error('EXTERNAL_CONNECTION_REQUIRED');
      if (envelope(await call(cli, ['terminal', 'switch', '--terminal', command.terminalHandle])).runtimeId !== evidence.shown.runtimeId) error('EXTERNAL_NATIVE_GENERATION_STALE');
    },
    async close(command) {
      if (command.kind === 'cmux-target' && options.cmux) return options.cmux.close(command);
      const evidence = await inspect(command.executionRef);
      if (command.kind !== 'orca-target' || command.terminalHandle !== evidence.shown.handle || !command.executionRef.native?.owned || !evidence.agentVerified) return error('EXTERNAL_BINDING_UNVERIFIED');
      const cli = await options.resolveOrcaCli(); assertCurrent(command.executionRef); if (!cli) return error('EXTERNAL_CONNECTION_REQUIRED');
      const closed = envelope(await call(cli, ['terminal', 'close', '--terminal', command.terminalHandle]));
      const terminal = object(closed.body.terminal);
      return {closed: closed.runtimeId === evidence.shown.runtimeId && (terminal?.handle === command.terminalHandle && terminal.closed === true
        || closed.body.handle === command.terminalHandle && closed.body.closed === true)};
    },
  };
  return deps;
}

export const createTeamExternalHostRuntime = (options: TeamExternalHostOptions) => createTeamExternalRuntime(createTeamExternalHost(options));

export interface TeamExternalFileJournalOptions {
  maxRecords?: number; maxBytes?: number; lockWaitMs?: number;
  /** false requires positive evidence that the owner process is dead; null/unknown keeps the lock. */
  processAlive?(pid: number): boolean | null;
}
/** Local host journal: no active/unknown record (or dedupe tombstone) is evicted to make capacity. New writes fail closed. */
export function createTeamExternalFileJournal(file: string, options: TeamExternalFileJournalOptions = {}): TeamExternalJournal {
  const maxRecords = options.maxRecords ?? 2_048, maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) error('EXTERNAL_JOURNAL_CAPACITY_INVALID');
  const lock = `${file}.lock`;
  type Store = {version: 1; records: Record<string, TeamExternalJournalRecord>};
  function readStore(): Store {
    if (!existsSync(file)) return {version: 1, records: Object.create(null) as Store['records']};
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) return error('EXTERNAL_JOURNAL_FILE_UNSAFE');
    const parsed = object(JSON.parse(readFileSync(file, 'utf8'))), records = object(parsed?.records);
    if (parsed?.version !== 1 || !records || Object.keys(records).length > maxRecords) return error('EXTERNAL_JOURNAL_CORRUPT');
    for (const [id, value] of Object.entries(records)) {
      const record = object(value), receipt = object(record?.receipt), ref = object(receipt?.executionRef);
      if (record?.version !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 1
        || receipt?.version !== 1 || ref?.executionId !== id || !Array.isArray(record.operations)) return error('EXTERNAL_JOURNAL_CORRUPT');
    }
    return {version: 1, records: Object.assign(Object.create(null), records) as Store['records']};
  }
  function reclaimDeadOwner(): boolean {
    const stat = lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return error('EXTERNAL_JOURNAL_LOCK_UNSAFE');
    const raw = readFileSync(lock, 'utf8');
    let owner: Record<string, unknown> | null = null;
    try {owner = object(JSON.parse(raw));} catch {return false;}
    if (!Number.isSafeInteger(owner?.pid) || Number(owner?.pid) < 1) return false;
    let alive: boolean | null = null;
    if (options.processAlive) alive = options.processAlive(Number(owner!.pid));
    else {try {process.kill(Number(owner!.pid), 0); alive = true;} catch (cause) {alive = (cause as NodeJS.ErrnoException).code === 'ESRCH' ? false : null;}}
    if (alive !== false || lstatSync(lock).ino !== stat.ino || readFileSync(lock, 'utf8') !== raw) return false;
    unlinkSync(lock); return true; // Only a dead owner's lock, never its reserved/unknown execution record.
  }
  return {
    async read(id) {return copy(readStore().records[id] ?? null);},
    async compareAndSet(id, revision, next) {
      mkdirSync(dirname(file), {recursive: true, mode: 0o700});
      const deadline = Date.now() + (options.lockWaitMs ?? 250);
      let fd: number;
      for (;;) {
        try {fd = openSync(lock, 'wx', 0o600); break;}
        catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
          try {if (reclaimDeadOwner()) continue;} catch (cause) {if ((cause as NodeJS.ErrnoException).code === 'ENOENT') continue; throw cause;}
          if (Date.now() >= deadline) return error('EXTERNAL_JOURNAL_LOCKED');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      let temp: string | null = null;
      try {
        writeFileSync(fd, JSON.stringify({pid: process.pid})); fsyncSync(fd);
        const store = readStore(), previous = store.records[id];
        if ((previous?.revision ?? null) !== revision) return false;
        if (next.version !== 1 || next.receipt.executionRef.executionId !== id || next.revision !== (revision ?? 0) + 1
          || previous && (previous.launchFingerprint !== next.launchFingerprint || !scopeEqual(previous.receipt.executionRef, next.receipt.executionRef)
            || previous.receipt.executionRef.native && JSON.stringify(previous.receipt.executionRef.native) !== JSON.stringify(next.receipt.executionRef.native))) return error('EXTERNAL_JOURNAL_REVISION_INVALID');
        if (!previous && Object.keys(store.records).length >= maxRecords) return error('EXTERNAL_JOURNAL_CAPACITY');
        store.records[id] = copy(next);
        const data = JSON.stringify(store);
        if (Buffer.byteLength(data) > maxBytes) return error('EXTERNAL_JOURNAL_CAPACITY');
        temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
        const output = openSync(temp, 'wx', 0o600);
        try {writeFileSync(output, data); fsyncSync(output);} finally {closeSync(output);}
        renameSync(temp, file); temp = null;
        const directory = openSync(dirname(file), 'r');
        try {fsyncSync(directory);} finally {closeSync(directory);}
        return true;
      } finally {
        if (temp) {try {unlinkSync(temp);} catch { /* Keep the original journal on failed rename/write. */ }}
        closeSync(fd!); unlinkSync(lock);
      }
    },
  };
}
