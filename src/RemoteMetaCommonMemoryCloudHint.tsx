import React, { useMemo, useState } from 'react';
import MetaCommonMemoryPanel from './MetaCommonMemoryPanel';
import { MetaMemoryClientError, type MetaMemoryRequester } from './metaCommonMemoryClient';

/** Codes the Mac answers when a local-common request belongs in the 공통기억 (cloud) tab. */
export const META_MEMORY_CLOUD_TAB_CODES: readonly string[] = ['META_MEMORY_CLOUD_AUTHORITY', 'META_MEMORY_CLOUD_REQUIRED'];
export const META_MEMORY_CLOUD_TAB_HINT = '새 공통기억과 클라우드로 옮긴 기억은 「공통기억」 탭에서 관리합니다.';

/** Decides the one-line hint from a request outcome: a cloud-tab refusal, or an unfiltered first page with nothing in it.
 *  Returns undefined when the outcome says nothing new (the current hint stays). */
export function metaMemoryCloudHintFor(body: Record<string, unknown>, outcome: { result?: any; error?: unknown }): boolean | undefined {
  if (outcome.error !== undefined) return outcome.error instanceof MetaMemoryClientError && META_MEMORY_CLOUD_TAB_CODES.includes(outcome.error.code ?? '') ? true : undefined;
  if (body.operation !== 'list' || body.query || body.offset) return undefined;
  return Number(outcome.result?.total) === 0;
}

/** The phone's local-common panel with the cloud-tab hint. It only observes results: the request and response pass through unchanged. */
export function RemoteMetaCommonMemoryCloudHint({ request, ...panel }: { request: MetaMemoryRequester; visible: boolean; remote: true; hostName?: string }) {
  const [hint, setHint] = useState(false);
  const observed = useMemo<MetaMemoryRequester>(() => async (body, signal) => {
    try {
      const result = await request(body, signal);
      const next = metaMemoryCloudHintFor(body, { result }); if (next !== undefined) setHint(next);
      return result;
    } catch (error) {
      if (metaMemoryCloudHintFor(body, { error })) setHint(true);
      throw error;
    }
  }, [request]);
  return <>
    {hint && <p role="note" data-testid="meta-common-memory-cloud-hint">{META_MEMORY_CLOUD_TAB_HINT}</p>}
    <MetaCommonMemoryPanel {...panel} request={observed} />
  </>;
}
