/**
 * 「사진 첨부」·「파일 첨부」·「화면 캡처 ▾」 for the Mac Workroom composer, plus paste and drag-and-drop
 * (S3, 2026-10-16 — "맥 직접 또는 원격제어시 사진첨부 파일첨부 버튼이 없다 … 드래그앤드랍 되어야 하고").
 *
 * The panel keeps the attachment list (it clears it when a request is sent); everything about adding to it lives
 * here. Mac only: a phone's composer never mounts this (its files would have to cross the relay first).
 */
import {useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {Camera, ChevronDown, File as FileIcon, Folder, ImagePlus, Paperclip} from 'lucide-react';
import {isWindowsClient} from './clientPlatform';
import {isTauri} from './lib/env';
import {
  WORKROOM_EMPTY_PASTE_MESSAGE, WORKROOM_FILE_MAX_ATTACHMENTS, WORKROOM_PATHLESS_APP_DROP_MESSAGE, WORKROOM_PATHLESS_DROP_MESSAGE,
  addWorkroomAttachments, attachmentKind, attachmentLimitMessage, hasUnsafeAttachmentChars, isWorkroomImageMime, workroomAttachCopy,
} from './workroomAttachmentRules';
import {importWorkroomAttachmentPaths, pickWorkroomAttachmentPaths, saveWorkroomFileBlob, typeWorkroomDroppedPaths} from './workroomAttachmentClient';
import {registerWorkroomDropZone, type WorkroomDropEvent} from './workroomDropRouter';
import {WORKROOM_CAPTURE_LABELS, WORKROOM_CAPTURE_SHORTCUTS, WORKROOM_IMAGE_MAX_ATTACHMENTS, type WorkroomCaptureMode, type WorkroomImageAttachment} from './workroomImageAttachments';
import {captureWorkroomScreen, saveWorkroomImageBlob} from './workroomImageClient';

const LIMITS = {images: WORKROOM_IMAGE_MAX_ATTACHMENTS, files: WORKROOM_FILE_MAX_ATTACHMENTS};
const message = (prefix: string, error: unknown) => `${prefix} ${error instanceof Error ? error.message : String(error)}`;
const leftOut = (total: number, kept: number, verb: string) => total > kept ? [`${total - kept}개는 경로가 없거나 너무 많아 ${verb} 않았습니다.`] : [];

/** The composer's attachment copy for this platform (⌘V/Ctrl+V, 이 Mac/이 PC); AiTerminalPanel reads it too. */
export function workroomComposerAttachCopy() { return workroomAttachCopy(isWindowsClient()); }

export interface WorkroomAttachments {
  capture(mode: WorkroomCaptureMode): Promise<void>;
  paste(event: ReactClipboardEvent<HTMLTextAreaElement>): void;
  /** `ownNames`: a picked or dropped image shows its file name; a pasted one keeps the host's time-based name. */
  addFiles(files: readonly File[], ownNames?: boolean): Promise<void>;
  /** `total` counts everything handed over, including items without a usable path; `pathless` is a drag that carried none. */
  addPaths(paths: readonly string[], total: number, options?: {pathless?: boolean}): Promise<void>;
  remove(path: string): void;
  typePaths(session: {id: string; targetId: string}, paths: readonly string[], total?: number): Promise<void>;
}

/**
 * The adding half. `attachments` is the panel's ref (read at call time, so several adds in a row see each
 * other); `setAttachments` writes both the ref and the state.
 */
export function useWorkroomAttachments(options: {
  enabled: boolean;
  attachments: {current: WorkroomImageAttachment[]};
  setAttachments: (next: WorkroomImageAttachment[]) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setError: (message: string) => void;
  focusComposer: () => void;
}): WorkroomAttachments {
  const live = useRef(options);
  live.current = options;
  const api = useRef<WorkroomAttachments | null>(null);
  if (!api.current) {
    const add = (incoming: WorkroomImageAttachment[]) => {
      const o = live.current;
      const {next, refused} = addWorkroomAttachments(o.attachments.current, incoming, LIMITS);
      o.setAttachments(next);
      return refused;
    };
    const room = (kind: 'image' | 'file') => {
      const count = live.current.attachments.current.filter(item => attachmentKind(item) === kind).length;
      return (kind === 'image' ? LIMITS.images : LIMITS.files) - count;
    };
    const run = async (work: () => Promise<string[]>) => {
      const o = live.current;
      if (!o.enabled) return;
      o.setBusy(true); o.setError('');
      try {
        const notes = await work();
        if (notes.length) live.current.setError(notes.join(' '));
      } finally {
        live.current.setBusy(false);
      }
    };
    api.current = {
      capture: mode => live.current.busy ? Promise.resolve() : run(async () => {
        if (room('image') < 1) return [attachmentLimitMessage(['화면 캡처'], LIMITS)!];
        try {
          const image = await captureWorkroomScreen(mode);
          return image ? add([image]).length ? [attachmentLimitMessage(['화면 캡처'], LIMITS)!] : [] : [];
        } catch (error) { return [message('화면을 캡처하지 못했습니다.', error)]; }
        finally { requestAnimationFrame(() => live.current.focusComposer()); }
      }),
      addFiles: (files, ownNames = true) => run(async () => {
        const notes: string[] = [], refused: string[] = [];
        for (const file of files) {
          const kind = isWorkroomImageMime(file.type) ? 'image' : 'file';
          if (room(kind) < 1) { refused.push(file.name || '이름 없는 항목'); continue; }
          try {
            // A picked or dropped image keeps its own name on the chip (the host names its copy by time).
            const saved = kind === 'image' ? await saveWorkroomImageBlob(file) : await saveWorkroomFileBlob(file);
            const named = kind === 'image' && ownNames && file.name && file.name.length <= 200 && !hasUnsafeAttachmentChars(file.name) ? {...saved, name: file.name} : saved;
            refused.push(...add([named]));
          }
          catch (error) { notes.push(message(kind === 'image' ? '이미지를 넣지 못했습니다.' : '파일을 넣지 못했습니다.', error)); }
        }
        const limit = attachmentLimitMessage(refused, LIMITS);
        live.current.focusComposer();
        return limit ? [...notes, limit] : notes;
      }),
      addPaths: (paths, total, options) => run(async () => {
        if (total < 0) return ['끌어 놓은 파일을 받지 못했습니다. 다시 끌어 놓거나 「파일 첨부」로 고르세요.'];
        if (!paths.length) return total > 0 ? leftOut(total, 0, '넣지') : [options?.pathless ? WORKROOM_PATHLESS_APP_DROP_MESSAGE : WORKROOM_PATHLESS_DROP_MESSAGE];
        const notes: string[] = leftOut(total, paths.length, '넣지');
        try {
          const imported = await importWorkroomAttachmentPaths(paths);
          const limit = attachmentLimitMessage(add(imported.attachments), LIMITS);
          if (limit) notes.push(limit);
          if (imported.refused.length) notes.push(`넣지 못한 항목: ${imported.refused.slice(0, 3).map(item => `${item.name} — ${item.reason}`).join(' / ')}${imported.refused.length > 3 ? ` 외 ${imported.refused.length - 3}개` : ''}`);
        } catch (error) { notes.push(message('첨부하지 못했습니다.', error)); }
        live.current.focusComposer();
        return notes;
      }),
      remove: path => { const o = live.current; o.setAttachments(o.attachments.current.filter(item => item.path !== path)); },
      typePaths: (session, paths, total = paths.length) => run(async () => {
        try { await typeWorkroomDroppedPaths(session.id, session.targetId, paths); return leftOut(total, paths.length, '입력하지'); }
        catch (error) { return [message('경로를 입력하지 않았습니다.', error), ...leftOut(total, paths.length, '입력하지')]; }
      }),
      paste: event => {
        if (!live.current.enabled) return;
        const data = event.clipboardData;
        const files = Array.from(data?.files ?? []);
        const text = data?.getData('text/plain') ?? '';
        if (files.length) {
          // Rich copies (a web page, Notion) carry text and an image: the text still pastes, the files attach.
          // A Finder copy's text is just the file names — do not type those too.
          const names = new Set(files.map(file => file.name));
          if (!text || text.split(/\r?\n/).every(line => !line.trim() || names.has(line.trim()))) event.preventDefault();
          void api.current!.addFiles(files, false);
          return;
        }
        if (text) return;
        event.preventDefault();
        const types = Array.from(data?.types ?? []);
        live.current.setError(types.includes('Files') ? WORKROOM_PATHLESS_DROP_MESSAGE : WORKROOM_EMPTY_PASTE_MESSAGE);
      },
    };
  }
  return api.current;
}

const CAPTURE_MODES: WorkroomCaptureMode[] = ['region', 'window', 'screen'];

/**
 * The buttons, the chips and the drop zone. `panel` is the whole Workroom panel (terminal and composer); while it
 * is registered, a Finder drop on it belongs to this Workroom and to nothing else (src/workroomDropArbiter.ts).
 */
export function WorkroomAttachBar({attach, attachments, busy, disabled, panel, rawInput, session, focusComposer}: {
  attach: WorkroomAttachments;
  attachments: readonly WorkroomImageAttachment[];
  busy: boolean;
  disabled: boolean;
  panel: RefObject<HTMLElement | null>;
  rawInput: boolean;
  session: {id: string; targetId: string} | null;
  /** Where focus goes when the last chip is removed by keyboard. */
  focusComposer?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLSpanElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const copy = workroomComposerAttachCopy();
  const [captureOpen, setCaptureOpen] = useState(false);
  const [dropArea, setDropArea] = useState<'terminal' | 'composer' | null>(null);
  const live = useRef({attach, rawInput, session});
  live.current = {attach, rawInput, session};
  const captureAvailable = !isWindowsClient();

  // App (Tauri): drops arrive with paths through the router, for the main window and pop-outs alike.
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const onEvent = (event: WorkroomDropEvent) => {
      if (event.type === 'leave') { setDropArea(null); return; }
      if (event.type === 'over') { setDropArea(event.area); return; }
      setDropArea(null);
      const {attach: current, rawInput: raw, session: running} = live.current;
      if (event.area === 'terminal' && raw && running && event.paths.length) void current.typePaths(running, event.paths, event.total);
      else void current.addPaths(event.paths, event.total, {pathless: event.pathless});
    };
    return registerWorkroomDropZone(element, onEvent);
  }, [panel]);

  // Web build: the browser hands over File objects without paths, so they are saved by their bytes. In the app the
  // webview's own drop carries no path (Tauri delivers the path above), so it is ignored there.
  useEffect(() => {
    const element = panel.current;
    if (!element || isTauri()) return;
    const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const area = (event: DragEvent) => (event.target instanceof Element && event.target.closest('.ai-terminal-surface') ? 'terminal' : 'composer');
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDropArea(area(event));
    };
    const leave = (event: DragEvent) => { if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) setDropArea(null); };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDropArea(null);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void live.current.attach.addFiles(files);
      else void live.current.attach.addPaths([], 0);
    };
    element.addEventListener('dragenter', over);
    element.addEventListener('dragover', over);
    element.addEventListener('dragleave', leave);
    element.addEventListener('drop', drop);
    return () => {
      element.removeEventListener('dragenter', over);
      element.removeEventListener('dragover', over);
      element.removeEventListener('dragleave', leave);
      element.removeEventListener('drop', drop);
    };
  }, [panel]);

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    if (dropArea) element.dataset.workroomDropActive = 'true'; else delete element.dataset.workroomDropActive;
    return () => { delete element.dataset.workroomDropActive; };
  }, [dropArea, panel]);

  // The capture menu follows the menu pattern: focus moves to the first item when it opens, arrows move between
  // items, and Esc closes it and returns focus to 「화면 캡처」. Esc is taken here, in the capture phase, so the
  // composer under it does not also send ESC to the AI.
  const menuItems = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? []);
  useEffect(() => {
    if (!captureOpen) return;
    requestAnimationFrame(() => menuItems()[0]?.focus());
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation();
        setCaptureOpen(false); trigger.current?.focus();
        return;
      }
      if (!(event.target instanceof Element && event.target.closest('.ai-terminal-capture-menu'))) setCaptureOpen(false);
    };
    // Focus leaving the menu (Tab, Shift+Tab, a click elsewhere) closes it, so it is never open behind the composer.
    const leave = (event: FocusEvent) => { if (!(event.target instanceof Node && menu.current?.parentElement?.contains(event.target))) setCaptureOpen(false); };
    window.addEventListener('keydown', close, true);
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('focusin', leave, true);
    return () => { window.removeEventListener('keydown', close, true); window.removeEventListener('pointerdown', close, true); window.removeEventListener('focusin', leave, true); };
  }, [captureOpen]);
  const menuKeys = (event: ReactKeyboardEvent) => {
    const items = menuItems();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === 'ArrowDown' ? (at + 1) % items.length : event.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    items[to]!.focus();
  };

  const pick = async (kind: 'image' | 'file') => {
    const field = input.current;
    if (!isTauri() && field) { field.accept = kind === 'image' ? 'image/*' : ''; field.click(); return; }
    const picked = await pickWorkroomAttachmentPaths(kind);
    if (picked === null) { if (field) { field.accept = kind === 'image' ? 'image/*' : ''; field.click(); } return; }
    if (picked.paths.length || picked.total) await attach.addPaths(picked.paths, picked.total);
  };

  // Removing a chip by keyboard keeps focus nearby: the next chip's ×, else the previous one, else the composer.
  const removeChip = (path: string, index: number) => {
    const byKeyboard = document.activeElement instanceof HTMLElement && !!chips.current?.contains(document.activeElement);
    attach.remove(path);
    if (!byKeyboard) return;
    requestAnimationFrame(() => {
      const buttons = Array.from(chips.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const next = buttons[Math.min(index, buttons.length - 1)];
      if (next) next.focus(); else focusComposer?.();
    });
  };

  const off = disabled || busy;
  const overlay = dropArea && panel.current ? createPortal(
    <div className="ai-terminal-drop-overlay" data-testid="workroom-drop-overlay" data-drop-area={dropArea} aria-hidden="true">
      <span>{dropArea === 'terminal' && rawInput ? '여기에 놓으면 터미널에 경로를 입력합니다' : '여기에 놓으면 첨부합니다'}</span>
    </div>, panel.current) : null;

  return <div className="ai-terminal-images ai-terminal-attach" data-testid="workroom-images" role="group" aria-label="첨부">
    <button type="button" className="ai-terminal-key" data-testid="workroom-attach-photo" disabled={off} title={copy.photoTitle} onClick={() => void pick('image')}><ImagePlus size={13}/>사진 첨부</button>
    <button type="button" className="ai-terminal-key" data-testid="workroom-attach-file" disabled={off} title={copy.fileTitle} onClick={() => void pick('file')}><Paperclip size={13}/>파일 첨부</button>
    {captureAvailable && <span className="ai-terminal-capture-menu">
      <button ref={trigger} type="button" className="ai-terminal-key" data-testid="workroom-capture-menu" aria-haspopup="menu" aria-expanded={captureOpen} disabled={off} onClick={() => setCaptureOpen(open => !open)}><Camera size={13}/>화면 캡처<ChevronDown size={12}/></button>
      {captureOpen && <span ref={menu} className="ai-terminal-capture-items" role="menu" aria-label="화면 캡처" onKeyDown={menuKeys}>
        {CAPTURE_MODES.map(mode => <button type="button" role="menuitem" key={mode} className="ai-terminal-key" data-testid={`workroom-capture-${mode}`} disabled={off} title={`${WORKROOM_CAPTURE_LABELS[mode]} · 캡처하는 동안 이 앱을 잠시 숨깁니다 · Esc로 취소`} onClick={() => { setCaptureOpen(false); void attach.capture(mode); }}>{WORKROOM_CAPTURE_LABELS[mode]} <kbd>{WORKROOM_CAPTURE_SHORTCUTS[mode].label}</kbd></button>)}
      </span>}
    </span>}
    <span className="ai-terminal-hint">{copy.hint}</span>
    <input ref={input} type="file" multiple hidden data-testid="workroom-attach-input" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (files.length) void attach.addFiles(files); }}/>
    {busy && <span className="ai-terminal-hint" role="status">첨부하는 중…</span>}
    {!!attachments.length && <div ref={chips} className="ai-terminal-image-chips">{attachments.map((item, index) => attachmentKind(item) === 'image'
      ? <span key={item.path} className="ai-terminal-image-chip" data-testid="workroom-image-chip" title={item.path}>{item.thumbnail && <img src={item.thumbnail} alt="" draggable={false}/>}<span>{item.name}</span><button type="button" aria-label={`${item.name} 빼기`} onClick={() => removeChip(item.path, index)}>×</button></span>
      : <span key={item.path} className="ai-terminal-image-chip ai-terminal-file-chip" data-testid="workroom-file-chip" title={item.path}>{item.directory ? <Folder size={14}/> : <FileIcon size={14}/>}<span>{item.name}</span><button type="button" aria-label={`${item.name} 빼기`} onClick={() => removeChip(item.path, index)}>×</button></span>)}</div>}
    {overlay}
  </div>;
}
