import type { MobileWorkspaceScope } from './mobileWorkspaceProtocol';
import { historyGrantFields, normalizeHistoryScopes, type RemoteHistoryScope } from './workroomHistoryRemoteProtocol';

/** The local `/access` request of the Mac project panel (`terminalLocalRequest(AI_TERMINAL_PREFIX+'/access', body)`). */
export type WorkroomAccessRequest = (body: Record<string, unknown>) => Promise<any>;
export type WorkroomAccessScope = { workspaceRootIds: string[] } | { targetIds: string[] };
export interface WorkroomAccessSave {
  owner: string; enabled: boolean; workspaceScopes: readonly MobileWorkspaceScope[];
  scope: WorkroomAccessScope;
}

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256);
/** The scope the listing says the history permission was granted for (`historyGrantScope`); null when absent or malformed. */
function grantScopeOf(value: unknown): WorkroomAccessScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const v = value as Record<string, unknown>;
  if (keys[0] === 'targetIds' && ids(v.targetIds)) return { targetIds: [...v.targetIds] };
  if (keys[0] === 'workspaceRootIds' && ids(v.workspaceRootIds)) return { workspaceRootIds: [...v.workspaceRootIds] };
  return null;
}
/** The history scopes the Mac holds for `owner` in an `/access` listing and the scope they were granted for; null when
 *  the listing does not say (an older sidecar, no such connection) or says something malformed. */
export function grantedHistory(listing: unknown, owner: string): { scopes: RemoteHistoryScope[]; scope: WorkroomAccessScope | null } | null {
  const connections = (listing as { connections?: unknown } | null)?.connections;
  if (!Array.isArray(connections)) return null;
  const connection = connections.find(c => (c as { id?: unknown } | null)?.id === owner) as { historyScopes?: unknown; historyGrantScope?: unknown } | undefined;
  if (!connection || !Array.isArray(connection.historyScopes)) return null;
  let scopes: RemoteHistoryScope[];
  try { scopes = normalizeHistoryScopes(connection.historyScopes); } catch { return null; }
  return { scopes, scope: grantScopeOf(connection.historyGrantScope) };
}
/** A save within the granted scope: the same kind, and every project or folder it names was granted. Narrowing keeps the
 *  person's consent; another project, another folder or the other kind does not. */
export function historyScopeCovers(granted: WorkroomAccessScope, next: WorkroomAccessScope): boolean {
  const pick = (s: WorkroomAccessScope) => 'targetIds' in s ? { kind: 'targets', list: s.targetIds } : { kind: 'roots', list: s.workspaceRootIds };
  const g = pick(granted), n = pick(next);
  return g.kind === n.kind && n.list.length > 0 && n.list.every(id => g.list.includes(id));
}

/**
 * The project panel's «워크룸 작업 허용» save. The grant store replaces a grant whole, and this panel does not edit the
 * phone's Workroom history permission (only the Mac's internet QR dialog does, inside a per-scope form). So the save carries
 * the history scopes the Mac holds right now — read fresh at save time, never from the panel's 5-second polling state,
 * which may still show a permission another window just turned off — and only when the saved scope stays within the one
 * history was granted for. A save to another project or folder carries none (`historyScopeChanged`): history would
 * otherwise move to a project nobody approved it for. When the grant cannot be read the save carries none either:
 * fail-closed, history off; `historyCarried` is null in that case.
 */
export async function saveWorkroomAccess(request: WorkroomAccessRequest, input: WorkroomAccessSave): Promise<{ result: any; historyCarried: RemoteHistoryScope[] | null; historyScopeChanged: boolean }> {
  let historyCarried: RemoteHistoryScope[] | null = null, historyScopeChanged = false;
  if (input.enabled) {
    let granted: ReturnType<typeof grantedHistory> = null;
    try { granted = grantedHistory(await request({}), input.owner); } catch { granted = null; }
    if (granted && !granted.scopes.length) historyCarried = [];
    else if (granted?.scope && historyScopeCovers(granted.scope, input.scope)) historyCarried = granted.scopes;
    else if (granted?.scope) { historyCarried = []; historyScopeChanged = true; }
  }
  const result = await request({ owner: input.owner, enabled: input.enabled, rememberDevice: true, workspaceScopes: [...input.workspaceScopes],
    ...historyGrantFields(historyCarried ?? []), ...input.scope });
  return { result, historyCarried, historyScopeChanged };
}
/** Said when the save left out a history permission: the scope moved away from the one it was granted for, or fail-closed
 *  dropped one the panel's last listing still showed. Otherwise null. */
export function workroomHistoryDropNotice(previous: readonly string[] | undefined, carried: readonly RemoteHistoryScope[] | null, scopeChanged = false): string | null {
  if (scopeChanged) return '저장한 허용 범위가 대화 기록 권한을 허용한 범위와 달라 그 권한은 끈 채로 저장했습니다. 새 범위에서도 필요하면 Mac의 외부 인터넷 QR 원격제어에서 다시 허용하세요.';
  return carried === null && !!previous?.length
    ? '이 기기의 대화 기록 권한을 확인하지 못해 그 권한은 끈 채로 저장했습니다. 필요하면 Mac의 외부 인터넷 QR 원격제어에서 다시 허용하세요.'
    : null;
}
