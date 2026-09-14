import {normalizePromptGuideSnapshot, type PromptGuideEntry, type PromptGuideSnapshot} from './promptGuideClient';

export interface PromptGuideRepository {
  read(signal?: AbortSignal): Promise<PromptGuideSnapshot>;
  save(revision: string, entries: PromptGuideEntry[], signal?: AbortSignal): Promise<PromptGuideSnapshot>;
}
type RpcClient = {rpc(name: string, args?: Record<string, unknown>): any};
export function createSharedPromptGuideClient(client: RpcClient): PromptGuideRepository {
  async function request(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, 15_000);
    try {
      const {data, error} = await client.rpc(name, args).abortSignal(controller.signal);
      if (error) {
        const conflict = String(error.message).includes('PROMPT_GUIDES_CONFLICT');
        throw Object.assign(new Error(conflict
          ? '다른 기기에서 보관함이 바뀌었습니다. 다시 불러온 뒤 초안을 확인해 주세요.'
          : 'Supabase 보관함을 확인하지 못했습니다. 로그인·연결 상태와 DB 업데이트를 확인하세요. 초안은 유지됩니다.'),
        {code: conflict ? 'PROMPT_GUIDES_CONFLICT' : 'PROMPT_GUIDES_CLOUD_UNAVAILABLE'});
      }
      return normalizePromptGuideSnapshot(data);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    read: signal => request('portmgr_prompt_guides_read', {}, signal),
    save: (revision, entries, signal) => request('portmgr_prompt_guides_save', {p_expected_revision: revision, p_entries: entries}, signal),
  };
}

/** Explicit import only. Never overwrites a shared edit or resurrects a missing item on reload. */
export function mergePromptGuideImport(shared: PromptGuideEntry[], local: PromptGuideEntry[]): PromptGuideEntry[] {
  const result = [...shared];
  for (const item of local) {
    if (result.some(existing => existing.title === item.title && existing.body === item.body)) continue;
    result.push({...item, id: result.some(existing => existing.id === item.id) ? crypto.randomUUID() : item.id});
  }
  if (result.length > 100 || new TextEncoder().encode(JSON.stringify({entries:result})).length > 1024 * 1024) {
    throw new Error('가져올 항목을 합치면 보관함 한도를 넘습니다. 항목을 정리한 뒤 다시 시도하세요.');
  }
  return result;
}
