/**
 * Phone Workroom attachments, the phone half (w13 step B). What happens between a pick and a ready `wa_` id:
 *
 *   pick → prepare (a photo is redrawn as JPEG ≤ 2400px; a file goes as it is, ≤ 10,485,732 bytes) → encrypt with a fresh
 *   key, upload the ciphertext to the private VOC transit bucket, sign it (src/remoteVoc.ts `sealAndUploadTransit`, the VOC
 *   order) → `attachments.receive` in batches of ≤ 5 items / ≤ 10,000 bytes → `attachments.status` until each item is
 *   ready or failed. A ready item is an opaque id the next submission names; the Mac appends the paths itself.
 *
 * Network rules (CLAUDE.md 「휴대폰이 오프라인이면 그렇게 말한다」): offline, a pick waits with no storage or relay request;
 * a receive the controller holds on the phone (`REMOTE_CONTROL_REQUEST_UNSENT`) keeps its transit objects and is asked
 * again with the same receiveId once the phone reconnects (the Mac treats it as the same job); an answer that could not be
 * read is asked again at most three times. A wait for the network is never a failure: an item is failed only on a FRESH
 * status that still says pending after the three-minute deadline. Nothing here ever sends anything to the AI — that is
 * the submission's job.
 *
 * Ids are bound to one project on the Mac. When the viewed session moves to another project, ready ids follow with
 * `attachments.rebind` (no new upload, download or id); an uploaded object not yet handed to a Mac simply goes to the new
 * project. A chip taken back out releases its id (`attachments.release`), so 「빼기」 frees the Mac's room. Every transit
 * object the phone uploaded is handed to a Mac or deleted, on every path — removal, retarget, dispose (review w13).
 *
 * No React: the panel subscribes to `snapshot()` (src/RemoteWorkroomAttachBar.tsx) and calls `kick()` on `online`.
 */
import type { MobileWorkspaceRequest, MobileWorkspaceResult } from './mobileWorkspaceProtocol';
import { encryptTransitBlob, VOC_TRANSIT_BUCKET } from './vocAttachments';
import { prepareTransitPhoto, sealAndUploadTransit, sweepOwnVocTransit, type TransitBucket, type TransitUpload } from './remoteVoc';
import {
  WORKROOM_ATTACH_FEATURE, WORKROOM_ATTACH_MAX_FILES, WORKROOM_ATTACH_MAX_IMAGES, WORKROOM_ATTACH_NAME_MAX,
  WORKROOM_ATTACH_RECEIVE_MAX_ITEMS, WORKROOM_ATTACH_RECEIVE_MAX_JSON_BYTES, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES,
  workroomAttachmentFailureMessage,
  type WorkroomAttachmentItemResult, type WorkroomAttachmentReceive, type WorkroomAttachmentReceiveItem,
} from './workroomRemoteAttachmentProtocol';
import { workroomAttachmentMessage } from './workroomImageAttachments';
import { displayAttachmentName } from './workroomAttachmentRules';
import { phoneIsOnline } from './phoneNetwork';

export type RemoteAttachAvailability = 'ready' | 'update-required' | 'checking' | 'unavailable';
/** The minimal Supabase client the transit needs: the signed-in uid and the transit bucket. */
export interface RemoteAttachStorageClient {
  auth: { getSession(): Promise<{ data: { session: { user?: { id?: string } | null } | null } }> };
  storage: { from(bucket: string): TransitBucket & { remove(paths: string[]): Promise<{ error: unknown }>; list?: unknown } };
}
export interface RemoteAttachContext {
  availability: RemoteAttachAvailability;
  /** Why attaching is off here (another AgentsToZ's session, no portal login). */
  reason?: string;
  supabase: RemoteAttachStorageClient | null;
  /** This Mac's relay host id: transit paths sit under it. */
  hostId: string;
  send: (request: MobileWorkspaceRequest) => Promise<MobileWorkspaceResult>;
}

export const REMOTE_ATTACH_UPDATE_REQUIRED = 'Mac 앱 업데이트 필요 — 연결한 Mac의 AgentsToZ를 업데이트하면 휴대폰에서 사진·파일을 넣을 수 있습니다';
export const REMOTE_ATTACH_CHECKING = 'Mac 기능 확인 중 — 잠시 후 다시 눌러 주세요';
/** The LAN QR page has no transit (no Supabase session there): the button says so. */
export const REMOTE_ATTACH_LAN_NOTICE = '첨부는 인터넷 연결에서만 할 수 있습니다';
export const REMOTE_ATTACH_LOGIN_REQUIRED = '사진·파일을 넣으려면 포털 로그인이 필요합니다. 다시 로그인해 주세요.';
export const REMOTE_ATTACH_ROUTE_REFUSAL = '첨부는 이 세션의 프로젝트에만 넣을 수 있습니다 — 첨부를 빼고 보내세요';
export const REMOTE_ATTACH_MOVING = '첨부를 전달하는 중…';
/** The send button while a chip only waits for the network: nothing is moving, so it does not claim a transfer. */
export const REMOTE_ATTACH_WAITING = '연결되면 첨부를 전달합니다';
export const REMOTE_ATTACH_BUDGET_REFUSAL = '첨부 경로까지 합쳐 24,000바이트를 넘습니다 — 글을 줄이세요';
export const REMOTE_ATTACH_VAULT_NOTICE = '첨부가 있는 요청은 작성 내용 보관에 넣지 않습니다';
export const REMOTE_ATTACH_NO_RECORD = '첨부가 있는 요청은 제출 기록을 남길 수 있을 때만 보냅니다 — 이 브라우저의 사이트 데이터 저장을 허용하세요. 작성 내용은 유지했습니다.';
export const REMOTE_ATTACH_LAUNCH_NO_RECORD = '첨부가 있는 새 작업은 시작 기록을 남길 수 있을 때만 시작합니다 — 이 브라우저의 사이트 데이터 저장을 허용하세요. 작성 내용은 유지했습니다.';

