/**
 * Names for Workroom session tabs. Two sessions of the same project and AI used to share one
 * label ("ai-trend-monitor · codex" twice), so the user could not tell which tab was which —
 * in the main window or in a pop-out. Duplicates get " #n" in start order (oldest #1); a
 * unique session keeps the plain name.
 */
export interface WorkroomSessionLabelInput {
  id: string;
  targetId: string;
  agent: string;
  createdAt: string;
}

export function workroomSessionLabels(
  sessions: readonly WorkroomSessionLabelInput[],
  projectLabel: (targetId: string) => string | undefined,
): Map<string, string> {
  const base = (s: WorkroomSessionLabelInput) => `${projectLabel(s.targetId) ?? '프로젝트'} · ${s.agent}`;
  const groups = new Map<string, WorkroomSessionLabelInput[]>();
  for (const session of sessions) {
    const key = base(session);
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  const labels = new Map<string, string>();
  for (const [key, members] of groups) {
    const [only] = members;
    if (members.length === 1 && only) { labels.set(only.id, key); continue; }
    [...members]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .forEach((session, index) => labels.set(session.id, `${key} #${index + 1}`));
  }
  return labels;
}

/** Local start time for a tab tooltip, e.g. "09:54 시작". */
export function workroomSessionStartedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 시작`;
}
