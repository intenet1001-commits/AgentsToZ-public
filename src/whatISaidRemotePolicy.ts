import { redactWhatISaidForFeed } from './whatISaidRedaction';
import type { WhatISaidRedactionReason } from './whatISaidRedaction';
import { whatISaidFeedProjectionHash } from './whatISaidStore';
import type { WhatISaidPromptOrigin } from './whatISaidStore';
import type { WhatISaidSharedCapturePolicy } from './whatISaidSharedPolicy';

/**
 * 원격 적재 정책 — **전체 포함이 기본이고, 고른 프로젝트만 빠진다.**
 *
 * 반대(프로젝트마다 켜기)로 만들면 새로 등록한 프로젝트가 조용히 빠지고,
 * 소비하는 앱 입장에서는 "그 프로젝트에서 말한 적이 없다"와 구분되지 않는다.
 * 대신 이 방향의 대가는 새 프로젝트가 자동으로 올라간다는 것이라, 제외는
 * 언제든 고를 수 있어야 하고 제외하는 순간 이미 올라간 행도 사라져야 한다.
 *
 * ⚠️ **두 스위치는 축이 다르다.**
 *  - `enabled` — 이번 실행의 적재 동의. 검증된 shared policy가 정본이며,
 *    미설정·offline에서는 portal.json의 legacy 동의 또는 명시적 동기화를 따른다.
 *  - 제외 — "이 장기기억은 올리지 않는다". 장기기억의 결정이라 Supabase 에 있다
 *    (`portmgr_what_i_said_memory_policy`). 기기별로 두면 Mac A 에서 제외해도
 *    Mac B 가 계속 올려서, 사용자가 뺐다고 믿는 프로젝트가 원격에 남는다.
 */
export interface WhatISaidRemotePolicy {
  enabled: boolean;
  /**
   * 이 실행에서 확인한 제외 목록. **정본은 Supabase** 이고 이 배열은 그 사본이다 —
   * portal.json 에 다시 눌러 담지 말 것.
   */
  excludedMemoryIds: string[];
}

export const EMPTY_WHAT_I_SAID_REMOTE_POLICY: WhatISaidRemotePolicy = {
  enabled: false,
  excludedMemoryIds: [],
};

/** Use the same consent authority as the shared-policy status UI. Exclusions
 * are checked separately, even for an explicitly requested manual sync. */
export function whatISaidRemoteUploadEnabled(input: {
  sharedReady: boolean;
  sharedPolicy: Pick<WhatISaidSharedCapturePolicy, 'configured' | 'enabled'> | null;
  localEnabled: boolean;
  explicit?: boolean;
}): boolean {
  if (input.sharedReady && input.sharedPolicy?.configured) return input.sharedPolicy.enabled;
  return input.localEnabled || input.explicit === true;
}

function normalizedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0 && item.length <= 512);
  return [...new Set(ids)].sort();
}

/**
 * 저장된 값이 깨졌으면 **적재를 끄는 쪽으로** 떨어진다. 켜진 것으로 오인하면
 * 사용자가 올린 적 없다고 믿는 프롬프트가 올라간다 — 되돌릴 수 없는 방향이다.
 */
export function normalizeWhatISaidRemotePolicy(raw: unknown): WhatISaidRemotePolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_WHAT_I_SAID_REMOTE_POLICY;
  const value = raw as Record<string, unknown>;
  return {
    enabled: value.enabled === true,
    excludedMemoryIds: normalizedIds(value.excludedMemoryIds),
  };
}

/** 이 프로젝트를 올려도 되는가. 목록에 없으면 포함이 기본이다. */
export function whatISaidRemotePushAllowed(
  policy: WhatISaidRemotePolicy,
  memoryId: string | null | undefined,
): boolean {
  if (!policy.enabled) return false;
  const id = typeof memoryId === 'string' ? memoryId.trim() : '';
  if (!id) return false;
  return !policy.excludedMemoryIds.includes(id);
}

export function withWhatISaidProjectExcluded(
  policy: WhatISaidRemotePolicy,
  memoryId: string,
  excluded: boolean,
): WhatISaidRemotePolicy {
  const id = memoryId.trim();
  if (!id) return policy;
  const remaining = policy.excludedMemoryIds.filter(item => item !== id);
  return {
    enabled: policy.enabled,
    excludedMemoryIds: excluded ? [...remaining, id].sort() : remaining,
  };
}

export type WhatISaidRemoteRedactionState = 'clean' | 'redacted' | 'withheld';

/** 원격 테이블 한 행. 컬럼 이름 그대로라 upsert 페이로드로 바로 쓴다. */
export interface WhatISaidRemoteRow {
  id: string;
  device_id: string;
  device_name: string | null;
  memory_id: string;
  project_name: string | null;
  local_seq: number;
  agent: 'claude' | 'codex';
  prompt_origin: WhatISaidPromptOrigin;
  recorded_at: string;
  captured_at: string;
  body: string | null;
  /**
   * 기기 키로 HMAC 된 로컬 해시. 같은 글이라도 기기마다 값이 달라서 단말 간
   * 대조에는 쓸 수 없다 — 그 용도는 projection_hash 다.
   */
  content_hash: string;
  /**
   * 레닥션을 통과한 **보이는 글**의 키 없는 해시. 여러 단말의 기록이 한 테이블에
   * 모이므로, 소비하는 쪽이 중복을 판정하거나 본문이 바뀌지 않았음을 확인할
   * 근거가 하나는 있어야 한다. withheld 행은 본문이 없으므로 null 이다.
   */
  projection_hash: string | null;
  redaction_state: WhatISaidRemoteRedactionState;
  redaction_reasons: WhatISaidRedactionReason[];
  truncated: boolean;
  retention_until: string | null;
}

export interface WhatISaidRemoteProjectionInput {
  id: string;
  seq: string;
  agent: 'claude' | 'codex';
  recordedAt: string;
  capturedAt: string;
  text: string;
  contentHash: string;
  retentionUntil: string | null;
  promptOrigin?: WhatISaidPromptOrigin;
}

/**
 * 원문이 아니라 **피드 투영**을 올린다. 고신뢰 시크릿이 든 프롬프트는 본문 없이
 * withheld 행으로만 남는다 — 개수는 정직하게 유지되면서 시크릿은 기기 밖으로
 * 나가지 않는다. 이 함수를 우회해서 entry.text 를 바로 올리는 경로를 만들지 말 것.
 */
export function whatISaidRemoteRow(
  entry: WhatISaidRemoteProjectionInput,
  context: { deviceId: string; deviceName: string | null; memoryId: string; projectName: string | null },
): WhatISaidRemoteRow {
  const projected = redactWhatISaidForFeed(entry.text);
  const state: WhatISaidRemoteRedactionState = projected.withheld
    ? 'withheld'
    : projected.reasons.length > 0 ? 'redacted' : 'clean';
  return {
    id: entry.id,
    device_id: context.deviceId,
    device_name: context.deviceName,
    memory_id: context.memoryId,
    project_name: context.projectName,
    local_seq: Number(entry.seq),
    agent: entry.agent,
    prompt_origin: entry.promptOrigin ?? 'unknown',
    recorded_at: entry.recordedAt,
    captured_at: entry.capturedAt,
    body: projected.withheld ? null : projected.text,
    content_hash: entry.contentHash,
    projection_hash: projected.withheld || projected.text === null
      ? null
      : whatISaidFeedProjectionHash(projected.text),
    redaction_state: state,
    redaction_reasons: projected.reasons,
    truncated: projected.truncated,
    retention_until: entry.retentionUntil,
  };
}
