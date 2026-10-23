/** A USE choice shares its registered project ID; the role is never a folder or a new registration. */
export interface ProjectUseMention {
  useServices?: string[];
  executionRole?: 'dev' | 'use';
  serviceKey?: string;
}
export const SERVICE_USE_CHANGED_EVENT = 'agentstoz:service-use-changed';
const serviceKeyPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function normalizeUseServices(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some(k => typeof k !== 'string' || !serviceKeyPattern.test(k))
    || new Set(value).size !== value.length) throw Error('USE 호출 목록을 확인하세요.');
  return [...value] as string[];
}
export function useMentionLabel(label: string, serviceKey = 'default'): string {
  return `${label}-USE${serviceKey === 'default' ? '' : ':' + serviceKey}`;
}
export function projectMentionKey(project: {targetId: string} & ProjectUseMention): string {
  return project.executionRole === 'use' ? `use:${project.targetId}:${project.serviceKey ?? 'default'}` : project.targetId;
}
export function projectMentionChoices<T extends {targetId: string; label: string; scope?: string} & ProjectUseMention>(projects: readonly T[]): T[] {
  const rows: T[] = [], seen = new Set<string>();
  const add = (p: T) => {const key = projectMentionKey(p); if (!seen.has(key)) {seen.add(key); rows.push(p);}};
  for (const project of projects) {
    add(project);
    if (project.executionRole === 'use' || project.scope === 'worktree') continue;
    for (const serviceKey of project.useServices ?? []) add({...project, label: useMentionLabel(project.label, serviceKey), executionRole: 'use', serviceKey});
  }
  return rows;
}
/** Kept opaque on the wire. The host rechecks the parent grant and reads only the selected USE memory. */
export function useReferenceId(targetId: string, serviceKey = 'default'): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId) || !serviceKeyPattern.test(serviceKey)) throw Error('USE 참고 대상을 확인하세요.');
  return `use:${targetId}:${serviceKey}`;
}
export function parseUseReferenceId(value: string): {targetId: string; serviceKey: string} | null {
  if (!value.startsWith('use:')) return null;
  const match = /^use:([A-Za-z0-9_-]{1,128}):([a-z0-9][a-z0-9_-]{0,63})$/.exec(value);
  if (!match) throw Error('USE 참고 대상을 확인하세요.');
  return {targetId: match[1]!, serviceKey: match[2]!};
}
