import {ControlProfileError} from './controlProfileContract';
import { CommonMemoryError } from './commonMemory';
import { parseCommonMemoryRequest } from './commonMemoryRequest';
import { createHash } from 'node:crypto';
import { MetaMemoryError, normalizeMetaMemoryVocabulary, parseMetaMemoryRequest } from './metaCommonMemoryContract';
import { META_MEMORY_REMOTE_LIMITS as limits, normalizeMetaMemoryRemoteRequest, splitMetaMemoryWireText, type MetaMemoryRemoteRequest, type MetaMemoryRemoteResponse } from './metaCommonMemoryRemoteProtocol';
type Transfer = { owner: string; hash: string; count: number; chunks: Map<number, string>; bytes: number; expiresAt: number; result?: string[]; resultHash?: string; executing?: Promise<void>; version?: 2; served?: Set<number> };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Device-bound opaque references are stable across a restart, never execution authority. */
/**
 * A v2 `call` that is refused before it runs answers with an ordinary one-frame result whose envelope is a 409 failure,
 * never a thrown error: a thrown error reaches the phone as a bare message it cannot tell from a lost answer, so it would
 * keep the mutation as "uncertain" and block its form. Only callers that know nothing ran may use this.
 */
export function metaMemoryRemoteRefusal(rpcId: string, message: string, code = 'META_MEMORY_REMOTE_REFUSED'): MetaMemoryRemoteResponse {
  const text = JSON.stringify({ ok: false, status: 409, code, error: message.slice(0, 500) });
  return { phase: 'result', rpcId, hash: digest(text), count: 1, index: 0, text };
}
export const metaMemoryRemoteProjectRef = (owner: string, portId: string) => 'meta_project_' + digest('meta-memory-project-v1\0' + owner + '\0' + portId).slice(0, 48);
function assertKnownFields(raw: unknown, parsed: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  if (Array.isArray(raw)) { raw.forEach((v, i) => assertKnownFields(v, (parsed as any[])?.[i])); return; }
  if (!parsed || typeof parsed !== 'object' || Object.keys(raw).some(k => !Object.hasOwn(parsed, k))) throw new MetaMemoryError('META_MEMORY_REMOTE_FIELDS', '공통 기억 요청에 지원하지 않는 값이 있습니다.');
  for (const key of Object.keys(raw)) assertKnownFields((raw as any)[key], (parsed as any)[key]);
}
/** Transfers are bounded ephemeral buffers. The existing SQLite transaction owns durable receipts. */
export class MetaCommonMemoryRemoteHost {
  private transfers = new Map<string, Transfer>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private execute: (owner: string, request: unknown, active: () => boolean, kind?:'meta'|'cloud'|'device', canAdd?:(rootId?:string,identity?:string)=>boolean) => Promise<unknown>, private now = Date.now) {}
  prune() {
    for (const [key, t] of this.transfers) if (!t.executing && this.now() >= t.expiresAt) this.transfers.delete(key);
    if (!this.transfers.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; this.transfers.clear(); }
  get size() { this.prune(); return this.transfers.size; }
  async perform(owner: string, raw: MetaMemoryRemoteRequest, active: () => boolean, kind:'meta'|'cloud'|'device'='meta', canAdd?:(rootId?:string,identity?:string)=>boolean): Promise<MetaMemoryRemoteResponse> {
    const r = normalizeMetaMemoryRemoteRequest(raw); this.prune();
    if (!active()) { if (r.phase === 'call') return metaMemoryRemoteRefusal(r.rpcId, '공통 기억 관리 권한이 변경되었습니다.'); throw Error('공통 기억 관리 권한이 변경되었습니다.'); }
    const key = owner + '\0' + kind + '\0' + r.rpcId; let t = this.transfers.get(key);
    if (r.phase === 'release') {
      if (t && t.hash !== r.hash) throw Error('공통 기억 요청 검증 값이 다릅니다.');
      if (t?.executing) throw Error('공통 기억 저장 결과를 먼저 확인하세요.');
      this.transfers.delete(key); this.prune(); return { phase: 'released', rpcId: r.rpcId };
    }
    if (r.phase === 'upload' || r.phase === 'call') {
      if (!t) {
        if (this.transfers.size >= limits.records || [...this.transfers.values()].filter(v => v.owner === owner).length >= limits.ownerRecords) {
          const busy = '공통 기억 전송이 많습니다. 기존 결과를 확인하고 잠시 후 다시 시도하세요.';
          if (r.phase === 'call') return metaMemoryRemoteRefusal(r.rpcId, busy, 'META_MEMORY_REMOTE_BUSY');
          throw Error(busy);
        }
        t = { owner, hash: r.hash, count: r.count, chunks: new Map(), bytes: 0, expiresAt: this.now() + limits.ttlMs }; this.transfers.set(key, t);
        if (!this.timer) { this.timer = setInterval(() => this.prune(), 15_000); this.timer.unref?.(); }
      }
      // A repeated call for a result this transfer still holds answers the same first chunk; it never runs twice.
      if (r.phase === 'call' && t.version === 2 && t.hash === r.hash && t.count === r.count && (t.result || t.executing)) {
        if (t.executing) await t.executing;
        return this.first(key, t, r.rpcId, active);
      }
      const transfer = t;
      try {
        if (transfer.hash !== r.hash || transfer.count !== r.count || transfer.result || transfer.executing) throw Error('이미 준비한 공통 기억 요청과 다릅니다.');
        const prior = transfer.chunks.get(r.index);
        if (prior !== undefined && prior !== r.text) throw Error('같은 공통 기억 조각의 내용이 다릅니다.');
        if (prior === undefined) {
          const bytes = Buffer.byteLength(r.text);
          if (transfer.bytes + bytes > limits.requestBytes) throw Error('공통 기억 요청은 600 KiB까지입니다.');
          transfer.bytes += bytes; transfer.chunks.set(r.index, r.text);
        }
        if (r.phase === 'upload') return { phase: 'uploaded', rpcId: r.rpcId };
        transfer.version = 2;
        await this.settle(transfer, owner, active, kind, canAdd, limits.v2WireBytes);
      } catch (e) {
        // v2 frees its buffer when the call fails before execution; v1 keeps its upload until release.
        if (r.phase === 'call' && !transfer.result && !transfer.executing && this.transfers.get(key) === transfer) { this.transfers.delete(key); this.prune(); }
        // settle throws only before execution, so a failed call here provably never ran.
        if (r.phase === 'call') return metaMemoryRemoteRefusal(r.rpcId, e instanceof Error ? e.message : '공통 기억 요청을 확인하세요.', e instanceof MetaMemoryError ? e.code : undefined);
        throw e;
      }
      return this.first(key, transfer, r.rpcId, active);
    }
    if (!t || t.hash !== r.hash) throw Error('공통 기억 전송이 만료됐습니다. 같은 저장 요청을 다시 확인하세요.');
    if (r.phase === 'execute') {
      if (t.version === 2) throw Error('공통 기억 결과 조각을 확인하세요.');
      await this.settle(t, owner, active, kind, canAdd, limits.wireBytes);
      if (!active()) throw Error('공통 기억 관리 권한이 변경되었습니다. 결과를 다시 확인하세요.');
      return { phase: 'ready', rpcId: r.rpcId, hash: t.resultHash!, count: t.result!.length };
    }
    if (r.phase !== 'read' || !t.result || !t.resultHash || r.index >= t.result.length) throw Error('공통 기억 결과 조각을 확인하세요.');
    const chunk: MetaMemoryRemoteResponse = { phase: 'chunk', rpcId: r.rpcId, hash: t.resultHash, count: t.result.length, index: r.index, text: t.result[r.index]! };
    if (t.version === 2) this.serve(key, t, r.index);
    return chunk;
  }
  /** A v2 transfer deletes itself once every result chunk has been served. */
  private serve(key: string, t: Transfer, index: number) {
    (t.served ??= new Set()).add(index);
    if (t.served.size >= t.result!.length && this.transfers.get(key) === t) { this.transfers.delete(key); this.prune(); }
  }
  private first(key: string, t: Transfer, rpcId: string, active: () => boolean): MetaMemoryRemoteResponse {
    if (!active()) { if (this.transfers.get(key) === t) { this.transfers.delete(key); this.prune(); } throw Error('공통 기억 관리 권한이 변경되었습니다. 결과를 다시 확인하세요.'); }
    const response: MetaMemoryRemoteResponse = { phase: 'result', rpcId, hash: t.resultHash!, count: t.result!.length, index: 0, text: t.result![0]! };
    this.serve(key, t, 0);
    return response;
  }
  /** Assemble, verify and run once; concurrent callers share the same execution. Throws only before execution. */
  private async settle(t: Transfer, owner: string, active: () => boolean, kind: 'meta' | 'cloud' | 'device', canAdd: ((rootId?: string, identity?: string) => boolean) | undefined, chunkBytes: number) {
    if (!t.result && !t.executing) {
      if (t.chunks.size !== t.count) throw Error('공통 기억 요청의 조각이 누락됐습니다.');
      const text = Array.from({ length: t.count }, (_, i) => t.chunks.get(i)!).join('');
      if (digest(text) !== t.hash) throw Error('공통 기억 요청의 검증 값이 일치하지 않습니다.');
      let request: unknown; try { const rawRequest = JSON.parse(text); request = kind==='device'?rawRequest:kind==='cloud'?parseCommonMemoryRequest(rawRequest):parseMetaMemoryRequest(rawRequest); if(kind==='meta')assertKnownFields(normalizeMetaMemoryVocabulary(rawRequest), request); } catch (e) { throw new MetaMemoryError('META_MEMORY_REMOTE_INPUT', e instanceof MetaMemoryError || e instanceof CommonMemoryError || e instanceof ControlProfileError ? e.message : '공통 기억 요청 형식을 확인하세요.'); }
      const transfer = t;
      transfer.executing = (async () => {
        let envelope: unknown;
        try { if (!active()) throw Error('공통 기억 관리 권한이 변경되었습니다.'); envelope = { ok: true, result: await this.execute(owner, request, active, kind, canAdd) }; }
        catch (e) { envelope = { ok: false, status: e instanceof MetaMemoryError || e instanceof CommonMemoryError || e instanceof ControlProfileError ? e.status : 500, code: e instanceof MetaMemoryError || e instanceof CommonMemoryError || e instanceof ControlProfileError ? e.code : 'META_MEMORY_REMOTE_FAILED', error: e instanceof MetaMemoryError || e instanceof CommonMemoryError || e instanceof ControlProfileError ? e.message : '공통 기억 요청을 완료하지 못했습니다. 같은 저장 요청으로 결과를 확인하세요.' }; }
        let serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized) > limits.resultBytes) serialized = JSON.stringify({ ok: false, status: 500, code: 'META_MEMORY_REMOTE_RESULT_CAPACITY', error: '공통 기억 응답 범위가 큽니다. Mac에서 결과를 확인하세요.' });
        transfer.result = splitMetaMemoryWireText(serialized, chunkBytes); transfer.resultHash = digest(serialized); transfer.chunks.clear(); transfer.bytes = 0;
      })();
      try { await transfer.executing; } finally { transfer.executing = undefined; }
    } else if (t.executing) await t.executing;
  }
}
