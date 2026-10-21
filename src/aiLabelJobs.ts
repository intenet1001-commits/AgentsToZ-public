import {normalizeSearchAliases, PortAiLabelPatchError, type PortAiLabelExpected} from './portAiLabelPatch';
import {portAiLabelExpected, portAiLabelExpectedWithAliases} from './portAiLabelView';

/**
 * AI 이름·카테고리·검색 별칭 보충을 **OPS 워크룸 AI**에게 맡기는 작업 장부.
 *
 * 예전 경로는 15개씩 `claude -p`를 새로 띄워 한 번에 답을 받았다 — 출력이 길어지면 잘리고, 폴더를
 * 직접 열어 볼 수 없었다. 이제 앱이 작업 하나를 만들고 OPS 워크룸에 짧은 지시만 보내면, 그 AI가
 * MCP로 20개씩 읽고(`readAiLabelJobPage`) 원하는 만큼 나눠 제출한다(`submitAiLabelResults`).
 * 앱은 제출된 결과를 폴링해 **기존 CAS 패치 경로**(`/api/ports/ai-labels`)로 적용한다 — 이 장부는
 * ports.json을 쓰지 않는다. 메모리에만 있고 사이드카가 재시작하면 사라진다(앱이 「작업 없음」을 말한다).
 */
export const AI_LABEL_JOB_PAGE_SIZE = 20;
export const AI_LABEL_JOB_MAX_ITEMS = 500;
export const AI_LABEL_JOB_MAX_JOBS = 8;
export const AI_LABEL_JOB_TTL_MS = 6 * 60 * 60 * 1000;
export const AI_LABEL_NAME_MAX = 60;
export const AI_LABEL_CATEGORY_MAX = 30;
const SUBMIT_MAX = 50;
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AiLabelJobError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

/** 작업을 만들 때의 프로젝트 모습. `aiName`·`category`·`searchAliases`는 CAS 기준값이기도 하다. */
export interface AiLabelJobItem {
  id: string;
  name: string;
  folderPath: string;
  description?: string;
  aiName?: string;
  category?: string;
  searchAliases?: string[];
  /** CAS 기준값 — 자르지 않은 저장값 그대로. AI에게는 보이지 않는다. */
  expected: PortAiLabelExpected;
}
export interface AiLabelResult {aiName?: string; category?: string; searchAliases?: string[]}
export interface AiLabelJobResultRow extends AiLabelResult {seq: number; id: string}
export interface AiLabelJob {
  id: string;
  createdAt: number;
  items: AiLabelJobItem[];
  results: AiLabelJobResultRow[];
  seq: number;
  cancelled: boolean;
}

const text = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const out = value.normalize('NFC').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return out ? out.slice(0, max) : undefined;
};

/** 비어 있는 칸이 하나라도 있는 프로젝트만 작업에 넣는다 — 채워진 값은 AI가 바꾸지 않는다. */
export function aiLabelJobNeedsWork(item: AiLabelJobItem): boolean {
  return !item.aiName || !item.category || !item.searchAliases?.length;
}

export function aiLabelJobItemFrom(row: Record<string, unknown>): AiLabelJobItem | null {
  const id = typeof row.id === 'string' && ID.test(row.id) ? row.id : null;
  const folderPath = typeof row.folderPath === 'string' && row.folderPath.trim() ? row.folderPath : null;
  if (!id || !folderPath) return null;
  let aliases: string[] | undefined;
  try { aliases = Array.isArray(row.searchAliases) ? normalizeSearchAliases(row.searchAliases) : undefined; }
  catch { aliases = undefined; }
  const expected = portAiLabelExpectedWithAliases(row, portAiLabelExpected(row as Parameters<typeof portAiLabelExpected>[0]));
  return {
    id, folderPath, name: text(row.name, 200) ?? id, expected,
    ...(text(row.description, 300) ? {description: text(row.description, 300)} : {}),
    ...(typeof row.aiName === 'string' && row.aiName.trim() ? {aiName: row.aiName} : {}),
    ...(typeof row.category === 'string' && row.category.trim() ? {category: row.category} : {}),
    ...(aliases?.length ? {searchAliases: aliases} : {}),
  };
}

export class AiLabelJobStore {
  #jobs = new Map<string, AiLabelJob>();
  constructor(private readonly now: () => number = Date.now, private readonly newId: () => string = () => crypto.randomUUID()) {}

