/**
 * Normalizes the conflict payloads returned by project-memory endpoints.
 * Keeping it separate from the panel makes the three conflict paths (Push,
 * Pull, and session-end's pre/post-flight checks) present the same safe UI.
 */

export type ProjectMemoryConflictOrigin =
  | 'push'
  | 'pull'
  | 'session-preflight'
  | 'session-post-update'
  | 'resolve';

export type ProjectMemoryConflictSource = 'push' | 'pull' | 'session' | 'resolve';

export interface ProjectMemoryConflict {
  origin: ProjectMemoryConflictOrigin;
  /** True only when the local AI consolidation already completed. */
  localSaved: boolean;
  remoteRevisionId: string | null;
  remoteCreatedAt: string | null;
  remoteContentHash: string | null;
  remoteDeviceName: string | null;
  remoteContent: string | null;
  localContentHash: string | null;
  localModifiedAt: string | null;
  lastSyncedHash: string | null;
  localContent: string | null;
}

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;

const asString = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** Extract either a direct conflict or the race detected after session memory
 * was locally saved but before its final Push. */
export function projectMemoryConflictFromResult(
  value: unknown,
  source: ProjectMemoryConflictSource,
): ProjectMemoryConflict | null {
  const result = asRecord(value);
  if (!result) return null;
  const nestedRemote = asRecord(result.remote);
  const payload = result.conflict === true ? result : nestedRemote?.conflict === true ? nestedRemote : null;
  if (!payload) return null;

  const preflight = result.preflightConflict === true || payload.preflightConflict === true;
  const localSaved = result.localSaved === true || payload.localSaved === true;
  const origin: ProjectMemoryConflictOrigin = preflight
    ? 'session-preflight'
    : source === 'resolve'
      ? 'resolve'
      : source === 'push' || source === 'pull'
        ? source
        : localSaved
          ? 'session-post-update'
          : 'session-preflight';

  return {
    origin,
    localSaved,
    remoteRevisionId: asString(payload.remoteRevisionId),
    remoteCreatedAt: asString(payload.remoteCreatedAt),
    remoteContentHash: asString(payload.remoteContentHash),
    remoteDeviceName: asString(payload.remoteDeviceName),
    remoteContent: asString(payload.remoteContent),
    localContentHash: asString(payload.localContentHash),
    localModifiedAt: asString(payload.localModifiedAt),
    lastSyncedHash: asString(payload.lastSyncedHash),
    localContent: asString(payload.localContent),
  };
}

export function projectMemoryConflictSummary(conflict: ProjectMemoryConflict): string {
  if (conflict.origin === 'session-preflight') {
    return '세션 기억 AI는 시작되지 않았습니다. 먼저 로컬·원격 장기기억의 방향을 선택하세요.';
  }
  if (conflict.origin === 'session-post-update') {
    return '로컬 세션 기억은 저장됐고, Supabase 백업만 충돌했습니다. 아래에서 안전하게 동기화 방향을 선택하세요.';
  }
  return '로컬과 Supabase 장기기억이 모두 변경되었습니다. 아직 어느 쪽도 자동으로 덮어쓰지 않았습니다.';
}

