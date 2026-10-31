import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import type {WeeklyProvider,WeeklyUsage} from './weeklyUsage';
import {commonMemoryUuid} from './commonMemoryCrypto';
import {workroomEffortUnsupported} from './workroomEffortView';

/**
 * 「주간 잔여」 on the phone's Home tab. This Mac's weekly allowance per CLI (`WeeklyUsageHost.status()`, src/weeklyUsageHost.ts)
 * reaches a phone only as this read-only workspace answer (`usage.weekly`, src/mobileWorkspaceProtocol.ts) — never on the
 * project card DTO, `AiTerminalSummary`, `session.ready` or a new capability flag, so `REMOTE_CONTROL_PROTOCOL_VERSION` and
 * the extended feature list stay as they are. Like `workroom.effort`, a Mac that predates the action refuses it once and the
 * card hides itself for that Mac. The phone only reads: 「사용량 연결」 (it rewrites ~/.claude and ~/.gemini settings) stays on
 * the Mac. Browser-safe: no node imports, and only types from src/weeklyUsage.ts (the Mac's module must not ride the portal).
 * The mobile and dock contracts are documented in docs/claude/remote-control.md and docs/claude/voice-dock.md.
 */
export const WEEKLY_USAGE_REMOTE_ACTION = 'usage.weekly' as const;
export const WEEKLY_USAGE_REMOTE_PROVIDERS = ['claude', 'codex', 'agy'] as const satisfies readonly WeeklyProvider[];
export const WEEKLY_USAGE_REMOTE_LABELS = ['주간', 'Gemini', 'Claude/GPT', '추가 한도'] as const;
export const WEEKLY_USAGE_REMOTE_MAX_BUCKETS = 8;
export type RemoteWeeklyLabel = typeof WEEKLY_USAGE_REMOTE_LABELS[number];
export interface RemoteWeeklyBucket {label: RemoteWeeklyLabel; remainingPercent: number; resetsAt: number | null}
/** `WeeklyUsage` without `canConnect`: whether 「사용량 연결」 could run is the Mac's own business (the phone cannot run it). */
export interface RemoteWeeklyUsageRow {provider: WeeklyProvider; buckets: RemoteWeeklyBucket[]; checkedAt: string | null; source: 'live' | 'statusline' | 'unavailable'; connected: boolean}
export type RemoteWeeklyUsageState = 'ready' | 'stale' | 'waiting' | 'unavailable';

/** A community receiver runs only `workroom.*` (src/agentDialogueControl.ts): v1 reads the connected Mac only, and says so. */
export const WEEKLY_USAGE_COMMUNITY_REFUSAL = '주간 잔여는 연결한 Mac 것만 볼 수 있습니다. 다른 아젠투지는 그 Mac에 직접 연결해 확인하세요.';
export const WEEKLY_USAGE_UPDATE_REQUIRED = 'Mac 앱 업데이트 필요 — 연결한 Mac 앱을 업데이트하면 휴대폰에서 주간 잔여를 볼 수 있습니다.';

