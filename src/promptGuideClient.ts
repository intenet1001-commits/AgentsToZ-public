import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './lib/env';

export interface PromptGuideEntry { id: string; title: string; body: string; pinned: boolean; updatedAt: string }
export interface PromptGuideSnapshot { revision: string; entries: PromptGuideEntry[] }
export interface PromptGuideHumanPage {
  items: Array<{
    id: string; seq: string; recordedAt: string; text: string; agent: 'claude' | 'codex';
    memoryId?: string | null; projectId: string | null; projectName: string | null;
    deviceId: string | null; deviceName: string | null;
    promptOrigin: 'human' | 'agentstoz' | 'unknown'; storage?: 'local' | 'supabase';
  }>;
  nextBeforeSeq: string | null; hasMore: boolean; source: 'local' | 'supabase';
  scan: {complete: boolean; unreadable: number; withheld: number} | null;
  capture: null;
}
type NativeResponse = {status: number; body: unknown};
interface ClientOptions {
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  invokeImpl?: (command: string, args: Record<string, unknown>) => Promise<NativeResponse>;
  isNative?: () => boolean;
  timeoutMs?: number;
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const failure = (code: string, message: string) => Object.assign(new Error(message), {code});
const invalidPage = () => failure('PROMPT_GUIDE_PAGE_INVALID', '입력 기록의 응답이 올바르지 않습니다. 다시 조회해 주세요.');
const validCursor = (value: unknown): value is string => typeof value === 'string' && (
  /^(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 32
  || /^wisr1_(?:0|[1-9][0-9]*)$/.test(value) && value.length <= 32
  || /^wisg1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length <= 65_536);

/** Strict list boundary: malformed success responses are never empty history. */
export function normalizePromptGuideHumanPage(raw: unknown): PromptGuideHumanPage {
  const value = record(raw);
  if (!value || value.success !== true || !Array.isArray(value.items) || value.items.length > 100
    || (value.source !== 'local' && value.source !== 'supabase') || typeof value.hasMore !== 'boolean'
    || !(value.nextBeforeSeq === null || validCursor(value.nextBeforeSeq))
    || (value.hasMore && !value.nextBeforeSeq)) throw invalidPage();
  const items = value.items.map(rawItem => {
    const item = record(rawItem);
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 512
      || typeof item.seq !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(item.seq)
      || typeof item.recordedAt !== 'string' || !Number.isFinite(Date.parse(item.recordedAt))
      || typeof item.text !== 'string' || (item.agent !== 'claude' && item.agent !== 'codex')
      || (item.memoryId != null && (typeof item.memoryId !== 'string' || item.memoryId.length > 512))) throw invalidPage();
    const optional = (key: string) => typeof item[key] === 'string' && item[key].trim() ? item[key].trim() as string : null;
    return {id: item.id, seq: item.seq, recordedAt: item.recordedAt, text: item.text, agent: item.agent,
      memoryId: optional('memoryId'), projectId: optional('projectId'), projectName: optional('projectName'),
      deviceId: optional('deviceId'), deviceName: optional('deviceName'),
      promptOrigin: item.promptOrigin === 'human' || item.promptOrigin === 'agentstoz' ? item.promptOrigin : 'unknown',
      ...(item.storage === 'local' || item.storage === 'supabase' ? {storage: item.storage} : {}),
    } as PromptGuideHumanPage['items'][number];
  });
  let scan: PromptGuideHumanPage['scan'] = null;
  if (value.scan != null) {
    const rawScan = record(value.scan);
    if (!rawScan || typeof rawScan.complete !== 'boolean'
      || !Number.isSafeInteger(rawScan.unreadable) || (rawScan.unreadable as number) < 0
      || !Number.isSafeInteger(rawScan.withheld) || (rawScan.withheld as number) < 0) throw invalidPage();
    scan = {complete: rawScan.complete, unreadable: rawScan.unreadable as number, withheld: rawScan.withheld as number};
  }
  return {items, source: value.source, nextBeforeSeq: value.nextBeforeSeq, hasMore: value.hasMore, scan, capture: null};
}
export function normalizePromptGuideSnapshot(raw: unknown): PromptGuideSnapshot {
  const value = raw as PromptGuideSnapshot & {success?: boolean};
  if (!value || value.success !== true || typeof value.revision !== 'string' || !value.revision
    || !Array.isArray(value.entries) || value.entries.length > 100
    || value.entries.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 120
      || typeof item.body !== 'string' || !item.body.trim() || item.body.length > 16_384 || typeof item.pinned !== 'boolean' || !Number.isFinite(Date.parse(item.updatedAt)))
    || new Set(value.entries.map(item => item.id)).size !== value.entries.length) throw new Error('프롬프트 가이드 응답을 확인하지 못했습니다. 목록을 다시 읽어 결과를 확인해 주세요.');
  return {revision: value.revision, entries: value.entries};
}

export function createPromptGuideClient(options: ClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const invokeImpl = options.invokeImpl ?? ((command, args) => invoke<NativeResponse>(command, args));
  const isNative = options.isNative ?? (() => isTauri() && String(import.meta.env.DEV) !== 'true');
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 15_000) throw new RangeError('Invalid prompt guide timeout.');
  let nativeHumanBusy = false;
  async function request(path: string, body: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const native = isNative();
    const humanRead = native && path === '/api/what-i-said/list';
    if (humanRead && nativeHumanBusy) throw failure('PROMPT_GUIDE_READ_IN_PROGRESS', '이전 입력 기록 조회가 끝나기를 기다리고 있습니다. 잠시 후 다시 시도해 주세요.');
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, {once: true});
    const timer = setTimeout(() => controller.abort(failure('PROMPT_GUIDE_REQUEST_TIMEOUT', '요청 시간이 초과되었습니다. 저장 요청이었다면 목록을 다시 읽어 결과를 확인해 주세요.')), timeoutMs);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    try {
      let operation: Promise<NativeResponse>;
      if (native) {
        if (humanRead) nativeHumanBusy = true;
        operation = (async () => invokeImpl('what_i_said_management_request', {path, method: 'POST', body}))();
        // Cancelling the JS wait cannot cancel a Rust invoke. Keep its slot
        // occupied until the actual native request settles, including failure.
        if (humanRead) void operation.then(() => {nativeHumanBusy = false;}, () => {nativeHumanBusy = false;});
      } else {
        operation = (async () => {
          const response = await fetchImpl(path, {method: 'POST', cache: 'no-store', redirect: 'error',
            headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: controller.signal});
          return {status: response.status, body: await response.json()};
        })();
      }
      const result = await Promise.race([operation, aborted]);
      const value = record(result?.body);
      if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) {
        throw failure(typeof value?.code === 'string' ? value.code : 'PROMPT_GUIDE_REQUEST_FAILED',
          typeof value?.error === 'string' ? value.error : '프롬프트 가이드 응답을 확인하지 못했습니다.');
      }
      return result.body;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onExternalAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  return {
    async read(signal?: AbortSignal) { return normalizePromptGuideSnapshot(await request('/api/what-i-said/guides/list', {}, signal)); },
    async save(expectedRevision: string, entries: PromptGuideEntry[], signal?: AbortSignal) {
      return normalizePromptGuideSnapshot(await request('/api/what-i-said/guides/save', {expectedRevision, entries}, signal));
    },
    async humanPage(beforeSeq?: string, signal?: AbortSignal) {
      return normalizePromptGuideHumanPage(await request('/api/what-i-said/list', {origin: 'human', limit: 100, ...(beforeSeq ? {beforeSeq} : {})}, signal));
    },
  };
}
export const promptGuideClient = createPromptGuideClient();
