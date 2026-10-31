import {createHash, randomBytes} from 'node:crypto';
import {parseComputerCaller, type ComputerCaller} from './computerUseProtocol';

/** A caller resolved from a transport credential. Only a registry mints one; request data never becomes one. */
export type AuthenticatedComputerCaller = Readonly<ComputerCaller>;
/**
 * Trust belongs to the credential, not to the object a host may have cached: once the session retires or the
 * lifetime ends, the same object is refused. Every issued credential is its own generation, so a later credential for
 * a reused session ID is a different caller and inherits no approval or grant of the earlier one.
 */
type Lease = {readonly generation: string; readonly expires: number; retired: boolean; readonly now: () => number};
const leases = new WeakMap<object, Lease>();
/** Live generations only; retired and expired ones are removed when noticed. Bounded by the registries' limits. */
const generations = new Map<string, Lease>();
const live = (lease: Lease | undefined): lease is Lease => !!lease && !lease.retired && lease.expires > lease.now();
export function isAuthenticatedComputerCaller(v: unknown): v is AuthenticatedComputerCaller {
  return typeof v === 'object' && v !== null && live(leases.get(v));
}
/** The identity a grant or an open approval binds to, or null when `v` is not a live caller. */
export function computerCallerGeneration(v: unknown): string | null {
  const lease = typeof v === 'object' && v !== null ? leases.get(v) : undefined;
  return live(lease) ? lease.generation : null;
}
/** Whether the credential a grant or an approval was bound to is still live. */
export function isLiveComputerCallerGeneration(generation: unknown): boolean {
  if (typeof generation !== 'string') return false;
  const lease = generations.get(generation);
  if (live(lease)) return true;
  generations.delete(generation);
  return false;
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Maps one per-session credential, carried outside request bodies (an MCP connection header), to the Workroom
 * session and team lane that owns it. The trusted host issues it when it starts that session's agent connection and
 * retires it when the session ends. Only digests are kept.
 *
 * Processes of the same macOS user are not a boundary: this keeps lanes from using each other's grants by mistake
 * or by a leaked grant secret. The signed helper's native human approval stays the authority for any new control.
 */
export class ComputerCallerRegistry {
  private entries = new Map<string, {caller: AuthenticatedComputerCaller; lease: Lease}>();
  constructor(private readonly options: {now?: () => number; lifetimeMs?: number; limit?: number} = {}) {}
  private now() {return (this.options.now ?? Date.now)();}
  private end(key: string) {
    const entry = this.entries.get(key); if (!entry) return;
    entry.lease.retired = true; generations.delete(entry.lease.generation); this.entries.delete(key);
  }
  private reap() {for (const [k, e] of this.entries) if (!live(e.lease)) this.end(k);}
  issue(value: ComputerCaller): string {
    const caller = Object.freeze(parseComputerCaller(value)); this.reap();
    if (this.entries.size >= (this.options.limit ?? 64)) throw Error('작업 세션 연결 한도입니다. 끝난 세션을 정리하세요.');
    const credential = randomBytes(32).toString('hex');
    const lease: Lease = {generation: randomBytes(16).toString('hex'), retired: false, now: () => this.now(),
      expires: this.now() + (this.options.lifetimeMs ?? 86_400_000)};
    leases.set(caller, lease); generations.set(lease.generation, lease);
    this.entries.set(digest(credential), {caller, lease});
    return credential;
  }
  authenticate(credential: unknown): AuthenticatedComputerCaller | null {
    if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) return null;
    this.reap(); return this.entries.get(digest(credential))?.caller ?? null;
  }
  /** Ends every credential of a session, for example when its Workroom closes, including objects already handed out. */
  retire(sessionId: string) {for (const [k, e] of this.entries) if (e.caller.sessionId === sessionId) this.end(k);}
}
