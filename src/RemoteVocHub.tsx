import { useEffect, useMemo, useRef, useState } from 'react';
import { Images, Inbox, Loader2, MessageSquarePlus, RefreshCw, TerminalSquare, Trash2, X } from 'lucide-react';
import { VOC_INBOX_SOURCE_LABELS, type RemoteVocInbox, type RemoteVocInboxItem } from './vocInboxSummary';
import type { VocShareCapture } from './vocShareCaptureStore';

/**
 * 휴대폰 「VOC」 — 새로 쓰기 · 보내지 않은 캡처 · Mac에 쌓인 VOC를 한 화면에서.
 *
 * VOC는 보낸 순간에만 처리되는 것이 아니다. Mac의 「개선 요청 남기기」와 휴대폰의 사진 공유는 먼저 쌓이고,
 * 나중에 한꺼번에(또는 한 건씩) 워크룸에 넘긴다. 워크룸에는 **초안만** 채운다 — 실행은 사용자가
 * 「선택한 AI로 시작」을 누를 때만이다.
 */

export type RemoteVocInboxState =
  | { kind: 'offline' }
  | { kind: 'update-required' }
  | { kind: 'loading'; previous?: RemoteVocInbox }
  | { kind: 'ready'; inbox: RemoteVocInbox }
  | { kind: 'error'; message: string };

