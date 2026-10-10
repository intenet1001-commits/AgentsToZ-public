import {describe, expect, test} from 'bun:test';
import {
  AI_LABEL_JOB_PAGE_SIZE, AI_LABEL_JOB_TTL_MS, AiLabelJobError, AiLabelJobStore, aiLabelJobInstruction, aiLabelJobItemFrom,
  aiLabelJobUpdates, parseAiLabelSubmission, readAiLabelJobPage, submitAiLabelResults, type AiLabelJobItem,
} from '../src/aiLabelJobs';
import {advanceAiLabelBaselines, aiLabelPatchesFrom} from '../src/aiLabelJobClient';
import {applyPortAiLabelPatches} from '../src/portAiLabelPatch';
import {agentsToZUseMcpActionForTool} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const rows = [
  {id: 'shadow', name: 'ShadowLoop', folderPath: '/p/ShadowLoop', description: 'x'.repeat(500)},
  {id: 'named', name: '블로그', folderPath: '/p/blog', aiName: 'blog writer', category: 'writing', searchAliases: ['블로그 작성기']},
  {id: 'partial', name: '포트관리', folderPath: '/p/ports', aiName: 'port manager'},
  {id: 'nofolder', name: 'Bookmarks'},
];
const items = () => rows.map(row => aiLabelJobItemFrom(row)).filter((item): item is AiLabelJobItem => item !== null);
let next = 0;
const store = (now = () => 1_000) => new AiLabelJobStore(now, () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`);

describe('OPS 워크룸 이름 작업 장부', () => {
  test('빈 칸이 있는 폴더 프로젝트만 작업이 되고, AI 페이지에는 CAS 기준값이 보이지 않는다', () => {
    const job = store().create(items());
    expect(job.items.map(item => item.id)).toEqual(['shadow', 'partial']);
    const page = readAiLabelJobPage(job, 0);
    expect(page.total).toBe(2);
    expect(page.nextPage).toBeNull();
    expect(page.items[0]).not.toHaveProperty('expected');
    expect(page.items[0]!.description!.length).toBe(300);
    expect(page.items.find(item => item.id === 'partial')!.needs).toEqual(['category', 'searchAliases']);
    expect(() => readAiLabelJobPage(job, 1)).toThrow(AiLabelJobError);
  });

  test('한 페이지는 20개이고 nextPage로 끝까지 읽는다', () => {
    const many = Array.from({length: 45}, (_, i) => aiLabelJobItemFrom({id: `p${i}`, name: `P${i}`, folderPath: `/p/${i}`})!);
    const job = store().create(many);
    const first = readAiLabelJobPage(job, 0);
    expect(first.items).toHaveLength(AI_LABEL_JOB_PAGE_SIZE);
    expect(first.nextPage).toBe(1);
    expect(readAiLabelJobPage(job, 2).items).toHaveLength(5);
    expect(readAiLabelJobPage(job, 2).nextPage).toBeNull();
  });

  test('제출은 빈 칸만 채우고, 작업 밖의 id는 거절하며, 멈춘 작업은 받지 않는다', () => {
    const job = store().create(items());
    const receipt = submitAiLabelResults(job, parseAiLabelSubmission([
      {id: 'shadow', aiName: 'loop recorder', category: 'Audio', searchAliases: ['쉐도우루프', '섀도루프']},
      {id: 'partial', aiName: 'should be dropped', category: 'manager'},
      {id: 'named', aiName: 'outside'},
    ]));
    expect(receipt.accepted).toEqual(['shadow', 'partial']);
    expect(receipt.ignored.map(row => row.id)).toEqual(['named']);
    // 'partial' still owes its search aliases, so it is not done yet.
    expect(receipt.remaining).toBe(1);
    const updates = aiLabelJobUpdates(job, 0);
    expect(updates.results.find(row => row.id === 'partial')).not.toHaveProperty('aiName');
    expect(updates.results.find(row => row.id === 'shadow')!.category).toBe('audio');
    expect(aiLabelJobUpdates(job, updates.seq).results).toEqual([]);
    job.cancelled = true;
    expect(() => submitAiLabelResults(job, parseAiLabelSubmission([{id: 'shadow', aiName: 'again'}]))).toThrow('멈췄습니다');
  });

  test('형식이 틀린 제출은 통째로 거절한다', () => {
    expect(() => parseAiLabelSubmission([])).toThrow(AiLabelJobError);
    expect(() => parseAiLabelSubmission([{id: 'a', folderPath: '/etc'}])).toThrow(AiLabelJobError);
    expect(() => parseAiLabelSubmission([{id: 'a', searchAliases: Array.from({length: 9}, (_, i) => `alias ${i}`)}])).toThrow(AiLabelJobError);
    expect(() => parseAiLabelSubmission([{id: '../a'}])).toThrow(AiLabelJobError);
  });

  test('제출 → 패치 → CAS 적용: 사람이 그 사이 고친 칸은 덮지 않는다', () => {
    const job = store().create(items());
    submitAiLabelResults(job, parseAiLabelSubmission([
      {id: 'shadow', aiName: 'loop recorder', category: 'audio', searchAliases: ['쉐도우루프']},
      {id: 'partial', category: 'manager', searchAliases: ['포트 매니저']},
    ]));
    const patches = aiLabelPatchesFrom(aiLabelJobUpdates(job, 0).results);
    // 사람이 작업 도중 partial의 카테고리를 직접 정했다.
    const current = rows.map(row => row.id === 'partial' ? {...row, category: 'tools'} : row);
    const result = applyPortAiLabelPatches(current, {patches});
    expect(result.appliedIds).toEqual(['shadow']);
    expect(result.skipped.map(row => row.id)).toEqual(['partial']);
    const shadow = result.ports.find(row => row.id === 'shadow') as Record<string, unknown>;
    expect(shadow).toMatchObject({aiName: 'loop recorder', category: 'audio', searchAliases: ['쉐도우루프']});
    expect(shadow.description).toBe('x'.repeat(500));
  });

  test('별칭을 바꾸지 않는 패치에는 별칭 기준값을 싣지 않는다(패치 계약)', () => {
    const job = store().create(items());
    submitAiLabelResults(job, parseAiLabelSubmission([{id: 'shadow', aiName: 'loop recorder'}]));
    const [patch] = aiLabelPatchesFrom(aiLabelJobUpdates(job, 0).results);
    expect(patch!.expected).not.toHaveProperty('searchAliases');
    expect(applyPortAiLabelPatches(rows, {patches: [patch!]}).appliedIds).toEqual(['shadow']);
  });

  test('나눠 낸 제출은 칸별로 합치고, 이미 채운 칸은 다음 패치의 기준값이 된다(2026-10-06 리뷰)', () => {
    const job = store().create(items());
    // Same poll: name first, aliases second for the same project.
    submitAiLabelResults(job, parseAiLabelSubmission([{id: 'shadow', aiName: 'loop recorder'}]));
    expect(aiLabelJobUpdates(job, 0).submitted).toBe(0); // category and aliases still missing
    submitAiLabelResults(job, parseAiLabelSubmission([{id: 'shadow', category: 'audio', searchAliases: ['쉐도우루프']}]));
    const first = aiLabelPatchesFrom(aiLabelJobUpdates(job, 0).results);
    expect(first).toHaveLength(1);
    expect(first[0]!.desired).toEqual({aiName: 'loop recorder', category: 'audio', searchAliases: ['쉐도우루프']});
    // Across polls: the second patch builds on what the first one wrote.
    const job2 = store().create(items());
    submitAiLabelResults(job2, parseAiLabelSubmission([{id: 'shadow', aiName: 'loop recorder'}]));
    const poll1 = aiLabelJobUpdates(job2, 0);
    const p1 = aiLabelPatchesFrom(poll1.results);
    let current = rows as Record<string, unknown>[];
    const r1 = applyPortAiLabelPatches(current as any, {patches: p1});
    expect(r1.appliedIds).toEqual(['shadow']);
    current = r1.ports as any;
    const baselines = new Map(), initial = new Map(poll1.results.map(row => [row.id, row.expected]));
    advanceAiLabelBaselines(baselines, p1, r1.appliedIds, initial);
    submitAiLabelResults(job2, parseAiLabelSubmission([{id: 'shadow', category: 'audio', searchAliases: ['쉐도우루프']}]));
    const p2 = aiLabelPatchesFrom(aiLabelJobUpdates(job2, poll1.seq).results, baselines);
    const r2 = applyPortAiLabelPatches(current as any, {patches: p2});
    expect(r2.appliedIds).toEqual(['shadow']);
    expect(r2.ports.find((row: any) => row.id === 'shadow')).toMatchObject({aiName: 'loop recorder', category: 'audio', searchAliases: ['쉐도우루프']});
  });

  test('장부는 6시간 뒤 잊고, 없는 작업은 404로 말한다', () => {
    let now = 1_000;
    const jobs = store(() => now);
    const job = jobs.create(items());
    expect(jobs.get(job.id)).toBe(job);
    now += AI_LABEL_JOB_TTL_MS + 1;
    expect(() => jobs.get(job.id)).toThrow(AiLabelJobError);
    expect(() => jobs.get('not-a-job')).toThrow(AiLabelJobError);
    expect(() => jobs.create([aiLabelJobItemFrom(rows[1]!)!])).toThrow('채울');
  });

  test('지시문은 짧고 두 MCP 도구와 jobId를 말한다', () => {
    const text = aiLabelJobInstruction('11111111-2222-4333-8444-555555555555', 140);
    expect(text).toContain('agentstoz_use_read_ai_label_job');
    expect(text).toContain('agentstoz_use_submit_ai_labels');
    expect(text).toContain('11111111-2222-4333-8444-555555555555');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(2_000);
  });

  test('MCP 도구 → USE 동작 → 서버 파서가 같은 모양을 주고받는다', () => {
    const jobId = '11111111-2222-4333-8444-555555555555';
    const read = agentsToZUseMcpActionForTool('agentstoz_use_read_ai_label_job', {jobId, page: 2}, 'controller-id');
    expect(parseAgentsToZUseActionRequest(read).aiLabelJob).toEqual({jobId, page: 2});
    const submit = agentsToZUseMcpActionForTool('agentstoz_use_submit_ai_labels', {jobId, results: [{id: 'a', aiName: 'x'}]}, 'controller-id');
    expect(parseAgentsToZUseActionRequest(submit).aiLabelJob).toEqual({jobId, results: [{id: 'a', aiName: 'x'}]});
    expect(() => parseAgentsToZUseActionRequest({...read, aiLabelJob: {jobId, page: 1, extra: true}})).toThrow();
    expect(() => parseAgentsToZUseActionRequest({...read, aiLabelJob: {jobId: '../x'}})).toThrow();
  });
});
