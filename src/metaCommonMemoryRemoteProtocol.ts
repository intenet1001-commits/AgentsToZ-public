/** Explicit device-wide permission; this never expands a project's terminal grant. */
export const META_MEMORY_REMOTE_FEATURE = 'meta-memory-v1';
export const META_MEMORY_REMOTE_SCOPE = 'meta-memory.manage';
export const META_MEMORY_REMOTE_TARGET = 'meta-common-memory';
/**
 * Extended capability: one-exchange `call`/`result` phases with 7,600-byte frames and transfers that free
 * themselves. A phone uses it only when the Mac advertises it — never by reading an error.
 */
export const COMMON_MEMORY_RPC_V2_FEATURE = 'common-memory-rpc-v2';
export const META_MEMORY_REMOTE_LIMITS = { wireBytes: 4000, v2WireBytes: 7600, requestBytes: 600 * 1024, resultBytes: 2 * 1024 * 1024, records: 8, ownerRecords: 4, ttlMs: 5 * 60_000 } as const;
export type MetaMemoryRemoteRequest =
  | { phase: 'upload' | 'call'; rpcId: string; hash: string; index: number; count: number; text: string }
  | { phase: 'execute' | 'release'; rpcId: string; hash: string }
  | { phase: 'read'; rpcId: string; hash: string; index: number };
export type MetaMemoryRemoteResponse =
  | { phase: 'uploaded' | 'released'; rpcId: string }
  | { phase: 'ready'; rpcId: string; hash: string; count: number }
  | { phase: 'chunk' | 'result'; rpcId: string; hash: string; count: number; index: number; text: string };
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const index = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < 4096;
// Accepts the larger v2 frame for every text-bearing phase; a v1 peer never produces one.
const wireText = (x: unknown): x is string => typeof x === 'string' && new TextEncoder().encode(JSON.stringify(x)).length <= META_MEMORY_REMOTE_LIMITS.v2WireBytes + 2;
function shape(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) throw Error('공통 기억 원격 메시지 형식을 확인하세요.');
  return value as Record<string, any>;
}
export function normalizeMetaMemoryRemoteRequest(value: unknown): MetaMemoryRemoteRequest {
  const r = shape(value, ['phase', 'rpcId', 'hash', 'index', 'count', 'text']);
  if (!uuid(r.rpcId) || !hash(r.hash)) throw Error('공통 기억 원격 요청을 확인하세요.');
  if ((r.phase === 'upload' || r.phase === 'call') && index(r.index) && index(r.count) && r.count > 0 && r.index < r.count && (r.phase === 'upload' || r.index === r.count - 1) && wireText(r.text)) return shape(r, ['phase', 'rpcId', 'hash', 'index', 'count', 'text']) as MetaMemoryRemoteRequest;
  if (r.phase === 'read' && index(r.index)) return shape(r, ['phase', 'rpcId', 'hash', 'index']) as MetaMemoryRemoteRequest;
  if (r.phase === 'execute' || r.phase === 'release') return shape(r, ['phase', 'rpcId', 'hash']) as MetaMemoryRemoteRequest;
  throw Error('공통 기억 원격 요청 범위를 확인하세요.');
}
export function normalizeMetaMemoryRemoteResponse(value: unknown): MetaMemoryRemoteResponse {
  const r = shape(value, ['phase', 'rpcId', 'hash', 'index', 'count', 'text']);
  if (!uuid(r.rpcId)) throw Error('공통 기억 원격 응답을 확인하세요.');
  if (r.phase === 'uploaded' || r.phase === 'released') return shape(r, ['phase', 'rpcId']) as MetaMemoryRemoteResponse;
  if (hash(r.hash) && index(r.count) && r.count > 0) {
    if (r.phase === 'ready') return shape(r, ['phase', 'rpcId', 'hash', 'count']) as MetaMemoryRemoteResponse;
    if (r.phase === 'chunk' && index(r.index) && r.index < r.count && wireText(r.text)) return r as MetaMemoryRemoteResponse;
    if (r.phase === 'result' && r.index === 0 && wireText(r.text)) return shape(r, ['phase', 'rpcId', 'hash', 'count', 'index', 'text']) as MetaMemoryRemoteResponse;
  }
  throw Error('공통 기억 원격 응답 범위를 확인하세요.');
}
/** Count escaped JSON bytes, preserve Unicode code points, and keep every existing envelope bounded. */
export function splitMetaMemoryWireText(value: string, limit: number = META_MEMORY_REMOTE_LIMITS.wireBytes): string[] {
  const chunks: string[] = []; let parts: string[] = [], bytes = 0;
  for (const character of value) {
    const cost = new TextEncoder().encode(JSON.stringify(character)).length - 2;
    if (bytes + cost > limit) { chunks.push(parts.join('')); parts = []; bytes = 0; }
    parts.push(character); bytes += cost;
  }
  if (parts.length || !chunks.length) chunks.push(parts.join(''));
  return chunks;
}
