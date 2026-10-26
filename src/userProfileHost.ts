import { UserProfileStore } from './userProfileStore';
import { type PromptGuideKeyProvider } from './promptGuideKeyProvider';
import {
  normalizeUserProfileSave, normalizeUserProfileRecallRequest, UserProfileError,
  type UserProfileSave, type UserProfileRecall,
} from './userProfileContract';

export const USER_PROFILE_PATH = '/api/user-profile';
export const USER_PROFILE_HTTP_MAX_BYTES = 768 * 1024;
export const USER_PROFILE_HTTP_BODY_TIMEOUT_MS = 5_000;
export const USER_PROFILE_POLICY = Object.freeze({
  currentInstructionWins: true, grantsAuthority: false, automaticModelOrAccountChanges: false,
});
/** Private registry evidence, never a path, credential, or OPS/person identity. */
export interface UserProfileRegisteredProject { projectId: string; memoryId: string; name: string }
function fail(code: string): never { throw new UserProfileError(code); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) fail('USER_PROFILE_INVALID_INPUT');
  return value as Record<string, unknown>;
}

/** Lazy local storage; construction and registry listing do not read OS credentials. */
export class UserProfileHost {
  readonly #store: UserProfileStore;
  constructor(readonly options: {
    appDataDir: string;
    keyProvider?: PromptGuideKeyProvider;
    /** Must freshly resolve initialized DEV/managed registrations and exclude OPS. No cache. */
    registeredProjects: () => Promise<UserProfileRegisteredProject[]>;
    /** Narrow fresh admission avoids enumerating every project's memory on an MCP read. */
    resolveProject?: (projectId: string) => Promise<UserProfileRegisteredProject | null>;
  }) {
    this.#store = new UserProfileStore({ appDataDir: options.appDataDir, keyProvider: options.keyProvider,
      beforeCommit: save => this.#validateScopes(save) });
  }
  #validated(rows: UserProfileRegisteredProject[]): UserProfileRegisteredProject[] {
    if (!Array.isArray(rows) || rows.length > 1_000) fail('USER_PROFILE_PROJECTS_UNAVAILABLE');
    const seen = new Set<string>();
    return rows.map(row => {
      if (!row || typeof row.projectId !== 'string' || !row.projectId || row.projectId.length > 200
        || seen.has(row.projectId) || typeof row.name !== 'string' || !row.name.trim()
        || !row.name.isWellFormed() || Array.from(row.name).length > 240 || /[\x00-\x1f\x7f]/.test(row.name)) fail('USER_PROFILE_PROJECTS_UNAVAILABLE');
      seen.add(row.projectId);
      let memoryId: string;
      try { memoryId = normalizeUserProfileRecallRequest({ projectMemoryId: row.memoryId }).projectMemoryId!; }
      catch { return fail('USER_PROFILE_PROJECTS_UNAVAILABLE'); }
      if (!memoryId) fail('USER_PROFILE_PROJECTS_UNAVAILABLE');
      return { projectId: row.projectId, memoryId, name: row.name };
    });
  }
  async #registered(): Promise<UserProfileRegisteredProject[]> {
    return this.#validated(await this.options.registeredProjects());
  }
  async #resolve(projectId: string): Promise<UserProfileRegisteredProject | undefined> {
    if (!this.options.resolveProject) return (await this.#registered()).find(row => row.projectId === projectId);
    const row = await this.options.resolveProject(projectId);
    if (!row) return undefined;
    const validated = this.#validated([row])[0]!;
    if (validated.projectId !== projectId) fail('USER_PROFILE_SCOPE_UNAVAILABLE');
    return validated;
  }
  async #validateScopes(save: UserProfileSave): Promise<void> {
    if (!save.entries.some(entry => entry.scope === 'project' && entry.state === 'active')) return;
    const allowed = new Set((await this.#registered()).map(row => row.memoryId));
    if (save.entries.some(entry => entry.scope === 'project' && entry.state === 'active' && !allowed.has(entry.projectMemoryId!))) fail('USER_PROFILE_SCOPE_UNAVAILABLE');
  }
  async projects(): Promise<Array<{ memoryId: string; name: string }>> {
    const projects = new Map<string, { memoryId: string; name: string }>();
    for (const row of await this.#registered()) if (!projects.has(row.memoryId)) projects.set(row.memoryId, { memoryId: row.memoryId, name: row.name });
    return [...projects.values()];
  }
  async perform(value: unknown) {
    const operation = (value as { operation?: unknown } | null)?.operation;
    if (operation === 'read') {
      exact(value, ['operation']);
      return { storage: 'local' as const, profile: await this.#store.read(), policy: USER_PROFILE_POLICY };
    }
    if (operation === 'projects') {
      exact(value, ['operation']);
      return { storage: 'local' as const, projects: await this.projects() };
    }
    const row = exact(value, ['operation', 'confirmed', 'expectedRevision', 'entries']);
    if (operation !== 'save') fail('USER_PROFILE_INVALID_INPUT');
    if (row.confirmed !== true) fail('USER_PROFILE_CONFIRMATION_REQUIRED');
    const save = normalizeUserProfileSave({ expectedRevision: row.expectedRevision, entries: row.entries });
    // Reject invalid scopes before even creating a credential; the store repeats this
    // after credential awaits, immediately before the synchronous atomic commit.
    await this.#validateScopes(save);
    return { storage: 'local' as const, profile: await this.#store.save(save), policy: USER_PROFILE_POLICY };
  }
  /** Exact current project admission before and after a possibly asynchronous key read. */
  async recallForProject(projectId: string, query?: string): Promise<UserProfileRecall> {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200) fail('USER_PROFILE_INVALID_INPUT');
    const project = await this.#resolve(projectId);
    if (!project) fail('USER_PROFILE_SCOPE_UNAVAILABLE');
    const input = normalizeUserProfileRecallRequest({ projectMemoryId: project.memoryId, ...(query === undefined ? {} : { query }) });
    const recalled = await this.#store.recall(input);
    const current = await this.#resolve(projectId);
    if (!current || current.memoryId !== project.memoryId) fail('USER_PROFILE_SCOPE_UNAVAILABLE');
    return recalled;
  }
}

const errors: Readonly<Record<string, { status: number; error: string }>> = {
  USER_PROFILE_ORIGIN_DENIED: { status: 403, error: '사용자 프로필은 이 기기의 AgentsToZ 화면에서만 관리할 수 있습니다.' },
  USER_PROFILE_NOT_FOUND: { status: 404, error: '사용자 프로필 요청 경로를 확인하세요.' },
  USER_PROFILE_METHOD_NOT_ALLOWED: { status: 405, error: '사용자 프로필 요청은 POST 방식만 허용됩니다.' },
  USER_PROFILE_INVALID_INPUT: { status: 400, error: '사용자 프로필 입력 형식을 확인하세요. 현재 초안은 유지됩니다.' },
  USER_PROFILE_CONFIRMATION_REQUIRED: { status: 400, error: '사용자가 직접 확인한 항목만 저장할 수 있습니다.' },
  USER_PROFILE_JSON_REQUIRED: { status: 415, error: '압축하지 않은 JSON 요청이 필요합니다.' },
  USER_PROFILE_BODY_TOO_LARGE: { status: 413, error: '사용자 프로필 요청 용량이 너무 큽니다.' },
  USER_PROFILE_LIMIT_EXCEEDED: { status: 413, error: '사용자 프로필 저장 용량 한도를 넘었습니다.' },
  USER_PROFILE_BODY_TIMEOUT: { status: 408, error: '요청 본문을 받는 시간이 초과되었습니다. 저장을 시작하지 않았습니다.' },
  USER_PROFILE_CONFLICT: { status: 409, error: '다른 창에서 프로필이 바뀌었습니다. 다시 읽어 비교하세요. 현재 초안은 유지됩니다.' },
  USER_PROFILE_SCOPE_UNAVAILABLE: { status: 409, error: '선택한 프로젝트의 등록과 장기기억 연결을 다시 확인하세요.' },
  USER_PROFILE_PROJECTS_UNAVAILABLE: { status: 503, error: '현재 등록된 프로젝트 목록을 확인하지 못했습니다.' },
  USER_PROFILE_LOCKED: { status: 423, error: '다른 창에서 프로필을 저장하고 있습니다. 잠시 후 다시 시도하세요.' },
  USER_PROFILE_LOCK_LOST: { status: 409, error: '저장 권한이 변경되었습니다. 프로필을 다시 읽어 확인하세요.' },
  USER_PROFILE_RESULT_UNCERTAIN: { status: 503, error: '저장 결과가 미확정입니다. 자동으로 재시도하지 말고 프로필을 다시 읽어 비교하세요.' },
  USER_PROFILE_RECOVERY_REQUIRED: { status: 503, error: '프로필 저장소의 복구 확인이 필요합니다. 기존 자료와 현재 초안은 유지됩니다.' },
  USER_PROFILE_CORRUPT: { status: 503, error: '저장한 프로필을 읽을 수 없습니다. 기존 자료는 유지됩니다.' },
  USER_PROFILE_SCHEMA_UNSUPPORTED: { status: 503, error: '더 새로운 프로필 저장 형식입니다. 앱을 업데이트하세요.' },
  USER_PROFILE_PATH_UNSAFE: { status: 503, error: '프로필 저장 경로를 확인하지 못했습니다.' },
  USER_PROFILE_FILE_TOO_LARGE: { status: 503, error: '프로필 저장 파일의 크기를 확인해야 합니다.' },
  USER_PROFILE_KEY_MISSING: { status: 503, error: '프로필 암호화 키를 찾을 수 없습니다. 키나 파일을 새로 덮어쓰지 않습니다.' },
  USER_PROFILE_KEY_UNAVAILABLE: { status: 503, error: '프로필 암호화 키에 접근할 수 없습니다. 잠금 상태를 확인하세요.' },
  USER_PROFILE_KEY_MALFORMED: { status: 503, error: '프로필 암호화 키를 확인하지 못했습니다. 기존 자료는 유지됩니다.' },
  USER_PROFILE_KEY_UNSUPPORTED: { status: 503, error: '이 운영체제에서는 프로필 암호화 저장을 지원하지 않습니다.' },
  USER_PROFILE_UNAVAILABLE: { status: 503, error: '프로필 요청 결과를 확인하지 못했습니다. 현재 상태를 다시 읽어 확인하세요.' },
};
export function userProfilePublicError(error: unknown) {
  const requested = error instanceof UserProfileError ? error.code : '';
  const code = Object.hasOwn(errors, requested) ? requested : 'USER_PROFILE_UNAVAILABLE';
  return { code, ...errors[code]! };
}

/** Bounded streaming JSON: reject length/encoding before allocation or credentials. */
async function readJson(req: Request): Promise<unknown> {
  const type = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const encoding = req.headers.get('content-encoding')?.trim().toLowerCase();
  if (type !== 'application/json' || (encoding && encoding !== 'identity')) fail('USER_PROFILE_JSON_REQUIRED');
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail('USER_PROFILE_INVALID_INPUT');
  if (declared !== null && Number(declared) > USER_PROFILE_HTTP_MAX_BYTES) fail('USER_PROFILE_BODY_TOO_LARGE');
  const reader = req.body?.getReader();
  if (!reader) fail('USER_PROFILE_INVALID_INPUT');
  const bytes = new Uint8Array(USER_PROFILE_HTTP_MAX_BYTES);
  let size = 0, stopped = false, completed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UserProfileError('USER_PROFILE_BODY_TIMEOUT')), USER_PROFILE_HTTP_BODY_TIMEOUT_MS);
    aborted = () => reject(new UserProfileError('USER_PROFILE_INVALID_INPUT'));
    req.signal.addEventListener('abort', aborted, { once: true });
    if (req.signal.aborted) aborted();
  });
  try {
    const body = async () => {
      for (;;) {
        const part = await reader.read();
        if (stopped) fail('USER_PROFILE_INVALID_INPUT');
        if (part.done) break;
        if (size + part.value.byteLength > bytes.length) fail('USER_PROFILE_BODY_TOO_LARGE');
        bytes.set(part.value, size); size += part.value.byteLength;
      }
      if (declared !== null && Number(declared) !== size) fail('USER_PROFILE_INVALID_INPUT');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
      catch { return fail('USER_PROFILE_INVALID_INPUT'); }
    };
    const value = await Promise.race([body(), deadline]);
    completed = true;
    return value;
  } catch (error) {
    if (error instanceof UserProfileError) throw error;
    return fail('USER_PROFILE_INVALID_INPUT');
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    if (aborted) req.signal.removeEventListener('abort', aborted);
    bytes.fill(0);
    if (!completed) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* cancellation must not delay the response */ }
  }
}

/** Local management origin admission is mandatory and precedes body/store access. */
export async function handleUserProfileRequest(req: Request, host: Pick<UserProfileHost, 'perform'>,
  options: { authorize: (req: Request) => boolean; headers?: HeadersInit }): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Origin');
  try {
    if (!options.authorize(req)) fail('USER_PROFILE_ORIGIN_DENIED');
    const url = new URL(req.url);
    if (url.pathname !== USER_PROFILE_PATH) fail('USER_PROFILE_NOT_FOUND');
    if (req.method !== 'POST') fail('USER_PROFILE_METHOD_NOT_ALLOWED');
    if (url.search || req.url.includes('?') || url.hash) fail('USER_PROFILE_INVALID_INPUT');
    return Response.json({ success: true, ...await host.perform(await readJson(req)) }, { headers });
  } catch (error) {
    const detail = userProfilePublicError(error);
    if (detail.status === 405) headers.set('Allow', 'POST');
    if (detail.status === 413 || detail.status === 408) {
      headers.set('Connection', 'close');
      if (req.body && !req.body.locked) void req.body.cancel().catch(() => {});
    }
    return Response.json({ success: false, code: detail.code, error: detail.error }, { status: detail.status, headers });
  }
}
