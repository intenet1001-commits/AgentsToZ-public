// Cross-memory lesson clusters: the discovery behind 「교집합·카테고리 후보 확인」 and recommend_common_memory_topics.
// Pure fixtures first, then the cloud service wiring (read-only, keyword topics only as a fallback).
import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {CommonMemorySourceEntry} from '../src/commonMemory';
import {COMMON_MEMORY_DISCOVERY_MAX_BYTES, COMMON_MEMORY_DISCOVERY_MAX_ENTRIES, LESSON_CLUSTER_THRESHOLD, clusterCrossMemoryLessons, isGeneratedLessonHeading, lessonClusterText, lessonSimilarity, lessonTitle} from '../src/commonMemoryLessonClusters';
import {commonTopicCandidates, commonTopicDiscovery} from '../src/commonMemoryTopicEvidence';
import {createCommonMemoryService} from '../common-memory-server';
import {parseMetaMemoryRequest} from '../src/metaCommonMemoryContract';
import {readCommonTopicEvidence} from '../src/commonMemoryTopicEvidence';
import {CommonCloud, A, B, C} from './fixtures/common-memory/cloud';

const P1 = '0a000000-0000-4000-8000-000000000001', P2 = '0a000000-0000-4000-8000-000000000002', P3 = '0a000000-0000-4000-8000-000000000003';
const P4 = '0a000000-0000-4000-8000-000000000004', P5 = '0a000000-0000-4000-8000-000000000005';
let serial = 0;
function entry(memoryId: string, title: string, excerpt: string): CommonMemorySourceEntry {
  serial++;
  return {memoryId, revisionId: 'r' + memoryId.slice(-4), entryId: serial.toString(16).padStart(24, '0'), contentHash: createHash('sha256').update(title + excerpt).digest('hex'), title, excerpt, section: 'Key Decisions'};
}
const lessons = {
  vercel1: ['Vercel 배포는 커밋 이메일부터 확인한다', 'Vercel은 GitHub 사용자와 이어지지 않는 커밋 이메일의 배포를 조용히 BLOCKED로 둔다. 기기마다 `git config user.email`을 확인한다. 화면에 보인다고 배포된 것이 아니다(2026-10-07 실측).'],
  vercel2: ['Vercel 커밋 이메일 차단', 'GitHub 사용자와 연결되지 않은 커밋 이메일이면 Vercel이 배포를 조용히 BLOCKED 처리한다. 각 기기에서 `git config user.email`을 먼저 확인해야 한다. 화면에 보여도 배포됐다고 보지 않는다. 근거: docs/claude/voc-and-deploy.md'],
  bun1: ['Bun has no --no-env-file flag', 'Bun loads .env files automatically. The --no-env-file flag does not exist in Bun, so pass --env-file=/dev/null and start from a neutral cwd (/) so the project secrets are never loaded.'],
  bun2: ['Keep Bun from loading the project .env', "Bun automatically loads .env and has no --no-env-file option. Use --env-file=/dev/null and launch from a neutral working directory (/) so the project's secrets are never loaded. Verified 2026-09-02 in ~/forcs/app/src/guard.ts."],
  rls: ['Supabase RLS는 끄지 않는다', '모든 portmgr 테이블에서 RLS를 켜 둔다. 권한 오류가 나면 정책을 끄지 말고 정책과 역할을 고친다.'],
  jwt: ['Supabase 401은 JWT 세션부터 본다', '401·403·PGRST301 응답이 오면 먼저 로그인 세션의 JWT가 만료됐는지 확인한다. 키를 바꾸기 전에 세션을 새로 고친다.'],
  ios: ['아이폰 권한', '아이폰 권한은 사용자 동의로 시작하고 거절하면 설정 화면으로 안내한다.'],
  drag: ['Tauri blocks HTML5 drag and drop', 'Tauri intercepts HTML5 drag and drop events, so draggable and drop never fire in the app. Implement dragging with pointer events instead.'],
  build: ['빌드 번호는 git 기록에서 센다', '버전은 git 기록에서 센다. bump 커밋을 만들지 않는다. 얕은 clone은 빌드 번호를 셀 수 없다.'],
  workroom: ['나눠 보낸 입력은 한 묶음', '나눠 보낸 입력은 한 묶음이다. 한 부분이 실패하면 나머지와 그 세션의 남은 입력을 버린다. 키 입력을 붙여넣기로 바꾸지 않는다.'],
  smoke: ['Smoke tests need the dev API server', 'Quit the installed app before running smoke tests: its sidecar holds port 3001, the dev page gets 403 or 503 and the QR dialog never opens.'],
} as const;
const lesson = (memoryId: string, key: keyof typeof lessons) => entry(memoryId, lessons[key][0], lessons[key][1]);
const refs = (list: CommonMemorySourceEntry[]) => list.map(e => `${e.memoryId}:${e.entryId}:${e.contentHash}:${e.revisionId}`).sort();
const CANDIDATE_KEYS = ['category', 'evidence', 'key', 'method', 'name', 'needsSemanticReview', 'sourceMemoryIds'];

