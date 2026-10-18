/**
 * 「사진 첨부」·「파일 첨부」 on the phone portal's Workroom (w13 step B — 「맥직접 또는 원격제어시 사진첨부 파일첨부 버튼이없다 …
 * 드래그앤드랍 되어야하고」). The queue (pick → ready id) is src/remoteWorkroomAttachments.ts; this file is what the person sees:
 *
 *   - the docked composer of the full-screen session view: one 44×44 「+」 left of the text box, a menu above the dock with
 *     two rows — 사진 (`accept="image/*"`; iOS offers 사진 보관함·카메라·파일) and 파일 (no `accept`: every type) — and the chips row;
 *   - the 「새 작업」 sheet: the same two entries as buttons, and the chips;
 *   - an iPad (or any browser) dropping files on the session view or the sheet;
 *   - an older Mac: 「+」 stays, says 「Mac 앱 업데이트 필요」 and opens no file chooser.
 *
 * Only the phone mounts this (`AiTerminalPanel` with `remote`). The Mac's own composer keeps src/WorkroomAttachBar.tsx.
 */
import {useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {File as FileIcon, ImagePlus, Paperclip, Plus, RotateCw, X} from 'lucide-react';
import {
  REMOTE_ATTACH_CHECKING, REMOTE_ATTACH_STATE_LABELS, REMOTE_ATTACH_UPDATE_REQUIRED, RemoteWorkroomAttachments, remoteAttachSummary,
  type RemoteAttachAvailability, type RemoteAttachChip, type RemoteAttachContext,
} from './remoteWorkroomAttachments';
import './RemoteWorkroomAttachBar.css';

export interface RemoteAttachHandle {
  queue: RemoteWorkroomAttachments;
  chips: readonly RemoteAttachChip[];
  availability: RemoteAttachAvailability;
  /** Why the entries are off, in a sentence (empty when they are on). */
  reason: string;
  /**
   * A refusal of the last pick (too large, too many), shown under the chips until the next pick, a written request, the
   * last chip taken out, or its own close button (review w13: it outlived the send).
   */
  notice: string;
  setNotice(text: string): void;
  add(files: readonly File[], kind: 'image' | 'file' | 'auto'): void;
  /** A written request (or launch) carried these chips: they go, and so does the notice under them. */
  settled(keys: readonly string[]): void;
}

function reasonFor(context: RemoteAttachContext | undefined): string {
  if (!context) return '';
  if (context.availability === 'ready') return context.supabase ? '' : '사진·파일을 넣으려면 포털 로그인이 필요합니다.';
  if (context.availability === 'update-required') return REMOTE_ATTACH_UPDATE_REQUIRED;
  if (context.availability === 'checking') return REMOTE_ATTACH_CHECKING;
  return context.reason || '이 화면에서는 첨부할 수 없습니다.';
}

/**
 * One attachment queue for one composer, bound to `targetId` (the session's project, or the sheet's chosen project): on a
 * new project the ready ids follow with a rebind (no new upload or download). Waiting and held work goes on when the phone
 * is `online` again, with a nudge every 3 s meanwhile (the relay controller flushes what it held only on its own poll).
 */
export function useRemoteWorkroomAttachments(context: RemoteAttachContext | undefined, targetId: string): RemoteAttachHandle {
  const contextRef = useRef(context);
  contextRef.current = context;
  const [queue] = useState(() => new RemoteWorkroomAttachments({context: () => contextRef.current, targetId}));
  const subscribe = useCallback((listener: () => void) => queue.subscribe(listener), [queue]);
  const chips = useSyncExternalStore(subscribe, () => queue.snapshot(), () => queue.snapshot());
  const [notice, setNotice] = useState('');
  useEffect(() => { if (targetId) queue.retarget(targetId); }, [queue, targetId]);
  const waiting = chips.some(chip => chip.state === 'waiting' || chip.state === 'held');
  const ready = chips.some(chip => chip.state === 'ready');
  useEffect(() => {
    const onOnline = () => queue.kick();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [queue]);
  // Waiting: nudge every 3 s. Ready: every 30 s, so an id about to expire turns into 「전달 못 함」 before it is sent.
  useEffect(() => {
    if (!waiting && !ready) return;
    const timer = setInterval(() => queue.kick(), waiting ? 3_000 : 30_000);
    return () => clearInterval(timer);
  }, [queue, waiting, ready]);
  // Disposed a turn after unmount: a StrictMode remount keeps the queue (and its chips) as they are.
  const disposal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(disposal.current);
    return () => { disposal.current = setTimeout(() => queue.dispose(), 0); };
  }, [queue]);
  const availability = context?.availability ?? 'unavailable';
  const reason = reasonFor(context);
  const add = useCallback((files: readonly File[], kind: 'image' | 'file' | 'auto') => {
    if (!files.length) return;
    const live = contextRef.current;
    if (!live || live.availability !== 'ready' || !live.supabase) { setNotice(reasonFor(live) || '이 화면에서는 첨부할 수 없습니다.'); return; }
    setNotice(queue.add(files, kind).join(' '));
  }, [queue]);
  const settled = useCallback((keys: readonly string[]) => { queue.removeKeys(keys); setNotice(''); }, [queue]);
  // The last chip went (taken out, or sent): a notice about the picks has nothing left to stand under.
  const hadChips = useRef(false);
  useEffect(() => {
    if (chips.length) hadChips.current = true;
    else if (hadChips.current) { hadChips.current = false; setNotice(''); }
  }, [chips.length]);
  return {queue, chips, availability, reason, notice, setNotice, add, settled};
}

