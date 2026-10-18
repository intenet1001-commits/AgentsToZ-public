import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { withCodexExperimentalAppServer, type SpawnCodexAppServer } from './codexFirstConversation';
import { sameCodexWorkspacePath, normalizeCodexWorkspacePath } from './codexDesktopProjectBinding';

export type CodexBackendProjectRegistration = {
  backendRegistered: true; backendProjectId: string; reused: boolean;
};
type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null;
const project = (v: unknown): { id: string; roots: { path: string }[] } | null => {
  const p = record(v);
  if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.id) || !Array.isArray(p.roots)) return null;
  const roots = p.roots.map(record);
  if (roots.some(r => !r || typeof r.path !== 'string')) return null;
  return { id: p.id, roots: roots as { path: string }[] };
};
const matches = (p: { roots: { path: string }[] }, folderPath: string) => p.roots.some(r => sameCodexWorkspacePath(r.path, folderPath));

/** A deterministic UUID keeps a lost create receipt retry-safe across sidecar processes. */
export function codexProjectIdempotencyKey(codexHome: string, folderPath: string): string {
  const hex = createHash('sha1').update(JSON.stringify(['agentstoz-project-v1', 'local', normalizeCodexWorkspacePath(codexHome), normalizeCodexWorkspacePath(folderPath)])).digest('hex').slice(0, 32);
  const variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** List every page before deciding absence. Names never identify a project. */
export async function reconcileCodexBackendProject(input: {
  folderPath: string; codexHome: string;
  request: (method: string, params: RecordValue) => Promise<RecordValue>;
}): Promise<CodexBackendProjectRegistration> {
  const projects = new Map<string, ReturnType<typeof project>>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await input.request('project/list', { cursor, limit: 100 });
    if (!Array.isArray(result.data) || !(result.nextCursor === null || typeof result.nextCursor === 'string')) throw new Error('Invalid project inventory.');
    for (const row of result.data) {
      const parsed = project(row);
      if (!parsed) throw new Error('Invalid project record.');
      const previous = projects.get(parsed.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) throw new Error('Conflicting project records.');
      projects.set(parsed.id, parsed);
    }
    cursor = result.nextCursor as string | null;
    if (cursor === null) break;
    if (!cursor || cursors.has(cursor) || page === 19) throw new Error('Incomplete project inventory.');
    cursors.add(cursor);
  }
  const existing = [...projects.values()].filter(p => p && matches(p, input.folderPath));
  if (existing.length > 1) throw new Error('Ambiguous project roots.');
  const reused = existing.length === 1;
  let found = existing[0];
  if (!found) {
    const created = await input.request('project/create', {
      name: basename(input.folderPath), roots: [{ path: input.folderPath }],
      idempotencyKey: codexProjectIdempotencyKey(input.codexHome, input.folderPath),
    });
    found = project(created.project);
  }
  if (!found || !matches(found, input.folderPath)) throw new Error('Project creation did not preserve the existing folder.');
  const readback = project((await input.request('project/read', { projectId: found.id })).project);
  if (!readback || readback.id !== found.id || !matches(readback, input.folderPath)) throw new Error('Project readback did not confirm its identity and root.');
  return { backendRegistered: true, backendProjectId: found.id, reused };
}

export function ensureCodexBackendProject(input: {
  codexPath: string; folderPath: string; env?: Record<string, string | undefined>; spawn?: SpawnCodexAppServer;
}): Promise<CodexBackendProjectRegistration> {
  return withCodexExperimentalAppServer(input, client => reconcileCodexBackendProject({ ...client, folderPath: input.folderPath }));
}
