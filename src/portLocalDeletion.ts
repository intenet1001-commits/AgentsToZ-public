const validPortId = (value: unknown): value is string => typeof value === "string"
  && value.length > 0
  && value.length <= 512
  && !value.includes("\0");

/** App-local suppression list. It is stored in portal.json and never pushed. */
export function normalizeLocalOnlyDeletedPortIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!validPortId(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    ids.push(candidate);
  }
  // Tombstones are deletion authority, not an LRU cache. Silently trimming an
  // old ID makes a later Pull/auto-push recreate something the user removed.
  // Compaction is allowed only in a separate flow that proves both local and
  // remote absence; normalization therefore preserves every valid unique ID.
  return ids;
}

export function addLocalOnlyDeletedPortIds(value: unknown, added: readonly string[]): string[] {
  const next = normalizeLocalOnlyDeletedPortIds(value);
  for (const id of added) {
    if (!validPortId(id)) continue;
    const previous = next.indexOf(id);
    if (previous >= 0) next.splice(previous, 1);
    next.push(id);
  }
  return next;
}

export function removeLocalOnlyDeletedPortIds(value: unknown, removed: readonly string[]): string[] {
  const remove = new Set(removed.filter(validPortId));
  return normalizeLocalOnlyDeletedPortIds(value).filter(id => !remove.has(id));
}

export function withoutLocallyDeletedRemotePorts<T extends { id: string }>(
  rows: readonly T[],
  value: unknown,
): T[] {
  const deleted = new Set(normalizeLocalOnlyDeletedPortIds(value));
  return rows.filter(row => !deleted.has(row.id));
}