const takeFiles = (event: ChangeEvent<HTMLInputElement>) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; return files; };

/** The two hidden inputs: 사진 with `accept="image/*"` (no `capture`, so iOS offers the library, the camera and Files) and 파일 with none. */
function AttachInputs({attach, photo, file}: {attach: RemoteAttachHandle; photo: RefObject<HTMLInputElement | null>; file: RefObject<HTMLInputElement | null>}) {
  return <>
    <input ref={photo} type="file" accept="image/*" multiple hidden data-testid="workroom-remote-attach-photo-input" onChange={event => attach.add(takeFiles(event), 'image')}/>
    <input ref={file} type="file" multiple hidden data-testid="workroom-remote-attach-file-input" onChange={event => attach.add(takeFiles(event), 'file')}/>
  </>;
}

/**
 * The docked composer's 「+」. The menu opens above the dock, no taller than the room the view leaves it
 * (`--workroom-menu-room`, like the @ menu). Escape (taken in the capture phase, so it never reaches the AI or closes the
 * view) and a tap outside close it; focus goes back to 「+」.
 */
export function RemoteAttachMenuButton({attach, disabled}: {attach: RemoteAttachHandle; disabled?: boolean}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  const off = attach.availability !== 'ready' || !!attach.reason;
  // The count rides on 「+」: with the keyboard up a calm chips row folds away entirely, and this is where it still shows.
  const count = attach.chips.length;
  const label = attach.availability === 'update-required' ? '첨부 · Mac 앱 업데이트 필요'
    : attach.availability === 'checking' ? '첨부 · Mac 기능 확인 중' : off ? '첨부 · 지금은 사용할 수 없음' : count ? `첨부 · ${count}개 넣음` : '첨부';
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? []);
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => (items()[0] ?? menu.current)?.focus());
    const close = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        setOpen(false); trigger.current?.focus();
        return;
      }
      const target = event.target instanceof Node ? event.target : null;
      if (!target || (!menu.current?.contains(target) && !trigger.current?.contains(target))) setOpen(false);
    };
    window.addEventListener('keydown', close, true);
    window.addEventListener('pointerdown', close, true);
    return () => { window.removeEventListener('keydown', close, true); window.removeEventListener('pointerdown', close, true); };
  }, [open]);
  const choose = (input: RefObject<HTMLInputElement | null>) => { setOpen(false); attach.setNotice(''); input.current?.click(); };
  return <span className="ai-terminal-remote-attach">
    <button ref={trigger} type="button" className="ai-terminal-btn ai-terminal-btn--icon ai-terminal-remote-attach-plus" data-testid="workroom-remote-attach"
      data-help-key="workroom-remote-attach" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-disabled={off ? 'true' : undefined}
      disabled={disabled} onClick={() => setOpen(value => !value)}><Plus size={18} aria-hidden="true"/>
      {count > 0 && <span className="ai-terminal-remote-attach-badge" data-testid="workroom-remote-attach-badge" aria-hidden="true">{count}</span>}</button>
    {open && <div ref={menu} className="ai-terminal-remote-attach-menu" role="menu" aria-label="첨부" tabIndex={-1} data-testid="workroom-remote-attach-menu"
      onKeyDown={event => {
        const list = items(); const at = list.indexOf(document.activeElement as HTMLButtonElement);
        const to = event.key === 'ArrowDown' ? (at + 1) % list.length : event.key === 'ArrowUp' ? (at - 1 + list.length) % list.length : -1;
        if (to >= 0 && list.length) { event.preventDefault(); list[to]!.focus(); }
      }}>
      {off && <p className="ai-terminal-hint ai-terminal-remote-attach-reason" role="status">{attach.reason}</p>}
      <button type="button" role="menuitem" data-testid="workroom-remote-attach-photo" disabled={off} onClick={() => choose(photo)}>
        <ImagePlus size={18} aria-hidden="true"/><span>사진 첨부<small>사진 보관함·카메라</small></span></button>
      <button type="button" role="menuitem" data-testid="workroom-remote-attach-file" disabled={off} onClick={() => choose(file)}>
        <Paperclip size={18} aria-hidden="true"/><span>파일 첨부<small>파일 앱 · 모든 형식 · 10MB까지</small></span></button>
    </div>}
    <AttachInputs attach={attach} photo={photo} file={file}/>
  </span>;
}

