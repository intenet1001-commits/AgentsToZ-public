/**
 * Names for several GitHub buttons on one project (VOC 2026-09-25): 「GitHub 1/2/3」
 * said nothing about which repository each opened. The repository name does;
 * when two share a name the owner is added. The full URL stays in the tooltip.
 */
function parts(url: string): {owner: string; repo: string} | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return null;
    const [owner, repo] = parsed.pathname.split('/').filter(Boolean);
    if (!owner || !repo) return null;
    return {owner, repo: repo.replace(/\.git$/i, '')};
  } catch { return null; }
}

export function githubRepositoryLabels(urls: readonly string[]): string[] {
  const parsed = urls.map(parts);
  const counts = new Map<string, number>();
  for (const p of parsed) if (p) counts.set(p.repo.toLowerCase(), (counts.get(p.repo.toLowerCase()) ?? 0) + 1);
  return parsed.map((p, index) => !p ? `GitHub ${index + 1}` : (counts.get(p.repo.toLowerCase())! > 1 ? `${p.owner}/${p.repo}` : p.repo));
}