function formatTime(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '시각 모름';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CaptureThumb({ capture }: { capture: VocShareCapture }) {
  const url = useMemo(() => {
    const first = capture.images[0];
    return first ? URL.createObjectURL(new Blob([first.bytes as BlobPart], { type: first.mime })) : null;
  }, [capture]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img src={url} alt="" /> : <Images aria-hidden="true" />;
}

export function RemoteVocHub({
  onClose, onCompose, captures, capturesPersistent, onResumeCapture, onDeleteCapture,
  inbox, onRefreshInbox, onProcessInbox, onProcessInboxItem, canUseWorkroom, focusInbox = false,
}: {
  onClose: () => void;
  onCompose: () => void;
  captures: readonly VocShareCapture[];
  /** false면 이 브라우저에서는 캡처가 페이지를 닫을 때까지만 남는다. */
  capturesPersistent: boolean;
  onResumeCapture: (id: string) => void;
  onDeleteCapture: (id: string) => Promise<void>;
  inbox: RemoteVocInboxState;
  onRefreshInbox: () => void;
  onProcessInbox: () => Promise<void>;
  onProcessInboxItem: (item: RemoteVocInboxItem) => Promise<void>;
  canUseWorkroom: boolean;
  /** 워크룸에서 열었을 때 — 쌓인 VOC 구역부터 보여 준다. */
  focusInbox?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inboxSection = useRef<HTMLElement>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    if (focusInbox) inboxSection.current?.scrollIntoView?.({ block: 'start' });
  }, [focusInbox]);

  const close = () => { dialog.current?.close(); onClose(); };
  const run = async (key: string, task: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : '처리하지 못했습니다.'); } finally { setBusy(null); }
  };

  const ready = inbox.kind === 'ready' ? inbox.inbox : inbox.kind === 'loading' ? inbox.previous ?? null : null;
  const total = ready?.total ?? null;
  const hidden = ready ? Math.max(0, ready.total - ready.unreadable - ready.items.length) : 0;
  const workroomTitle = canUseWorkroom
    ? 'AgentsToZ DEV 워크룸에 처리 요청 초안을 채웁니다. 「선택한 AI로 시작」을 눌러야 실행됩니다.'
    : 'Mac에 연결되어 있어야 워크룸으로 처리할 수 있습니다.';

  return <dialog ref={dialog} className="remote-voc-dialog remote-voc-hub" data-testid="remote-voc-hub" aria-label="VOC"
    onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}>
    <header><h2>VOC</h2><button type="button" aria-label="닫기" disabled={!!busy} onClick={close}><X aria-hidden="true" /></button></header>

    <button type="button" className="remote-voc-hub-new" data-testid="remote-voc-new" disabled={!!busy}
      onClick={() => { dialog.current?.close(); onCompose(); }}><MessageSquarePlus aria-hidden="true" />새 VOC 작성</button>

    {captures.length > 0 && <section className="remote-voc-hub-section" data-testid="remote-voc-captures" aria-label="보내지 않은 캡처">
      <h3>보내지 않은 캡처 <span data-testid="remote-voc-captures-count">{captures.length}개</span></h3>
      <p className="remote-voc-hint">사진 공유로 담았지만 아직 Mac으로 보내지 않은 것입니다. 보내거나 삭제할 때까지 이 휴대폰에 남습니다.{capturesPersistent ? '' : ' 이 브라우저에서는 페이지를 닫으면 사라집니다.'}</p>
      <ul>
        {captures.map(capture => <li key={capture.id} data-testid="remote-voc-capture">
          <span className="remote-voc-hub-thumb"><CaptureThumb capture={capture} /></span>
          <span className="remote-voc-hub-body">
            <small>{formatTime(capture.createdAt)} · 사진 {capture.images.length}장</small>
            <span>{capture.comment.trim() ? capture.comment.trim().split(/\r?\n/)[0] : '고칠 내용 없음'}</span>
          </span>
          <span className="remote-voc-hub-actions">
            {confirmDelete === capture.id ? <>
              <button type="button" className="danger" data-testid="remote-voc-capture-delete-confirm" disabled={!!busy}
                onClick={() => void run('delete:' + capture.id, async () => { await onDeleteCapture(capture.id); setConfirmDelete(null); })}>
                {busy === 'delete:' + capture.id ? <Loader2 className="remote-spin" aria-hidden="true" /> : null}삭제</button>
              <button type="button" data-testid="remote-voc-capture-delete-cancel" disabled={!!busy} onClick={() => setConfirmDelete(null)}>취소</button>
            </> : <>
              <button type="button" className="primary" data-testid="remote-voc-capture-resume" disabled={!!busy}
                onClick={() => { dialog.current?.close(); onResumeCapture(capture.id); }}>이어서 보내기</button>
              <button type="button" data-testid="remote-voc-capture-delete" aria-label="이 캡처 삭제" disabled={!!busy}
                onClick={() => setConfirmDelete(capture.id)}><Trash2 aria-hidden="true" />삭제</button>
            </>}
          </span>
        </li>)}
      </ul>
    </section>}

    <section ref={inboxSection} className="remote-voc-hub-section" data-testid="remote-voc-inbox" aria-label="Mac에 쌓인 VOC">
      <h3><Inbox aria-hidden="true" />Mac에 쌓인 VOC {total !== null && <span data-testid="remote-voc-inbox-count">{total}건</span>}
        {(inbox.kind === 'ready' || inbox.kind === 'error' || inbox.kind === 'loading') && <button type="button" className="remote-voc-hub-refresh" aria-label="쌓인 VOC 새로고침"
          data-testid="remote-voc-inbox-refresh" disabled={inbox.kind === 'loading'} onClick={onRefreshInbox}>
          {inbox.kind === 'loading' ? <Loader2 className="remote-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}</button>}
      </h3>
      {inbox.kind === 'offline' && <p className="remote-voc-hint" data-testid="remote-voc-inbox-offline">Mac에 연결하면 쌓인 VOC를 볼 수 있습니다.</p>}
      {inbox.kind === 'update-required' && <p className="remote-voc-hint" role="status" data-testid="remote-voc-inbox-update">Mac 앱 업데이트 필요 — 연결한 Mac의 AgentsToZ 앱을 업데이트하면 여기서 쌓인 VOC 목록을 볼 수 있습니다. 목록 없이도 아래 버튼으로 전체를 워크룸에 넘길 수 있습니다.</p>}
      {inbox.kind === 'error' && <p className="remote-voc-error" role="alert" data-testid="remote-voc-inbox-error">{inbox.message}</p>}
      {inbox.kind === 'loading' && !ready && <p className="remote-voc-progress" role="status"><Loader2 className="remote-spin" aria-hidden="true" />불러오는 중…</p>}
      {ready && ready.total === 0 && <p className="remote-voc-hint" data-testid="remote-voc-inbox-empty">Mac에 처리되지 않은 VOC가 없습니다.</p>}
      {ready && ready.items.length > 0 && <ul>
        {ready.items.map(item => <li key={item.file} data-testid="remote-voc-inbox-item">
          <span className="remote-voc-hub-body">
            <small>{formatTime(item.createdAt)} · {VOC_INBOX_SOURCE_LABELS[item.source]}{item.photos ? ` · 사진 ${item.photos}장` : ''}</small>
            <span>{item.summary || '(내용 없음)'}</span>
          </span>
          <span className="remote-voc-hub-actions">
            <button type="button" data-testid="remote-voc-inbox-item-workroom" disabled={!!busy || !canUseWorkroom} title={workroomTitle}
              onClick={() => void run('item:' + item.file, () => onProcessInboxItem(item))}>
              {busy === 'item:' + item.file ? <Loader2 className="remote-spin" aria-hidden="true" /> : <TerminalSquare aria-hidden="true" />}이 VOC만 워크룸으로</button>
          </span>
        </li>)}
      </ul>}
      {ready && (hidden > 0 || ready.unreadable > 0) && <p className="remote-voc-hint">
        {hidden > 0 ? `외 ${hidden}건은 Mac에서 확인할 수 있습니다. ` : ''}{ready.unreadable > 0 ? `읽을 수 없는 파일 ${ready.unreadable}개는 Mac의 개선 요청 목록에서 지울 수 있습니다.` : ''}</p>}
      {inbox.kind !== 'offline' && <>
        <button type="button" className="primary remote-voc-hub-process" data-testid="remote-voc-inbox-workroom" disabled={!!busy || !canUseWorkroom} title={workroomTitle}
          onClick={() => void run('all', onProcessInbox)}>
          {busy === 'all' ? <Loader2 className="remote-spin" aria-hidden="true" /> : <TerminalSquare aria-hidden="true" />}쌓인 VOC 워크룸으로 처리</button>
        <p className="remote-voc-hint">AgentsToZ DEV 워크룸에 처리 요청 초안만 채웁니다. 휴대폰에서 보낸 오류 보고도 함께 확인하며, 「선택한 AI로 시작」을 눌러야 실행됩니다.</p>
      </>}
    </section>
    {error && <p className="remote-voc-error" role="alert">{error}</p>}
  </dialog>;
}
