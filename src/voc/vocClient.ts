/**
 * VOC 사이드카 호출 — 메인 창(App)과 워크룸 팝아웃 창이 함께 쓴다.
 *
 * 두 창이 같은 로직을 따로 들고 있으면 전송 결과 문구·오류 처리가 조용히 갈라진다.
 * 화면 알림은 호출자가 넘긴 `notify`로만 낸다(App은 토스트, 팝아웃은 자기 알림 줄).
 */
import { isTauri } from '../lib/env';
import type { PortalClientError } from '../clientErrorReport';
import { describeVocAnchor, normalizeVocAnchor } from '../vocAnchor';
import { normalizeVocInbox, type VocInboxItem } from '../vocFileAccess';
import { buildVocAttachmentPayload, normalizeVocSubmitResponse, type VocAttachment, type VocSubmitResult } from './vocAttachments';

export type VocFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type VocNotifyKind = 'success' | 'error';
export type VocNotify = (message: string, kind: VocNotifyKind) => void;

export interface VocClientOptions {
  notify: VocNotify;
  /** 테스트가 가짜 fetch를 넣는다. */
  fetchImpl?: VocFetch;
  /** API origin. 기본은 앱이면 사이드카(127.0.0.1:3001), 웹이면 같은 origin. */
  apiOrigin?: string;
}

export interface VocSubmitInput {
  anchor: unknown;
  comment: string;
  sendRemote: boolean;
  attachments: VocAttachment[];
}

export function defaultVocApiOrigin(): string {
  return isTauri() ? 'http://127.0.0.1:3001' : '';
}

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

/** 저장 응답의 delivery 상태를 사용자 문구로 바꾼다. */
export function vocDeliveryMessage(delivery: unknown): { message: string; kind: VocNotifyKind } {
  const d = (delivery && typeof delivery === 'object' ? delivery : {}) as Record<string, unknown>;
  switch (d.status) {
    case 'sent':
      return {
        message: d.unlimited === true
          ? '관리자 VOC로 전송했습니다 · 한도 없음'
          : `개선 요청을 전송했습니다 · 오늘 ${d.remaining}회 남음`,
        kind: 'success',
      };
    case 'rate_limited':
      return { message: `로컬에 저장했습니다 · 이 기기의 오늘 전송 한도 ${d.dailyLimit}회를 모두 사용했습니다`, kind: 'success' };
    case 'disabled':
      return { message: '로컬에 저장했습니다 · 현재 개발자 VOC 접수가 일시 중지되어 있습니다', kind: 'success' };
    case 'blocked':
      return { message: '로컬에 저장했습니다 · 이 설치본의 개발자 전송이 제한되어 있습니다', kind: 'error' };
    case 'failed':
      return { message: '로컬에 저장했습니다 · 개발자 전송은 네트워크 문제로 실패했습니다', kind: 'error' };
    default:
      return { message: '개선 요청을 로컬에 저장했습니다', kind: 'success' };
  }
}

export interface VocAccess {
  appBlock: { expiresAt?: string } | null;
  remoteUnlimited: boolean;
}

export function createVocClient({ notify, fetchImpl, apiOrigin }: VocClientOptions) {
  const doFetch: VocFetch = (input, init) => (fetchImpl ?? fetch)(input, init);
  const origin = () => apiOrigin ?? defaultVocApiOrigin();
  const vocUrl = () => `${origin()}/api/voc`;
  const json = async (res: Response) => res.json().catch(() => ({})) as Promise<Record<string, any>>;

  async function submit({ attachments, ...input }: VocSubmitInput, context: { tab: string; appVersion: string }): Promise<VocSubmitResult | false> {
    try {
      const res = await doFetch(vocUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, ...buildVocAttachmentPayload(attachments), tab: context.tab, appVersion: context.appVersion }),
      });
      const data = await json(res);
      if (!res.ok || !data.success) throw new Error(data.error || '저장 실패');
      const { message, kind } = vocDeliveryMessage(data.delivery);
      notify(message, kind);
      return normalizeVocSubmitResponse(data);
    } catch (e) {
      notify(`개선 요청 저장 실패: ${errorText(e)}`, 'error');
      return false;
    }
  }

  /** 미처리 개선 요청 목록(`done/`으로 옮기지 않은 최상위 파일만). */
  async function loadInbox(): Promise<VocInboxItem[]> {
    const res = await doFetch(vocUrl(), { cache: 'no-store' });
    const data = await json(res);
    if (!res.ok) throw new Error(data?.error || '개선 요청 목록을 읽지 못했습니다.');
    return normalizeVocInbox(data, anchor => describeVocAnchor(normalizeVocAnchor(anchor)));
  }

  async function mutate(method: 'PATCH' | 'DELETE', body: Record<string, string>, done: string, failed: string, fallback: string): Promise<boolean> {
    try {
      const res = await doFetch(vocUrl(), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await json(res);
      if (!res.ok || !data.success) throw new Error(data.error || fallback);
      notify(done, 'success');
      return true;
    } catch (e) {
      notify(`${failed}: ${errorText(e)}`, 'error');
      return false;
    }
  }

  const updateInboxItem = (file: string, comment: string) =>
    mutate('PATCH', { file, comment }, '개선 요청을 수정했습니다', '개선 요청 수정 실패', '수정 실패');
  const deleteInboxItem = (file: string) =>
    mutate('DELETE', { file }, '개선 요청을 삭제했습니다', '개선 요청 삭제 실패', '삭제 실패');

  /** 대기 중인(아직 처리되지 않은) 휴대폰 포털 오류. */
  async function loadPortalErrors(): Promise<PortalClientError[]> {
    const res = await doFetch(`${origin()}/api/client-errors`, { cache: 'no-store' });
    const data = await json(res) as { items?: PortalClientError[]; error?: unknown };
    if (!res.ok || data.error) {
      throw new Error(typeof data.error === 'string' && data.error.trim()
        ? data.error
        : `휴대폰 오류를 불러오지 못했습니다. (${res.status})`);
    }
    return (Array.isArray(data.items) ? data.items : []).filter(item => item.resolved !== true);
  }

  /** 앱 차단·관리자 한도 없음 여부. 네트워크 오류나 unverified 응답은 정상 사용자를 잠그지 않는다. */
  async function loadAccess(): Promise<VocAccess> {
    try {
      const res = await doFetch(`${vocUrl()}/access`, { cache: 'no-store' });
      const data = await json(res);
      return {
        appBlock: res.ok && data.blocked === true && data.scope === 'app'
          ? { expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined }
          : null,
        remoteUnlimited: res.ok && data.unlimited === true && data.identity === 'receiver_admin',
      };
    } catch {
      return { appBlock: null, remoteUnlimited: false };
    }
  }

  return { submit, loadInbox, updateInboxItem, deleteInboxItem, loadPortalErrors, loadAccess };
}

export type VocClient = ReturnType<typeof createVocClient>;
