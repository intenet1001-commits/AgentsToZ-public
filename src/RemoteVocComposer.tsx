import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, Loader2, MessageSquareWarning, Send, TerminalSquare, X } from 'lucide-react';
import { VOC_MAX_ATTACHMENTS, VOC_REMOTE_COMMENT_MAX, type RemoteVocError } from './vocAttachments';
import { prepareVocImage, type VocDraftImage } from './remoteVoc';

/**
 * 휴대폰의 「VOC 작성」 — 사진(최대 5장) + 고칠 내용(필수) + 자동 맥락을 한 세트로 보낸다.
 * 진입점(사진 앱 공유, 앱 안 「VOC 보내기」, 모든 오류 옆 버튼)은 전부 이 한 화면으로 모인다.
 */

export interface VocComposerPrefill {
  comment?: string;
  images?: readonly { mime: string; bytes: Uint8Array }[];
  error?: RemoteVocError;
  source: 'phone' | 'phone-share' | 'phone-error';
  screen?: string;
  /** 「보내지 않은 캡처」에서 연 경우 그 캡처 id — 보내면 지우고, 보내지 않고 닫으면 고친 내용을 남긴다. */
  captureId?: string;
}

export type VocComposerMode = 'send' | 'workroom';

export interface VocComposerDraft { comment: string; images: VocDraftImage[]; error?: RemoteVocError; source: VocComposerPrefill['source']; screen?: string }

interface ErrorVocHandlers {
  /** 오류 옆 「VOC 보내기」 — 작성 화면을 오류로 채워 연다. */
  compose(error: RemoteVocError): void;
  /** 오류 옆 「워크룸으로 VOC 처리」 — 오류를 VOC로 남기고 DEV 워크룸 초안을 연다. */
  workroom(error: RemoteVocError): void;
}

const ErrorVocContext = createContext<ErrorVocHandlers | null>(null);

export function ErrorVocProvider({ value, children }: { value: ErrorVocHandlers | null; children: ReactNode }) {
  return <ErrorVocContext.Provider value={value}>{children}</ErrorVocContext.Provider>;
}

/**
 * 오류 문구 바로 옆에 붙는 두 버튼. 휴대폰 원격 화면(provider가 있는 곳)에서만 그려지고,
 * 데스크톱에서는 아무것도 그리지 않는다.
 */
