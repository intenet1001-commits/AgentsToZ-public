import { detectVocImageMime, VOC_MAX_ATTACHMENTS, VOC_MAX_IMAGE_BYTES, VOC_REMOTE_COMMENT_MAX, type VocImageMime } from './vocAttachments';

/**
 * 「보내지 않은 캡처」 — iOS 사진 공유로 들어온 사진을 **보낼 때까지** 이 휴대폰에 붙잡아 둔다.
 *
 * 앱 셸은 App Group 보관함(`voc-outbox/`)의 항목을 페이지에 넘기고, 페이지가 `ack`하면 그 파일을 지운다.
 * 예전에는 작성 화면을 연 순간 ack해서, 보내지 않고 닫으면 사진이 그대로 사라졌다(여러 건을 한꺼번에
 * 공유하면 뒤의 것이 앞의 작성 화면을 덮어써 역시 사라졌다). 그래서 페이지는 **먼저 이 보관소에 담고**
 * 그다음에만 ack한다. 담긴 캡처는 VOC를 보내거나 사용자가 「삭제」를 누를 때만 지워진다.
 *
 * 저장은 이 페이지 origin의 IndexedDB다(릴레이 키 vault와 같은 저장소). 보관소를 쓸 수 없는 환경이면
 * 메모리에만 두고, 그 사실을 `persistent:false`로 알린다.
 */

export const VOC_SHARE_CAPTURE_MAX = 20;

export interface VocShareCaptureImage { mime: VocImageMime; bytes: Uint8Array }

export interface VocShareCapture {
  /** 앱 셸이 준 보관함 항목 id(소문자 UUID). 같은 항목을 두 번 받아도 한 번만 담긴다. */
  id: string;
  createdAt: string;
  /** 마지막으로 이 휴대폰에 담거나 고친 시각. */
  savedAt: string;
  comment: string;
  images: VocShareCaptureImage[];
}

export interface VocShareCaptureBackend {
  readonly persistent: boolean;
  list(): Promise<VocShareCapture[]>;
  get(id: string): Promise<VocShareCapture | null>;
  put(capture: VocShareCapture): Promise<void>;
  delete(id: string): Promise<void>;
}

export type VocShareTakeResult =
  | { status: 'stored'; capture: VocShareCapture }
  | { status: 'duplicate'; capture: VocShareCapture }
  | { status: 'full' }
  | { status: 'invalid' };

const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 앱 셸의 `agentstoz-voc-share` 이벤트 detail을 캡처로 바꾼다. 형식이 맞지 않으면 null.
 * 이미지는 **바이트로** 판정한다 — 선언된 mime은 믿지 않는다.
 */
export function vocShareCaptureFromDetail(detail: unknown, now = new Date()): VocShareCapture | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const raw = detail as { id?: unknown; createdAt?: unknown; comment?: unknown; images?: unknown };
  if (typeof raw.id !== 'string' || !CAPTURE_ID.test(raw.id) || !Array.isArray(raw.images)) return null;
  const images: VocShareCaptureImage[] = [];
  for (const item of raw.images.slice(0, VOC_MAX_ATTACHMENTS)) {
    const data = item && typeof item === 'object' ? (item as { dataBase64?: unknown }).dataBase64 : null;
    if (typeof data !== 'string' || data.length > Math.ceil(VOC_MAX_IMAGE_BYTES / 3) * 4 + 8) continue;
    let bytes: Uint8Array;
    try { bytes = decodeBase64(data); } catch { continue; }
    const mime = detectVocImageMime(bytes);
    if (!mime || bytes.byteLength > VOC_MAX_IMAGE_BYTES) continue;
    images.push({ mime, bytes });
  }
  if (!images.length) return null;
  const created = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now.toISOString();
  return {
    id: raw.id,
    createdAt: created,
    savedAt: now.toISOString(),
    comment: typeof raw.comment === 'string' ? raw.comment.slice(0, VOC_REMOTE_COMMENT_MAX) : '',
    images,
  };
}

export class VocShareCaptureStore {
  constructor(private readonly backend: VocShareCaptureBackend, private readonly max = VOC_SHARE_CAPTURE_MAX) {}

  get persistent(): boolean { return this.backend.persistent; }

