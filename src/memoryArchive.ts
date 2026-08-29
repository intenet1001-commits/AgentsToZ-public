/**
 * 장기기억 아카이브 — 프로젝트를 지워도 거기서 얻은 노하우는 남긴다.
 *
 * 프로젝트를 정리하면 폴더와 함께 `.agent-memory/`도 사라진다. 그런데 거기 적힌 것은
 * 그 프로젝트만의 사실이 아니다 — "이 API는 이렇게 인증한다", "이 빌드는 이래서 깨진다"
 * 같은 내용은 다음 프로젝트에서도 그대로 쓰인다. 폴더를 지우는 순간 그 지식이 함께
 * 사라지면, 사용자는 안 쓰는 프로젝트를 **지우기를 두려워하게 된다**. 그러면 정리 검토
 * 자체가 작동하지 않는다.
 *
 * 그래서 삭제 전에 기억을 앱 데이터 폴더로 **복사**해 둔다. 원본은 건드리지 않으므로
 * 아카이브가 실패해도 삭제가 막히지 않고, 성공하면 폴더가 사라져도 내용이 남는다.
 */

export interface MemoryArchiveMeta {
  id: string;
  /** 프로젝트 이름 (아카이브 당시). */
  projectName: string;
  /** 이름이 바뀌어도 유지되는 프로젝트 코드. */
  projectCode: string;
  /** 원본 폴더 경로 — 어디에 있던 프로젝트인지. */
  sourcePath: string;
  archivedAt: string;
  /** 왜 보관됐는지 (cleanup·manual …). */
  reason: string;
  bytes: number;
  /** 목록에서 보여줄 첫 문단. */
  summary: string;
  /** 본문 파일명. */
  file: string;
}

const MAX_SUMMARY = 180;

/**
 * 목록에 보여줄 한 문단을 본문에서 뽑는다.
 *
 * 머리말(제목·메타 줄)은 어느 기억이나 비슷해서 목록에서 서로 구분되지 않는다.
 * 첫 번째 **의미 있는 산문 줄**을 찾는 이유가 그것이다.
 */
export function summarizeMemory(content: string, limit = MAX_SUMMARY): string {
  const lines = (content ?? '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;          // 제목
    if (line.startsWith('<!--')) continue;       // 마커 주석
    if (line.startsWith('|') || line.startsWith('---')) continue; // 표·구분선
    // `**Project**: …`, `**Created**: …` 같은 머리말 키-값 줄. 어느 기억에나 있어서
    // 목록에서 서로 구분되지 않는다 — 실측에서 요약이 "**Created**: 2026-07-26"으로
    // 뽑혀 아무 정보도 주지 못했다.
    if (/^\*\*[^*]{1,24}\*\*\s*[::]/.test(line)) continue;
    const text = line.replace(/^[-*+]\s+/, '').replace(/\s+/g, ' ').trim();
    if (text.length < 8) continue;
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }
  return '';
}

/** 파일명에 쓸 안전한 조각. VOC와 같은 규칙 — 한글은 남기고 경로 문자만 없앤다. */
export function archiveSlug(value: string, limit = 40): string {
  const cleaned = (value || '')
    .replace(/[-/\\:*?"<>|\s]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = cleaned.slice(0, limit).replace(/-+$/g, '');
  return slug || 'memory';
}

/** `2026-08-13` — 날짜만. 같은 날 같은 프로젝트를 두 번 보관하면 서버가 접미사를 붙인다. */
export function archiveDateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '0000-00-00';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function archiveFileName(meta: Pick<MemoryArchiveMeta, 'archivedAt' | 'projectName' | 'projectCode'>): string {
  return `${archiveDateStamp(meta.archivedAt)}-${archiveSlug(meta.projectName)}-${meta.projectCode}.md`;
}

/**
 * 본문 앞에 붙는 머리말.
 *
 * 아카이브는 원본 폴더가 사라진 뒤에 읽힌다. 그때 "이게 어느 프로젝트의 무엇인지"를
 * 알려 줄 것이 파일 안에 없으면 내용만 남고 맥락이 사라진다.
 */
export function archiveHeader(meta: MemoryArchiveMeta): string {
  return [
    `<!-- AgentsToZ memory-archive -->`,
    `# ${meta.projectName} — 장기기억 아카이브`,
    '',
    `- 프로젝트 코드: \`${meta.projectCode}\``,
    `- 원본 경로: \`${meta.sourcePath}\``,
    `- 보관 시각: ${meta.archivedAt}`,
    `- 보관 사유: ${meta.reason}`,
    '',
    '---',
    '',
  ].join('\n');
}
