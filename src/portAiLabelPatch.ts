import type { PortRecord } from './ports-merge';

const MAX_PATCHES = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const BODY_TIMEOUT_MS = 5_000;
const EXPECTED_FIELDS = ['name', 'folderPath', 'aiName', 'category', 'description'] as const;
type ExpectedField = typeof EXPECTED_FIELDS[number];

export interface PortAiLabelExpected {
  name: string;
  folderPath: string | null;
  aiName: string | null;
  category: string | null;
  description: string | null;
}

export interface PortAiLabelPatch {
  id: string;
  expected: PortAiLabelExpected;
  desired: { aiName?: string; category?: string };
}

export interface PortAiLabelPatchRequest { patches: PortAiLabelPatch[] }
export interface PortAiLabelPatchResult<T extends PortRecord = PortRecord> {
  ports: T[];
  appliedIds: string[];
  unchangedIds: string[];
  skipped: Array<{ id: string; reason: 'missing' | 'changed'; fields: ExpectedField[] }>;
}

export class PortAiLabelPatchError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
    this.name = 'PortAiLabelPatchError';
  }
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, max: number, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')
    || (!allowEmpty && !value.trim())) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  }
  return value;
}

/** Validate the complete batch before taking the file lock or changing any row. */
export function normalizePortAiLabelPatchRequest(value: unknown): PortAiLabelPatchRequest {
  const body = exactObject(value, ['patches']);
  if (!Array.isArray(body.patches) || body.patches.length < 1 || body.patches.length > MAX_PATCHES) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  }
  const seen = new Set<string>();
  const limits: Record<ExpectedField, number> = {
    name: 512, folderPath: 4_096, aiName: 256, category: 256, description: 16_384,
  };
  const patches = body.patches.map(value => {
    const item = exactObject(value, ['id', 'expected', 'desired']);
    const id = boundedString(item.id, 512, false);
    if (/[\x00-\x1f\x7f]/.test(id) || seen.has(id)) {
      throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
    }
    seen.add(id);
    const expected = exactObject(item.expected, EXPECTED_FIELDS);
    for (const field of EXPECTED_FIELDS) {
      if (field !== 'name' && expected[field] === null) continue;
      boundedString(expected[field], limits[field], field !== 'name');
    }
    const desiredInput = item.desired;
    if (!desiredInput || typeof desiredInput !== 'object' || Array.isArray(desiredInput)) {
      throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
    }
    const keys = Object.keys(desiredInput);
    if (keys.length < 1 || keys.length > 2 || keys.some(key => key !== 'aiName' && key !== 'category')) {
      throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
    }
    const desired: PortAiLabelPatch['desired'] = {};
    for (const key of keys as Array<keyof PortAiLabelPatch['desired']>) {
      const value = boundedString((desiredInput as Record<string, unknown>)[key], 256, false).trim();
      if (/[\x00-\x1f\x7f]/.test(value)) throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
      desired[key] = value;
    }
    return { id, expected: { ...expected } as unknown as PortAiLabelExpected, desired };
  });
  return { patches };
}

/** Bounded local JSON transport; no lock is held while an upload body arrives. */
export async function readPortAiLabelPatchRequest(request: Request): Promise<PortAiLabelPatchRequest> {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_JSON_REQUIRED', 415);
  }
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  }
  if (length !== null && Number(length) > MAX_BODY_BYTES) {
    throw new PortAiLabelPatchError('PORT_AI_LABELS_BODY_TOO_LARGE', 413);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        let text = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BODY_BYTES) throw new PortAiLabelPatchError('PORT_AI_LABELS_BODY_TOO_LARGE', 413);
          text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PortAiLabelPatchError('PORT_AI_LABELS_BODY_TIMEOUT', 408)), BODY_TIMEOUT_MS);
      }),
    ]);
    return normalizePortAiLabelPatchRequest(JSON.parse(body));
  } catch (error) {
    if (error instanceof PortAiLabelPatchError) throw error;
    throw new PortAiLabelPatchError('PORT_AI_LABELS_INVALID_REQUEST');
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Caller holds ports.json.lock across the current read, this check and atomic write. */
export function applyPortAiLabelPatches<T extends PortRecord>(
  current: readonly T[], request: PortAiLabelPatchRequest,
): PortAiLabelPatchResult<T> {
  // Revalidate even for non-HTTP callers; invalid suggestions must never partly commit.
  const { patches } = normalizePortAiLabelPatchRequest(request);
  const byId = new Map<string, T>();
  for (const row of current) {
    if (!row || typeof row.id !== 'string' || !row.id || byId.has(row.id)) {
      throw new PortAiLabelPatchError('PORT_AI_LABELS_CURRENT_ROWS_INVALID', 409);
    }
    byId.set(row.id, row);
  }
  const replacements = new Map<string, T>();
  const result: PortAiLabelPatchResult<T> = { ports: [], appliedIds: [], unchangedIds: [], skipped: [] };
  for (const patch of patches) {
    const row = byId.get(patch.id);
    if (!row) {
      result.skipped.push({ id: patch.id, reason: 'missing', fields: [] });
      continue;
    }
    const record = row as unknown as Record<string, unknown>;
    // A lost successful response is a no-op only while the original identity
    // and every unpatched label still match, and patched fields equal the proposal.
    const alreadyApplied = EXPECTED_FIELDS.every(field => {
      const value = (field === 'aiName' || field === 'category') && Object.hasOwn(patch.desired, field)
        ? patch.desired[field] : patch.expected[field];
      return (record[field] ?? null) === value;
    });
    if (alreadyApplied) {
      result.unchangedIds.push(patch.id);
      continue;
    }
    const fields = EXPECTED_FIELDS.filter(field => (record[field] ?? null) !== patch.expected[field]);
    if (fields.length > 0) {
      result.skipped.push({ id: patch.id, reason: 'changed', fields });
      continue;
    }
    replacements.set(patch.id, { ...row, ...patch.desired });
    result.appliedIds.push(patch.id);
  }
  result.ports = current.map(row => replacements.get(row.id) ?? row);
  return result;
}
