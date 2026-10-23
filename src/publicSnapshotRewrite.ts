/**
 * Values that differ between this private source and the public snapshot.
 *
 * `scripts/publish.ts` copies the committed tree as-is, except for the files
 * listed by a rewrite rule. A rule replaces one exact value with its public
 * counterpart in one file. The private build never sees the rewrite.
 *
 * A rule must match exactly once. If the source moved the value or added a
 * second copy, publishing stops instead of guessing.
 */
export interface PublicSnapshotRewrite {
  readonly path: string;
  readonly from: string;
  readonly to: string;
}

export function applyPublicSnapshotRewrite(content: string, rule: PublicSnapshotRewrite): string {
  if (!rule.from || rule.from === rule.to) throw new Error(`PUBLIC_REWRITE_INVALID: ${rule.path}`);
  const count = content.split(rule.from).length - 1;
  if (count !== 1) throw new Error(`PUBLIC_REWRITE_MATCH_COUNT: ${rule.path} (${count})`);
  return content.replace(rule.from, () => rule.to);
}