/** The 「새 작업」 sheet's two entries, as buttons: there is room for them, so no menu. */
export function RemoteAttachSheetButtons({attach, disabled}: {attach: RemoteAttachHandle; disabled?: boolean}) {
  const photo = useRef<HTMLInputElement>(null), file = useRef<HTMLInputElement>(null);
  const off = attach.availability !== 'ready' || !!attach.reason;
  return <div className="ai-terminal-remote-attach-sheet" role="group" aria-label="첨부">
    <button type="button" className="ai-terminal-btn" data-testid="workroom-remote-attach-photo" data-help-key="workroom-remote-attach" disabled={disabled || off}
      onClick={() => { attach.setNotice(''); photo.current?.click(); }}><ImagePlus size={16} aria-hidden="true"/>사진 첨부</button>
    <button type="button" className="ai-terminal-btn" data-testid="workroom-remote-attach-file" disabled={disabled || off}
      onClick={() => { attach.setNotice(''); file.current?.click(); }}><Paperclip size={16} aria-hidden="true"/>파일 첨부</button>
    <span className="ai-terminal-hint ai-terminal-remote-attach-sheet-note">{off ? attach.reason : '사진 보관함·카메라 · 파일 앱(모든 형식, 10MB까지)'}</span>
    <AttachInputs attach={attach} photo={photo} file={file}/>
  </div>;
}

/**
 * The chips: a photo shows its thumbnail, a file its name; a chip that is not ready yet says where it is. A failed chip
 * keeps its reason in the summary line, which says what a send will carry. × removes one; focus moves to the next chip,
 * else to the composer (as on the Mac). In the session view the row never grows past a capped height (it scrolls), and
 * with the keyboard up or in landscape on a phone it folds into one 「첨부 N」 button (chips, summary and reasons inside)
 * and a one-line notice — the terminal and the composer keep the screen (review w13).
 */
