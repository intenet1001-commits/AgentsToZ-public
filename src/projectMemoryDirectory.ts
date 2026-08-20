/**
 * 배포 포털의 장기기억 목록 판정 한 곳.
 *
 * 포털은 브라우저 단독이라 로컬 API(3001)에 닿을 수 없다. 그래서 여기서 할 수 있는 일은
 * 기억 **내용을 내려받는 것**이 아니라 Supabase 를 직접 읽어 **어떤 기억이 있고 그 ID 가
 * 무엇인지** 보여주는 것이다. 그 ID 를 다른 기기의 앱에 붙여넣는 것이 실제 연동 경로다.
 *
 * 저장소가 없는 기억은 `github_url` 로 서로를 찾을 수 없어 **ID 를 건네는 것이 유일한 길**이다
 * (실측 2026-08-14: 기억 43개 중 36개가 저장소 없음).
 */

/** `portmgr_project_memory_revisions` 에서 목록에 필요한 열만. `content` 는 크므로 뺀다. */
export interface MemoryRevisionRow {
  id: string;
  memory_id: string | null;
  project_name: string | null;
  github_url: string | null;
  device_id: string | null;
  device_name: string | null;
  content_hash: string | null;
  created_at: string | null;
}

export interface MemoryDirectoryEntry {
  memoryId: string;
  /** 가장 최근 리비전이 쓴 이름. 이름은 바뀌어도 memoryId 는 고정이다. */
  projectName: string;
  githubUrl: string | null;
  /** 마지막으로 push 한 기기. */
  lastDeviceName: string | null;
  updatedAt: string | null;
  /** 조회한 구간 안에서 이 기억에 push 한 서로 다른 기기 수. */
  deviceCountInWindow: number;
  /** 조회한 구간 안의 리비전 수. 전체 수가 아니다. */
  revisionsInWindow: number;
}

/**
 * 리비전 목록을 기억 단위로 접는다. PostgREST 에 `DISTINCT ON` 이 없어 최근 N 건을 받아
 * 여기서 접는다 — 그래서 집계값은 **조회 구간 한정**이고, 이름에 그 사실을 담았다.
 *
 * 입력은 정렬을 가정하지 않는다. 호출부가 정렬을 바꿔도 결과가 흔들리면 안 된다.
 */
export function buildMemoryDirectory(rows: readonly MemoryRevisionRow[]): MemoryDirectoryEntry[] {
  const byMemory = new Map<string, {
    latest: MemoryRevisionRow;
    devices: Set<string>;
    revisions: number;
  }>();

  for (const row of rows) {
    const memoryId = (row.memory_id ?? '').trim();
    if (!memoryId) continue;
    const existing = byMemory.get(memoryId);
    if (!existing) {
      byMemory.set(memoryId, {
        latest: row,
        devices: new Set(row.device_id ? [row.device_id] : []),
        revisions: 1,
      });
      continue;
    }
    existing.revisions += 1;
    if (row.device_id) existing.devices.add(row.device_id);
    if (compareCreatedAt(row.created_at, existing.latest.created_at) > 0) existing.latest = row;
  }

  return [...byMemory.entries()]
    .map(([memoryId, group]) => ({
      memoryId,
      // 이름이 빈 리비전만 있는 기억도 목록에서 사라지면 안 된다 — ID 를 건네려면 보여야 한다.
      projectName: (group.latest.project_name ?? '').trim() || '(이름 없음)',
      githubUrl: (group.latest.github_url ?? '').trim() || null,
      lastDeviceName: (group.latest.device_name ?? '').trim() || null,
      updatedAt: group.latest.created_at ?? null,
      deviceCountInWindow: group.devices.size,
      revisionsInWindow: group.revisions,
    }))
    .sort((a, b) => compareCreatedAt(b.updatedAt, a.updatedAt) || a.projectName.localeCompare(b.projectName));
}

/** 값이 없거나 파싱되지 않는 시각은 항상 더 오래된 것으로 둔다. */
function compareCreatedAt(a: string | null | undefined, b: string | null | undefined): number {
  const left = Date.parse(a ?? '');
  const right = Date.parse(b ?? '');
  const leftValid = Number.isFinite(left);
  const rightValid = Number.isFinite(right);
  if (!leftValid && !rightValid) return 0;
  if (!leftValid) return -1;
  if (!rightValid) return 1;
  return left - right;
}