test('the same lesson phrased differently in two projects is one cluster, in Korean and in English', () => {
  const vercel1 = lesson(P1, 'vercel1'), vercel2 = lesson(P2, 'vercel2'), bun1 = lesson(P2, 'bun1'), bun2 = lesson(P3, 'bun2');
  const entries = [vercel1, lesson(P1, 'ios'), lesson(P1, 'rls'), vercel2, bun1, lesson(P2, 'drag'), bun2, lesson(P3, 'jwt'), lesson(P3, 'build')];
  const clusters = clusterCrossMemoryLessons(entries);
  expect(clusters).toHaveLength(2);
  const byTitle = new Map(clusters.map(c => [c.memoryIds.join(','), c]));
  const vercel = byTitle.get(`${P1},${P2}`)!, bun = byTitle.get(`${P2},${P3}`)!;
  // Exact references survive so a later propose-source-entry can carry them as evidence.
  expect(refs(vercel.members.map(m => m.entry))).toEqual(refs([vercel1, vercel2]));
  expect(refs(bun.members.map(m => m.entry))).toEqual(refs([bun1, bun2]));
  expect(vercel.members[0]!.similarity).toBe(1);
  for (const cluster of clusters) expect(cluster.members[1]!.similarity).toBeGreaterThan(LESSON_CLUSTER_THRESHOLD * 2);
  // The topic name is the representative member's heading.
  expect<string[]>([lessons.vercel1[0], lessons.vercel2[0]]).toContain(vercel.title);
  // As candidates: the existing shape, one per cluster, labelled by the keyword topic when one fits.
  const discovery = commonTopicDiscovery(entries);
  expect(discovery.method).toBe('cross-memory-lesson-cluster');
  expect(discovery.candidates).toHaveLength(2);
  for (const candidate of discovery.candidates) {
    expect(Object.keys(candidate).sort()).toEqual(CANDIDATE_KEYS);
    expect(candidate.method).toBe('cross-memory-lesson-cluster');
    expect(candidate.needsSemanticReview).toBe(true);
    expect(new Set(candidate.evidence.map(e => e.memoryId)).size).toBe(2);
  }
  expect(discovery.candidates.find(c => c.sourceMemoryIds.includes(P1))!.category).toBe('빌드·배포');
  expect(discovery.candidates.find(c => c.sourceMemoryIds.includes(P3))!.category).toBe('공통 교훈');
});

test('unrelated lessons, even on one topic, make no cluster; keyword topics are only the fallback', () => {
  const entries = [lesson(P1, 'rls'), lesson(P1, 'ios'), lesson(P2, 'jwt'), lesson(P2, 'drag'), lesson(P3, 'build'), lesson(P3, 'workroom'), lesson(P3, 'smoke')];
  expect(lessonSimilarity(lessonClusterText(...lessons.rls), lessonClusterText(...lessons.jwt))).toBeLessThan(LESSON_CLUSTER_THRESHOLD / 2);
  expect(clusterCrossMemoryLessons(entries)).toEqual([]);
  const fallback = commonTopicDiscovery(entries);
  expect(fallback.method).toBe('source-entry-topic-intersection');
  // Both Supabase lessons mention 권한/세션 words the keyword topics know; that broad overlap is still offered.
  expect(fallback.candidates.every(c => c.method === 'source-entry-topic-intersection' && Object.keys(c).sort().join() === CANDIDATE_KEYS.join())).toBe(true);
  expect(fallback.candidates.length).toBeGreaterThan(0);
  expect(commonTopicCandidates(entries)).toEqual(fallback.candidates);
});

