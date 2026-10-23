import {DEVICE_MEMORY_TARGET} from './deviceOperatingMemoryProtocol';
import {COMMON_MEMORY_REMOTE_TARGET} from './commonMemoryRequest';
import {commonMemoryDigest as digest,commonMemoryUuid} from './commonMemoryCrypto';
import { MetaMemoryClientError, type MetaMemoryRequester } from './metaCommonMemoryClient';
import { META_MEMORY_REMOTE_LIMITS as limits, META_MEMORY_REMOTE_TARGET, normalizeMetaMemoryRemoteResponse, splitMetaMemoryWireText, type MetaMemoryRemoteRequest } from './metaCommonMemoryRemoteProtocol';
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
/**
 * `rpcV2` comes only from the Mac's advertised capability (`COMMON_MEMORY_RPC_V2_FEATURE`); this requester never
 * downgrades by reading an error. Without it the v1 exchange sequence is unchanged, byte for byte.
 *
 * The relay carries one exchange at a time, so concurrent calls on one requester run one after another: the first
 * caller gets its answer soonest and the host's per-owner transfer limit cannot fill up.
 */
/**
 * Refusals the phone's own relay controller raises before it encrypts or queues anything (offline, an earlier envelope
 * still unsent, another request in flight): the exchange never left the phone, so it cannot have run on the Mac.
 * `REMOTE_CONTROL_REQUEST_UNSENT` is deliberately absent: that envelope is kept and sent once later.
 */
const UNSENT_REFUSAL_CODES = new Set(['REMOTE_CONTROL_PHONE_OFFLINE', 'REMOTE_CONTROL_REQUEST_UNSENT_AHEAD']);
const refusedBeforeSending = (e: unknown) => e instanceof Error && (UNSENT_REFUSAL_CODES.has(String((e as { code?: unknown }).code)) || e.message === 'REMOTE_CONTROL_ACTION_IN_PROGRESS');
const errorCode = (e: unknown) => { const code = (e as { code?: unknown } | null)?.code; return typeof code === 'string' && code ? code : undefined; };
export function createMetaMemoryRemoteRequester(transport: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>, action:'meta-memory'|'common-memory'|'device-memory'='meta-memory', options:{rpcV2?:boolean}={}): MetaMemoryRequester {
  const rpcV2=options.rpcV2===true;
  let tail: Promise<void> = Promise.resolve();
  const single: MetaMemoryRequester = async (body, signal) => {
    const targetId=action==='device-memory'?DEVICE_MEMORY_TARGET:action==='common-memory'?COMMON_MEMORY_REMOTE_TARGET:META_MEMORY_REMOTE_TARGET;
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).length > limits.requestBytes) throw new MetaMemoryClientError('공통 기억 요청은 600 KiB까지입니다.');
    const rpcId = commonMemoryUuid(), hash = await digest(serialized); let executionStarted = false, drained = false;
    const send = async (meta: MetaMemoryRemoteRequest) => {
      signal?.throwIfAborted();
      const response = await transport({ operation: 'workspace', requestId: commonMemoryUuid(), targetId, workspace: { action, meta } });
      signal?.throwIfAborted();
      if (response.kind !== 'workspace' || response.action !== action) throw Error('공통 기억 원격 응답이 요청과 다릅니다.');
      const result = normalizeMetaMemoryRemoteResponse(response.meta);
      if (result.rpcId !== rpcId) throw Error('공통 기억 원격 결과가 다른 요청에 해당합니다.');
      return result;
    };
    try {
      const parts: string[] = []; let bytes = 0, resultHash: string;
      const take = (text: string) => { parts.push(text); bytes += new TextEncoder().encode(text).length; if (bytes > limits.resultBytes) throw Error('공통 기억 응답 범위를 확인하세요.'); };
      if (rpcV2) {
        // Upload every chunk but the last, then send the last one as `call`: a small request is one exchange,
        // and the host frees the transfer itself after serving the final result chunk.
        const chunks = splitMetaMemoryWireText(serialized, limits.v2WireBytes);
        for (let index = 0; index < chunks.length - 1; index++) if ((await send({ phase: 'upload', rpcId, hash, index, count: chunks.length, text: chunks[index]! })).phase !== 'uploaded') throw Error('공통 기억 전송 결과를 확인하세요.');
        executionStarted = true;
        let first: Awaited<ReturnType<typeof send>>;
        try { first = await send({ phase: 'call', rpcId, hash, index: chunks.length - 1, count: chunks.length, text: chunks[chunks.length - 1]! }); }
        catch (e) { if (refusedBeforeSending(e)) executionStarted = false; throw e; }
        if (first.phase !== 'result' || first.index !== 0) throw Error('공통 기억 처리 결과를 확인하세요.');
        resultHash = first.hash; take(first.text);
        for (let index = 1; index < first.count; index++) {
          const chunk = await send({ phase: 'read', rpcId, hash, index });
          if (chunk.phase !== 'chunk' || chunk.index !== index || chunk.hash !== first.hash || chunk.count !== first.count) throw Error('공통 기억 응답 조각이 일치하지 않습니다.');
          take(chunk.text);
        }
        drained = true;
      } else {
        const chunks = splitMetaMemoryWireText(serialized);
        for (let index = 0; index < chunks.length; index++) if ((await send({ phase: 'upload', rpcId, hash, index, count: chunks.length, text: chunks[index]! })).phase !== 'uploaded') throw Error('공통 기억 전송 결과를 확인하세요.');
        executionStarted = true;
        let ready: Awaited<ReturnType<typeof send>>;
        try { ready = await send({ phase: 'execute', rpcId, hash }); }
        catch (e) { if (refusedBeforeSending(e)) executionStarted = false; throw e; }
        if (ready.phase !== 'ready') throw Error('공통 기억 처리 결과를 확인하세요.');
        resultHash = ready.hash;
        for (let index = 0; index < ready.count; index++) {
          const chunk = await send({ phase: 'read', rpcId, hash, index });
          if (chunk.phase !== 'chunk' || chunk.index !== index || chunk.hash !== ready.hash || chunk.count !== ready.count) throw Error('공통 기억 응답 조각이 일치하지 않습니다.');
          take(chunk.text);
        }
      }
      const resultText = parts.join('');
      if (await digest(resultText) !== resultHash) throw Error('공통 기억 응답 검증 값이 일치하지 않습니다.');
      const result = JSON.parse(resultText);
      if (!result.ok) throw new MetaMemoryClientError(result.error ?? '공통 기억 요청을 완료하지 못했습니다.', result.code, result.status >= 500);
      return result.result;
    } catch (e) {
      if (e instanceof MetaMemoryClientError) throw e;
      throw new MetaMemoryClientError(e instanceof Error ? e.message : '공통 기억 응답을 확인하지 못했습니다.', errorCode(e), executionStarted);
    } finally {
      // Release only ephemeral buffers, including aborted reads. This never retries
      // execution or deletes the SQLite request receipt after an unknown response.
      // A drained v2 transfer has already freed itself on the Mac.
      if (!drained) await transport({ operation: 'workspace', requestId: commonMemoryUuid(), targetId, workspace: { action, meta: { phase: 'release', rpcId, hash } } }).catch(() => {});
    }
  };
  return async (body, signal) => {
    const prior = tail; let release!: () => void;
    const mine = new Promise<void>(resolve => { release = resolve; });
    tail = prior.then(() => mine);
    try {
      if (signal) await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new MetaMemoryClientError(signal.reason instanceof Error ? signal.reason.message : '공통 기억 요청을 취소했습니다.'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        prior.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      else await prior;
      return await single(body, signal);
    } finally { release(); }
  };
}
