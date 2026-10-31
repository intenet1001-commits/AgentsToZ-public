import type {TeamExternalRef} from './teamExternalRuntime';
import type {TeamExternalOrcaRunner} from './teamExternalHost';

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

export type TeamOrcaRecoveryReason = 'EXTERNAL_RECOVERY_SCOPE_UNVERIFIED' | 'EXTERNAL_RECOVERY_TEAM_CHANGED'
  | 'EXTERNAL_RECOVERY_CLI_UNAVAILABLE' | 'EXTERNAL_RECOVERY_TRANSPORT_UNAVAILABLE'
  | 'EXTERNAL_RECOVERY_NATIVE_CHANGED' | 'EXTERNAL_RECOVERY_CWD_CHANGED'
  | 'EXTERNAL_RECOVERY_AGENT_UNVERIFIED' | 'EXTERNAL_RECOVERY_DISCONNECTED' | 'EXTERNAL_RECOVERY_READ_UNVERIFIED';
export type TeamOrcaRecoveryResult = {outcome: 'read'; text: string; cursor?: string}
  | {outcome: 'unconfirmed'; reason: TeamOrcaRecoveryReason};
interface RecoveryOptions {
  resolveOrcaCli(): string | null | Promise<string | null>;
  runOrca: TeamExternalOrcaRunner;
  bindingStillMatches(ref: TeamExternalRef): boolean;
}
class RecoveryFailure extends Error {
  constructor(readonly reason: TeamOrcaRecoveryReason) {super(reason);}
}
const refuse = (reason: TeamOrcaRecoveryReason): never => {throw new RecoveryFailure(reason);};

/** Diagnostic read-only recovery. Reasons are fixed host codes, never terminal text,
 * paths or native handles. No diagnosis transfers ownership or enables a write. */
export function createTeamOrcaRecoveryInspect(options: RecoveryOptions) {
  return async (ref: TeamExternalRef, input: {cursor?: string; limit?: number}): Promise<TeamOrcaRecoveryResult> => {
    try {
      const native = ref.native;
      if (native?.kind !== 'orca' || ref.surface !== 'orca-worktree' || !native.owned || native.cwd !== ref.cwd
        || native.agent !== ref.agent || native.hostInstanceId !== ref.hostInstanceId) return refuse('EXTERNAL_RECOVERY_SCOPE_UNVERIFIED');
      let expected: unknown;
      try {expected = JSON.parse(native.runtimeInstanceId);} catch {return refuse('EXTERNAL_RECOVERY_SCOPE_UNVERIFIED');}
      if (!Array.isArray(expected) || expected.length !== 2 || !expected.every(v => typeof v === 'string' && v.length > 0)) return refuse('EXTERNAL_RECOVERY_SCOPE_UNVERIFIED');
      const current = () => {if (!options.bindingStillMatches(ref)) refuse('EXTERNAL_RECOVERY_TEAM_CHANGED');};
      current();
      const cli = await options.resolveOrcaCli(); current();
      if (!cli) return refuse('EXTERNAL_RECOVERY_CLI_UNAVAILABLE');
      const call = async (args: string[]) => {
        const result = object(await options.runOrca(cli, [...args, '--json'], {cwd: '/', timeoutMs: 15_000, attempts: 1}));
        if (!result || result.ok !== true) return refuse('EXTERNAL_RECOVERY_TRANSPORT_UNAVAILABLE');
        return {body: object(result.result), runtimeId: object(result._meta)?.runtimeId};
      };
      const check = async () => {
        current();
        const result = await call(['terminal', 'show', '--terminal', native.terminalHandle]);
        current();
        const t = object(result.body?.terminal);
        if (!t || t.handle !== native.terminalHandle || t.worktreeId !== native.worktreeId || t.executionHostId !== 'local'
          || result.runtimeId !== expected[0] || t.incarnationId !== expected[1]) return refuse('EXTERNAL_RECOVERY_NATIVE_CHANGED');
        if (t.worktreePath !== ref.cwd) return refuse('EXTERNAL_RECOVERY_CWD_CHANGED');
        if (t.agentIdentity !== ref.agent) return refuse('EXTERNAL_RECOVERY_AGENT_UNVERIFIED');
        if (t.connected !== true) return refuse('EXTERNAL_RECOVERY_DISCONNECTED');
      };
      await check();
      const length = Math.max(1, Math.min(20_000, Math.floor(Number.isFinite(input.limit) ? input.limit! : 4000)));
      const limit = Math.min(1000, length);
      const result = await call(['terminal', 'read', '--terminal', native.terminalHandle, ...(input.cursor !== undefined ? ['--cursor', input.cursor] : []), '--limit', String(limit)]);
      const terminal = object(result.body?.terminal);
      if (!terminal || result.runtimeId !== expected[0] || terminal.handle !== native.terminalHandle
        || !Array.isArray(terminal.tail) || !terminal.tail.every(line => typeof line === 'string')) return refuse('EXTERNAL_RECOVERY_READ_UNVERIFIED');
      await check();
      return {outcome: 'read', text: terminal.tail.join('\n').slice(-length), ...(typeof terminal.nextCursor === 'string' ? {cursor: terminal.nextCursor} : {})};
    } catch (cause) {
      return {outcome: 'unconfirmed', reason: cause instanceof RecoveryFailure ? cause.reason : 'EXTERNAL_RECOVERY_TRANSPORT_UNAVAILABLE'};
    }
  };
}

/** Compatibility adapter for callers that do not display diagnostic evidence. */
export function createTeamOrcaRecoveryRead(options: RecoveryOptions) {
  const inspect = createTeamOrcaRecoveryInspect(options);
  return async (ref: TeamExternalRef, input: {cursor?: string; limit?: number}): Promise<{text: string; cursor?: string} | null> => {
    const result = await inspect(ref, input);
    return result.outcome === 'read' ? {text: result.text, ...(result.cursor !== undefined ? {cursor: result.cursor} : {})} : null;
  };
}
