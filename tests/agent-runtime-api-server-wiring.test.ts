import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { LOCAL_API_SHUTDOWN_HARD_CEILING_MS } from '../src/localApiShutdown';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const tauriSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const supervisorSource = readFileSync(
  new URL('../src/agentRuntimeSupervisor.ts', import.meta.url),
  'utf8',
);

function sourceIndex(marker: string, from = 0): number {
  const index = apiSource.indexOf(marker, from);
  expect(index, `api-server.ts is missing contract marker: ${marker}`).toBeGreaterThanOrEqual(0);
  return index;
}

function sourceSection(startMarker: string, endMarker: string, from = 0): string {
  const start = sourceIndex(startMarker, from);
  const end = sourceIndex(endMarker, start + startMarker.length);
  expect(end).toBeGreaterThan(start);
  return apiSource.slice(start, end);
}

describe('agent runtime API server wiring', () => {
  test('dispatches the isolated runtime surface only after the existing host/origin and CORS gates', () => {
    const serverStart = sourceIndex('const server = Bun.serve({');
    const hostOriginGate = sourceIndex("if (!isAllowedApiHost(req.headers.get('host'))", serverStart);
    const corsHeaders = sourceIndex('const headers: Record<string, string> = {', hostOriginGate);
    const preflight = sourceIndex('if (req.method === "OPTIONS")', corsHeaders);
    const runtimeDispatch = sourceIndex(
      "if (url.pathname.startsWith(`${AGENT_RUNTIME_HTTP_PREFIX}/`))",
      preflight,
    );
    const existingRemoteDispatch = sourceIndex(
      "if (url.pathname.startsWith('/api/remote-control/'))",
      runtimeDispatch,
    );

    expect(hostOriginGate).toBeGreaterThan(serverStart);
    expect(corsHeaders).toBeGreaterThan(hostOriginGate);
    expect(preflight).toBeGreaterThan(corsHeaders);
    expect(runtimeDispatch).toBeGreaterThan(preflight);
    expect(existingRemoteDispatch).toBeGreaterThan(runtimeDispatch);

    const runtimeBlock = apiSource.slice(runtimeDispatch, existingRemoteDispatch);
    expect(runtimeBlock).toContain('handleAgentRuntimeHttpRequest(');
    expect(runtimeBlock).toMatch(/handleAgentRuntimeHttpRequest\(\s*req,\s*url,\s*agentRuntimeHttpService,\s*headers,\s*\)/);
    expect(runtimeBlock).toContain('if (runtimeResponse) return runtimeResponse;');

    const portalRouteAllowlist = sourceSection(
      'const PORTAL_LOCAL_INTEGRATION_ROUTES = new Set([',
      ']);',
    );
    expect(portalRouteAllowlist).not.toContain('/api/agent-runtime');
  });

  test('uses a strict registered-target loader and verified Codex executable', () => {
    const ordinaryLoader = sourceSection(
      'async function loadPortsData() {',
      '/**\n * Agent Runtime target resolution is an execution-authority boundary',
    );
    expect(ordinaryLoader).toContain('console.error("[Data] Error loading ports data:", error);');
    expect(ordinaryLoader).toContain('return [];');

    const strictLoader = sourceSection(
      'async function loadAgentRuntimeRegisteredTargets()',
      'function resolveVerifiedAgentRuntime(',
    );
    expect(strictLoader).toContain("readFileAsync(PORTS_DATA_FILE, 'utf8')");
    expect(strictLoader).toContain("if (error?.code === 'ENOENT') {");
    expect(strictLoader).toContain('loadAgentRuntimeRegistrationSafetyMetadata()');
    expect(strictLoader).toContain('withoutAgentRuntimeSuppressedTargets(');
    expect(strictLoader).toContain('throw error;');
    expect(strictLoader).toContain('normalizePortsPayload(JSON.parse(raw))');
    expect(strictLoader).not.toContain('console.error');
    expect(strictLoader).toContain('discoverRegisteredGitWorktrees(cursor, registeredRows)');
    expect(strictLoader).toContain('agentRuntimeRegistrationAuthoritySignature()');
    expect(strictLoader).toContain('buildAgentRuntimeTargetInventory({');
    expect(strictLoader).toContain('targets: inventory.targets.map(({ cwd: _cwd, ...target }) => target)');

    const executableResolver = sourceSection(
      'function resolveVerifiedAgentRuntime(',
      'async function resolveAgentRuntimeRegisteredTarget(',
    );
    expect(executableResolver).toContain("if (adapterId !== 'codex') return null;");
    expect(executableResolver).toContain('&& !AGENT_RUNTIME_LOCAL_DEVELOPMENT_TEST_MODE) return null;');
    expect(executableResolver).toContain('if (IS_WIN) return null;');
    expect(executableResolver).toContain(
      'await resolveCodexRuntimeExecutable({ fresh: options.fresh === true })',
    );
    expect(executableResolver).not.toContain("resolveAgentBin('codex')");
    expect(executableResolver).not.toContain('Bun.which(');
    expect(executableResolver).toContain('cached.identityRevision === identity.revision');
    expect(executableResolver).toContain(
      'agentRuntimeCompatibilityInFlight.identityRevision !== identity.revision',
    );
    expect(executableResolver).toContain('inspectCodexAgentRuntimeCompatibility({');
    expect(executableResolver).toContain('codexExecutable: identity.path');
    expect(executableResolver).toContain('codexExecutableIdentity: identity');
    expect(executableResolver).toContain('executableIdentity: identity');
    expect(executableResolver).toContain('spawn: agentRuntimeGuardLaunchers.spawnCodex');
    expect(executableResolver).toContain('AGENT_RUNTIME_INSPECTION_ATTEMPTS');
    expect(executableResolver).toContain("state: 'unknown'");
    expect(executableResolver).not.toContain("compatible ? canonical : null");

    const targetResolver = sourceSection(
      'async function resolveAgentRuntimeRegisteredTarget(',
      'function unavailableAgentRuntimeCapabilities(',
    );
    expect(targetResolver).toContain('await loadAgentRuntimeTargetInventory()');
    expect(targetResolver).not.toContain('await loadPortsData()');
    expect(targetResolver).toContain("'AGENT_RUNTIME_TARGET_STATUS_UNKNOWN'");
    expect(targetResolver).toContain('agentRuntimeTargetInventoryError(inventory.complete)');
    expect(targetResolver).toContain('verifyFreshAgentRuntimeWorktree(resolved, inventory.targets)');
    expect(targetResolver).toContain("proof.status === 'missing' ? 404 : 503");
    expect(targetResolver).toContain('cwd,');
    expect(targetResolver).not.toContain('folderPath:');
  });

  test('acquires one supervisor lease before opening or reconciling the journal and uses the parent-death guard', () => {
    const fallback = sourceSection('const unavailableAgentRuntimeHttpService:', 'let agentRuntimeJournal:');
    expect(fallback).toContain('readiness: () => inspectAgentRuntimeReadiness({ supervisorState: agentRuntimeStartupState })');
    expect(fallback).not.toContain('inspectCodexAdapter:');
    expect(apiSource).toContain('agentRuntimeStartupState = agentRuntimeStartupFailure(error)');
    const bootstrap = sourceSection(
      'let agentRuntimeJournal: AgentRuntimeTaskJournal | null = null;',
      'type DetectedStartCommand = {',
    );
    const acquireLease = bootstrap.indexOf('agentRuntimeSupervisorRelease = await acquireAgentRuntimeSupervisor({');
    const openJournal = bootstrap.indexOf('agentRuntimeJournal = openAgentRuntimeTaskJournal(');
    const createService = bootstrap.indexOf('agentRuntimeService = createAgentRuntimeService({');
    expect(acquireLease).toBeGreaterThanOrEqual(0);
    expect(openJournal).toBeGreaterThan(acquireLease);
    expect(createService).toBeGreaterThan(openJournal);
    expect(bootstrap).toContain('registry: agentRuntimeGuardRegistry');
    expect(supervisorSource).toContain("join(input.appDataDir, 'agent-runtime', 'supervisor-v1.lock')");
    expect(supervisorSource).toContain('AGENT_RUNTIME_SUPERVISOR_STALE_AFTER_MS = 60_000');
    expect(supervisorSource).toContain('AGENT_RUNTIME_SUPERVISOR_DEAD_OWNER_GRACE_MS = 1_000');
    expect(supervisorSource).toContain("recoveryMode?: 'manual' | 'registered-pgid-test'");
    expect(supervisorSource).toContain("deadOwnerRecoveryClass: registeredPgidTest ? 'guarded' : 'manual'");
    expect(supervisorSource).toContain('input.registry.canRecoverDeadOwner(owner)');
    expect(bootstrap).toContain("join(APP_DATA_DIR, 'agent-runtime', 'tasks-v1.sqlite')");
    expect(bootstrap).toContain('runCodex: input => runCodexAgentTask(input, {');
    expect(bootstrap).toContain('managedExecutionEnabled: AGENT_RUNTIME_MANAGED_EXECUTION_ENABLED');
    expect(bootstrap).toContain('|| AGENT_RUNTIME_LOCAL_DEVELOPMENT_TEST_MODE');
    expect(bootstrap).toContain('dangerousModeEnabled: AGENT_RUNTIME_DANGEROUS_MODE_ENABLED');
    expect(bootstrap.match(/acquireWorkspaceLease: acquireAgentRuntimeWorkspaceLeaseForTarget/g))
      .toHaveLength(2);
    expect(apiSource).toContain('acquireManagedWorkspaceLease(target.cwd)');
    expect(bootstrap).toContain('spawn: agentRuntimeGuardLaunchers!.spawnCodex,');
    expect(bootstrap).not.toContain('await killProcessTree(pid');
    expect(bootstrap).not.toContain('confirmProcessTreeTerminated:');
    expect(bootstrap).toContain('agentRuntimeHttpService = {');
    expect(bootstrap).toContain('targets: listAgentRuntimeTargets,');
    expect(apiSource).toContain('captureAgentRuntimeLeasedTargetIdentity(target.targetId, target.cwd)');
    expect(apiSource).toContain('agentRuntimeWorkspaceLeaseMatchesIdentity(ownedLease, current)');
    expect(apiSource).toContain('revalidate: async () => {');
    expect(bootstrap).toContain("join(APP_DATA_DIR, 'agent-runtime', 'conversations-v1.sqlite')");
    expect(bootstrap).toContain('runCodexConversation: input => runCodexConversationTurn(input, {');
    expect(bootstrap).toContain('resolveRuntime: resolveReadOnlyVerifiedAgentRuntime');
    expect(bootstrap).toContain('executionMode: \'read-only\'');
    expect(bootstrap).toContain('conversationCapabilities: readOnlyAgentRuntimeConversationCapabilities');
    expect(bootstrap).toContain('conversations: readyConversationService,');
    expect(bootstrap).toContain('agentRuntimeHttpService: AgentRuntimeHttpService = unavailableAgentRuntimeHttpService');
    expect(bootstrap.match(/service: agentRuntimeHttpService/g)).toHaveLength(2);
    expect(bootstrap).not.toContain('remoteControlTaskRuntimeService');
    expect(bootstrap).toContain('The remote gateway itself forces workspace-write');
    expect(apiSource).toContain('const conversationRequest = url.pathname === `${AGENT_RUNTIME_HTTP_PREFIX}/conversations`');
    expect(apiSource).toContain('? AGENT_RUNTIME_CONVERSATION_PROTOCOL_VERSION');

    const initializationFailure = bootstrap.slice(bootstrap.indexOf('} catch (error) {'));
    const closeJournal = initializationFailure.indexOf('agentRuntimeJournal?.close()');
    const releaseLease = initializationFailure.indexOf('agentRuntimeSupervisorRelease?.()');
    expect(closeJournal).toBeGreaterThanOrEqual(0);
    expect(releaseLease).toBeGreaterThan(closeJournal);
  });

  test('opens writes only for a non-bundled source-development API process', () => {
    expect(apiSource).toContain("const IS_BUNDLED_API_SIDECAR = process.env.PORTMGR_BUNDLED_SIDECAR === '1';");
    expect(apiSource).toContain('!IS_BUNDLED_API_SIDECAR');
    expect(apiSource).toContain("process.env.AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE === '1'");
    expect(apiSource).toContain('delete process.env.AGENTSTOZ_LOCAL_RUNTIME_TEST_MODE;');
  });

  test('aborts synchronously on exit without releasing the supervisor lease', () => {
    const exitHook = sourceSection(
      "process.once('exit', () => {",
      'let remoteControlApiShutdown: Promise<void> | null = null;',
    );
    expect(exitHook).toContain('agentRuntimeService?.forceAbortNow();');
    expect(exitHook).toContain('agentRuntimeConversationService?.forceAbortNow();');
    expect(exitHook).not.toContain('agentRuntimeSupervisorRelease');
    expect(exitHook).not.toContain('agentRuntimeJournal?.close()');
  });

  test('contains Claude Remote Control across synchronous and parent-death shutdown', () => {
    const launcher = sourceSection(
      'const spawnContainedClaudeRemoteControl: SpawnClaudeRemoteControl =',
      'const remoteClaudeConversationManager = new ClaudeRemoteConversationManager(',
    );
    expect(launcher).toContain('agentRuntimeGuardLaunchers.spawnClaudeRemote(command, options)');
    expect(launcher).toContain('buildWindowsSupervisedLaunch(');
    expect(launcher).toContain('{ parentPid: process.pid }');
    const open = sourceSection(
      'async function openVerifiedClaudeProjectConversation(',
      "process.once('exit', () => {",
    );
    expect(open).toContain('spawn: spawnContainedClaudeRemoteControl');
    expect(apiSource).not.toContain('terminateProcessTree: pid => killProcessTree(pid)');
  });

  test('settles Claude and runtime independently and releases ownership only after complete shutdown', () => {
    const shutdown = sourceSection(
      'function shutdownRemoteControlApi(exitCode: number): Promise<void> {',
      "process.once('SIGINT', () => {",
    );
    expect(shutdown).toContain('if (remoteControlApiShutdown) return remoteControlApiShutdown;');
    expect(shutdown).toContain('await settleLocalApiShutdown([');
    expect(shutdown).toContain('remoteClaudeConversationManager.shutdown()');
    expect(shutdown).toContain('agentRuntimeService?.shutdown() ?? Promise.resolve()');
    expect(shutdown).toContain('agentRuntimeConversationService?.shutdown() ?? Promise.resolve()');

    const runtimeSuccessMarker = "if (agentRuntimeResult.status === 'fulfilled') {";
    const runtimeSuccess = sourceSection(
      runtimeSuccessMarker,
      '    } else {\n      // Do not close the journal or release the supervisor lease',
      sourceIndex('function shutdownRemoteControlApi(exitCode: number): Promise<void> {'),
    );
    const closeJournal = runtimeSuccess.indexOf('agentRuntimeJournal?.close()');
    const closeConversationJournal = runtimeSuccess.indexOf('agentRuntimeConversationJournal?.close()');
    const releaseLease = runtimeSuccess.indexOf('agentRuntimeSupervisorRelease?.()');
    expect(closeJournal).toBeGreaterThanOrEqual(0);
    expect(closeConversationJournal).toBeGreaterThanOrEqual(0);
    expect(releaseLease).toBeGreaterThan(closeJournal);
    expect(releaseLease).toBeGreaterThan(closeConversationJournal);

    const runtimeIncomplete = sourceSection(
      '    } else {\n      // Do not close the journal or release the supervisor lease',
      '    process.exit(exitCode);',
      sourceIndex('function shutdownRemoteControlApi(exitCode: number): Promise<void> {'),
    );
    expect(runtimeIncomplete).not.toContain('agentRuntimeJournal?.close()');
    expect(runtimeIncomplete).not.toContain('agentRuntimeSupervisorRelease?.()');
    expect(runtimeIncomplete).toContain("'[AgentRuntime] runtime shutdown incomplete:'");
    expect(shutdown).toContain("'[Runtime] local API shutdown exceeded its hard ceiling.'");
    expect(shutdown).toContain('remoteClaudeConversationManager.forceKillNow();');
    expect(shutdown).toContain('agentRuntimeService?.forceAbortNow();');
    expect(shutdown).toContain('agentRuntimeConversationService?.forceAbortNow();');
    expect(shutdown.lastIndexOf('process.exit(exitCode)')).toBeGreaterThan(
      shutdown.indexOf(runtimeSuccessMarker) + releaseLease,
    );
  });

  test('lets the Bun sidecar drain Agent Runtime before using a bounded hard kill', () => {
    const start = tauriSource.indexOf(
      'fn terminate_local_api_sidecar(child: &mut Child) -> Result<(), String> {',
    );
    const end = tauriSource.indexOf('fn shutdown_local_api_sidecar(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const shutdown = tauriSource.slice(start, end);
    const term = shutdown.indexOf('libc::kill(pid as i32, libc::SIGTERM)');
    const boundedDeadline = shutdown.indexOf('LOCAL_API_SIDECAR_SHUTDOWN_GRACE');
    const hardKill = shutdown.lastIndexOf(
      'terminate_and_confirm_local_api_process_group(pid, Some(child))',
    );
    expect(term).toBeGreaterThanOrEqual(0);
    expect(boundedDeadline).toBeGreaterThan(term);
    expect(hardKill).toBeGreaterThan(boundedDeadline);
    const groupCleanupStart = tauriSource.indexOf(
      'fn terminate_and_confirm_local_api_process_group(',
    );
    const groupCleanup = tauriSource.slice(groupCleanupStart, start);
    expect(groupCleanup).toContain('signal_managed_process_group(process_group_id, libc::SIGKILL)?');
    expect(groupCleanup).toContain('LOCAL_API_PROCESS_GROUP_CONFIRM_GRACE');
    const nativeGrace = tauriSource.match(
      /const LOCAL_API_SIDECAR_SHUTDOWN_GRACE: Duration = Duration::from_secs\((\d+)\);/,
    );
    expect(nativeGrace).not.toBeNull();
    expect(Number(nativeGrace?.[1]) * 1_000).toBeGreaterThan(
      LOCAL_API_SHUTDOWN_HARD_CEILING_MS,
    );
  });

  test('confirms the packaged POSIX sidecar group is gone before replacement', () => {
    const spawnStart = tauriSource.indexOf('fn spawn_bundled_api_sidecar(');
    const maintainStart = tauriSource.indexOf('fn maintain_local_api_sidecar(', spawnStart);
    expect(spawnStart).toBeGreaterThanOrEqual(0);
    expect(maintainStart).toBeGreaterThan(spawnStart);
    const spawn = tauriSource.slice(spawnStart, maintainStart);
    expect(spawn).toContain('.process_group(0)');
    expect(spawn).toContain('libc::getpgid(pid)');

    const supervisorStart = tauriSource.indexOf('fn start_local_api_supervisor(', maintainStart);
    expect(supervisorStart).toBeGreaterThan(maintainStart);
    const maintain = tauriSource.slice(maintainStart, supervisorStart);
    const cleanup = maintain.indexOf('terminate_and_confirm_local_api_process_group(');
    const replacement = maintain.lastIndexOf('spawn_bundled_api_sidecar(app_handle)');
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(replacement).toBeGreaterThan(cleanup);
    expect(maintain).toContain('old process group {} remains quarantined');
    expect(maintain).toContain('api_supervisor_stop.load(Ordering::SeqCst)');

    const shutdownStart = tauriSource.indexOf('fn shutdown_local_api_sidecar(', supervisorStart);
    const shutdownEnd = tauriSource.indexOf('struct SpawnArgs', shutdownStart);
    expect(shutdownStart).toBeGreaterThan(supervisorStart);
    expect(shutdownEnd).toBeGreaterThan(shutdownStart);
    const shutdown = tauriSource.slice(shutdownStart, shutdownEnd);
    expect(shutdown).toContain('while let Err(error) = terminate_local_api_sidecar(&mut child)');
  });

  test('keeps the source development API and packaged sidecar supervisors mutually exclusive', () => {
    const setupStart = tauriSource.indexOf('.setup(|app| {');
    const setupEnd = tauriSource.indexOf('// 창 닫기 → 숨김', setupStart);
    expect(setupStart).toBeGreaterThanOrEqual(0);
    expect(setupEnd).toBeGreaterThan(setupStart);
    const setup = tauriSource.slice(setupStart, setupEnd);
    expect(setup).toContain('if cfg!(debug_assertions) {');
    expect(setup).toContain('[API sidecar] source development API is managed by dev.ts');
    expect(setup).toContain('} else {\n        start_local_api_supervisor(app.handle().clone());');
  });

  test('runs the blocking native loopback proxy off Tauri\'s main thread', () => {
    const start = tauriSource.indexOf('async fn agent_runtime_request(');
    const end = tauriSource.indexOf('struct PortLaunchClaim', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const command = tauriSource.slice(start, end);
    expect(command).toContain('tauri::async_runtime::spawn_blocking(move || {');
    expect(command).toContain('authenticated_agent_runtime_request(&capability, &path, &method, body)');
  });
});