  create(items: readonly AiLabelJobItem[]): AiLabelJob {
    this.#sweep();
    const work = items.filter(aiLabelJobNeedsWork);
    if (!work.length) throw new AiLabelJobError('AI_LABEL_JOB_EMPTY', '채울 이름·카테고리·검색 별칭이 없습니다.');
    if (work.length > AI_LABEL_JOB_MAX_ITEMS) throw new AiLabelJobError('AI_LABEL_JOB_TOO_LARGE', `한 번에 ${AI_LABEL_JOB_MAX_ITEMS}개까지 맡길 수 있습니다.`);
    while (this.#jobs.size >= AI_LABEL_JOB_MAX_JOBS) {
      const oldest = [...this.#jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0]!;
      this.#jobs.delete(oldest.id);
    }
    const job: AiLabelJob = {id: this.newId(), createdAt: this.now(), items: work.map(item => ({...item})), results: [], seq: 0, cancelled: false};
    this.#jobs.set(job.id, job);
    return job;
  }

  get(jobId: unknown): AiLabelJob {
    this.#sweep();
    const job = typeof jobId === 'string' && JOB_ID.test(jobId) ? this.#jobs.get(jobId) : undefined;
    if (!job) throw new AiLabelJobError('AI_LABEL_JOB_NOT_FOUND', '이름 작업을 찾지 못했습니다. 앱에서 다시 시작하세요.', 404);
    return job;
  }

  cancel(jobId: unknown): void { this.get(jobId).cancelled = true; }

  #sweep(): void {
    const cutoff = this.now() - AI_LABEL_JOB_TTL_MS;
    for (const [id, job] of this.#jobs) if (job.createdAt < cutoff) this.#jobs.delete(id);
  }
}

/** 이 작업이 채워야 할 칸을 **모두** 받은 프로젝트만 끝난 것으로 센다 — 이름만 내고 별칭이 남은 것은 아직이다. */
function coveredIds(job: AiLabelJob): Set<string> {
  const got = new Map<string, Set<string>>();
  for (const row of job.results) {
    const fields = got.get(row.id) ?? new Set<string>();
    for (const field of ['aiName', 'category', 'searchAliases'] as const) if (row[field] !== undefined) fields.add(field);
    got.set(row.id, fields);
  }
  const done = new Set<string>();
  for (const item of job.items) {
    const fields = got.get(item.id);
    if (!fields) continue;
    const needs = [!item.aiName && 'aiName', !item.category && 'category', !item.searchAliases?.length && 'searchAliases'].filter(Boolean) as string[];
    if (needs.every(field => fields.has(field))) done.add(item.id);
  }
  return done;
}

/** AI가 읽는 한 페이지. CAS 기준값은 그대로 보여 준다 — 「이미 있는 칸은 비워 두라」는 지시의 근거다. */
export function readAiLabelJobPage(job: AiLabelJob, page = 0) {
  const pages = Math.max(1, Math.ceil(job.items.length / AI_LABEL_JOB_PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new AiLabelJobError('AI_LABEL_JOB_PAGE_INVALID', `page는 0부터 ${pages - 1}까지입니다.`);
  const done = coveredIds(job);
  return {
    jobId: job.id,
    cancelled: job.cancelled,
    total: job.items.length,
    submitted: done.size,
    page,
    pages,
    nextPage: page + 1 < pages ? page + 1 : null,
    rules: {
      aiName: `빈 칸만: 2~4단어의 짧은 영어 소문자, 핵심 기능 키워드 (${AI_LABEL_NAME_MAX}자 이내)`,
      category: `빈 칸만: 소문자 영어 한 단어 (converter, dashboard, manager, tracker, bot, guide, automation …)`,
      searchAliases: '빈 칸만: 사람들이 이 프로젝트를 부를 이름 1~5개 — 영어 이름의 한글 발음(쉐도우루프), 한글 이름의 영어 뜻, 흔한 줄임말. 각 40자 이내, 초성은 넣지 말 것(검색이 자동으로 처리)',
    },
    items: job.items.slice(page * AI_LABEL_JOB_PAGE_SIZE, (page + 1) * AI_LABEL_JOB_PAGE_SIZE).map(({expected: _cas, ...item}) => ({
      ...item, submitted: done.has(item.id),
      needs: [!item.aiName && 'aiName', !item.category && 'category', !item.searchAliases?.length && 'searchAliases'].filter(Boolean),
    })),
  };
}

export function parseAiLabelSubmission(value: unknown): Array<{id: string} & AiLabelResult> {
  if (!Array.isArray(value) || value.length === 0 || value.length > SUBMIT_MAX) {
    throw new AiLabelJobError('AI_LABEL_SUBMIT_INVALID', `results는 1~${SUBMIT_MAX}개 배열이어야 합니다.`);
  }
  return value.map(raw => {
    const row = raw as Record<string, unknown>;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['id', 'aiName', 'category', 'searchAliases'].includes(key))
      || typeof row.id !== 'string' || !ID.test(row.id)) {
      throw new AiLabelJobError('AI_LABEL_SUBMIT_INVALID', '각 결과는 id와 aiName·category·searchAliases만 가질 수 있습니다.');
    }
    let searchAliases: string[] | undefined;
    if (row.searchAliases !== undefined) {
      try { searchAliases = normalizeSearchAliases(row.searchAliases); }
      catch (error) {
        if (error instanceof PortAiLabelPatchError) throw new AiLabelJobError('AI_LABEL_SUBMIT_INVALID', 'searchAliases는 8개까지, 각 40자 이내 문자열이어야 합니다.');
        throw error;
      }
    }
    const aiName = text(row.aiName, AI_LABEL_NAME_MAX);
    const category = text(row.category, AI_LABEL_CATEGORY_MAX)?.toLowerCase();
    return {id: row.id, ...(aiName ? {aiName} : {}), ...(category ? {category} : {}), ...(searchAliases?.length ? {searchAliases} : {})};
  });
}

/**
 * 제출을 받는다. 작업에 없는 id는 거절하고, 이미 채워져 있던 칸에 대한 값은 버린다(채워진 값을 AI가 바꾸지
 * 않는다는 약속을 장부가 지킨다). 같은 프로젝트를 다시 내면 새 줄이 되어 앱이 다시 적용한다.
 */
export function submitAiLabelResults(job: AiLabelJob, results: ReturnType<typeof parseAiLabelSubmission>) {
  if (job.cancelled) throw new AiLabelJobError('AI_LABEL_JOB_CANCELLED', '앱에서 이 작업을 멈췄습니다. 제출하지 마세요.', 409);
  const items = new Map(job.items.map(item => [item.id, item]));
  const accepted: string[] = [];
  const ignored: Array<{id: string; reason: string}> = [];
  for (const result of results) {
    const item = items.get(result.id);
    if (!item) { ignored.push({id: result.id, reason: '이 작업의 프로젝트가 아닙니다'}); continue; }
    const kept: AiLabelResult = {
      ...(!item.aiName && result.aiName ? {aiName: result.aiName} : {}),
      ...(!item.category && result.category ? {category: result.category} : {}),
      ...(!item.searchAliases?.length && result.searchAliases?.length ? {searchAliases: result.searchAliases} : {}),
    };
    if (!Object.keys(kept).length) { ignored.push({id: result.id, reason: '채울 빈 칸에 해당하는 값이 없습니다'}); continue; }
    job.seq += 1;
    job.results.push({seq: job.seq, id: result.id, ...kept});
    accepted.push(result.id);
  }
  const done = coveredIds(job);
  return {jobId: job.id, accepted, ignored, submitted: done.size, total: job.items.length, remaining: job.items.length - done.size};
}

/** 앱 폴링: `after` 뒤의 새 결과와 그 프로젝트의 작업 시점 값(CAS 기준). */
export function aiLabelJobUpdates(job: AiLabelJob, after: number) {
  const items = new Map(job.items.map(item => [item.id, item]));
  const done = coveredIds(job);
  return {
    jobId: job.id, cancelled: job.cancelled, total: job.items.length, submitted: done.size, seq: job.seq,
    results: job.results.filter(row => row.seq > after).map(row => ({...row, expected: items.get(row.id)!.expected})),
  };
}

/** OPS 워크룸에 보내는 지시. 짧게 — 데이터는 MCP가 나른다. */
export function aiLabelJobInstruction(jobId: string, total: number): string {
  return [
    `[아젠투지 이름 작업 ${jobId}] 등록 프로젝트 ${total}개의 빈 칸(별명 aiName · 카테고리 category · 검색 별칭 searchAliases)을 채워 주세요.`,
    `1) agentstoz_use_read_ai_label_job(jobId="${jobId}", page=0)부터 nextPage가 null이 될 때까지 읽습니다. 각 항목의 rules와 needs를 따릅니다.`,
    '2) 확신이 없으면 그 프로젝트 폴더(folderPath)의 README·package.json 등을 직접 열어 보고 정합니다. 폴더 안의 파일은 바꾸지 않습니다.',
    `3) 몇 개씩 모아 agentstoz_use_submit_ai_labels(jobId="${jobId}", results=[{id, aiName?, category?, searchAliases?}])로 제출합니다. 앱이 제출되는 대로 반영합니다.`,
    '4) 모두 제출하면 몇 개를 채웠는지만 짧게 보고하고 끝냅니다. 도구가 cancelled를 알리면 즉시 멈춥니다.',
  ].join('\n');
}
