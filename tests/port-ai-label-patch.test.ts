import { describe, expect, test } from 'bun:test';
import {
  applyPortAiLabelPatches, normalizePortAiLabelPatchRequest, readPortAiLabelPatchRequest,
  PortAiLabelPatchError, type PortAiLabelPatch,
} from '../src/portAiLabelPatch';

const original = { id: 'p1', name: 'Original', folderPath: '/projects/one', aiName: 'Old', category: 'Work', description: 'Details' };
const proposal = (overrides: Partial<PortAiLabelPatch> = {}): PortAiLabelPatch => ({
  id: original.id,
  expected: { name: original.name, folderPath: original.folderPath, aiName: original.aiName, category: original.category, description: original.description },
  desired: { aiName: 'New label', category: 'Tools' },
  ...overrides,
});
const apply = <T extends { id: string }>(rows: T[], patches = [proposal()]) => applyPortAiLabelPatches(rows, { patches });
function expectCode(run: () => unknown, code = 'PORT_AI_LABELS_INVALID_REQUEST') {
  try { run(); throw new Error('expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(PortAiLabelPatchError); expect((error as PortAiLabelPatchError).code).toBe(code); }
}
const request = (body: BodyInit, headers: Record<string, string> = {}) => new Request('http://localhost/api/ports/ai-labels', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
});

describe('guarded AI label patch', () => {
  test('updates only labels while preserving latest unrelated fields, order and new rows', () => {
    const current = [
      { id: 'windows', name: 'Other platform', folderPath: 'C:\\projects\\two', futureField: { safe: true } },
      { ...original, favorite: true, memo: 'Concurrent memo', syncGeneration: '9007199254740993', futureField: ['keep'] },
      { id: 'new', name: 'Concurrent addition' },
    ];
    const before = structuredClone(current);
    const result = apply(current);
    const expected = [current[0]!, { ...current[1]!, aiName: 'New label', category: 'Tools' }, current[2]!];
    expect(result.appliedIds).toEqual(['p1']);
    expect(result.ports).toEqual(expected);
    expect(current).toEqual(before);
    expect(result.ports[0]).toBe(current[0]);
    expect(result.ports[2]).toBe(current[2]);
  });

  test.each(['name', 'folderPath', 'aiName', 'category', 'description'] as const)('skips a concurrent %s edit', field => {
    const current = { ...original, [field]: 'Concurrent user edit' };
    const result = apply([current]);
    expect(result.ports).toEqual([current]);
    expect(result.appliedIds).toEqual([]);
    expect(result.skipped).toEqual([{ id: 'p1', reason: 'changed', fields: [field] }]);
  });

  test('partial success never recreates a deleted project', () => {
    const result = apply([original], [proposal({ id: 'deleted' }), proposal()]);
    expect(result.ports).toHaveLength(1);
    expect(result.appliedIds).toEqual(['p1']);
    expect(result.skipped).toEqual([{ id: 'deleted', reason: 'missing', fields: [] }]);
  });

  test('patches only a missing field and preserves an existing long legacy label', () => {
    const longLabel = 'Legacy descriptive label '.repeat(7);
    const p = proposal({ expected: { ...proposal().expected, aiName: longLabel, category: null }, desired: { category: 'Tools' } });
    const current: Omit<typeof original, 'category'> & { category?: string; futureField: string } = {
      ...original, aiName: longLabel, category: undefined, futureField: 'preserve',
    };
    const result = apply([current], [p]);
    expect(result.appliedIds).toEqual(['p1']);
    expect(result.ports[0]).toEqual({ ...current, category: 'Tools' });
    const replay = apply(result.ports, [p]);
    expect(replay.appliedIds).toEqual([]);
    expect(replay.unchangedIds).toEqual(['p1']);
  });

  test('an unpatched label edit is a conflict even when the patched label already matches', () => {
    for (const field of ['aiName', 'category'] as const) {
      const other = field === 'aiName' ? 'category' : 'aiName';
      const p = proposal({ desired: { [field]: 'Proposed' } });
      const current = { ...original, [field]: 'Proposed', [other]: 'Later user value' };
      const result = apply([current], [p]);
      expect(result.appliedIds).toEqual([]);
      expect(result.unchangedIds).toEqual([]);
      expect(result.skipped[0]?.fields).toContain(other);
      expect(result.ports).toEqual([current]);
    }
  });

  test('permits bounded legacy proposals independently of stricter quick-model output validation', () => {
    const p = proposal({ desired: { aiName: 'l'.repeat(256) } });
    expect(apply([original], [p]).ports[0]?.aiName).toBe('l'.repeat(256));
    expect(apply([original], [p]).ports[0]?.category).toBe(original.category);
  });

  test('retry after partial success is a no-op; later label or identity changes are conflicts', () => {
    const first = apply([original]);
    const replay = apply(first.ports);
    expect(replay.appliedIds).toEqual([]);
    expect(replay.unchangedIds).toEqual(['p1']);
    expect(replay.ports[0]).toBe(first.ports[0]);
    for (const field of ['name', 'folderPath', 'aiName', 'category', 'description'] as const) {
      const changed = apply([{ ...first.ports[0]!, [field]: 'User changed later' }]);
      expect(changed.unchangedIds).toEqual([]);
      expect(changed.appliedIds).toEqual([]);
      expect(changed.skipped[0]?.fields).toContain(field);
    }
  });

  test('null means absent, preserves empty-string distinction and the complete snapshot', () => {
    const p = proposal({ expected: { name: 'n'.repeat(121), folderPath: null, aiName: null, category: null, description: 'd'.repeat(501) } });
    const row = { id: 'p1', name: p.expected.name, description: p.expected.description };
    expect(apply([row], [p]).appliedIds).toEqual(['p1']);
    expect(apply([{ ...row, aiName: '' }], [p]).skipped[0]?.fields).toEqual(['aiName']);
    expect(apply([{ ...row, name: row.name.slice(0, 120) }], [p]).skipped[0]?.fields).toEqual(['name']);
  });

  test('validates the full batch and rejects duplicates before returning any changes', () => {
    const rows = [original];
    const invalid = proposal({ id: 'p2', desired: { aiName: 'Valid', category: '' } });
    expectCode(() => apply(rows, [proposal(), invalid]));
    expect(rows).toEqual([original]);
    expectCode(() => apply(rows, [proposal(), proposal()]));
    expectCode(() => apply([original, original]), 'PORT_AI_LABELS_CURRENT_ROWS_INVALID');
    expectCode(() => apply([{ id: '' }]), 'PORT_AI_LABELS_CURRENT_ROWS_INVALID');
  });

  test('strict schema rejects unknown keys, missing guards, wrong types, empty and oversized batches', () => {
    const invalid: unknown[] = [
      null, [], { patches: [] }, { patches: [proposal()], ports: [] },
      { patches: [{ ...proposal(), extra: true }] },
      { patches: [{ ...proposal(), expected: { name: 'Original' } }] },
      { patches: [proposal({ desired: {} })] },
      { patches: [{ ...proposal(), desired: { aiName: null } }] },
      { patches: [{ ...proposal(), desired: { aiName: 'Valid', name: 'Not allowed' } }] },
      { patches: [proposal({ desired: { aiName: 'x'.repeat(257), category: 'Tools' } })] },
      { patches: [proposal({ desired: { aiName: 'Hi\nthere', category: 'Tools' } })] },
      { patches: [proposal({ id: 'bad\nidentity' })] },
      { patches: Array.from({ length: 5_001 }, (_, i) => proposal({ id: String(i) })) },
    ];
    for (const body of invalid) expectCode(() => normalizePortAiLabelPatchRequest(body));
  });
});

describe('bounded AI label JSON transport', () => {
  test('reads JSON and normalizes proposal whitespace without changing expected values', async () => {
    const p = proposal({ desired: { aiName: '  New label  ', category: ' Tools ' } });
    expect(await readPortAiLabelPatchRequest(request(JSON.stringify({ patches: [p] })))).toEqual({ patches: [proposal()] });
  });

  test('rejects malformed JSON, wrong media type and invalid UTF-8', async () => {
    await expect(readPortAiLabelPatchRequest(request('{'))).rejects.toMatchObject({ code: 'PORT_AI_LABELS_INVALID_REQUEST' });
    await expect(readPortAiLabelPatchRequest(request('{}', { 'Content-Type': 'text/plain' }))).rejects.toMatchObject({ status: 415 });
    await expect(readPortAiLabelPatchRequest(request(new Uint8Array([0xff])))).rejects.toMatchObject({ code: 'PORT_AI_LABELS_INVALID_REQUEST' });
  });

  test('rejects both declared and streamed oversized bodies', async () => {
    await expect(readPortAiLabelPatchRequest(request('{}', { 'Content-Length': String(2 * 1024 * 1024 + 1) }))).rejects.toMatchObject({ status: 413 });
    await expect(readPortAiLabelPatchRequest(request(' '.repeat(2 * 1024 * 1024 + 1)))).rejects.toMatchObject({ status: 413 });
  });

  test('cancels a stalled body by its bounded deadline', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const started = performance.now();
    await expect(readPortAiLabelPatchRequest(request(stream))).rejects.toMatchObject({ code: 'PORT_AI_LABELS_BODY_TIMEOUT', status: 408 });
    expect(performance.now() - started).toBeLessThan(6_500);
    expect(cancelled).toBe(true);
  }, 7_000);
});