test('boilerplate every project carries is not a lesson; a real lesson among it still is', () => {
  const projects = [['Alpha', P1], ['Bravo', P2], ['Charlie', P3], ['Delta', P4], ['Echo', P5]] as const;
  // Generated instruction text, copied into each memory with only the project name changed and an unknown heading.
  const generated = (name: string) => `${name} uses AgentsToZ project memory. Before substantial work, read the configured local memory and its index, then only the notes whose titles match the task. When asked to remember a session, update the local memory first, mark the activity as remembered and push the backup. A failed remote backup never rolls back the local update.`;
  const own = ['ios', 'drag', 'build', 'workroom', 'smoke'] as const;
  const entries = projects.flatMap(([name, id], i) => [entry(id, `${name} agent operating notes`, generated(name)), lesson(id, own[i]!)]);
  // Known generated headings are left out even when only two memories carry them.
  entries.push(entry(P1, 'Project memory integration', generated('Alpha')), entry(P2, '## Project memory integration', generated('Alpha')));
  entries.push(lesson(P1, 'vercel1'), lesson(P4, 'vercel2'));
  expect(isGeneratedLessonHeading('Project memory integration')).toBe(true);
  expect(isGeneratedLessonHeading('Review remote version: Vercel 커밋 이메일 차단')).toBe(true);
  expect(isGeneratedLessonHeading('Project memory integration with Supabase is slow')).toBe(false);
  const clusters = clusterCrossMemoryLessons(entries);
  expect(clusters).toHaveLength(1);
  expect(clusters[0]!.memoryIds).toEqual([P1, P4]);
  expect(clusters[0]!.members.map(m => m.entry.title).sort()).toEqual([lessons.vercel1[0], lessons.vercel2[0]].sort());
  // Below four memories the share rule cannot tell boilerplate from a shared lesson, so two copies still cluster;
  // known generated headings are the guard there.
  const twoCopies = [entry(P1, 'Alpha agent operating notes', generated('Alpha')), entry(P2, 'Bravo agent operating notes', generated('Bravo'))];
  expect(clusterCrossMemoryLessons(twoCopies)).toHaveLength(1);
});

test('one project repeating itself is not a cross-project lesson; a second project makes it one', () => {
  const first = lesson(P1, 'vercel1'), again = entry(P1, lessons.vercel2[0], lessons.vercel2[1]);
  expect(clusterCrossMemoryLessons([first, again, lesson(P2, 'drag')])).toEqual([]);
  const other = lesson(P2, 'vercel2'), clusters = clusterCrossMemoryLessons([first, again, other]);
  expect(clusters).toHaveLength(1);
  expect(clusters[0]!.memoryIds).toEqual([P1, P2]);
  expect(clusters[0]!.members).toHaveLength(3);
  // Evidence names every memory before any memory's second entry.
  const [candidate] = commonTopicCandidates([first, again, other]);
  expect(candidate!.evidence.slice(0, 2).map(e => e.memoryId).sort()).toEqual([P1, P2]);
  expect(candidate!.sourceMemoryIds).toEqual([P1, P2]);
  // The same entry reference listed twice is one entry, not a second project.
  expect(clusterCrossMemoryLessons([first, {...first}])).toEqual([]);
});