export function RemoteAttachChips({attach, focusComposer}: {attach: RemoteAttachHandle; focusComposer?: () => void}) {
  const row = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const {chips, notice, queue} = attach;
  if (!chips.length && !notice) return null;
  const failed = chips.filter(chip => chip.state === 'failed');
  const ready = chips.filter(chip => chip.state === 'ready').length;
  const moving = chips.some(chip => chip.state === 'preparing' || chip.state === 'uploading' || chip.state === 'receiving');
  const removeChip = (key: string, index: number) => {
    const byKeyboard = document.activeElement instanceof HTMLElement && !!row.current?.contains(document.activeElement);
    queue.remove(key);
    if (!byKeyboard) return;
    requestAnimationFrame(() => {
      const buttons = Array.from(row.current?.querySelectorAll<HTMLButtonElement>('.ai-terminal-remote-attach-remove') ?? []);
      const next = buttons[Math.min(index, buttons.length - 1)];
      if (next) next.focus(); else focusComposer?.();
    });
  };
  // Something to act on (a failure, a refusal notice): with the keyboard up the row keeps one line for it; otherwise it folds
  // away entirely while typing and 「+」 carries the count.
  const attention = failed.length > 0 || !!notice;
  return <div ref={row} className="ai-terminal-remote-attach-row" data-testid="workroom-remote-attach-chips" data-expanded={expanded ? 'true' : 'false'} data-attention={attention ? 'true' : 'false'}>
    {!!chips.length && <button type="button" className="ai-terminal-btn ai-terminal-remote-attach-count" data-testid="workroom-remote-attach-count" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>첨부 {chips.length}{failed.length ? ` · ${failed.length}개 못 함` : chips.length > ready ? (moving ? ' · 전달 중' : ' · 연결되면 전달') : ''}</button>}
    {!!chips.length && <div className="ai-terminal-image-chips ai-terminal-remote-attach-chips">{chips.map((chip, index) => {
      const state = REMOTE_ATTACH_STATE_LABELS[chip.state];
      const title = chip.state === 'ready' ? 'Mac에 준비됨 · 보내기를 누르면 요청과 함께 갑니다' : chip.error ?? state;
      return <span key={chip.key} className={`ai-terminal-image-chip${chip.kind === 'file' ? ' ai-terminal-file-chip' : ''}`} data-chip-state={chip.state}
        data-testid={chip.kind === 'image' ? 'workroom-remote-image-chip' : 'workroom-remote-file-chip'} title={title}>
        {chip.thumbnail ? <img src={chip.thumbnail} alt="" draggable={false}/> : <FileIcon size={14} aria-hidden="true"/>}
        <span className="ai-terminal-remote-attach-name">{chip.name}</span>
        {state && <em className="ai-terminal-remote-attach-state" aria-label={`${chip.name} · ${state}`}>{state}</em>}
        {chip.state === 'ready' && <span className="ai-terminal-sr-only">Mac에 준비됨 · 보내기를 누르면 요청과 함께 갑니다</span>}
        {chip.state === 'failed' && chip.retryable && <button type="button" className="ai-terminal-remote-attach-retry" aria-label={`${chip.name} 다시 시도`} onClick={() => queue.retry(chip.key)}><RotateCw size={14} aria-hidden="true"/></button>}
        <button type="button" className="ai-terminal-remote-attach-remove" aria-label={`${chip.name} 빼기`} onClick={() => removeChip(chip.key, index)}>×</button>
      </span>;
    })}</div>}
    {!!failed.length && <div className="ai-terminal-hint ai-terminal-remote-attach-summary" role="status" data-testid="workroom-remote-attach-summary">
      <p>{remoteAttachSummary(chips.length, failed.length, ready)}</p>
      <ul>{failed.slice(0, 3).map(chip => <li key={chip.key}>{chip.name}: {chip.error ?? '전달하지 못했습니다'}</li>)}{failed.length > 3 && <li>외 {failed.length - 3}개</li>}</ul>
      <span className="ai-terminal-remote-attach-summary-actions">
        {failed.some(chip => chip.retryable) && <button type="button" className="ai-terminal-btn" onClick={() => queue.retryFailed()}>다시 시도</button>}
        <button type="button" className="ai-terminal-btn" onClick={() => queue.removeFailed()}>빼기</button>
      </span>
    </div>}
    {notice && <div className="ai-terminal-remote-attach-notice-line"><p className="ai-terminal-hint ai-terminal-remote-attach-notice" role="status" data-testid="workroom-remote-attach-notice" title={notice}>{notice}</p>
      <button type="button" className="ai-terminal-remote-attach-notice-close" data-testid="workroom-remote-attach-notice-close" aria-label="첨부 안내 닫기" onClick={() => attach.setNotice('')}><X size={14} aria-hidden="true"/></button></div>}
  </div>;
}

/**
 * Files dropped on `zone` (an iPad dragging from Files or Photos, a desktop browser): an overlay while a file is over it,
 * images the photo way, everything else as files. Only a drag that carries files; text dragged inside the page passes.
 */
export function useRemoteAttachDrop(zone: RefObject<HTMLElement | null>, attach: RemoteAttachHandle, enabled: boolean): ReactNode {
  const [over, setOver] = useState(false);
  const live = useRef(attach);
  live.current = attach;
  useEffect(() => {
    const element = zone.current;
    if (!element || !enabled) return;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setOver(true);
    };
    const leave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) setOver(false); };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) live.current.add(files, 'auto');
      else live.current.setNotice('끌어 놓은 항목에 파일이 없습니다 — 파일로 저장한 뒤 다시 끌어 놓으세요.');
    };
    element.addEventListener('dragenter', enter);
    element.addEventListener('dragover', enter);
    element.addEventListener('dragleave', leave);
    element.addEventListener('drop', drop);
    return () => {
      element.removeEventListener('dragenter', enter);
      element.removeEventListener('dragover', enter);
      element.removeEventListener('dragleave', leave);
      element.removeEventListener('drop', drop);
      setOver(false);
    };
  }, [zone, enabled]);
  if (!over || !zone.current) return null;
  return createPortal(<div className="ai-terminal-drop-overlay ai-terminal-remote-attach-drop" data-testid="workroom-remote-attach-drop" aria-hidden="true">
    <span>{attach.availability === 'ready' && !attach.reason ? '여기에 놓으면 첨부합니다' : attach.reason}</span>
  </div>, zone.current);
}
