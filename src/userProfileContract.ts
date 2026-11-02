/** User-confirmed data on this OS user's device. It grants no execution authority. */
export interface UserProfileEntry {
  id: string;
  title: string;
  body: string;
  scope: 'all-projects' | 'project';
  projectMemoryId: string | null;
  state: 'active' | 'inactive';
  updatedAt: string;
  origin: 'user-confirmed';
}
export interface UserProfileSnapshot { revision: string; entries: UserProfileEntry[] }
export interface UserProfileSave { expectedRevision: string; entries: UserProfileEntry[] }
export interface UserProfileRecallRequest { projectMemoryId: string | null; query?: string; includeExplanation?: boolean }
export interface UserProfileExplanation {
  scope: 'this-device'; projectMemoryId: string | null; comparisonScope: 'returned-entries';
  selections: Array<{entryId: string; scope: UserProfileEntry['scope']; matchedTerms: string[]; fields: Array<'title' | 'body'>; reason: 'query-match' | 'active-in-scope'}>;
  overlaps: Array<{entryIds: [string, string]; reason: 'same-title-different-content'}>;
}
export interface UserProfileRecall extends UserProfileSnapshot { truncated: boolean; explanation?: UserProfileExplanation }
export const USER_PROFILE_MAX_ENTRIES = 64;
export const USER_PROFILE_MAX_BODY_BYTES = 4_000;
export const USER_PROFILE_RECALL_MAX_HITS = 5;
export const USER_PROFILE_RECALL_MAX_BYTES = 8_000;

export class UserProfileError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'UserProfileError'; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
function invalid(): never { throw new UserProfileError('USER_PROFILE_INVALID_INPUT'); }
function record(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || keys.some(key => !Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))) invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function revision(value: unknown): string { return value === '0' ? '0' : uuid(value); }
function entries(value: unknown): UserProfileEntry[] {
  if (!Array.isArray(value) || value.length > USER_PROFILE_MAX_ENTRIES) invalid();
  const seen = new Set<string>();
  return value.map(item => {
    const row = record(item, ['id', 'title', 'body', 'scope', 'projectMemoryId', 'state', 'updatedAt', 'origin']);
    const id = uuid(row.id);
    if (seen.has(id) || typeof row.title !== 'string' || !row.title.trim() || !row.title.isWellFormed()
      || Array.from(row.title).length > 120 || /[\x00-\x1f\x7f]/.test(row.title)
      || typeof row.body !== 'string' || !row.body.trim() || !row.body.isWellFormed()
      || bytes(row.body) > USER_PROFILE_MAX_BODY_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(row.body)
      || (row.scope !== 'all-projects' && row.scope !== 'project')
      || (row.state !== 'active' && row.state !== 'inactive') || row.origin !== 'user-confirmed'
      || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))
      || new Date(row.updatedAt).toISOString() !== row.updatedAt) invalid();
    const projectMemoryId = row.scope === 'project' ? uuid(row.projectMemoryId) : null;
    if (row.scope === 'all-projects' && row.projectMemoryId !== null) invalid();
    seen.add(id);
    return { id, title: row.title, body: row.body, scope: row.scope, projectMemoryId,
      state: row.state, updatedAt: row.updatedAt, origin: 'user-confirmed' };
  });
}
export function normalizeUserProfileSave(value: unknown): UserProfileSave {
  const row = record(value, ['expectedRevision', 'entries']);
  return { expectedRevision: revision(row.expectedRevision), entries: entries(row.entries) };
}
export const validateUserProfileSave = normalizeUserProfileSave;
export function normalizeUserProfileSnapshot(value: unknown): UserProfileSnapshot {
  const row = record(value, ['revision', 'entries']);
  const result = { revision: revision(row.revision), entries: entries(row.entries) };
  if (result.revision === '0' && result.entries.length !== 0) invalid();
  return result;
}
export function normalizeUserProfileRecallRequest(value: unknown): UserProfileRecallRequest {
  const row = record(value, ['projectMemoryId'], ['query', 'includeExplanation']);
  const projectMemoryId = row.projectMemoryId === null ? null : uuid(row.projectMemoryId);
  if (Object.hasOwn(row, 'includeExplanation') && typeof row.includeExplanation !== 'boolean') invalid();
  const extra = row.includeExplanation === true ? {includeExplanation: true} : {};
  if (!Object.hasOwn(row, 'query')) return { projectMemoryId, ...extra };
  if (typeof row.query !== 'string' || !row.query.isWellFormed() || bytes(row.query) > 1_024
    || /[\x00-\x1f\x7f]/.test(row.query)) invalid();
  const query = row.query.normalize('NFKC').trim();
  if (bytes(query) > 1_024) invalid();
  return { projectMemoryId, query, ...extra };
}