/** 검색어로 거른다. ID 일부만 붙여넣어도 찾아지도록 memoryId 도 대상에 넣는다. */
export function filterMemoryDirectory(
  entries: readonly MemoryDirectoryEntry[],
  query: string,
): MemoryDirectoryEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(entry =>
    entry.projectName.toLowerCase().includes(needle)
    || entry.memoryId.toLowerCase().includes(needle)
    || (entry.githubUrl ?? '').toLowerCase().includes(needle)
    || (entry.lastDeviceName ?? '').toLowerCase().includes(needle));
}

/**
 * 조회 실패를 사람이 다음 행동을 정할 수 있는 문구로 바꾼다.
 *
 * 이 테이블은 `authenticated` 에게만 SELECT 를 준다. `portmgr_ports`·`portmgr_devices` 는
 * anon 에게도 열려 있어서 **세션이 없어도 프로젝트 목록은 정상으로 보인다** — 그래서
 * 사용자는 로그인된 줄 알고 여기만 고장 났다고 읽는다(실측 2026-08-14).
 *
 * 화면 게이트가 localStorage 플래그(`portal_google_verified`)만 보고 통과시키므로
 * 세션이 만료돼도 앱은 그대로 렌더된다. 그때 쿼리는 anon 으로 나가고 42501(permission
 * denied)이 돌아온다. **세션 유무를 모른 채 "정책을 다시 실행하라"고 하면 멀쩡한 DB 를
 * 건드리게 만드는 오답이다** — 그래서 세션 상태를 받아 둘을 갈라 말한다.
 */
export function describeMemoryQueryFailure(error: unknown, hasSession?: boolean): string {
  const message = (error as { message?: string } | null)?.message ?? String(error);
  if (/permission denied|JWT|PGRST301|row-level security/i.test(message)) {
    if (hasSession === false) {
      return `${message}\n\n로그인 세션이 없어 익명(anon)으로 조회됐습니다. 프로젝트 목록은 익명에게도 열려 있어 정상으로 보이지만, 장기기억은 로그인한 사용자만 읽을 수 있습니다. 아래 버튼으로 다시 로그인하세요.`;
    }
    if (hasSession === true) {
      return `${message}\n\n로그인 세션은 있는데 거부됐습니다. Supabase 읽기 정책이 아무 행도 허용하지 않는 상태일 수 있습니다 — 설치 가이드의 테이블/정책 SQL을 다시 실행하세요.`;
    }
    return `${message}\n\n이 테이블은 로그인한 사용자에게만 열립니다. 로그인 상태를 먼저 확인하세요.`;
  }
  if (/does not exist|schema cache|PGRST205/i.test(message)) {
    return `${message}\n\n장기기억 테이블이 아직 없습니다. 설정 마법사의 테이블 생성을 먼저 실행하세요.`;
  }
  return message;
}

/**
 * 프로젝트 행 하나에 붙일 기억을 고른다.
 *
 * `portmgr_ports` 에는 기억을 가리키는 열이 없다. 그래서 저장소 주소와 이름으로 잇는데,
 * **저장소가 먼저**다 — 이름은 바뀌어도 저장소는 그 프로젝트의 계보 키(`github_url`)이기
 * 때문이다(실측 2026-08-14: 이 기기 9개 중 저장소로 4개, 이름으로 4개가 더 붙어 8개 연결).
 *
 * 후보가 여럿이면 **고르지 않는다**. 틀린 ID 를 복사해 다른 기기의 기억에 합류시키면
 * 남의 기억 위에 이 프로젝트를 얹게 되므로, 애매할 때는 아무것도 보여주지 않는 편이 낫다.
 */