export function projectMemoryContentPreview(content: string | null, maxLength = 900): string {
  if (!content) return '비교할 본문을 받지 못했습니다. “다시 비교”를 눌러 최신 충돌 정보를 확인하세요.';
  const normalized = content.trim();
  if (!normalized) return '(빈 장기기억)';
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}\n\n… (${normalized.length - maxLength}자 더 있음)`
    : normalized;
}

/** Copy-only prompt: the user decides whether an AI should propose a merge. */
export function projectMemoryConflictMergePrompt(conflict: ProjectMemoryConflict): string {
  return [
    '아래 두 프로젝트 장기기억을 비교해서 병합 초안을 만들어줘.',
    '중요: 원본 파일을 바로 덮어쓰지 말고, 중복은 정리하고 모순은 “Contested Entries” 아래에 남겨줘.',
    `원격 리비전: ${conflict.remoteRevisionId || '알 수 없음'}`,
    '',
    '## 로컬 장기기억',
    conflict.localContent || '(본문을 받지 못함)',
    '',
    '## Supabase 장기기억',
    conflict.remoteContent || '(본문을 받지 못함)',
  ].join('\n');
}

interface MemoryEntryBlock {
  title: string;
  entryId: string | null;
  content: string;
}

/** Keep section/preamble text separate and ignore headings inside examples. A
 * heading regex alone can silently drop a remote document's decisions. */
function documentParts(content: string): {entries: MemoryEntryBlock[]; context: string; malformedIds: number} {
  const normalized = content.replace(/\r\n?/g, '\n');
  const entries: MemoryEntryBlock[] = [], context: string[] = [];
  let fence: {marker: string; length: number} | null = null;
  let lines: string[] = [], title: string | null = null, malformedIds = 0;
  const flush = () => {
    if (title === null) context.push(...lines);
    else {
      const next = lines.slice(1).find(line => line.trim());
      const marker = next?.trim().match(/^<!--\s*memory-entry-id:([^\s]+)\s*-->$/);
      const id = marker?.[1];
      if (next?.includes('memory-entry-id:') && (!id || !/^[0-9a-f]{24}$/.test(id))) malformedIds++;
      entries.push({title, entryId: id && /^[0-9a-f]{24}$/.test(id) ? id : null, content: lines.join('\n').trim()});
    }
    lines = [];
  };
  for (const line of normalized.split('\n')) {
    const boundary = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (boundary) {
      if (!fence) fence = {marker: boundary[1]![0]!, length: boundary[1]!.length};
      else if (boundary[1]![0] === fence.marker && boundary[1]!.length >= fence.length && !boundary[2]!.trim()) fence = null;
      lines.push(line); continue;
    }
    if (!fence) {
      const heading = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (heading) { flush(); title = heading[1] === '###' ? heading[2]! : null; }
    }
    lines.push(line);
  }
  flush();
  return {entries, context: context.join('\n').trim(), malformedIds};
}

export function projectMemoryConflictIdentityIssues(content: string): {duplicateIds: string[]; malformedIds: number} {
  const {entries, malformedIds} = documentParts(content);
  const counts = new Map<string, number>();
  for (const entry of entries) if (entry.entryId) counts.set(entry.entryId, (counts.get(entry.entryId) ?? 0) + 1);
  return {duplicateIds: [...counts].filter(([,count]) => count > 1).map(([id]) => id), malformedIds};
}

const blockBody = (block: MemoryEntryBlock): string => block.content
  .replace(/^###\s+.+?\s*\n/, '')
  .replace(/^<!-- memory-entry-id:[0-9a-f]{24} -->\s*\n/, '')
  .trim();

const quoted = (content: string): string => content
  .split('\n')
  .map(line => `> ${line}`)
  .join('\n');

/**
 * Creates a local-only, review-required merge draft. The local document stays
 * the structural anchor; remote-only entries are retained verbatim and two
 * versions of one stable entry remain visibly contested instead of choosing a
 * winner automatically.
 */
export function projectMemoryConflictSuggestedMerge(conflict: ProjectMemoryConflict): string {
  const local = conflict.localContent?.replace(/\r\n?/g, '\n').trim() ?? '';
  const remote = conflict.remoteContent?.replace(/\r\n?/g, '\n').trim() ?? '';
  if (!local) return remote;
  if (!remote) return local;

  if (local === remote) return local;
  const localParts = documentParts(local), remoteParts = documentParts(remote);
  const localEntries = localParts.entries, remoteEntries = remoteParts.entries;
  const issues = [projectMemoryConflictIdentityIssues(local), projectMemoryConflictIdentityIssues(remote)];
  if (issues.some(issue => issue.duplicateIds.length || issue.malformedIds)) {
    return `${local}\n\n## Contested Entries\n\n### Review ambiguous entry identities\n\n중복되거나 잘못된 항목 ID가 있습니다. ID를 자동 재발급하지 않았습니다. 두 원본을 대조해 항목의 소유를 먼저 검토하세요.\n\n${quoted(remote)}\n`;
  }
  if (!remoteEntries.length) {
    return `${local}\n\n## Contested Entries\n\n### Review remote document without stable entries\n\n${quoted(remote)}\n`;
  }

  const localById = new Map(localEntries
    .filter((entry): entry is MemoryEntryBlock & { entryId: string } => entry.entryId !== null)
    .map(entry => [entry.entryId, entry]));
  const remoteOnly: MemoryEntryBlock[] = [];
  const changed: MemoryEntryBlock[] = [];
  for (const remoteEntry of remoteEntries) {
    if (!remoteEntry.entryId) {
      changed.push(remoteEntry);
      continue;
    }
    const localEntry = localById.get(remoteEntry.entryId);
    if (!localEntry) remoteOnly.push(remoteEntry);
    else if (localEntry.content !== remoteEntry.content) changed.push(remoteEntry);
  }

  const additions: string[] = [];
  if (remoteParts.context && remoteParts.context !== localParts.context) {
    additions.push('## Remote document context to review', '',
      '항목 밖의 원격 제목·설명·결정도 검토할 수 있도록 보존했습니다.', '', quoted(remoteParts.context));
  }
  if (remoteOnly.length) {
    additions.push(
      '## Supabase-only entries to place after review',
      '',
      'The entries below were present only in the remote revision. Keep, move, or consolidate them before saving.',
      '',
      ...remoteOnly.map(entry => entry.content),
    );
  }
  if (changed.length) {
    additions.push(
      '## Contested Entries',
      '',
      'The remote entries below use an existing stable ID but differ from the local version. Review both versions; do not remove either fact merely to clear this section.',
      '',
      ...changed.flatMap(entry => [
        `### Review remote version: ${entry.title}`,
        '',
        `- Stable entry ID: \`${entry.entryId ?? 'missing'}\``,
        '- The local version remains in its original section above. The quoted body below is the remote version to reconcile.',
        '',
        quoted(blockBody(entry)),
        '',
      ]),
    );
  }
  return additions.length ? `${local}\n\n${additions.join('\n').trim()}\n` : local;
}