/** Lexical matching only. No AI, history lookup, collection, or implicit project fallback. */
export function selectUserProfileRecall(value: UserProfileSnapshot, request: UserProfileRecallRequest): UserProfileRecall {
  const snapshot = normalizeUserProfileSnapshot(value), input = normalizeUserProfileRecallRequest(request);
  const query = (input.query ?? '').toLocaleLowerCase('en-US');
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  const candidates = snapshot.entries.flatMap((entry, order) => {
    if (entry.state !== 'active' || (entry.scope === 'project' && entry.projectMemoryId !== input.projectMemoryId)) return [];
    const title = entry.title.normalize('NFKC').toLocaleLowerCase('en-US'), body = entry.body.normalize('NFKC').toLocaleLowerCase('en-US');
    const score = query ? (title.includes(query) ? 8 : 0) + (body.includes(query) ? 2 : 0)
      + tokens.reduce((sum, token) => sum + (title.includes(token) ? 3 : 0) + (body.includes(token) ? 1 : 0), 0) : 1;
    return score > 0 ? [{ entry, score, order }] : [];
  }).sort((a, b) => b.score - a.score || a.order - b.order);
  const result: UserProfileRecall = { revision: snapshot.revision, entries: [], truncated: false };
  const explanation = (selected: UserProfileEntry[]): UserProfileExplanation => {
    const overlaps: UserProfileExplanation['overlaps'] = [];
    for (let a = 0; a < selected.length; a++) for (let b = a + 1; b < selected.length; b++) {
      const left = selected[a]!, right = selected[b]!;
      if (left.title.normalize('NFKC').toLocaleLowerCase('en-US').trim() === right.title.normalize('NFKC').toLocaleLowerCase('en-US').trim()
        && left.body.normalize('NFC').replace(/\r\n?/g, '\n') !== right.body.normalize('NFC').replace(/\r\n?/g, '\n'))
        overlaps.push({entryIds: [left.id, right.id], reason: 'same-title-different-content'});
    }
    return {scope: 'this-device', projectMemoryId: input.projectMemoryId, comparisonScope: 'returned-entries',
      selections: selected.map(entry => {
        const title = entry.title.normalize('NFKC').toLocaleLowerCase('en-US'), body = entry.body.normalize('NFKC').toLocaleLowerCase('en-US');
        const matched = tokens.length ? tokens.filter(token => title.includes(token) || body.includes(token)) : query && (title.includes(query) || body.includes(query)) ? [query] : [];
        return {entryId: entry.id, scope: entry.scope, matchedTerms: matched.slice(0, 8).map(token => [...token].slice(0, 64).join('')),
          fields: [...(query && (title.includes(query) || tokens.some(t => title.includes(t))) ? ['title' as const] : []),
            ...(query && (body.includes(query) || tokens.some(t => body.includes(t))) ? ['body' as const] : [])], reason: query ? 'query-match' : 'active-in-scope'};
      }), overlaps};
  };
  for (const { entry } of candidates) {
    const selected = [...result.entries, entry], details = input.includeExplanation ? {explanation: explanation(selected)} : {};
    if (result.entries.length >= USER_PROFILE_RECALL_MAX_HITS
      || bytes(JSON.stringify({ ...result, entries: selected, truncated: false, ...details })) > USER_PROFILE_RECALL_MAX_BYTES) {
      result.truncated = true;
      continue;
    }
    result.entries.push(entry);
  }
  if (input.includeExplanation) result.explanation = explanation(result.entries);
  return result;
}