export function matchMemoryForProject(
  entries: readonly MemoryDirectoryEntry[],
  project: { name?: string | null; githubUrl?: string | null; memoryId?: string | null },
): MemoryDirectoryEntry | null {
  // 행이 ID 를 직접 들고 있으면 추측하지 않는다 — 앱이 프로젝트 폴더의
  // `.agent-memory/config.json` 에서 읽어 실은 값이다. 기억 대부분은 저장소가 없고
  // 폴더 이름은 바뀌므로, 간접 키는 이 값이 없을 때만 쓰는 폴백이다.
  const exact = (project.memoryId ?? '').trim();
  if (exact) {
    const byId = entries.find(entry => entry.memoryId === exact);
    // 목록(최근 N건)에 그 기억이 없을 수도 있다. 그때는 간접 키로 내려가지 않는다 —
    // ID 를 아는데 다른 기억을 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.
    return byId ?? null;
  }
  const repo = (project.githubUrl ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  if (repo) {
    const byRepo = entries.filter(entry =>
      (entry.githubUrl ?? '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '') === repo);
    if (byRepo.length === 1) return byRepo[0]!;
    if (byRepo.length > 1) return null;
  }
  const name = (project.name ?? '').trim().toLowerCase();
  if (!name) return null;
  const byName = entries.filter(entry => entry.projectName.trim().toLowerCase() === name);
  return byName.length === 1 ? byName[0]! : null;
}

/**
 * 기억 목록을 두 소비자(프로젝트 행의 칩 · 장기기억 탭)가 **공유**한다.
 *
 * 예전에는 각자 1,000행을 받았고, 각 컴포넌트가 마운트 직후와 `INITIAL_SESSION`
 * 콜백에서 두 번씩 쐈다. 같은 화면을 그리는 데 최대 4회가 나갔다.
 * in-flight 프라미스를 재사용하면 그 중복이 저절로 접힌다.
 */
export const MEMORY_LIST_COLUMNS =
  'id, memory_id, project_name, github_url, device_id, device_name, content_hash, created_at';

/** 한 번에 읽어올 리비전 수. 이 값에 닿으면 목록이 잘린 것이므로 호출부가 그 사실을 말한다. */
export const MEMORY_REVISION_WINDOW = 1000;

export interface MemoryDirectoryLoad {
  entries: MemoryDirectoryEntry[];
  /** 조회 구간을 가득 채웠는가 — 잘렸을 수 있다는 뜻이다. */
  windowFull: boolean;
}

interface CacheSlot {
  at: number;
  inFlight: Promise<MemoryDirectoryLoad> | null;
  value: MemoryDirectoryLoad | null;
}

const cache = new Map<string, CacheSlot>();
/** 짧게 잡는다 — 목적은 "같은 화면을 그리는 동시 요청 합치기"이지 오래 캐싱하는 것이 아니다. */
const TTL_MS = 30_000;

/** supabase 쿼리 빌더는 Promise 가 아니라 thenable 이라 PromiseLike 로 받는다. */
type MemoryQuery = () => PromiseLike<{ data: unknown; error: unknown }>;

/**
 * @param key    `url::anonKey` — 프로젝트가 바뀌면 캐시도 갈린다.
 * @param query  실제 조회. 호출부가 supabase 클라이언트를 쥐고 있으므로 주입받는다.
 * @param force  「새로고침」 버튼만 쓴다.
 */
export async function loadMemoryDirectory(
  key: string,
  query: MemoryQuery,
  options: { force?: boolean; now?: number } = {},
): Promise<MemoryDirectoryLoad> {
  const now = options.now ?? Date.now();
  const slot = cache.get(key);
  if (!options.force && slot) {
    if (slot.inFlight) return slot.inFlight;
    if (slot.value && now - slot.at < TTL_MS) return slot.value;
  }
  const inFlight = (async () => {
    const { data, error } = await query();
    if (error) throw error;
    const rows = (data ?? []) as MemoryRevisionRow[];
    return { entries: buildMemoryDirectory(rows), windowFull: rows.length >= MEMORY_REVISION_WINDOW };
  })();
  cache.set(key, { at: now, inFlight, value: slot?.value ?? null });
  try {
    const value = await inFlight;
    cache.set(key, { at: now, inFlight: null, value });
    return value;
  } catch (error) {
    // 실패는 캐싱하지 않는다 — 다음 시도가 즉시 다시 나가야 한다.
    cache.delete(key);
    throw error;
  }
}

/** 테스트 전용 — 캐시를 비운다. */
export function resetMemoryDirectoryCache(): void {
  cache.clear();
}