const ROW_KEYS = ['provider', 'buckets', 'checkedAt', 'source', 'connected'] as const;
const BUCKET_KEYS = ['label', 'remainingPercent', 'resetsAt'] as const;
const LABELS: ReadonlySet<string> = new Set(WEEKLY_USAGE_REMOTE_LABELS);
const SOURCES: ReadonlySet<string> = new Set(['live', 'statusline', 'unavailable']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const isoTime = (v: unknown): v is string => typeof v === 'string' && v.length < 80 && ISO.test(v) && Number.isFinite(Date.parse(v));

/**
 * What the Mac sends: its `status()` rows in claude/codex/agy order, each bucket checked again, `canConnect` dropped. A bad
 * bucket is left out rather than failing the row, a reset time that is not a positive number is unknown (null), and the
 * check time is re-written as a plain ISO instant — Python's `isoformat()` (microseconds, `+00:00`) is what every engine parses.
 */
export function toRemoteWeeklyUsage(items: readonly WeeklyUsage[]): RemoteWeeklyUsageRow[] {
  return WEEKLY_USAGE_REMOTE_PROVIDERS.flatMap(provider => {
    const row = items.find(item => item?.provider === provider);
    if (!row) return [];
    const buckets = (Array.isArray(row.buckets) ? row.buckets : [])
      .filter(b => b && LABELS.has(b.label) && finite(b.remainingPercent) && b.remainingPercent >= 0 && b.remainingPercent <= 100)
      .slice(0, WEEKLY_USAGE_REMOTE_MAX_BUCKETS)
      .map(b => ({label: b.label as RemoteWeeklyLabel, remainingPercent: b.remainingPercent, resetsAt: finite(b.resetsAt) && b.resetsAt > 0 ? b.resetsAt : null}));
    const at = typeof row.checkedAt === 'string' ? Date.parse(row.checkedAt) : NaN;
    const checkedAt = Number.isFinite(at) ? new Date(at).toISOString() : null;
    return [{provider, buckets, checkedAt: isoTime(checkedAt) ? checkedAt : null, source: row.source === 'live' || row.source === 'statusline' ? row.source : 'unavailable', connected: row.connected === true}];
  });
}

/**
 * Strict reader for what a Mac answers: at most three rows with unique providers in claude/codex/agy order, at most eight
 * buckets each, exactly these keys (a `canConnect` or any unknown key rejects the whole answer), known labels, 0–100,
 * a positive reset time or null, an ISO check time or null.
 */
export function normalizeRemoteWeeklyUsage(value: unknown): RemoteWeeklyUsageRow[] {
  const fail = (): never => { throw new Error('주간 잔여 응답 형식이 올바르지 않습니다.'); };
  if (!Array.isArray(value) || value.length > WEEKLY_USAGE_REMOTE_PROVIDERS.length) return fail();
  let last = -1;
  return value.map(row => {
    if (!plain(row) || !exactKeys(row, ROW_KEYS)) return fail();
    const index = WEEKLY_USAGE_REMOTE_PROVIDERS.indexOf(row.provider as WeeklyProvider);
    // Also rejects an unknown provider (-1) and a repeated one.
    if (index <= last) return fail();
    last = index;
    if (!Array.isArray(row.buckets) || row.buckets.length > WEEKLY_USAGE_REMOTE_MAX_BUCKETS || typeof row.connected !== 'boolean' || !SOURCES.has(row.source as string)) return fail();
    if (row.checkedAt !== null && !isoTime(row.checkedAt)) return fail();
    const buckets = row.buckets.map((b: unknown): RemoteWeeklyBucket => {
      if (!plain(b) || !exactKeys(b, BUCKET_KEYS) || !LABELS.has(b.label as string) || !finite(b.remainingPercent) || b.remainingPercent < 0 || b.remainingPercent > 100
        || !(b.resetsAt === null || finite(b.resetsAt) && b.resetsAt > 0)) return fail();
      return {label: b.label as RemoteWeeklyLabel, remainingPercent: b.remainingPercent, resetsAt: b.resetsAt as number | null};
    });
    return {provider: row.provider as WeeklyProvider, buckets, checkedAt: row.checkedAt as string | null, source: row.source as RemoteWeeklyUsageRow['source'], connected: row.connected};
  });
}

/**
 * The Mac dock's four states (`weeklyUsageState`, src/weeklyUsage.ts), re-stated so the portal never imports the Mac's module:
 * older than 15 minutes or past a reset time is 「이전 값」, a connected CLI that has not written yet is waiting, and nothing is
 * ever guessed as 0 or 100. tests/weekly-usage-remote.test.ts holds the two to one table.
 */
export function remoteWeeklyUsageState(row: Pick<RemoteWeeklyUsageRow, 'buckets' | 'checkedAt' | 'connected'>, now = Date.now()): RemoteWeeklyUsageState {
  const at = Date.parse(row.checkedAt ?? '');
  if (!row.buckets.length || !Number.isFinite(at) || at > now + 60_000) return row.connected && !Number.isFinite(at) ? 'waiting' : 'unavailable';
  if (row.buckets.some(b => b.resetsAt !== null && b.resetsAt * 1000 <= now) || now - at > 15 * 60_000) return 'stale';
  return 'ready';
}

/** The figure the Mac dock shows for a provider: the lowest remaining bucket (agy has up to three) and that bucket's reset. */
export function remoteWeeklyUsageMinimum(row: Pick<RemoteWeeklyUsageRow, 'buckets'>): {remainingPercent: number; resetsAt: number | null} | null {
  let lowest: RemoteWeeklyBucket | null = null;
  for (const bucket of row.buckets) if (!lowest || bucket.remainingPercent < lowest.remainingPercent) lowest = bucket;
  return lowest ? {remainingPercent: lowest.remainingPercent, resetsAt: lowest.resetsAt} : null;
}

/**
 * The refusal of a Mac (or relay host, or forwarding Mac) that predates `usage.weekly`: its strict request check rejects the
 * action. The same refusals `workroom.effort` relies on (src/workroomEffortView.ts) — the card then hides for that Mac instead
 * of showing an error. A network failure is not this.
 */
export function weeklyUsageUnsupported(error: unknown): boolean {
  return workroomEffortUnsupported(error);
}

/** One read through the phone's workspace transport. `controlId` is any project this phone was shown on that Mac (a channel). */
export async function readRemoteWeeklyUsage(transport: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>, controlId: string): Promise<RemoteWeeklyUsageRow[]> {
  // Not `crypto.randomUUID()`: a LAN WebKit page on an HTTP origin has secure random bytes but no randomUUID.
  const result = await transport({operation: 'workspace', requestId: commonMemoryUuid(), targetId: controlId, workspace: {action: WEEKLY_USAGE_REMOTE_ACTION}});
  if (result.action !== WEEKLY_USAGE_REMOTE_ACTION || !Array.isArray(result.weeklyUsage)) throw new Error('주간 잔여 응답을 확인하지 못했습니다.');
  return normalizeRemoteWeeklyUsage(result.weeklyUsage);
}
