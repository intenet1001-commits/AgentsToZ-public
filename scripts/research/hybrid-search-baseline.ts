/**
 * Exploratory search baseline using synthetic, reviewable data only.
 * Run with: bun scripts/research/hybrid-search-baseline.ts
 * This does not read project memory, install models, or contact any provider.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { recallProjectMemoryEntries } from '../../src/projectMemoryRecall';
import { recallProjectMemoryJournal, type ProjectMemoryJournalRecallEntry } from '../../src/projectMemoryJournalRecall';

type Entry = { id: string; title: string; body: string; scope?: 'allowed' | 'other'; contested?: boolean };
type Case = { id: string; query: string; expected?: string; scope?: 'allowed'; purpose: string };

// Synthetic examples: these are test fixtures, not claims about a live host.
const corpus: Entry[] = [
  { id: 'enter', title: '휴대폰 워크룸 엔터', body: '크기 변경 뒤 CPR 응답이 늦어 Enter가 전송되지 않은 과거 사례.' },
  { id: 'conflict', title: '기억 충돌 보존', body: '로컬과 원격이 모두 바뀌면 자동 덮어쓰기 대신 양쪽 원본을 보존한다.' },
  { id: 'backup', title: '백업 확인', body: '로컬 저장과 원격 백업의 결과를 각각 확인한다.' },
  { id: 'release', title: '앱 공증 설치', body: 'Apple 공증과 설치된 앱 실행 확인은 별도의 검증이다.' },
  { id: 'revoked', title: '원격 세션 만료', body: '오류 코드 E_DEVICE_REVOKED 는 권한 해제를 뜻하는 합성 예시다.' },
  { id: 'collection', title: '요청 기록 수집 경계', body: '마지막 수집 시각과 요청 종료 시각을 구분한다.' },
  { id: 'sequence', title: 'PostgreSQL 시퀀스', body: '시퀀스 호출과 테이블 잠금은 별도 경계로 검토한다.' },
  { id: 'allowed', title: '공용 프로젝트 A 배포', body: '프로젝트 A의 배포 단계는 합성 데이터다.', scope: 'allowed' },
  { id: 'other', title: '공용 프로젝트 B 배포', body: '프로젝트 B의 배포 단계는 합성 데이터다.', scope: 'other' },
  { id: 'contested', title: '공통 기억 병합 여부', body: '동일한 항목의 두 버전은 충돌 중이며 판단을 보류한다.', contested: true },
];

// These labels are initial hypotheses, not human-validated ground truth.
const cases: Case[] = [
  { id: 'exact-code', query: 'E_DEVICE_REVOKED', expected: 'revoked', purpose: 'exact error code' },
  { id: 'short-korean', query: '백업', expected: 'backup', purpose: 'two-character Korean' },
  { id: 'exact-technical', query: 'CPR', expected: 'enter', purpose: 'exact technical identifier' },
  { id: 'paraphrase', query: '키를 쳐도 대화가 제출되지 않는다', expected: 'enter', purpose: 'Korean paraphrase without the source wording' },
  { id: 'sync', query: '로컬 원격 충돌', expected: 'conflict', purpose: 'conflicting sources' },
  { id: 'capture', query: '수집 시각 종료 시각', expected: 'collection', purpose: 'collection range' },
  { id: 'sequence', query: '시퀀스 테이블 잠금', expected: 'sequence', purpose: 'technical safeguards' },
  { id: 'scoped', query: '공용 프로젝트 배포', expected: 'allowed', scope: 'allowed', purpose: 'filter before ranking' },
  { id: 'contested', query: '공통 기억 병합', expected: 'contested', purpose: 'contested source remains cautious' },
  { id: 'no-evidence', query: 'orchidquartz984113', purpose: 'no matching evidence' },
];

const markdown = corpus.map(e => `## ${e.contested ? 'Contested Entries' : 'Key Decisions'}\n\n### ${e.title}\n${e.body}\n`).join('\n');
const entries: ProjectMemoryJournalRecallEntry[] = corpus.map((e, index) => ({
  entryHash: (index + 1).toString(16).padStart(16, '0'),
  recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  agent: 'codex', headCommit: null, summary: e.title, body: e.body, integrity: 'verified',
}));
const corpusByTitle = new Map(corpus.map(e => [e.title, e]));
const byHash = new Map(entries.map((e, i) => [e.entryHash, corpus[i]!]));
const root = mkdtempSync(join(tmpdir(), 'agentstoz-search-baseline-'));
const started = performance.now();
try {
  const results = cases.map(c => {
    const allowed = (e: Entry) => !c.scope || e.scope !== 'other';
    const begin = performance.now();
    const curated = recallProjectMemoryEntries(markdown, c.query, {
      limit: 5, entryFilter: e => allowed(corpusByTitle.get(e.title)!),
    });
    const curatedMs = performance.now() - begin;
    const journalStart = performance.now();
    const journal = recallProjectMemoryJournal({ cachePath: join(root, 'journal.sqlite'), identity: 'synthetic-only-v1',
      entries: entries.filter(e => allowed(byHash.get(e.entryHash)!)), query: c.query, limit: 5 });
    const journalMs = performance.now() - journalStart;
    const curatedIds = curated.map(h => corpusByTitle.get(h.title)!.id);
    const journalIds = journal.hits.map(h => byHash.get(h.entryHash)!.id);
    const expectedFound = (ids: string[]) => c.expected ? ids.includes(c.expected) : ids.length === 0;
    return { ...c, curated: { ids: curatedIds, expectedFound: expectedFound(curatedIds), ms: curatedMs,
      contestedCaution: c.id === 'contested' ? curated.find(h => h.title === corpus.find(e => e.id === c.expected)?.title)?.caution ?? null : undefined },
      journal: { ids: journalIds, expectedFound: expectedFound(journalIds), ms: journalMs, mode: journal.mode, complete: journal.complete },
      prohibitedScopeReturned: curatedIds.includes('other') || journalIds.includes('other') };
  });
  const report = { version: 1, kind: 'exploratory-synthetic-baseline', validatedGroundTruth: false,
    data: 'synthetic only', externalProviderUsed: false, cases: results.length,
    curatedExpectedFound: results.filter(r => r.curated.expectedFound).length,
    journalExpectedFound: results.filter(r => r.journal.expectedFound).length,
    scopedLeakCases: results.filter(r => r.scope && r.prohibitedScopeReturned).length,
    durationMs: performance.now() - started,
    limitations: ['Small unreviewed synthetic corpus; not a production relevance or latency measurement.',
      'Direct retrieval functions do not exercise the complete host authorization and correction pipeline.',
      'Journal examples are historical evidence, not proof of current state.',
      'No hybrid or embedding model has been evaluated.'], results };
  const destination = process.env.AGENTSTOZ_SEARCH_BASELINE_REPORT || join(tmpdir(), 'agentstoz-hybrid-search-synthetic-baseline.json');
  writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, results: undefined, report: destination }));
} finally { rmSync(root, { recursive: true, force: true }); }
