import {commonMemoryUuid} from './commonMemoryCrypto';
import { isTauri } from './lib/env';
export class MetaMemoryClientError extends Error { constructor(message: string, readonly code?: string, readonly uncertain = false) { super(message); } }
export type MetaMemoryRequester = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
/** No automatic mutation retry: retain its request ID and exact payload when the result is unknown. */
export async function metaMemoryRequest<T = any>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/meta-common-memory`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  }).catch(() => { throw new MetaMemoryClientError('공통기억 서비스의 응답을 확인하지 못했습니다. 입력과 요청을 보존했습니다.', undefined, true); });
  const result = await response.json().catch(() => { throw new MetaMemoryClientError('공통기억 응답을 읽지 못했습니다.', undefined, true); });
  if (!response.ok) throw new MetaMemoryClientError(response.status === 404 && !result.code ? '현재 실행 중인 앱 서비스에는 공통기억 기능이 없습니다. 최신 개발 서비스를 실행하거나 앱을 업데이트하세요.' : result.error ?? '공통기억 요청을 완료하지 못했습니다.', result.code, response.status >= 500);
  return result as T;
}

/** Project creation is already complete; report each connection independently without deleting it.
 *  The memory form ({memoryId, mode}) is sent only when the caller allows it AND the group's own read says it takes it
 *  (memberForm:'memory', the cloud). A group in this Mac's local store gives no memberForm and refuses that form with
 *  META_MEMORY_CLOUD_REQUIRED, so it gets the project-card form. An older service that still rejects the memory form in
 *  its parser with an INPUT_INVALID code (before executing anything) gets one safe project-card retry. */
export async function connectProjectMetaMemories(portId: string, expectedMemoryId: string, memoryIds: readonly string[], options: { form?: 'memory' | 'port'; request?: MetaMemoryRequester; /** A stable id per group and form makes a repeated link an idempotent replay. */ requestIdFor?: (groupId: string, form: 'memory' | 'port') => string } = {}) {
  const request = options.request ?? metaMemoryRequest, results: Array<{ memoryId: string; linked: boolean; error?: string }> = [];
  const assignment = (form: 'memory' | 'port') => form === 'memory' ? { memoryId: expectedMemoryId, mode: 'include' } : { portId, expectedMemoryId, mode: 'include' };
  for (const memoryId of [...new Set(memoryIds)]) {
    try {
      const { memory, memberForm } = await request({ operation: 'read', memoryId });
      if (memory.archived) throw new Error('보관된 공통기억입니다.');
      if (!memory.members.some((m: any) => m.memoryId === expectedMemoryId && m.mode === 'include')) {
        const save = (form: 'memory' | 'port') => request({ operation: 'save', memoryId, expectedRevision: memory.revision, requestId: options.requestIdFor?.(memoryId, form) ?? commonMemoryUuid(), name: memory.name, description: memory.description, tags: memory.tags, categories: memory.categories, assignments: [assignment(form)] });
        const form = (options.form ?? 'memory') === 'memory' && memberForm === 'memory' ? 'memory' : 'port';
        try { await save(form); }
        catch (e) { if (form !== 'memory' || !isInputInvalid(e)) throw e; await save('port'); }
      }
      results.push({ memoryId, linked: true });
    } catch (e) { results.push({ memoryId, linked: false, error: (e as Error).message }); }
  }
  return results;
}
const isInputInvalid = (e: unknown) => e instanceof MetaMemoryClientError && !e.uncertain && /(^|_)INPUT_INVALID$/.test(e.code ?? '');
