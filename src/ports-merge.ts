export type PortRecord = {
  id: string;
};

const asRecord = (value: PortRecord): Record<string, unknown> =>
  value as unknown as Record<string, unknown>;

function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedFromBase(base: PortRecord, desired: PortRecord): boolean {
  const baseRecord = asRecord(base);
  const desiredRecord = asRecord(desired);
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(desiredRecord)]);
  for (const key of keys) {
    if (key !== 'id' && !jsonEqual(baseRecord[key], desiredRecord[key])) return true;
  }
  return false;
}

function mergeRecordFields(
  base: PortRecord,
  desired: PortRecord,
  current: PortRecord,
): PortRecord {
  const baseRecord = asRecord(base);
  const desiredRecord = asRecord(desired);
  const merged: Record<string, unknown> = { ...asRecord(current), id: desired.id };
  const keys = new Set([...Object.keys(baseRecord), ...Object.keys(desiredRecord)]);

  for (const key of keys) {
    if (key === 'id' || jsonEqual(baseRecord[key], desiredRecord[key])) continue;
    if (Object.prototype.hasOwnProperty.call(desiredRecord, key)) merged[key] = desiredRecord[key];
    else delete merged[key];
  }

  return merged as PortRecord;
}

/**
 * Three-way merge for ports.json.
 *
 * `base` is what this window last loaded, `desired` is its edited state, and
 * `current` is the newest disk state. Records added by another window after
 * `base` are preserved, while intentional local additions/deletions still apply.
 * Concurrent changes to different fields of the same record are also preserved.
 */
export function mergePortSnapshots<T extends PortRecord>(
  base: readonly T[],
  desired: readonly T[],
  current: readonly T[],
): T[] {
  const baseById = new Map(base.map(port => [port.id, port]));
  const desiredById = new Map(desired.map(port => [port.id, port]));
  const currentById = new Map(current.map(port => [port.id, port]));
  const deletedIds = new Set(
    base.filter(port => !desiredById.has(port.id)).map(port => port.id),
  );

  const mergedById = new Map<string, T>();

  // Preserve records that appeared after this window's baseline.
  for (const port of current) {
    if (!deletedIds.has(port.id)) mergedById.set(port.id, port);
  }

  for (const desiredPort of desired) {
    const basePort = baseById.get(desiredPort.id);
    const currentPort = currentById.get(desiredPort.id);

    if (!basePort) {
      // This window created the record.
      mergedById.set(desiredPort.id, desiredPort);
      continue;
    }

    if (!currentPort) {
      // Another window deleted it. Do not resurrect an untouched stale record.
      if (changedFromBase(basePort, desiredPort)) {
        mergedById.set(desiredPort.id, desiredPort);
      }
      continue;
    }

    mergedById.set(
      desiredPort.id,
      mergeRecordFields(basePort, desiredPort, currentPort) as T,
    );
  }

  const desiredAddedIds = desired
    .filter(port => !baseById.has(port.id) && mergedById.has(port.id))
    .map(port => port.id);
  const concurrentAddedIds = current
    .filter(port => !baseById.has(port.id) && !desiredById.has(port.id) && mergedById.has(port.id))
    .map(port => port.id);
  const remainingDesiredIds = desired
    .filter(port => baseById.has(port.id) && mergedById.has(port.id))
    .map(port => port.id);
  const knownOrder = new Set([
    ...desiredAddedIds,
    ...concurrentAddedIds,
    ...remainingDesiredIds,
  ]);
  const remainingIds = current
    .filter(port => mergedById.has(port.id) && !knownOrder.has(port.id))
    .map(port => port.id);

  return [
    ...desiredAddedIds,
    ...concurrentAddedIds,
    ...remainingDesiredIds,
    ...remainingIds,
  ].map(id => mergedById.get(id)!);
}

/** Legacy clients have no baseline, so only upsert their records and never
 * interpret missing records as deletions. This favors data preservation. */
export function mergeLegacyPortSave<T extends PortRecord>(
  desired: readonly T[],
  current: readonly T[],
): T[] {
  const desiredById = new Map(desired.map(port => [port.id, port]));
  return [
    ...desired,
    ...current.filter(port => !desiredById.has(port.id)),
  ];
}