  /** 새것부터. */
  async list(): Promise<VocShareCapture[]> {
    const items = await this.backend.list();
    return [...items].sort((a, b) => (a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * 앱 셸에서 받은 항목을 담는다. 담긴 뒤에만(또는 이미 담겨 있으면) 호출자가 ack해야 한다.
   * 가득 차 있으면 담지 않는다 — 그 항목은 ack하지 않으므로 App Group 보관함에 그대로 남는다.
   */
  async take(detail: unknown, now = new Date()): Promise<VocShareTakeResult> {
    const capture = vocShareCaptureFromDetail(detail, now);
    if (!capture) return { status: 'invalid' };
    const existing = await this.backend.get(capture.id);
    if (existing) return { status: 'duplicate', capture: existing };
    if ((await this.backend.list()).length >= this.max) return { status: 'full' };
    await this.backend.put(capture);
    return { status: 'stored', capture };
  }

  /** 작성 화면을 보내지 않고 닫았을 때 — 고친 내용과 남긴 사진을 기억한다. 사진을 전부 뺐고 글도 없으면 지운다. */
  async keep(id: string, draft: { comment: string; images: readonly VocShareCaptureImage[] }, now = new Date()): Promise<VocShareCapture | null> {
    const existing = await this.backend.get(id);
    if (!existing) return null;
    const images = draft.images.slice(0, VOC_MAX_ATTACHMENTS).map(image => ({ mime: image.mime, bytes: image.bytes }));
    const comment = draft.comment.slice(0, VOC_REMOTE_COMMENT_MAX);
    if (!images.length && !comment.trim()) { await this.backend.delete(id); return null; }
    const next: VocShareCapture = { ...existing, comment, images, savedAt: now.toISOString() };
    await this.backend.put(next);
    return next;
  }

  async get(id: string): Promise<VocShareCapture | null> { return this.backend.get(id); }

  /** 보냈거나 사용자가 지웠을 때. 이 휴대폰의 보관소에서 사진 바이트까지 지운다. */
  async remove(id: string): Promise<void> { await this.backend.delete(id); }
}

export function memoryVocShareBackend(): VocShareCaptureBackend {
  const items = new Map<string, VocShareCapture>();
  return {
    persistent: false,
    async list() { return [...items.values()]; },
    async get(id) { return items.get(id) ?? null; },
    async put(capture) { items.set(capture.id, capture); },
    async delete(id) { items.delete(id); },
  };
}

const DB_NAME = 'agentstoz-voc-share-captures';
const STORE = 'captures';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/** 이 origin의 IndexedDB 보관소. 열 수 없으면 null — 호출자는 메모리 보관소로 떨어진다. */
export async function openIndexedDbVocShareBackend(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<VocShareCaptureBackend | null> {
  if (!factory) return null;
  let db: IDBDatabase;
  try {
    const open = factory.open(DB_NAME, 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'id' }); };
    db = await request(open);
  } catch {
    return null;
  }
  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
  const done = (store: IDBObjectStore) => new Promise<void>((resolve, reject) => {
    store.transaction.oncomplete = () => resolve();
    store.transaction.onerror = () => reject(store.transaction.error);
    store.transaction.onabort = () => reject(store.transaction.error);
  });
  return {
    persistent: true,
    async list() { return (await request(tx('readonly').getAll())) as VocShareCapture[]; },
    async get(id) { return ((await request(tx('readonly').get(id))) as VocShareCapture | undefined) ?? null; },
    async put(capture) { const store = tx('readwrite'); const finished = done(store); store.put(capture); await finished; },
    async delete(id) { const store = tx('readwrite'); const finished = done(store); store.delete(id); await finished; },
  };
}

/**
 * 앱 셸이 넘긴 공유 항목 하나를 처리하는 순서의 정본(포털과 격리 fixture가 같은 함수를 쓴다):
 * ① 보관소에 담는다 → ② 담긴 뒤에만 ack(앱 셸이 App Group 파일을 지운다) → ③ 작성 화면이 비어 있으면 연다.
 * 담지 못했으면(저장 실패·가득 참) ack하지 않는다 — 항목은 App Group 보관함에 남아 다음에 다시 온다.
 */
export async function receiveVocShareDelivery(input: {
  store: VocShareCaptureStore;
  detail: unknown;
  ack: (id: string) => void;
  composerOpen: () => boolean;
  openComposer: (capture: VocShareCapture) => void;
  notice: (message: string) => void;
  refresh: () => Promise<void>;
}): Promise<VocShareTakeResult['status'] | 'error'> {
  const id = input.detail && typeof input.detail === 'object' ? (input.detail as { id?: unknown }).id : null;
  if (typeof id !== 'string') return 'invalid';
  let result: VocShareTakeResult;
  try { result = await input.store.take(input.detail); }
  catch { input.notice('공유한 사진을 이 휴대폰에 담지 못했습니다. 앱을 다시 열면 다시 시도합니다.'); return 'error'; }
  if (result.status === 'full') {
    input.notice(`보내지 않은 캡처가 ${VOC_SHARE_CAPTURE_MAX}개로 가득 찼습니다. 「VOC」에서 보내거나 삭제하면 나머지 사진 공유를 담습니다.`);
    return 'full';
  }
  input.ack(id);
  if (result.status === 'invalid') return 'invalid';
  await input.refresh().catch(() => {});
  if (result.status === 'stored') {
    if (input.composerOpen()) input.notice('사진 공유를 「보내지 않은 캡처」에 담았습니다. 「VOC」에서 이어서 보낼 수 있습니다.');
    else input.openComposer(result.capture);
  }
  return result.status;
}
