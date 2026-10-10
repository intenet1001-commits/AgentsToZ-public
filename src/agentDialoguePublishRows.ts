/**
 * The one place that decides what the «이 기기에서 공개 중» list shows.
 *
 * A checkbox there reflects the published endpoint state itself, not a staged
 * selection. The panel used to hold its own `['ops']` selection that never read
 * the host's enabled list, so a device with many published targets still read
 * «1/101개 선택» and looked as if only 총괄 were connected.
 *
 * ⚠️ Turning a target off revokes its endpoint, and turning it back on registers
 * a **new** endpointId that standing invitations and rooms do not follow. The
 * row state is derived here and the panel confirms every unpublish.
 */
export interface AgentDialoguePublishTarget { id: string; name: string }

export interface AgentDialoguePublishEnabled {
  target: string;
  kind: 'ops' | 'project';
  portId?: string;
  endpointId: string;
  displayName: string;
}

export type AgentDialoguePublishIntent = 'publish' | 'unpublish';

export interface AgentDialoguePublishRow {
  id: string;
  name: string;
  kind: 'ops' | 'project';
  /** What the host reports right now. */
  published: boolean;
  /** A change for this row is in flight; the checkbox shows the intent instead. */
  pending: AgentDialoguePublishIntent | null;
  endpointId: string | null;
  /** Published, but no longer a registered local target — still offer 연결 끄기. */
  missing: boolean;
}

/** `status.enabled[].target` is `'ops'` or `project:<portId>`; prefer the explicit fields. */
export function agentDialoguePublishId(item: AgentDialoguePublishEnabled): string {
  if (item.kind === 'ops') return 'ops';
  if (typeof item.portId === 'string' && item.portId) return item.portId;
  return item.target.startsWith('project:') ? item.target.slice('project:'.length) : item.target;
}

export function agentDialoguePublishedIds(enabled: readonly AgentDialoguePublishEnabled[]): string[] {
  const out: string[] = [];
  for (const item of enabled) {
    const id = agentDialoguePublishId(item);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

export function agentDialoguePublishRows({ targets, enabled, inFlight, search }: {
  targets: readonly AgentDialoguePublishTarget[];
  enabled: readonly AgentDialoguePublishEnabled[] | null;
  inFlight?: ReadonlyMap<string, AgentDialoguePublishIntent> | null;
  search?: string;
}): AgentDialoguePublishRow[] {
  const published = new Map<string, AgentDialoguePublishEnabled>();
  for (const item of enabled ?? []) {
    const id = agentDialoguePublishId(item);
    if (id && !published.has(id)) published.set(id, item);
  }
  const rows: AgentDialoguePublishRow[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    const match = published.get(target.id);
    rows.push({
      id: target.id,
      name: target.name,
      kind: target.id === 'ops' ? 'ops' : 'project',
      published: match !== undefined,
      pending: inFlight?.get(target.id) ?? null,
      endpointId: match?.endpointId ?? null,
      missing: false,
    });
  }
  // A published target the local app no longer lists must stay reachable to turn off.
  for (const [id, item] of published) {
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: item.displayName || id,
      kind: item.kind,
      published: true,
      pending: inFlight?.get(id) ?? null,
      endpointId: item.endpointId,
      missing: true,
    });
  }
  const needle = normalize(search ?? '');
  if (!needle) return rows;
  return rows.filter(row => normalize(row.name).includes(needle));
}

/** What the checkbox shows: the in-flight intent while one is pending. */
export function agentDialogueRowChecked(row: AgentDialoguePublishRow): boolean {
  return row.pending === null ? row.published : row.pending === 'publish';
}

/** Header counts come from the unfiltered rows so a search never understates them. */
export function agentDialoguePublishSummary(rows: readonly AgentDialoguePublishRow[]): {
  published: number; total: number; missing: number;
} {
  let publishedCount = 0, missing = 0, total = 0;
  for (const row of rows) {
    if (!row.missing) total += 1; else missing += 1;
    if (agentDialogueRowChecked(row)) publishedCount += 1;
  }
  return { published: publishedCount, total, missing };
}
