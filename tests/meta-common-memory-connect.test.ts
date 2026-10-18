import { describe, expect, test } from 'bun:test';
import { MetaMemoryClientError, connectProjectMetaMemories } from '../src/metaCommonMemoryClient';

const MEMORY = '11111111-1111-4111-8111-111111111111', GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const memory = (members: Array<{ memoryId: string; mode: string }> = []) => ({ id: GROUP, revision: 3, name: '공통', description: '', tags: [], categories: [], archived: false, entries: [], members });

/** A requester that records every body and answers saves through `onSave`. */
function requester(onSave: (assignments: any[]) => unknown, current = memory(), memberForm: string | null = 'memory') {
  const calls: any[] = [];
  const request = async (body: Record<string, any>) => {
    calls.push(body);
    if (body.operation === 'read') return { memory: current, ...(memberForm ? { memberForm } : {}) };
    if (body.operation === 'save') return onSave(body.assignments);
    throw Error('unexpected ' + body.operation);
  };
  return { calls, request };
}

describe('connectProjectMetaMemories', () => {
  test('sends the memory form by default, with no project card', async () => {
    const { calls, request } = requester(() => ({ memory: memory() }));
    expect(await connectProjectMetaMemories('port-1', MEMORY, [GROUP], { request })).toEqual([{ memoryId: GROUP, linked: true }]);
    expect(calls.filter(c => c.operation === 'save').map(c => c.assignments)).toEqual([[{ memoryId: MEMORY, mode: 'include' }]]);
  });

  test('an older service rejecting the memory form in its parser gets one retry with the project card', async () => {
    const { calls, request } = requester(assignments => {
      if ('memoryId' in assignments[0]) throw new MetaMemoryClientError('연결 대상 형식을 확인하세요.', 'META_MEMORY_INPUT_INVALID');
      return { memory: memory() };
    });
    expect(await connectProjectMetaMemories('port-1', MEMORY, [GROUP], { request })).toEqual([{ memoryId: GROUP, linked: true }]);
    expect(calls.filter(c => c.operation === 'save').map(c => c.assignments)).toEqual([[{ memoryId: MEMORY, mode: 'include' }], [{ portId: 'port-1', expectedMemoryId: MEMORY, mode: 'include' }]]);
  });

  test('never retries an unknown outcome or a different refusal', async () => {
    for (const error of [new MetaMemoryClientError('응답 없음', undefined, true), new MetaMemoryClientError('다른 기기에서 변경됨', 'COMMON_MEMORY_VERSION_CHANGED'), new MetaMemoryClientError('형식 오류', 'META_MEMORY_INPUT_INVALID', true)]) {
      const { calls, request } = requester(() => { throw error; });
      expect(await connectProjectMetaMemories('port-1', MEMORY, [GROUP], { request })).toEqual([{ memoryId: GROUP, linked: false, error: error.message }]);
      expect(calls.filter(c => c.operation === 'save')).toHaveLength(1);
    }
  });

  test('the project-card form, when asked for, is sent as is and not retried', async () => {
    const { calls, request } = requester(() => { throw new MetaMemoryClientError('형식 오류', 'META_MEMORY_INPUT_INVALID'); });
    expect((await connectProjectMetaMemories('port-1', MEMORY, [GROUP], { form: 'port', request }))[0]!.linked).toBe(false);
    expect(calls.filter(c => c.operation === 'save').map(c => c.assignments)).toEqual([[{ portId: 'port-1', expectedMemoryId: MEMORY, mode: 'include' }]]);
  });

  test('a group without memberForm (this Mac\'s local store, or an older cloud) gets the project-card form', async () => {
    const { calls, request } = requester(() => ({ memory: memory() }), memory(), null);
    expect(await connectProjectMetaMemories('port-1', MEMORY, [GROUP], { request })).toEqual([{ memoryId: GROUP, linked: true }]);
    expect(calls.filter(c => c.operation === 'save').map(c => c.assignments)).toEqual([[{ portId: 'port-1', expectedMemoryId: MEMORY, mode: 'include' }]]);
  });

  test('an existing member needs no save', async () => {
    const { calls, request } = requester(() => { throw Error('no save expected'); }, memory([{ memoryId: MEMORY, mode: 'include' }]));
    expect(await connectProjectMetaMemories('port-1', MEMORY, [GROUP, GROUP], { request })).toEqual([{ memoryId: GROUP, linked: true }]);
    expect(calls.map(c => c.operation)).toEqual(['read']);
  });
});