/** From the Mac's advertised features. A probe in flight is still checking: the legacy answer comes first and lacks the flag. */
export function remoteAttachAvailability(features: readonly string[] | null, probing: boolean): RemoteAttachAvailability {
  if (features?.includes(WORKROOM_ATTACH_FEATURE)) return 'ready';
  if (features === null || probing) return 'checking';
  return 'update-required';
}

/** What the send/start button says while chips are not all settled: waiting for the network is not a transfer. */
export function remoteAttachMovingLabel(chips: readonly { state: RemoteAttachChipState }[]): string {
  return chips.some(chip => chip.state === 'preparing' || chip.state === 'uploading' || chip.state === 'receiving') ? REMOTE_ATTACH_MOVING : REMOTE_ATTACH_WAITING;
}

/**
 * The name a chip and its notices show: no control or bidi character (an RLO would show 「invoice‮fdp.exe」 as
 * 「invoiceexe.pdf」 and reverse the rest of the sentence) — the w10 rule, and the name the Mac saves the file under.
 */
export function remoteAttachDisplayName(name: string, kind: 'image' | 'file'): string {
  if (!name) return kind === 'image' ? '사진' : '이름 없는 파일';
  return displayAttachmentName(name);
}

/** The partial-failure line above the composer: the text stays sendable with the rest. */
export function remoteAttachSummary(total: number, failed: number, ready: number): string {
  return `첨부 ${total}개 중 ${failed}개를 전달하지 못했습니다 — 보내면 글${ready ? `과 나머지 ${ready}개만` : '만'} 갑니다`;
}

/** C0/C1 controls, DEL, line/paragraph separators, BOM and every bidi control (as the wire normalizer refuses them). */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu;
/**
 * The name a file carries on the wire: the last path segment, without control and bidi characters, cut to 80 code points.
 * Undefined when nothing is left (the Mac then names it). The Mac sanitises it again before writing.
 */
export function sanitizeRemoteAttachName(name: string): string | undefined {
  const last = name.split(/[\\/]/).pop() ?? '';
  const clean = Array.from(last.replace(UNSAFE_NAME, '').trim()).slice(0, WORKROOM_ATTACH_NAME_MAX).join('').trim();
  // A lone surrogate is not well-formed text; the wire refuses it.
  if (!clean || new TextDecoder().decode(new TextEncoder().encode(clean)) !== clean) return undefined;
  return clean;
}

export type RemoteAttachChipState = 'preparing' | 'waiting' | 'uploading' | 'receiving' | 'ready' | 'failed' | 'held';
/** What the chip row shows (immutable; a new object on every change). */
export interface RemoteAttachChip {
  readonly key: string;
  readonly kind: 'image' | 'file';
  readonly name: string;
  readonly bytes: number;
  readonly thumbnail?: string;
  readonly state: RemoteAttachChipState;
  readonly error?: string;
  /** A failed chip whose bytes are kept: 「다시 시도」 sends it again. */
  readonly retryable: boolean;
  readonly id?: string;
}
export const REMOTE_ATTACH_STATE_LABELS: Record<RemoteAttachChipState, string> = {
  preparing: '준비 중', waiting: '연결되면 전달', uploading: '전달 중', receiving: 'Mac이 받는 중', ready: '', failed: '전달 못 함', held: '휴대폰에 보관됨',
};

/** A File, or anything with its bytes, name and type. */
export interface RemoteAttachFile { readonly name: string; readonly type: string; readonly size: number; arrayBuffer(): Promise<ArrayBuffer> }

export interface RemoteAttachDependencies {
  /** Read every time: the connection, the Mac and its features can change under a chip. */
  context: () => RemoteAttachContext | undefined;
  targetId: string;
  online?: () => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  randomUuid?: () => string;
  preparePhoto?: (file: RemoteAttachFile) => Promise<{ bytes: Uint8Array; mime: string }>;
  objectUrl?: (bytes: Uint8Array, mime: string) => string | undefined;
  revokeUrl?: (url: string) => void;
}

/** Status polls: 1 s × 5, then every 2 s; an admitted batch gives up after 3 min. */
const POLL_DELAYS_MS = [1_000, 1_000, 1_000, 1_000, 1_000];
const POLL_LATER_MS = 2_000;
const RECEIVE_DEADLINE_MS = 3 * 60_000;
/** An answer that could not be read is asked again this many times (same receiveId), 2 s apart. */
const UNREADABLE_RETRIES = 3;
/** A request held on the phone stays asked-for until the controller's envelope could not be delivered any more. */
const HELD_DEADLINE_MS = 12 * 60_000;
/** A ready id within this of its expiry is not sent: the Mac would refuse it at the submission's begin. */
const EXPIRY_MARGIN_MS = 30_000;

const NETWORK_WAIT = new Set(['REMOTE_CONTROL_PHONE_OFFLINE', 'REMOTE_CONTROL_REQUEST_UNSENT_AHEAD']);
const HELD = 'REMOTE_CONTROL_REQUEST_UNSENT';
const errorCode = (error: unknown) => error && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error ?? '');
const MAC_CODE = /\s*\((WORKROOM_ATTACH_[A-Z_]+)\)\s*$/;

