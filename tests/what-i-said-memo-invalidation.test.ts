import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('What-I-Said project-memory detection memo', () => {
  test('every memory creation drops the memo, via a single wrapped import', () => {
    // The memo answers "does this path have a memory?" for up to a minute.
    // Creating a memory changes that answer, and a stale "no" surfaces as
    // 「이 프로젝트에서 장기기억을 먼저 시작하세요」 on a project that has one.
    // Wrapping the import once is what keeps this true as call sites are added;
    // there are already six, and per-call-site invalidation would rot.
    expect(api).toContain('initializeProjectMemory as initializeProjectMemoryUncached');
    expect(api).toContain('function initializeProjectMemory(');
    const wrapper = api.slice(
      api.indexOf('function initializeProjectMemory('),
      api.indexOf('function initializeProjectMemory(') + 700,
    );
    expect(wrapper).toContain('initializeProjectMemoryUncached(...args)');
    // `finally`, so a throwing initialization still drops a memo that may
    // already have observed the half-created directory.
    expect(wrapper).toContain('finally');
    expect(wrapper).toContain('invalidateWhatISaidMemoryDetection()');

    // No call site may reach past the wrapper.
    const direct = api.split('\n').filter(line =>
      line.includes('initializeProjectMemoryUncached(')
      && !line.includes('as initializeProjectMemoryUncached'));
    expect(direct).toHaveLength(1);
  });

  test('the memo is not wired into the destructive source-revocation paths', () => {
    // DELETE /api/what-i-said/source authorises by comparing memory lineages.
    // Those two reads stay uncached on purpose: a scope check for a destructive
    // action must not run on state that can be up to a minute old.
    expect(api).toContain('function resolvePathAttachmentWhatISaidProject');
    expect(api).toContain('function survivingRegisteredWhatISaidLineage');
    for (const fn of ['resolvePathAttachmentWhatISaidProject', 'survivingRegisteredWhatISaidLineage']) {
      const start = api.indexOf(`function ${fn}`);
      const body = api.slice(start, start + 2_400);
      expect(body).toContain('detectProjectMemory(');
      expect(body).not.toContain('detectWhatISaidProjectMemory(');
    }
  });
});
