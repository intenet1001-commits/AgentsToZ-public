import {commonMemoryId, commonMemoryText, CommonMemoryError, type CommonMemorySourceEntry} from './commonMemory';

/** Kept in the existing body so older schema-1 clients preserve provenance on a round trip. */
const marker = '\n\n<!-- agentstoz-topic-evidence-v1:';
export type CommonTopicEvidence = {
  schemaVersion: 1;
  reason: string;
  category: string;
  conditions: string[];
  sources: Array<Pick<CommonMemorySourceEntry, 'memoryId' | 'revisionId' | 'entryId' | 'contentHash' | 'title'> & {memoryName: string}>;
  supersedes?: {entryId: string; contentHash: string};
};
export function validateCommonTopicEvidence(raw: unknown): CommonTopicEvidence {
  const fail = (): never => { throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_INVALID', '공통기억 후보의 원본 근거를 다시 확인하세요.', 400); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail();
  const value = raw as CommonTopicEvidence;
  if (value.schemaVersion !== 1 || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 16 || !Array.isArray(value.conditions) || value.conditions.length > 16) return fail();
  const sources = value.sources.map(source => {
    if (!source || !/^[a-f0-9]{24}$/.test(source.entryId) || !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(source.contentHash)) return fail();
    return {memoryId: commonMemoryId(source.memoryId), revisionId: commonMemoryId(source.revisionId), entryId: source.entryId, contentHash: source.contentHash, title: commonMemoryText(source.title, 300), memoryName: commonMemoryText(source.memoryName, 240)};
  });
  if (new Set(sources.map(source => `${source.memoryId}:${source.entryId}`)).size !== sources.length) return fail();
  if (value.supersedes && (!/^[a-f0-9]{24}$/.test(value.supersedes.entryId) || !/^[a-f0-9]{64}$/.test(value.supersedes.contentHash))) return fail();
  return {schemaVersion: 1, reason: commonMemoryText(value.reason, 2000), category: commonMemoryText(value.category, 120, false), conditions: value.conditions.map(condition => commonMemoryText(condition, 500)), sources, ...(value.supersedes ? {supersedes: value.supersedes} : {})};
}
export function withCommonTopicEvidence(body: string, evidence: CommonTopicEvidence): string {
  const content = commonMemoryText(body, 12000);
  if (content.includes('agentstoz-topic-evidence-v1:')) throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_INVALID', '후보 본문에는 원본 근거 표식을 직접 넣을 수 없습니다.', 400);
  const bytes = new TextEncoder().encode(JSON.stringify(validateCommonTopicEvidence(evidence)));
  const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
  const result = `${content}${marker}${encoded} -->`;
  if (new TextEncoder().encode(result).length > 12000) throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED', '규칙과 원본 근거가 너무 큽니다. 후보나 근거 범위를 나눠 주세요.');
  return result;
}
export function readCommonTopicEvidence(body: string): {body: string; evidence: CommonTopicEvidence | null} {
  const start = body.lastIndexOf(marker);
  if (start < 0) return {body, evidence: null};
  const encoded = body.slice(start + marker.length, -4);
  if (!body.endsWith(' -->') || encoded.length > 16000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_INVALID', '후보의 원본 근거 형식을 확인하지 못했습니다.');
  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    return {body: body.slice(0, start), evidence: validateCommonTopicEvidence(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)))};
  } catch (error) { if (error instanceof CommonMemoryError) throw error; throw new CommonMemoryError('COMMON_MEMORY_EVIDENCE_INVALID', '후보의 원본 근거를 확인하지 못했습니다.'); }
}
export function commonTopicProposalText(value: string): string { return value.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }

const topics = [
  {key: 'nh-design', name: 'NH 디자인·기획', category: '디자인·기획', matches: /\b(?:nhcs|nhdesign|nds|figma)\b|기획서|디자인 시스템/i},
  {key: 'runtime', name: 'AI 런타임·대화 세션', category: 'AI 런타임', matches: /\b(?:runtime|pty|terminal|workroom)\b|런타임|워크룸|터미널|대화 세션/i},
  {key: 'memory', name: '장기기억·동기화', category: '기억·데이터', matches: /\b(?:supabase|memory|sync)\b|장기기억|공통기억|동기화|리비전/i},
  {key: 'security', name: '인증·권한·보안', category: '보안', matches: /\b(?:auth|security|permission|capability)\b|인증|권한|보안|승인 경계/i},
  {key: 'release', name: '빌드·배포·검증', category: '빌드·배포', matches: /\b(?:build|deploy|release|notary)\b|빌드|배포|출하|공증|설치 검증/i},
  {key: 'ios', name: 'iOS 앱 개발', category: '모바일', matches: /\b(?:ios|iphone|swiftui|xcode)\b|아이폰|스위프트/i},
  {key: 'game', name: '게임·상호작용', category: '게임', matches: /\b(?:game|unity|unreal)\b|게임|레이싱|게임 조작/i},
] as const;
export type CommonTopicCandidate = {key: string; name: string; category: string; sourceMemoryIds: string[]; evidence: CommonMemorySourceEntry[]; method: 'source-entry-topic-intersection'; needsSemanticReview: true};
/** Actual entry overlap is a discovery hint; it never asserts the rules are interchangeable. */
export function commonTopicCandidates(entries: CommonMemorySourceEntry[]): CommonTopicCandidate[] {
  return topics.flatMap(topic => {
    const matching = entries.filter(entry => topic.matches.test(`${entry.title} ${entry.excerpt}`));
    const sourceMemoryIds = [...new Set(matching.map(entry => entry.memoryId))].sort();
    if (sourceMemoryIds.length < 2) return [];
    const evidence = sourceMemoryIds.flatMap(id => matching.filter(entry => entry.memoryId === id).slice(0, 2)).slice(0, 16);
    return [{key: topic.key, name: topic.name, category: topic.category, sourceMemoryIds, evidence, method: 'source-entry-topic-intersection' as const, needsSemanticReview: true as const}];
  }).sort((a, b) => b.sourceMemoryIds.length - a.sourceMemoryIds.length || a.name.localeCompare(b.name)).slice(0, 7);
}