class RemoteAttachFailure extends Error {}
/** The storage call failed the way a dropped fetch fails (WebKit 「Load failed」): the network, not the request. */
class RemoteAttachNetworkFailure extends Error {}
const DROPPED_FETCH = /Load failed|Failed to fetch|NetworkError|network connection was lost|Internet connection appears to be offline/i;
function droppedFetch(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return DROPPED_FETCH.test(String(raw ?? ''));
  const value = raw as { message?: unknown; originalError?: { message?: unknown } };
  return DROPPED_FETCH.test(String(value.message ?? '')) || DROPPED_FETCH.test(String(value.originalError?.message ?? ''));
}

interface Chip {
  key: string; kind: 'image' | 'file'; name: string; wireName?: string; bytes: number; thumbnail?: string; mime: string;
  plain?: Uint8Array; state: RemoteAttachChipState; error?: string; retryable: boolean;
  /** Bumped on every restart (retry): work for an older generation only cleans up. */
  gen: number; removed: boolean;
  /** Waiting after a dropped fetch: the uploader leaves it until the next nudge (`kick`), so it never spins. */
  parked?: boolean;
  /** Uploaded, not yet named in a receive. The receive takes the project it is for when it is sent. */
  staged?: TransitUpload & { gen: number };
  /** In a receive that a Mac admitted (or may have): its object is that receive's to settle. */
  delivering?: boolean;
  id?: string; lineBytes?: number; expiresAt?: number;
  /** The project the Mac bound `id` to; ready only while it is the queue's project. */
  boundTarget?: string;
  /** A ready id that has to follow the viewed project (`attachments.rebind`). */
  rebind?: boolean;
  view?: RemoteAttachChip;
}

export class RemoteWorkroomAttachments {
  #deps: Required<Omit<RemoteAttachDependencies, 'context' | 'targetId'>> & Pick<RemoteAttachDependencies, 'context'>;
  #target: string;
  #chips: Chip[] = [];
  #snapshot: readonly RemoteAttachChip[] = [];
  #listeners = new Set<() => void>();
  #wakers: (() => void)[] = [];
  #pumping = false;
  #rebinding = false;
  #disposed = false;
  #active = 0;

