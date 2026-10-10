import { isPendingVocFileName } from './vocFileAccess';

/**
 * 「쌓인 VOC」 — 휴대폰이 Mac의 미처리 VOC를 **읽기만** 하는 계약 (브라우저·Bun 공용, node 내장 모듈 금지).
 *
 * VOC는 쌓인다: Mac의 「개선 요청 남기기」는 먼저 저장만 하고, 휴대폰의 사진 공유도 나중에 처리한다.
 * 그래서 휴대폰은 보낸 순간이 아니어도 「지금 쌓인 것」을 보고 워크룸 초안을 채울 수 있어야 한다.
 *
 * 응답은 요약뿐이다: 파일 이름·만든 시각·출처·고칠 내용 첫 줄(짧게)·사진 개수. 첨부의 절대경로와
 * 사진 바이트는 싣지 않는다 — 워크룸의 AI가 Mac에서 `GET /api/voc`로 직접 읽는다. 릴레이 응답 상한
 * (워크스페이스 결과 8,500B) 안에 들도록 항목 수와 바이트를 함께 자른다.
 */

/** Mac이 `voc.inbox` 읽기를 지원하는지 알리는 기능 이름. 없으면 휴대폰은 요청하지 않고 업데이트를 안내한다. */
export const REMOTE_VOC_INBOX_FEATURE = 'voc-inbox-v1';
export const REMOTE_VOC_INBOX_MAX_ITEMS = 12;
export const REMOTE_VOC_INBOX_SUMMARY_MAX = 60;
/** 결과 봉투(kind·action)와 합쳐도 워크스페이스 결과 상한 8,500B 아래에 남도록 잡은 예산. */
export const REMOTE_VOC_INBOX_MAX_BYTES = 7_000;
const MAX_TOTAL = 100_000;

export type RemoteVocInboxSource = 'mac' | 'phone' | 'phone-share' | 'phone-error';
export const REMOTE_VOC_INBOX_SOURCES: readonly RemoteVocInboxSource[] = ['mac', 'phone', 'phone-share', 'phone-error'];

export interface RemoteVocInboxItem {
  file: string;
  createdAt: string;
  source: RemoteVocInboxSource;
  /** 고칠 내용의 첫 줄, 최대 60자. 전체 내용은 Mac의 `GET /api/voc`에 있다. */
  summary: string;
  photos: number;
}

export interface RemoteVocInbox {
  /** 최상위(미처리) VOC 파일 수. 읽을 수 없는 파일도 센다. */
  total: number;
  /** 내용을 읽을 수 없는 파일 수 — 목록에는 싣지 않는다. */
  unreadable: number;
  /** 최신순. `total`보다 적을 수 있다(상한). */
  items: RemoteVocInboxItem[];
}

export function vocInboxSourceKind(source: unknown): RemoteVocInboxSource {
  return source === 'phone' || source === 'phone-share' || source === 'phone-error' ? source : 'mac';
}

export const VOC_INBOX_SOURCE_LABELS: Record<RemoteVocInboxSource, string> = {
  mac: 'Mac',
  phone: '휴대폰',
  'phone-share': '휴대폰 사진 공유',
  'phone-error': '휴대폰 오류',
};

/** 고칠 내용의 첫 줄(비어 있지 않은 줄)을 짧게. 제어문자는 공백으로 바꾼다. */
export function vocInboxSummaryLine(comment: unknown, max = REMOTE_VOC_INBOX_SUMMARY_MAX): string {
  if (typeof comment !== 'string') return '';
  const line = comment.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0) ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : clean;
}

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * 읽어 온 기록(최신순)으로 응답을 만든다. 항목 수와 바이트 예산 중 먼저 닿는 쪽에서 멈춘다.
 * `records`의 각 원소는 `GET /api/voc`와 같은 모양이다(`file` + 기록 필드, 못 읽으면 `unreadable`).
 */
export function buildRemoteVocInbox(records: readonly Record<string, unknown>[]): RemoteVocInbox {
  let unreadable = 0;
  const items: RemoteVocInboxItem[] = [];
  let bytes = byteLength({ total: 0, unreadable: 0, items: [] });
  for (const record of records) {
    const file = typeof record.file === 'string' ? record.file : '';
    if (record.unreadable === true || !isPendingVocFileName(file)) { unreadable += 1; continue; }
    if (items.length >= REMOTE_VOC_INBOX_MAX_ITEMS) continue;
    const createdAt = typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : '';
    const attachments = Array.isArray(record.attachments) ? record.attachments.length : 0;
    const item: RemoteVocInboxItem = {
      file,
      createdAt,
      source: vocInboxSourceKind(record.source),
      summary: vocInboxSummaryLine(record.comment),
      photos: Math.max(0, Math.min(5, attachments)),
    };
    const next = byteLength(item) + 1;
    if (bytes + next > REMOTE_VOC_INBOX_MAX_BYTES) continue;
    bytes += next;
    items.push(item);
  }
  return { total: Math.min(MAX_TOTAL, records.length), unreadable: Math.min(MAX_TOTAL, unreadable), items };
}

/** 휴대폰이 받은 응답의 엄격한 검사. 모르는 키·긴 값·잘못된 모양은 통째로 거절한다. */
export function normalizeRemoteVocInbox(value: unknown): RemoteVocInbox {
  const fail = (): never => { throw new Error('쌓인 VOC 응답 형식이 올바르지 않습니다.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['total', 'unreadable', 'items'].includes(key))) return fail();
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TOTAL;
  if (!count(raw.total) || !count(raw.unreadable) || !Array.isArray(raw.items) || raw.items.length > REMOTE_VOC_INBOX_MAX_ITEMS) return fail();
  const items = raw.items.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return fail();
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !['file', 'createdAt', 'source', 'summary', 'photos'].includes(key))) return fail();
    if (!isPendingVocFileName(item.file)) return fail();
    if (typeof item.createdAt !== 'string' || item.createdAt.length > 40 || (item.createdAt && !Number.isFinite(Date.parse(item.createdAt)))) return fail();
    if (!REMOTE_VOC_INBOX_SOURCES.includes(item.source as RemoteVocInboxSource)) return fail();
    if (typeof item.summary !== 'string' || Array.from(item.summary).length > REMOTE_VOC_INBOX_SUMMARY_MAX) return fail();
    if (!Number.isSafeInteger(item.photos) || (item.photos as number) < 0 || (item.photos as number) > 5) return fail();
    return { file: item.file as string, createdAt: item.createdAt, source: item.source as RemoteVocInboxSource, summary: item.summary, photos: item.photos as number };
  });
  if ((raw.total as number) < items.length) return fail();
  return { total: raw.total as number, unreadable: raw.unreadable as number, items };
}
