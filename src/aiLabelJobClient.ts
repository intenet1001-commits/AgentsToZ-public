import type {AiTerminalAgent, AiTerminalRequest, AiTerminalResponse, AiTerminalSummary} from './aiTerminalProtocol';
import type {PortAiLabelExpected, PortAiLabelPatch} from './portAiLabelPatch';

/**
 * 앱 쪽 이름 작업 흐름: 작업을 만들고 → OPS 워크룸 **새 세션의 첫 요청**으로 지시를 넣고 → 제출을 폴링해
 * CAS 패치로 바꾼다. 막 뜬 CLI에 타이핑하지 않는 이유는 워크룸 `@` 전달과 같다 — 폴더 신뢰·로그인
 * 화면이 그 글자와 Enter를 받아 버린다. 이미 실행 중인 OPS 세션을 쓰지 않는 이유는 그 세션이 다른 일을
 * 하고 있을 수 있어서다(긴 작업 한가운데에 지시가 끼어들면 둘 다 망가진다).
 */
export interface AiLabelJobUpdateRow {seq: number; id: string; aiName?: string; category?: string; searchAliases?: string[]; expected: PortAiLabelExpected}
export interface AiLabelJobUpdates {jobId: string; cancelled: boolean; total: number; submitted: number; seq: number; results: AiLabelJobUpdateRow[]}

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !body || body.success !== true) {
    if (response.status === 404 && !body?.code) throw new Error('이름 작업을 지원하는 로컬 API로 앱을 업데이트해 주세요.');
    throw new Error(typeof body?.error === 'string' ? body.error : '이름 작업 요청을 처리하지 못했습니다.');
  }
  return body;
}

export async function createAiLabelJob(fetcher: Fetcher, ids: readonly string[]): Promise<{jobId: string; total: number; instruction: string}> {
  const body = await readJson(await fetcher('/api/ai-label-jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ids})}));
  if (typeof body.jobId !== 'string' || typeof body.instruction !== 'string' || typeof body.total !== 'number') throw new Error('이름 작업 응답을 확인하지 못했습니다.');
  return {jobId: body.jobId, total: body.total, instruction: body.instruction};
}

export async function readAiLabelJobUpdates(fetcher: Fetcher, jobId: string, after: number): Promise<AiLabelJobUpdates> {
  const body = await readJson(await fetcher(`/api/ai-label-jobs?jobId=${encodeURIComponent(jobId)}&after=${after}`));
  if (!Array.isArray(body.results)) throw new Error('이름 작업 응답을 확인하지 못했습니다.');
  return body as unknown as AiLabelJobUpdates;
}

export async function cancelAiLabelJob(fetcher: Fetcher, jobId: string): Promise<void> {
  await readJson(await fetcher('/api/ai-label-jobs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operation: 'cancel', jobId})})).catch(() => undefined);
}

/** OPS 워크룸에 새 세션을 열고 지시를 **첫 요청**으로 넣는다. */
export async function startAiLabelOpsSession(
  transport: (request: AiTerminalRequest) => Promise<AiTerminalResponse>,
  opsTargetId: string, agent: AiTerminalAgent, instruction: string, bypassPermissions?: boolean,
): Promise<AiTerminalSummary> {
  const {session} = await transport({
    operation: 'start', requestId: crypto.randomUUID(), targetId: opsTargetId, agent, cols: 100, rows: 28, prompt: instruction,
    ...(bypassPermissions === undefined ? {} : {bypassPermissions}),
  } as AiTerminalRequest);
  if (!session || session.targetId !== opsTargetId) throw new Error('OPS 워크룸 실행 결과를 확인하지 못했습니다.');
  if (session.state !== 'running') throw new Error('OPS 워크룸의 AI가 바로 종료되었습니다. 워크룸에서 CLI 설치·로그인 상태를 확인하세요.');
  return session;
}

/**
 * 제출 → CAS 패치. AI는 한 프로젝트를 여러 번에 나눠 낼 수 있으므로(예: 이름 먼저, 별칭 나중에) **칸별로** 합친다.
 * 기준값은 작업을 만든 시점의 값이지만, 이 작업이 이미 채운 칸은 `baselines`가 앞으로 옮겨 준다 — 그러지 않으면
 * 두 번째 패치가 「그 사이 바뀌었다」로 거절됐다(2026-10-06 리뷰). 사람이 고친 칸은 여전히 CAS가 건너뛴다.
 */
export function aiLabelPatchesFrom(rows: readonly AiLabelJobUpdateRow[], baselines: ReadonlyMap<string, PortAiLabelExpected> = new Map()): PortAiLabelPatch[] {
  const merged = new Map<string, AiLabelJobUpdateRow>();
  for (const row of rows) {
    const prior = merged.get(row.id);
    merged.set(row.id, {...(prior ?? row), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined))} as AiLabelJobUpdateRow);
  }
  const patches: PortAiLabelPatch[] = [];
  for (const row of merged.values()) {
    const expected = baselines.get(row.id) ?? row.expected;
    const desired: PortAiLabelPatch['desired'] = {
      ...(row.aiName && !expected.aiName ? {aiName: row.aiName} : {}),
      ...(row.category && !expected.category ? {category: row.category} : {}),
      ...(row.searchAliases?.length && !expected.searchAliases?.length ? {searchAliases: row.searchAliases} : {}),
    };
    if (!Object.keys(desired).length) continue;
    // The patch contract wants the alias baseline exactly when aliases change.
    const {searchAliases: aliasBaseline, ...base} = expected;
    patches.push({id: row.id, expected: desired.searchAliases ? {...base, searchAliases: aliasBaseline ?? null} : base, desired});
  }
  return patches;
}

/** After a receipt: the fields this job just wrote become the baseline for its next patch of that project. */
export function advanceAiLabelBaselines(baselines: Map<string, PortAiLabelExpected>, patches: readonly PortAiLabelPatch[], appliedIds: readonly string[], fallback: ReadonlyMap<string, PortAiLabelExpected>): void {
  const applied = new Set(appliedIds);
  for (const patch of patches) {
    if (!applied.has(patch.id)) continue;
    const before = baselines.get(patch.id) ?? fallback.get(patch.id);
    if (!before) continue;
    baselines.set(patch.id, {...before, ...patch.desired});
  }
}
