import type { SupabaseClient } from '@supabase/supabase-js';

export interface PushSnapshot {
  id: string;
  created_at: string;
  table_name: string;
  device_id: string | null;
  device_name: string | null;
  row_count: number;
}

const MAX_SNAPSHOTS = 20;

export async function savePushSnapshot(
  supabase: SupabaseClient,
  tableName: string,
  deviceId: string | null,
  deviceName: string | null,
  rows: unknown[]
): Promise<void> {
  try {
    // id 는 DDL에 DEFAULT가 없는 PRIMARY KEY — 반드시 클라이언트가 채워야 한다
    const { error: insertError } = await supabase.from('portmgr_push_snapshots').insert({
      id: crypto.randomUUID(),
      table_name: tableName,
      device_id: deviceId,
      device_name: deviceName,
      snapshot: rows,
      row_count: rows.length,
    });
    if (insertError) {
      console.warn('[pushHistory] snapshot insert failed:', insertError.message);
      return; // 기록에 실패했으면 정리(prune)도 하지 않는다
    }
    // Prune oldest beyond MAX_SNAPSHOTS
    const { data: all } = await supabase
      .from('portmgr_push_snapshots')
      .select('id')
      .eq('table_name', tableName)
      .eq('device_id', deviceId ?? '')
      .order('created_at', { ascending: false });
    const toDelete = (all ?? []).slice(MAX_SNAPSHOTS).map((r: any) => r.id);
    if (toDelete.length > 0) {
      await supabase.from('portmgr_push_snapshots').delete().in('id', toDelete);
    }
  } catch (e) {
    console.warn('[pushHistory] snapshot error:', e);
    // non-blocking — snapshot failure must not block push
  }
}

export async function fetchPushHistory(
  supabase: SupabaseClient,
  tableName: string,
  deviceId: string | null
): Promise<PushSnapshot[]> {
  const { data, error } = await supabase
    .from('portmgr_push_snapshots')
    .select('id, created_at, table_name, device_id, device_name, row_count')
    .eq('table_name', tableName)
    .eq('device_id', deviceId ?? '')
    .order('created_at', { ascending: false })
    .limit(MAX_SNAPSHOTS);
  // 오류를 빈 배열로 뭉개면 권한 거부가 "기록 없음 · Push하면 저장됩니다"로 표시된다 —
  // 사용자는 있지도 않은 문제를 고치려 든다. 호출부가 사유를 말할 수 있게 던진다.
  if (error) throw error;
  return data ?? [];
}

export async function fetchSnapshotRows(
  supabase: SupabaseClient,
  snapshotId: string
): Promise<unknown[]> {
  // maybeSingle: `.single()` 은 0행도 오류로 만들어 "없음"과 "실패"를 못 가른다.
  const { data, error } = await supabase
    .from('portmgr_push_snapshots')
    .select('snapshot')
    .eq('id', snapshotId)
    .maybeSingle();
  if (error) throw error;
  return (data as any)?.snapshot ?? [];
}