test('normalization drops markdown, dates, ids, versions, paths, links and fenced code; titles stay short and safe', () => {
  const text = lessonClusterText('**Vercel** 2026-10-07 배포', 'see `src/foo.ts`, /Users/x/y and ~/Library/A, commit 3fa9c2b1d, id 123e4567-e89b-42d3-a456-426614174000, https://x.y/z?q=1 Push/Pull v1.39.0 <!-- note -->\n```sh\nbun run verify\n```\n끝.');
  expect(text).toBe('vercel 배포 see and commit id push pull 끝');
  expect(lessonSimilarity(lessonClusterText(...lessons.bun1), lessonClusterText(lessons.bun1[0], lessons.bun1[1].replace('/dev/null', '/tmp/other/null') + ' 2027-01-01 abcdef1234'))).toBe(1);
  const long = lessonTitle('**' + '긴제목'.repeat(40) + '**\u0007');
  expect([...long].length).toBeLessThanOrEqual(60);
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(240);
  expect(/[\u0000-\u001f*]/.test(long)).toBe(false);
  expect(lessonTitle('   ')).toBe('공통 교훈');
});

test('the scan bounds hold: entries past 500 or past 2 MB are not compared, and 500 entries stay fast', () => {
  const fillers = Array.from({length: COMMON_MEMORY_DISCOVERY_MAX_ENTRIES}, (_, i) => entry(P3, `filler ${i}`, `x${i}`));
  const pair = [lesson(P1, 'vercel1'), lesson(P2, 'vercel2')];
  expect(clusterCrossMemoryLessons([...pair, ...fillers])).toHaveLength(1);
  expect(clusterCrossMemoryLessons([...fillers, ...pair])).toEqual([]);
  const heavy = Array.from({length: Math.ceil(COMMON_MEMORY_DISCOVERY_MAX_BYTES / 12_000) + 1}, (_, i) => entry(P3, `heavy ${i}`, 'ㅁ'.repeat(4_000)));
  expect(clusterCrossMemoryLessons([...heavy.slice(0, 10), ...pair])).toHaveLength(1);
  expect(clusterCrossMemoryLessons([...heavy, ...pair])).toEqual([]);
  // 500 unrelated entries across eight memories: no false cluster, deterministic under reordering, bounded time.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const syllables = [...'가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후기니디리미비시이지치키티피히'];
  const memories = Array.from({length: 8}, (_, i) => `0b000000-0000-4000-8000-00000000000${i}`);
  const big = Array.from({length: COMMON_MEMORY_DISCOVERY_MAX_ENTRIES - 2}, (_, i) => entry(memories[i % 8]!, `메모 ${i}`, Array.from({length: 300}, () => syllables[Math.floor(random() * syllables.length)]).join('')));
  const bun1 = lesson(memories[0]!, 'bun1'), bun2 = lesson(memories[5]!, 'bun2');
  const start = performance.now(), result = clusterCrossMemoryLessons([...big, bun1, bun2]);
  expect(performance.now() - start).toBeLessThan(5_000);
  expect(result).toHaveLength(1);
  expect(result[0]!.memoryIds).toEqual([memories[0]!, memories[5]!].sort());
  const reversed = clusterCrossMemoryLessons([bun2, ...big.slice().reverse(), bun1]);
  expect(reversed).toEqual(result);
});

function lessonCloud() {
  const cloud = Object.assign(new CommonCloud(), {commonMemoryScope: 'a'.repeat(64)});
  cloud.source(A, `### ${lessons.vercel1[0]}\n<!-- memory-entry-id:a1a1a1a1a1a1a1a1a1a1a1a1 -->\n${lessons.vercel1[1]}\n\n### ${lessons.build[0]}\n<!-- memory-entry-id:a2a2a2a2a2a2a2a2a2a2a2a2 -->\n${lessons.build[1]}`);
  cloud.source(B, `### ${lessons.vercel2[0]}\n<!-- memory-entry-id:b1b1b1b1b1b1b1b1b1b1b1b1 -->\n${lessons.vercel2[1]}\n\n### ${lessons.drag[0]}\n<!-- memory-entry-id:b2b2b2b2b2b2b2b2b2b2b2b2 -->\n${lessons.drag[1]}`);
  return {cloud, service: createCommonMemoryService(() => cloud)};
}

