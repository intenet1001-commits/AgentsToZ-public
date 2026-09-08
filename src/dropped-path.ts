export type DroppedPathKind = 'file' | 'folder';
export type DroppedPathCandidateKind = DroppedPathKind | 'other' | null;

const basenameAnyPlatform = (path: string): string => {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) || '';
};

export function selectMatchingDroppedPath(
  candidates: string[],
  expectedNames: string[],
  expectedKind: DroppedPathKind,
  getCandidateKind: (path: string) => DroppedPathCandidateKind,
): string | null {
  const names = new Set(expectedNames.map(name => name.trim()).filter(Boolean));
  if (names.size === 0) return null;

  return candidates.find(candidate =>
    names.has(basenameAnyPlatform(candidate))
    && getCandidateKind(candidate) === expectedKind
  ) ?? null;
}