export function ErrorVocActions({ message, code, surface, detail }: { message: string | null | undefined; code?: string | null; surface: string; detail?: string | null }) {
  const handlers = useContext(ErrorVocContext);
  if (!handlers || !message) return null;
  const error: RemoteVocError = { code: code || surface.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_ERROR', message, detail: detail ?? null, surface };
  return <span className="remote-error-voc-actions" data-testid="error-voc-actions">
    <button type="button" data-testid="error-voc-compose" onClick={() => handlers.compose(error)}><MessageSquareWarning aria-hidden="true" />VOC 보내기</button>
    <button type="button" data-testid="error-voc-workroom" onClick={() => handlers.workroom(error)}><TerminalSquare aria-hidden="true" />워크룸으로 VOC 처리</button>
  </span>;
}

let draftImageSeq = 0;

function toDraftImage(bytes: Uint8Array, mime: VocDraftImage['mime']): VocDraftImage {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  return { id: `img-${Date.now().toString(36)}-${(draftImageSeq += 1)}`, previewUrl: url, bytes, mime };
}

export function RemoteVocComposer({ prefill, onClose, onDismiss, onSubmit, canUseWorkroom, photoNotice }: {
  prefill: VocComposerPrefill;
  onClose: () => void;
  /** 보내지 않고 닫을 때(닫기 버튼·Esc) 지금 작성 중인 내용. 보낸 뒤 닫힐 때는 부르지 않는다. */
  onDismiss?: (draft: VocComposerDraft) => void;
  /** 성공하면 resolve. 실패 메시지는 throw한 Error.message를 그대로 보여 준다. */
  onSubmit: (mode: VocComposerMode, draft: VocComposerDraft, progress: (label: string) => void) => Promise<void>;
  canUseWorkroom: boolean;
  /** 사진을 보낼 수 없는 상태의 이유(예: Mac 업데이트 필요). 있으면 사진 추가를 막는다. */
  photoNotice?: string | null;
}) {
  const [comment, setComment] = useState(prefill.comment ?? '');
  const [images, setImages] = useState<VocDraftImage[]>([]);
  const [busy, setBusy] = useState<VocComposerMode | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

  useEffect(() => {
    const initial: VocDraftImage[] = [];
    for (const image of prefill.images ?? []) {
      const mime = image.mime === 'image/png' || image.mime === 'image/webp' ? image.mime : 'image/jpeg';
      if (initial.length < VOC_MAX_ATTACHMENTS) initial.push(toDraftImage(image.bytes, mime));
    }
    setImages(initial);
    const node = dialog.current;
    if (node && !node.open) node.showModal();
    return () => { for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl); };
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const room = VOC_MAX_ATTACHMENTS - imagesRef.current.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > room) setError(`사진은 ${VOC_MAX_ATTACHMENTS}장까지 첨부할 수 있습니다.`);
    for (const file of picked) {
      try {
        const prepared = await prepareVocImage(file);
        setImages(current => current.length >= VOC_MAX_ATTACHMENTS ? current : [...current, toDraftImage(prepared.bytes, prepared.mime)]);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '사진을 읽지 못했습니다.');
      }
    }
  };

  const remove = (id: string) => setImages(current => {
    const target = current.find(image => image.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    return current.filter(image => image.id !== id);
  });

  const submit = async (mode: VocComposerMode) => {
    if (!comment.trim()) { setError('고칠 내용을 입력해 주세요.'); return; }
    setBusy(mode); setError(''); setProgress('');
    try {
      await onSubmit(mode, { comment: comment.trim(), images, error: prefill.error, source: prefill.source, screen: prefill.screen }, setProgress);
      dialog.current?.close();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'VOC를 보내지 못했습니다.');
    } finally {
      setBusy(null); setProgress('');
    }
  };

  const dismiss = () => {
    onDismiss?.({ comment, images: imagesRef.current, error: prefill.error, source: prefill.source, screen: prefill.screen });
    onClose();
  };

  const photosBlocked = !!photoNotice;
  return <dialog ref={dialog} className="remote-voc-dialog" data-testid="remote-voc-composer" aria-label="VOC 작성"
    onCancel={event => { if (busy) event.preventDefault(); else dismiss(); }}>
    <header><h2>VOC 작성</h2><button type="button" aria-label="닫기" data-testid="remote-voc-close" disabled={!!busy} onClick={() => { dialog.current?.close(); dismiss(); }}><X aria-hidden="true" /></button></header>
    {prefill.captureId && <p className="remote-voc-hint" data-testid="remote-voc-capture-note">보내지 않고 닫으면 이 캡처는 「보내지 않은 캡처」에 그대로 남습니다.</p>}
    {prefill.error && <p className="remote-voc-context" data-testid="remote-voc-error-context">오류: {prefill.error.message}{prefill.error.code ? ` (${prefill.error.code})` : ''}</p>}
    <label className="remote-voc-comment"><span className="remote-voc-comment-title">고칠 내용 <small>(필수)</small></span>
      <textarea data-testid="remote-voc-comment" value={comment} maxLength={VOC_REMOTE_COMMENT_MAX} rows={4}
        placeholder="무엇이 불편했고 어떻게 바뀌면 좋을지 적어 주세요." onChange={event => setComment(event.target.value)} disabled={!!busy} />
    </label>
    <div className="remote-voc-photos">
      {images.map(image => <figure key={image.id} data-testid="remote-voc-thumb"><img src={image.previewUrl} alt="첨부한 사진" />
        <button type="button" aria-label="사진 빼기" disabled={!!busy} onClick={() => remove(image.id)}><X aria-hidden="true" /></button></figure>)}
      {images.length < VOC_MAX_ATTACHMENTS && <button type="button" className="remote-voc-add" data-testid="remote-voc-add-photo"
        disabled={!!busy || photosBlocked} onClick={() => fileInput.current?.click()}><ImagePlus aria-hidden="true" />사진 추가</button>}
      <input ref={fileInput} type="file" accept="image/*" multiple hidden data-testid="remote-voc-photo-input"
        onChange={event => { void addFiles(event.target.files); event.target.value = ''; }} />
    </div>
    <p className="remote-voc-hint">사진 {images.length}/{VOC_MAX_ATTACHMENTS} · 사진은 암호화되어 Mac으로 전달되고, Mac이 받으면 전송용 사본은 바로 지워집니다.</p>
    {photoNotice && <p className="remote-voc-hint" role="status">{photoNotice}</p>}
    {progress && <p className="remote-voc-progress" role="status"><Loader2 className="remote-spin" aria-hidden="true" />{progress}</p>}
    {error && <p className="remote-voc-error" role="alert">{error}</p>}
    <footer>
      <button type="button" data-testid="remote-voc-send" disabled={!!busy} onClick={() => void submit('send')}>
        {busy === 'send' ? <Loader2 className="remote-spin" aria-hidden="true" /> : <Send aria-hidden="true" />}보내기</button>
      <button type="button" data-testid="remote-voc-workroom" className="primary" disabled={!!busy || !canUseWorkroom}
        title={canUseWorkroom ? 'VOC를 Mac에 남기고 AgentsToZ DEV 워크룸에 처리 요청 초안을 채웁니다. 「선택한 AI로 시작」을 눌러야 실행됩니다.' : 'Mac에 연결되어 있어야 워크룸으로 처리할 수 있습니다.'}
        onClick={() => void submit('workroom')}>
        {busy === 'workroom' ? <Loader2 className="remote-spin" aria-hidden="true" /> : <TerminalSquare aria-hidden="true" />}워크룸으로 VOC 처리</button>
    </footer>
  </dialog>;
}
