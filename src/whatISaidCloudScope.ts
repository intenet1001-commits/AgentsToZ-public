import type { SupabaseClient } from '@supabase/supabase-js';

export interface WhatISaidCloudScope {
  memoryId: string;
  name: string;
}

/** Read only metadata, across devices. Skip duplicate history by memory_id,
 * rather than imposing a recent-row window that hides older memories. */
export async function readWhatISaidCloudScopes(sb: SupabaseClient): Promise<WhatISaidCloudScope[]> {
  const scopes = new Map<string, WhatISaidCloudScope>();
  let after: string | null = null;
  for (;;) {
    let query = sb.from('portmgr_what_i_said_prompts')
      .select('memory_id, project_name').order('memory_id', { ascending: true }).limit(500);
    if (after !== null) query = query.gt('memory_id', after);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error('Supabase 장기기억 범위 응답을 확인하지 못했습니다.');
    if (!data.length) break;
    let previous: string | null = after;
    for (const row of data) {
      const memoryId = typeof row.memory_id === 'string' ? row.memory_id.trim() : '';
      if (!memoryId || (after !== null && memoryId <= after) || (previous !== null && memoryId < previous)) {
        throw new Error('Supabase 장기기억 범위 페이지 순서를 확인하지 못했습니다.');
      }
      scopes.set(memoryId, { memoryId, name: row.project_name?.trim() || memoryId });
      previous = memoryId;
      if (scopes.size > 2048) throw new Error('클라우드 장기기억이 조회 한도 2048개를 초과했습니다.');
    }
    after = previous;
    if (data.length < 500) break;
  }
  return [...scopes.values()];
}