  constructor(deps: RemoteAttachDependencies) {
    this.#target = deps.targetId;
    this.#deps = {
      context: deps.context,
      online: deps.online ?? (() => phoneIsOnline()),
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
      randomUuid: deps.randomUuid ?? (() => crypto.randomUUID()),
      preparePhoto: deps.preparePhoto ?? (file => prepareTransitPhoto(file as unknown as Blob, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES)),
      objectUrl: deps.objectUrl ?? ((bytes, mime) => typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) : undefined),
      revokeUrl: deps.revokeUrl ?? (url => { try { URL.revokeObjectURL(url); } catch { /* nothing to free */ } }),
    };
  }

  get targetId(): string { return this.#target; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  snapshot(): readonly RemoteAttachChip[] { return this.#snapshot; }

  /** Anything still on its way (preparing, waiting, uploading, at the Mac, held, following a project): the send waits for it. */
  moving(): boolean { return this.#chips.some(chip => !chip.removed && chip.state !== 'ready' && chip.state !== 'failed') || this.#active > 0; }

  /** Ready ids for the queue's project, in chip order, and their chip keys. A ready id about to expire is failed first (retryable). */
  ready(): { ids: string[]; keys: string[] } {
    this.#expire();
    const ready = this.#chips.filter(chip => !chip.removed && chip.state === 'ready' && chip.id && chip.boundTarget === this.#target);
    return { ids: ready.map(chip => chip.id!), keys: ready.map(chip => chip.key) };
  }

  /**
   * The bytes of the request the Mac will write: the text, then the block of the ready ids' paths (the Mac's own lines,
   * counted from `lineBytes`, never the paths themselves), then Enter. The Mac refuses more than 24,000.
   */
  requestBytes(text: string): number {
    const ready = this.#chips.filter(chip => !chip.removed && chip.state === 'ready' && chip.lineBytes);
    const line = (chip: Chip) => 'x'.repeat(chip.lineBytes!);
    const message = workroomAttachmentMessage(text, ready.filter(c => c.kind === 'image').map(line), ready.filter(c => c.kind === 'file').map(line));
    return new TextEncoder().encode(message).length + 1;
  }

  /**
   * Adds picks. `kind` 'auto' (a drop) sorts by MIME: images go the photo way, everything else as a file. Returns what
   * was refused at once (too large, over the six photos / ten files of one request); everything else becomes a chip.
   * Names on screen never carry a control or bidi character (`remoteAttachDisplayName`); only the wire name is the raw
   * name's sanitised form.
   */
  add(files: readonly RemoteAttachFile[], kind: 'image' | 'file' | 'auto'): string[] {
    const notes: string[] = [], overLimit: string[] = [];
    const count = (k: 'image' | 'file') => this.#chips.filter(chip => !chip.removed && chip.kind === k).length;
    for (const file of files) {
      const wanted: 'image' | 'file' = kind === 'auto' ? (/^image\//i.test(file.type) ? 'image' : 'file') : kind;
      const label = remoteAttachDisplayName(file.name, wanted);
      if (wanted === 'file' && file.size > WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES) { notes.push(`${label} — 파일 하나는 10MB까지 넣을 수 있습니다`); continue; }
      if (count(wanted) >= (wanted === 'image' ? WORKROOM_ATTACH_MAX_IMAGES : WORKROOM_ATTACH_MAX_FILES)) { overLimit.push(label); continue; }
      const chip: Chip = { key: this.#deps.randomUuid(), kind: wanted, name: label, bytes: file.size, mime: file.type || 'application/octet-stream',
        state: 'preparing', retryable: false, gen: 0, removed: false };
      this.#chips.push(chip);
      void this.#prepare(chip, file);
    }
    if (overLimit.length) notes.push(`한 요청에 사진은 ${WORKROOM_ATTACH_MAX_IMAGES}개, 파일은 ${WORKROOM_ATTACH_MAX_FILES}개까지 넣을 수 있습니다 — 넣지 않은 항목: ${overLimit.slice(0, 3).join(', ')}${overLimit.length > 3 ? ` 외 ${overLimit.length - 3}개` : ''}`);
    this.#emit();
    return notes;
  }

  /** The person took it back out: its Mac id is released (its file deleted, its live slot back). */
  remove(key: string): void { this.#drop(key, true); }
  /** After a written submission: the chips whose ids went with it (consumed there, so nothing to release). */
  removeKeys(keys: readonly string[]): void { for (const key of keys) this.#drop(key, false); }
  clear(): void { for (const chip of [...this.#chips]) this.#drop(chip.key, true); }
  retry(key: string): void {
    const chip = this.#chips.find(item => item.key === key && !item.removed);
    if (!chip || chip.state !== 'failed' || !chip.retryable || !chip.plain) return;
    this.#restart(chip);
    this.#emit();
    void this.#pump();
  }
  retryFailed(): void { for (const chip of this.#chips) if (!chip.removed && chip.state === 'failed' && chip.retryable && chip.plain) this.#restart(chip); this.#emit(); void this.#pump(); }
  removeFailed(): void { for (const chip of [...this.#chips]) if (chip.state === 'failed') this.#drop(chip.key, true); }
  /**
   * The Mac refused a submission because these ids are unknown or expired there: they are no longer ready here either
   * (「다시 시도」 sends their kept bytes again).
   */
  invalidate(keys: readonly string[], message: string): void {
    const ids: string[] = [];
    for (const chip of this.#chips) if (keys.includes(chip.key) && !chip.removed && chip.state === 'ready') { if (chip.id) ids.push(chip.id); this.#fail(chip, message); }
    // One the Mac still holds for another project frees its room now (an unknown or consumed one is ignored there).
    this.#release(ids);
    this.#emit();
  }

  /**
   * Another project. Ids are bound to one project on the Mac: a ready id follows with `attachments.rebind` (same id, no
   * new upload or download, no quota); an upload not yet handed to a Mac goes to the new project when its receive is
   * sent; a receive already on its way finishes for the old project and then follows the same way. Nothing is minted
   * just because the viewed session changed (review w13: flipping projects exhausted the Mac's live ids and quota).
   */
  retarget(targetId: string): void {
    if (!targetId || targetId === this.#target) return;
    this.#target = targetId;
    // Even back to where an id already is: a rebind in flight may have moved it meanwhile, and the Mac's answer decides.
    for (const chip of this.#chips) if (!chip.removed && chip.id && (chip.state === 'ready' || chip.rebind)) { chip.rebind = true; chip.state = 'receiving'; }
    this.#emit();
    void this.#pump();
    void this.#rebindPump();
  }

  /** The network came back (or a periodic nudge): waiting and held work goes on. */
  kick(): void {
    this.#expire();
    for (const chip of this.#chips) chip.parked = false;
    const wakers = this.#wakers; this.#wakers = [];
    for (const wake of wakers) wake();
    void this.#pump();
    void this.#rebindPump();
  }

  /**
   * The composer went away (the panel unmounted). Nothing is left behind: an uploaded object not yet handed to a Mac is
   * deleted, a ready id is released, and the receives still on their way delete what they did not settle.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const release: string[] = [], objects: string[] = [];
    for (const chip of this.#chips) {
      if (chip.thumbnail) this.#deps.revokeUrl(chip.thumbnail);
      if (chip.staged && !chip.delivering) objects.push(chip.staged.path);
      if (chip.id && !chip.removed) release.push(chip.id);
      chip.removed = true;
    }
    void this.#deleteObjects(objects);
    this.#release(release);
    this.#chips = [];
    const wakers = this.#wakers; this.#wakers = [];
    for (const wake of wakers) wake();
    this.#listeners.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────

  #emit() {
    const live = this.#chips.filter(chip => !chip.removed);
    let changed = live.length !== this.#snapshot.length;
    const next = live.map((chip, index) => {
      const view: RemoteAttachChip = { key: chip.key, kind: chip.kind, name: chip.name, bytes: chip.bytes, state: chip.state, retryable: chip.retryable && !!chip.plain,
        ...(chip.thumbnail ? { thumbnail: chip.thumbnail } : {}), ...(chip.error ? { error: chip.error } : {}), ...(chip.id && chip.state === 'ready' ? { id: chip.id } : {}) };
      const old = chip.view;
      const same = !!old && old.state === view.state && old.error === view.error && old.id === view.id && old.retryable === view.retryable && old.thumbnail === view.thumbnail && old.bytes === view.bytes && old.kind === view.kind;
      if (!same) chip.view = view;
      if (!same || this.#snapshot[index] !== chip.view) changed = true;
      return chip.view!;
    });
    if (!changed) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) { try { listener(); } catch { /* a screen never stops the queue */ } }
  }

  #drop(key: string, release: boolean) {
    const chip = this.#chips.find(item => item.key === key);
    if (!chip) return;
    chip.removed = true;
    if (chip.thumbnail) this.#deps.revokeUrl(chip.thumbnail);
    chip.thumbnail = undefined;
    // An object uploaded but not yet handed to a Mac is this phone's to delete; one in a receive is that receive's.
    if (chip.staged && !chip.delivering) void this.#deleteObjects([chip.staged.path]);
    if (release && chip.id) this.#release([chip.id]);
    this.#chips = this.#chips.filter(item => item !== chip);
    this.#emit();
  }

  #restart(chip: Chip) {
    // An upload not yet named in a receive is deleted here; one in a receive is settled by that receive.
    if (chip.staged && !chip.delivering) void this.#deleteObjects([chip.staged.path]);
    chip.gen++; chip.parked = false;
    chip.state = this.#deps.online() ? 'uploading' : 'waiting';
    chip.error = undefined; chip.retryable = false; chip.id = undefined; chip.lineBytes = undefined; chip.expiresAt = undefined; chip.staged = undefined;
    chip.delivering = false; chip.boundTarget = undefined; chip.rebind = false;
  }

  #fail(chip: Chip, message: string, retryable = true) {
    chip.state = 'failed'; chip.error = message; chip.retryable = retryable; chip.id = undefined; chip.lineBytes = undefined; chip.expiresAt = undefined;
    chip.boundTarget = undefined; chip.rebind = false;
  }

  #expire() {
    const now = this.#deps.now();
    let changed = false;
    for (const chip of this.#chips) if (!chip.removed && (chip.state === 'ready' || chip.rebind) && chip.expiresAt !== undefined && now >= chip.expiresAt - EXPIRY_MARGIN_MS) {
      this.#fail(chip, workroomAttachmentFailureMessage('WORKROOM_ATTACH_EXPIRED'));
      changed = true;
    }
    if (changed) this.#emit();
  }

  #wake(): Promise<void> { return new Promise(resolve => { if (this.#disposed) resolve(); else this.#wakers.push(resolve); }); }

  async #prepare(chip: Chip, file: RemoteAttachFile) {
    try {
      let bytes: Uint8Array, mime = chip.mime;
      if (chip.kind === 'image') {
        try { const photo = await this.#deps.preparePhoto(file); bytes = photo.bytes; mime = photo.mime; }
        catch {
          // Not a photo the phone can redraw (an SVG, a RAW): it still goes, as a file.
          const raw = new Uint8Array(await file.arrayBuffer());
          if (raw.byteLength > WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES) throw new RemoteAttachFailure(`${chip.name} — 파일 하나는 10MB까지 넣을 수 있습니다`);
          chip.kind = 'file'; bytes = raw;
        }
      } else bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength < 1) throw new RemoteAttachFailure(`${chip.name} — 빈 파일은 넣을 수 없습니다`);
      if (bytes.byteLength > WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES) throw new RemoteAttachFailure(`${chip.name} — 파일 하나는 10MB까지 넣을 수 있습니다`);
      if (chip.removed || this.#disposed) return;
      chip.plain = bytes; chip.bytes = bytes.byteLength; chip.mime = mime;
      chip.wireName = chip.kind === 'file' ? sanitizeRemoteAttachName(file.name) : undefined;
      if (chip.kind === 'image') chip.thumbnail = this.#deps.objectUrl(bytes, mime);
      chip.state = this.#deps.online() ? 'uploading' : 'waiting';
    } catch (error) {
      this.#fail(chip, error instanceof RemoteAttachFailure ? error.message : `${chip.name} — 이 항목을 읽지 못했습니다. 다른 파일을 골라 주세요.`, false);
    }
    this.#emit();
    void this.#pump();
  }

  /** Uploads one at a time; once nothing is left to upload, everything uploaded goes to the Mac in batches. */
  async #pump(): Promise<void> {
    if (this.#pumping || this.#disposed) return;
    this.#pumping = true;
    try {
      for (;;) {
        if (this.#disposed) return;
        const next = this.#chips.find(chip => !chip.removed && !chip.parked && chip.plain && !chip.staged && (chip.state === 'uploading' || chip.state === 'waiting'));
        if (next) {
          if (!this.#deps.online()) { this.#waitAll(); await this.#wake(); continue; }
          await this.#upload(next);
          continue;
        }
        // Still preparing, or parked until the network answers: the batch waits for them (one receive for a pick of five).
        if (this.#chips.some(chip => !chip.removed && (chip.state === 'preparing' || chip.parked))) return;
        const staged = this.#chips.filter(chip => !chip.removed && chip.staged && !chip.delivering && chip.state === 'uploading');
        if (!staged.length) return;
        // The receive is for the project the queue is on NOW: an upload made before a switch goes to the new project.
        const targetId = this.#target;
        for (const batch of this.#batches(staged)) void this.#deliver(batch, targetId);
      }
    } finally { this.#pumping = false; }
  }

  #waitAll() {
    let changed = false;
    for (const chip of this.#chips) if (!chip.removed && chip.plain && !chip.staged && chip.state === 'uploading') { chip.state = 'waiting'; changed = true; }
    if (changed) this.#emit();
  }

  async #upload(chip: Chip) {
    const context = this.#deps.context();
    const gen = chip.gen;
    chip.state = 'uploading'; this.#emit();
    if (!context?.supabase || !context.hostId) { this.#fail(chip, REMOTE_ATTACH_LOGIN_REQUIRED); this.#emit(); return; }
    const supabase = context.supabase;
    let uploadedPath: string | null = null;
    this.#active++;
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) throw new RemoteAttachFailure(REMOTE_ATTACH_LOGIN_REQUIRED);
      void sweepOwnVocTransit(supabase as never, context.hostId, uid);
      const bucket = supabase.storage.from(VOC_TRANSIT_BUCKET);
      const staged = await sealAndUploadTransit({ bucket, hostId: context.hostId, uid, plain: chip.plain!,
        encrypt: plain => encryptTransitBlob(plain, WORKROOM_REMOTE_ATTACHMENT_MAX_BYTES), randomUuid: this.#deps.randomUuid,
        storageError: raw => droppedFetch(raw) ? new RemoteAttachNetworkFailure() : new RemoteAttachFailure(transitStorageMessage(raw)), onUploaded: path => { uploadedPath = path; } });
      if (chip.removed || chip.gen !== gen || this.#disposed) { void this.#deleteObjects([staged.path]); return; }
      chip.staged = { ...staged, gen };
    } catch (error) {
      if (uploadedPath) void this.#deleteObjects([uploadedPath]);
      if (chip.removed || chip.gen !== gen) return;
      // The network went away during the upload: it waits for the network (the next nudge) instead of failing.
      if (!this.#deps.online() || error instanceof RemoteAttachNetworkFailure || droppedFetch(error)) { chip.state = 'waiting'; chip.parked = true; this.#emit(); return; }
      this.#fail(chip, error instanceof RemoteAttachFailure ? error.message : '사진·파일을 전달하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.');
    } finally { this.#active--; this.#emit(); }
  }

  /** ≤ 5 items and ≤ 10,000 bytes of `{receiveId, items}` per receive. */
  #batches(chips: Chip[]): Chip[][] {
    const batches: Chip[][] = [];
    let current: Chip[] = [];
    const size = (list: Chip[]) => new TextEncoder().encode(JSON.stringify({ receiveId: '00000000-0000-4000-8000-000000000000', items: list.map(item) })).length;
    for (const chip of chips) {
      if (current.length && (current.length >= WORKROOM_ATTACH_RECEIVE_MAX_ITEMS || size([...current, chip]) > WORKROOM_ATTACH_RECEIVE_MAX_JSON_BYTES)) { batches.push(current); current = []; }
      current.push(chip);
      chip.state = 'receiving'; chip.delivering = true;
    }
    if (current.length) batches.push(current);
    this.#emit();
    return batches;
  }

  async #deliver(chips: Chip[], targetId: string) {
    const gens = new Map(chips.map(chip => [chip, chip.gen]));
    const receive: WorkroomAttachmentReceive = { receiveId: this.#deps.randomUuid(), items: chips.map(item) };
    const paths = receive.items.map(entry => entry.path);
    const current = (chip: Chip) => !chip.removed && chip.gen === gens.get(chip);
    const settledPaths = new Set<string>();
    // Counts toward `moving()` only while a chip of this batch is still on screen; a batch whose chips all went keeps
    // polling in the background just to release what the Mac still makes ready.
    let counted = true;
    const uncount = () => { if (counted) { counted = false; this.#active--; this.#emit(); } };
    this.#active++;
    try {
      let unreadable = 0;
      const heldSince = this.#deps.now();
      let answer: WorkroomAttachmentItemResult[] | null = null;
      // The receive: answered at once by the Mac (it downloads in the background).
      while (!answer) {
        if (this.#disposed || !chips.some(current)) { void this.#deleteObjects(paths); return; }
        const context = this.#deps.context();
        if (!context) { for (const chip of chips) if (current(chip)) this.#fail(chip, REMOTE_ATTACH_LOGIN_REQUIRED); void this.#deleteObjects(paths); return; }
        try {
          const result = await context.send({ operation: 'workspace', requestId: this.#deps.randomUuid(), targetId,
            workspace: { action: 'attachments.receive', attachments: receive } });
          answer = this.#items(result, receive.receiveId, receive.items.length);
        } catch (error) {
          const code = errorCode(error);
          if (code === HELD || NETWORK_WAIT.has(code)) {
            if (this.#deps.now() - heldSince > HELD_DEADLINE_MS) { this.#failBatch(chips, current, '연결이 오래 끊겨 첨부를 전달하지 못했습니다. 다시 시도하세요.'); void this.#deleteObjects(paths); return; }
            this.#markWaiting(chips, current, code === HELD ? 'held' : 'waiting');
            await this.#wake();
            this.#markWaiting(chips, current, 'receiving');
            continue;
          }
          const mac = MAC_CODE.exec(errorText(error));
          if (!mac && unreadable < UNREADABLE_RETRIES && !(error instanceof RemoteAttachFailure)) {
            unreadable++;
            await this.#deps.sleep(2_000);
            continue;
          }
          this.#failBatch(chips, current, mac ? errorText(error).replace(MAC_CODE, '') : remoteAttachSendMessage(error));
          void this.#deleteObjects(paths);
          return;
        }
      }
      // Then status, until every item is ready or failed. The deadline counts only a FRESH answer: after a wait for the
      // network the next status is asked first, and only what that answer still says pending is failed (review w13).
      const admitted = this.#deps.now();
      let answeredAt = admitted;
      let polls = 0, unreadableStatus = 0;
      for (;;) {
        this.#apply(chips, current, receive, answer, settledPaths, targetId);
        if (answer.every(entry => entry.state !== 'pending')) break;
        if (!chips.some(current)) uncount();
        if (this.#disposed) break;
        if (answeredAt - admitted >= RECEIVE_DEADLINE_MS) {
          if (counted) this.#failPending(chips, current, answer, 'Mac이 제때 받지 못했습니다. 다시 시도하세요.');
          break;
        }
        await this.#deps.sleep(POLL_DELAYS_MS[polls] ?? POLL_LATER_MS);
        polls++;
        if (this.#disposed) break;
        const context = this.#deps.context();
        if (!context) break;
        try {
          const result = await context.send({ operation: 'workspace', requestId: this.#deps.randomUuid(), targetId,
            workspace: { action: 'attachments.status', attachments: { receiveId: receive.receiveId } } });
          answer = this.#items(result, receive.receiveId, receive.items.length);
          answeredAt = this.#deps.now();
          unreadableStatus = 0;
        } catch (error) {
          const code = errorCode(error);
          if (code === HELD || NETWORK_WAIT.has(code)) {
            // Waiting for the network, not failing: the chip says so, and the next fresh answer decides.
            this.#markWaiting(chips, current, code === HELD ? 'held' : 'waiting', answer);
            await this.#wake();
            this.#markWaiting(chips, current, 'receiving', answer);
            continue;
          }
          if (MAC_CODE.test(errorText(error)) || ++unreadableStatus > UNREADABLE_RETRIES) {
            this.#failPending(chips, current, answer, MAC_CODE.test(errorText(error)) ? errorText(error).replace(MAC_CODE, '') : remoteAttachSendMessage(error));
            break;
          }
        }
      }
      // An item still pending (given up) or never answered: its object goes.
      void this.#deleteObjects(paths.filter(path => !settledPaths.has(path)));
    } finally { uncount(); }
  }

  /** Pending items of a batch (or all of it before the receive is answered) wait for the network, or go on. */
  #markWaiting(chips: Chip[], current: (chip: Chip) => boolean, state: RemoteAttachChipState, answer?: WorkroomAttachmentItemResult[]) {
    chips.forEach((chip, index) => { if (current(chip) && (!answer || answer[index]?.state === 'pending') && chip.state !== 'ready' && chip.state !== 'failed') chip.state = state; });
    this.#emit();
  }

  #items(result: MobileWorkspaceResult, receiveId: string, length: number): WorkroomAttachmentItemResult[] {
    const answer = result.workroomAttachments;
    if (!answer || answer.receiveId !== receiveId || answer.items.length !== length) throw new RemoteAttachFailure('Mac의 첨부 응답을 확인하지 못했습니다. 다시 시도하세요.');
    return answer.items;
  }

  #apply(chips: Chip[], current: (chip: Chip) => boolean, receive: WorkroomAttachmentReceive, answer: WorkroomAttachmentItemResult[], settled: Set<string>, targetId: string) {
    const now = this.#deps.now();
    let follow = false;
    answer.forEach((entry, index) => {
      const chip = chips[index]!, path = receive.items[index]!.path;
      if (entry.state === 'pending') return;
      if (!settled.has(path)) {
        settled.add(path);
        // The Mac could not delete the transit object: it is this phone's to delete.
        if (!entry.removed) void this.#deleteObjects([path]);
        // Made ready for a chip that is no longer here: its id is released, never left live on the Mac.
        if (entry.state === 'ready' && !current(chip)) this.#release([entry.id]);
      }
      if (!current(chip) || chip.state === 'ready' || chip.state === 'failed' || chip.rebind) return;
      chip.delivering = false; chip.staged = undefined;
      if (entry.state === 'ready') {
        chip.id = entry.id; chip.lineBytes = entry.lineBytes; chip.expiresAt = now + entry.expiresInMs; chip.error = undefined; chip.boundTarget = targetId;
        if (entry.kind !== chip.kind) chip.kind = entry.kind;
        // The viewed project moved while the Mac was receiving: the id follows it.
        if (targetId !== this.#target) { chip.rebind = true; chip.state = 'receiving'; follow = true; }
        else chip.state = 'ready';
      } else this.#fail(chip, entry.message);
    });
    this.#emit();
    if (follow) void this.#rebindPump();
  }

  /**
   * Moves ready ids to the queue's project, five per call. Idempotent on the Mac, so a held or unanswered call is asked
   * again. An id the Mac no longer has (expired, consumed) sends its kept bytes again instead.
   */
  async #rebindPump(): Promise<void> {
    if (this.#rebinding || this.#disposed) return;
    this.#rebinding = true;
    this.#active++;
    try {
      let unreadable = 0;
      for (;;) {
        if (this.#disposed) return;
        const due = this.#chips.filter(chip => !chip.removed && chip.rebind && chip.id);
        if (!due.length) return;
        const targetId = this.#target, batch = due.slice(0, WORKROOM_ATTACH_RECEIVE_MAX_ITEMS);
        const gens = new Map(batch.map(chip => [chip, chip.gen]));
        const current = (chip: Chip) => !chip.removed && chip.gen === gens.get(chip) && chip.rebind;
        const context = this.#deps.context();
        if (!context) { for (const chip of batch) this.#resend(chip, REMOTE_ATTACH_LOGIN_REQUIRED); this.#emit(); continue; }
        if (!this.#deps.online()) { for (const chip of batch) chip.state = 'waiting'; this.#emit(); await this.#wake(); continue; }
        for (const chip of batch) chip.state = 'receiving';
        this.#emit();
        const request = { receiveId: this.#deps.randomUuid(), ids: batch.map(chip => chip.id!) };
        try {
          const result = await context.send({ operation: 'workspace', requestId: this.#deps.randomUuid(), targetId,
            workspace: { action: 'attachments.rebind', attachments: request } });
          const answer = this.#items(result, request.receiveId, batch.length);
          unreadable = 0;
          const now = this.#deps.now();
          answer.forEach((entry, index) => {
            const chip = batch[index]!;
            if (!current(chip)) return;
            if (entry.state === 'ready' && entry.id === chip.id) {
              chip.boundTarget = targetId; chip.lineBytes = entry.lineBytes; chip.expiresAt = now + entry.expiresInMs;
              // The project moved again meanwhile: another round.
              if (targetId === this.#target) { chip.rebind = false; chip.state = 'ready'; }
            } else this.#resend(chip, entry.state === 'failed' ? entry.message : workroomAttachmentFailureMessage('WORKROOM_ATTACH_NOT_FOUND'));
          });
          this.#emit();
        } catch (error) {
          const code = errorCode(error);
          if (code === HELD || NETWORK_WAIT.has(code)) { for (const chip of batch) if (current(chip)) chip.state = code === HELD ? 'held' : 'waiting'; this.#emit(); await this.#wake(); continue; }
          if (!MAC_CODE.test(errorText(error)) && unreadable < UNREADABLE_RETRIES && !(error instanceof RemoteAttachFailure)) { unreadable++; await this.#deps.sleep(2_000); continue; }
          unreadable = 0;
          for (const chip of batch) if (current(chip)) this.#resend(chip, MAC_CODE.test(errorText(error)) ? errorText(error).replace(MAC_CODE, '') : remoteAttachSendMessage(error));
          this.#emit();
        }
      }
    } finally { this.#rebinding = false; this.#active--; this.#emit(); void this.#pump(); }
  }

  /** The id could not follow: the kept bytes go again for the queue's project (or the chip fails, saying why). */
  #resend(chip: Chip, message: string) {
    if (chip.plain) { this.#restart(chip); void this.#pump(); }
    else this.#fail(chip, message);
  }

  #failBatch(chips: Chip[], current: (chip: Chip) => boolean, message: string) {
    for (const chip of chips) if (current(chip)) { chip.delivering = false; chip.staged = undefined; this.#fail(chip, message); }
    this.#emit();
  }
  #failPending(chips: Chip[], current: (chip: Chip) => boolean, answer: WorkroomAttachmentItemResult[], message: string) {
    answer.forEach((entry, index) => { const chip = chips[index]!; if (entry.state === 'pending' && current(chip) && chip.state !== 'ready' && chip.state !== 'failed' && !chip.rebind) { chip.delivering = false; chip.staged = undefined; this.#fail(chip, message); } });
    this.#emit();
  }

  /** Best effort, five per call: an id that cannot be released expires on the Mac within the hour. */
  #release(ids: string[]) {
    const context = this.#deps.context();
    if (!ids.length || !context || !this.#deps.online()) return;
    for (let at = 0; at < ids.length; at += WORKROOM_ATTACH_RECEIVE_MAX_ITEMS) {
      const chunk = ids.slice(at, at + WORKROOM_ATTACH_RECEIVE_MAX_ITEMS);
      void Promise.resolve().then(() => context.send({ operation: 'workspace', requestId: this.#deps.randomUuid(), targetId: this.#target,
        workspace: { action: 'attachments.release', attachments: { receiveId: this.#deps.randomUuid(), ids: chunk } } })).catch(() => undefined);
    }
  }

  async #deleteObjects(paths: string[]) {
    if (!paths.length) return;
    try { await this.#deps.context()?.supabase?.storage.from(VOC_TRANSIT_BUCKET).remove(paths); } catch { /* the hourly and 24-hour transit sweeps remove leftovers */ }
  }
}

function item(chip: Chip): WorkroomAttachmentReceiveItem {
  const staged = chip.staged!;
  return { path: staged.path, token: staged.token, key: staged.key, sha256: staged.sha256, bytes: staged.bytes, kind: chip.kind,
    ...(chip.kind === 'file' && chip.wireName ? { name: chip.wireName } : {}) };
}

/** Storage failures in this feature's words: it 전달s, it never 올리기s (that word is Supabase Push, docs/ui-glossary.md). */
function transitStorageMessage(raw: unknown): string {
  const message = raw && typeof raw === 'object' && 'message' in raw ? String((raw as { message?: unknown }).message ?? '') : String(raw ?? '');
  if (/bucket not found|not found/i.test(message)) return '사진·파일 전달용 저장소가 아직 준비되지 않았습니다. Supabase에 VOC 사진 저장소 마이그레이션을 적용해야 합니다.';
  if (/row-level security|unauthorized|jwt|403|401/i.test(message)) return '사진·파일을 전달할 권한이 없습니다. 포털에 다시 로그인한 뒤 넣어 주세요.';
  if (/payload too large|exceeded|413/i.test(message)) return '파일 하나는 10MB까지 넣을 수 있습니다.';
  return '사진·파일을 전달하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.';
}

function remoteAttachSendMessage(error: unknown): string {
  const text = errorText(error);
  if (/Mac 앱 업데이트|업데이트하면/.test(text)) return REMOTE_ATTACH_UPDATE_REQUIRED;
  return text && text.length <= 200 ? text : 'Mac에 첨부를 전달하지 못했습니다. 다시 시도하세요.';
}

/**
 * A submission refused at its begin because ids are unknown, expired or of another project (the Mac's own sentences,
 * src/workroomRemoteAttachments.server.ts): the chips that went are no longer ready.
 */
export function remoteAttachIdsRefused(message: string): boolean {
  return /^첨부 \d+개를 찾을 수 없거나 만료되었습니다|^다른 프로젝트용으로 넣은 첨부입니다/.test(message);
}