test('cloud discovery returns lesson clusters in the existing candidate shape without writing anything', async () => {
  const {cloud, service} = lessonCloud(), before = JSON.stringify(cloud.tables);
  const result = await service.topicCandidates();
  expect(result.method).toBe('cross-memory-lesson-cluster');
  expect(result.semanticDecisionRequired).toBe(true);
  expect(result.checkedMemoryIds).toEqual([A, B, C]);
  expect(result.candidates).toHaveLength(1);
  const [candidate] = result.candidates;
  expect(Object.keys(candidate!).sort()).toEqual([...CANDIDATE_KEYS, 'existingGroups'].sort());
  expect(candidate!.sourceMemoryIds).toEqual([A, B]);
  expect(candidate!.category).toBe('빌드·배포');
  expect(candidate!.existingGroups).toEqual([]);
  // Evidence is the cloud's own current entry references, bodies cut to the same 240-character preview as before.
  const current = [...(await service.readCloudSource(A)).entries, ...(await service.readCloudSource(B)).entries].filter(e => ['a1a1a1a1a1a1a1a1a1a1a1a1', 'b1b1b1b1b1b1b1b1b1b1b1b1'].includes(e.entryId));
  expect(refs(candidate!.evidence)).toEqual(refs(current));
  expect(candidate!.evidence.every(e => [...e.excerpt].length <= 240)).toBe(true);
  expect(JSON.stringify(cloud.tables)).toBe(before);
  // A person can turn it into a reviewed proposal; it stays a candidate until a person accepts it.
  const group = await service.action({operation: 'create', groupId: crypto.randomUUID(), requestId: crypto.randomUUID(), name: candidate!.name, goal: {objective: candidate!.name, include: [candidate!.category]}, sourceMemoryIds: candidate!.sourceMemoryIds});
  expect(group.state.name).toBe(candidate!.name);
  const evidence = candidate!.evidence.map(e => ({memoryId: e.memoryId, revisionId: e.revisionId, entryId: e.entryId, contentHash: e.contentHash}));
  const saved = await service.knowledge(parseMetaMemoryRequest({operation: 'propose-source-entry', memoryId: group.state.id, expectedRevision: 0, requestId: crypto.randomUUID(), title: candidate!.name, body: 'GitHub 사용자와 이어지지 않는 커밋 이메일은 Vercel 배포를 막는다. 기기마다 커밋 이메일을 확인한다.', reason: '두 프로젝트에 같은 배포 교훈이 있다', category: candidate!.category, conditions: [], evidence}), []);
  const proposed = saved.state.portableKnowledge!.current.entries[0]!;
  expect(proposed.state).toBe('candidate');
  expect(readCommonTopicEvidence(proposed.body).evidence!.sources.map(s => s.memoryId)).toEqual([A, B]);
  // Once that topic exists, the same discovery points at it instead of offering a duplicate.
  expect((await service.topicCandidates()).candidates[0]!.existingGroups).toEqual([{id: group.state.id, name: candidate!.name}]);
});

test('cloud discovery keeps the 500-entry scan bound: a memory past it is warned about, not compared', async () => {
  const cloud = Object.assign(new CommonCloud(), {commonMemoryScope: 'a'.repeat(64)}), service = createCommonMemoryService(() => cloud);
  const notes = (prefix: string, count: number) => Array.from({length: count}, (_, i) => `### ${prefix} 메모 ${i}\n짧은 메모`).join('\n\n');
  cloud.source(A, `${notes('가', 300)}\n\n### ${lessons.bun1[0]}\n${lessons.bun1[1]}`);
  cloud.source(B, `${notes('나', 150)}\n\n### ${lessons.bun2[0]}\n${lessons.bun2[1]}`);
  cloud.source(C, `${notes('다', 60)}\n\n### ${lessons.vercel2[0]}\n${lessons.vercel2[1]}\n\n### Bun env\n${lessons.bun2[1]}`);
  const result = await service.topicCandidates(null, [A, B, C]);
  expect(result.warnings.map(w => w.memoryId)).toEqual([C]);
  expect(result.warnings[0]!.message).toContain('500개 항목·2MB');
  expect(result.scanComplete).toBe(false);
  expect(result.method).toBe('cross-memory-lesson-cluster');
  expect(result.candidates.map(c => c.sourceMemoryIds)).toEqual([[A, B]]);
});
