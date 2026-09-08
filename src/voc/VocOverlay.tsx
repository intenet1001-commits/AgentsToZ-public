import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Inbox, Loader2, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import { findTargetAt, namedElementsInRect } from '../guide/pickTarget';
import { GUIDE_Z } from '../guide/GuideMode';
import { buildRegionAnchor, buildVocAnchor, describeVocAnchor, type VocAnchor } from '../vocAnchor';
import { buildVocCopyPrompt } from '../vocCopyPrompt';
import { copyAgentsToZPrompt } from '../whatISaidPromptOriginClient';
import { placeVocForm } from './vocFormPlacement';
import type { VocInboxItem } from '../vocFileAccess';
import type { PortalClientError } from '../clientErrorReport';

interface VocOverlayProps {
  onClose: () => void;
  onSubmit: (input: { anchor: VocAnchor; comment: string; sendRemote: boolean }) => Promise<boolean>;
  /** 미처리 개선 요청 목록. 우측 하단 상자가 이것을 센다. */
  onLoadInbox: () => Promise<VocInboxItem[]>;
  onUpdateInboxItem: (file: string, comment: string) => Promise<boolean>;
  onDeleteInboxItem: (file: string) => Promise<boolean>;
  /** 툴바 배지와 같은 로더를 써서 Tauri/웹의 API origin이 갈라지지 않게 한다. */
  onLoadPortalErrors: () => Promise<PortalClientError[]>;
  /** 목록을 실제로 읽은 직후 배지도 같은 건수로 맞춘다. */
  onPortalErrorCountChange?: (count: number) => void;
  /**
   * 열자마자 인박스를 펼칠지.
   *
   * 툴바 배지로 들어온 사용자는 "오류를 보러" 온 것이다. 그 사람에게 닫힌
   * 인박스를 다시 누르게 하면 배지를 만든 이유가 사라진다.
   */
  openInboxOnMount?: boolean;
  tab: string;
  appVersion: string;
  remoteUnlimited: boolean;
}

const BANNER_H = 36;
/** 이 거리 이상 끌어야 영역 선택으로 본다 (손떨림 방지). */
const DRAG_THRESHOLD_PX = 6;
/** 이보다 작은 사각형은 영역으로 치지 않는다. */
const MIN_REGION_PX = 12;

/** 화면 좌표 사각형. DOMRect와 드래그 결과를 같은 모양으로 다룬다. */
interface Box { top: number; left: number; width: number; height: number }

function currentVisualViewport(): { width: number; height: number } {
  return {
    width: window.visualViewport?.width ?? window.innerWidth,
    height: window.visualViewport?.height ?? window.innerHeight,
  };
}

function boxOf(r: DOMRect): Box {
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** 목록 한 줄에 들어갈 만큼만 짧게. 연도는 같은 해가 대부분이라 뺀다. */
function formatVocTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 어느 방향으로 끌든 좌상단 기준 사각형으로 정규화한다. */
function normalizeBox(d: { x0: number; y0: number; x1: number; y1: number }): Box {
  return {
    left: Math.min(d.x0, d.x1),
    top: Math.min(d.y0, d.y1),
    width: Math.abs(d.x1 - d.x0),
    height: Math.abs(d.y1 - d.y0),
  };
}

/**
 * VOC 코멘트 모드 — 화면의 특정 영역을 집어 개선 요청을 남긴다.
 *
 * 가이드 모드와 **대상을 고르는 규칙은 공유**하고(`pickTarget`), 고른 다음이 다르다.
 * 가이드는 설명을 읽히는 것이 목적이라 마우스를 따라다니지만, 여기서는 고른 순간
 * 대상을 **고정**한다:
 *
 *   - 글을 쓰는 동안 커서가 움직여도 대상이 바뀌면 안 된다.
 *   - 고정하면 가이드 모드의 60fps rAF 추적(`isElementVisible` 조상 순회)이 필요 없다.
 *     그래서 이 모드가 가이드 모드보다 **가볍다**.
 *
 * 스크린샷은 담지 않는다 — 한 건에 수백 KB가 붙으면 폴더가 금세 무거워진다.
 */
export function VocOverlay({ onClose, onSubmit, onLoadInbox, onUpdateInboxItem, onDeleteInboxItem, onLoadPortalErrors, onPortalErrorCountChange, openInboxOnMount = false, tab, appVersion, remoteUnlimited }: VocOverlayProps) {
  const [hoverRect, setHoverRect] = useState<Box | null>(null);
  const [picked, setPicked] = useState<{ anchor: VocAnchor; rect: Box } | null>(null);
  /** 드래그 중인 사각형. null이면 드래그 아님. */
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // pointermove → pointerup이 같은 프레임에 이어질 수 있다. React state만 읽으면
  // 마지막 move가 아직 commit되지 않아 빠른 드래그를 클릭으로 오판한다.
  const dragRef = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [comment, setComment] = useState('');
  // 공개 전송은 사용자가 직접 체크한 경우에만 한다. 로컬 저장은 항상 수행된다.
  const [sendRemote, setSendRemote] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [viewport, setViewport] = useState(currentVisualViewport);

  /**
   * 남긴 개선 요청을 **그 자리에서 다시 볼 수 있게** 하는 상자 (VOC 2026-09-01 15:39).
   *
   * 저장하고 나면 어디에도 흔적이 없어서, 무엇을 이미 남겼는지 확인하려면 Finder로
   * 앱 데이터 폴더를 열어야 했다. 세 번째로 같은 요청을 남기는 것을 막는 것이 목적이라
   * 목록은 **미처리(`done/`에 없는) 건만** 센다.
   */
  const [inbox, setInbox] = useState<VocInboxItem[] | null>(null);
  // 휴대폰 포털이 공유 DB에 남긴 오류. 로컬 파일 인박스와 저장소가 달라 별도 상태다.
  const [portalErrors, setPortalErrors] = useState<PortalClientError[] | null>(null);
  const [portalErrorsLoading, setPortalErrorsLoading] = useState(false);
  const [portalErrorsMessage, setPortalErrorsMessage] = useState<string | null>(null);
  const loadPortalErrors = useCallback(async () => {
    setPortalErrorsLoading(true);
    setPortalErrorsMessage(null);
    try {
      const items = await onLoadPortalErrors();
      setPortalErrors(items);
      onPortalErrorCountChange?.(items.length);
    } catch (error) {
      // 읽기 실패를 빈 목록으로 바꾸면 툴바에는 건수가 있는데 들어오면
      // "오류가 없습니다"라고 말하는 모순이 다시 생긴다. 이전 성공 목록은
      // 유지하고, 처음부터 실패했다면 실패 사유만 정확히 보여준다.
      setPortalErrorsMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPortalErrorsLoading(false);
    }
  }, [onLoadPortalErrors, onPortalErrorCountChange]);
  const [inboxOpen, setInboxOpen] = useState(openInboxOnMount);
  // 배지로 들어왔다면 인박스가 이미 열려 있다. 그 사용자는 오류를 보러 온
  // 것이므로 '가져오기'를 한 번 더 누르게 하지 않는다.
  useEffect(() => {
    if (openInboxOnMount) void loadPortalErrors();
  }, [openInboxOnMount, loadPortalErrors]);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [inboxBusy, setInboxBusy] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);

  const refreshInbox = useCallback(async () => {
    try {
      setInbox(await onLoadInbox());
      setInboxError(null);
    } catch (e) {
      // 목록을 못 읽는다고 개선 요청 남기기 자체가 막히면 안 된다 — 부가 기능이다.
      setInbox(current => current ?? []);
      setInboxError(e instanceof Error ? e.message : String(e));
    }
  }, [onLoadInbox]);

  useEffect(() => { void refreshInbox(); }, [refreshInbox]);

  useEffect(() => {
    const refreshViewport = () => setViewport(currentVisualViewport());
    window.addEventListener('resize', refreshViewport);
    window.visualViewport?.addEventListener('resize', refreshViewport);
    return () => {
      window.removeEventListener('resize', refreshViewport);
      window.visualViewport?.removeEventListener('resize', refreshViewport);
    };
  }, []);

  useEffect(() => {
    if (picked) textareaRef.current?.focus();
  }, [picked]);

  /**
   * 배너가 차지한 36px만큼 앱을 밀어 내린다.
   *
   * 없으면 앱 상단이 배너 **아래에 깔려** 헤더 툴바의 버튼에는 코멘트를 남길 수 없다.
   * 실제로 그 상태로 한 번 테스트에 걸렸다 — 가이드 모드는 같은 규칙을 이미 갖고 있었다.
   */
  useEffect(() => {
    document.body.classList.add('voc-mode-active');
    return () => { document.body.classList.remove('voc-mode-active'); };
  }, []);

  /**
   * 포인터로 두 가지를 다 받는다.
   *   - 그냥 클릭 → 커서 아래 **아무 요소나** (버튼이 아니어도 된다)
   *   - 끌기      → 그린 사각형이 곧 대상 (여러 요소·여백을 함께 지정)
   * 임계값을 두는 이유는 손떨림이다. 몇 픽셀 흔들린 클릭이 영역 선택이 되면 안 된다.
   */
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (picked) return;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragRef.current = null;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [picked]);

  const handleMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (picked) return; // 고정된 뒤에는 커서를 따라가지 않는다
    const start = dragStart.current;
    if (start) {
      const far = Math.abs(e.clientX - start.x) >= DRAG_THRESHOLD_PX
        || Math.abs(e.clientY - start.y) >= DRAG_THRESHOLD_PX;
      if (far || dragRef.current) {
        const next = { x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY };
        dragRef.current = next;
        setDrag(next);
        setHoverRect(null);
        return;
      }
    }
    const target = findTargetAt(e.clientX, e.clientY, { allowAny: true });
    setHoverRect(target ? boxOf(target.getBoundingClientRect()) : null);
  }, [picked]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (picked) return;
    const pointerDistanceIsDrag = !!start && (
      Math.abs(e.clientX - start.x) >= DRAG_THRESHOLD_PX
      || Math.abs(e.clientY - start.y) >= DRAG_THRESHOLD_PX
    );
    const completedDrag = dragRef.current
      ?? (start && pointerDistanceIsDrag
        ? { x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY }
        : null);
    dragRef.current = null;
    setDrag(null);
    if (completedDrag) {
      const rect = normalizeBox(completedDrag);
      // 너무 작은 사각형은 잘못 끌린 클릭이다. 그때는 요소 선택으로 처리한다.
      if (rect.width >= MIN_REGION_PX && rect.height >= MIN_REGION_PX) {
        const contains = namedElementsInRect({
          left: rect.left, top: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height,
        });
        setPicked({ anchor: buildRegionAnchor(rect, contains), rect });
        return;
      }
    }
    const x = start?.x ?? e.clientX;
    const y = start?.y ?? e.clientY;
    const target = findTargetAt(x, y, { allowAny: true });
    if (!target) return;
    setPicked({ anchor: buildVocAnchor(target), rect: boxOf(target.getBoundingClientRect()) });
  }, [picked]);

  /** 대상을 다시 고르더라도 이미 쓴 요청은 보존한다. */
  const repick = useCallback(() => {
    setPicked(null);
    setHoverRect(null);
    setDrag(null);
    setCopyState('idle');
    dragRef.current = null;
    dragStart.current = null;
  }, []);

  const reset = useCallback(() => {
    repick();
    setComment('');
    setCopyState('idle');
  }, [repick]);

  const copyPrompt = useCallback(async () => {
    if (!picked || !comment.trim()) return;
    try {
      await copyAgentsToZPrompt(buildVocCopyPrompt({
        anchor: picked.anchor,
        comment,
        tab,
        appVersion,
      }));
      setCopyState('copied');
      window.setTimeout(() => setCopyState(current => current === 'copied' ? 'idle' : current), 2000);
    } catch {
      setCopyState('failed');
    }
  }, [picked, comment, tab, appVersion]);

  const submit = useCallback(async () => {
    if (!picked || !comment.trim() || saving) return;
    setSaving(true);
    const ok = await onSubmit({ anchor: picked.anchor, comment: comment.trim(), sendRemote });
    setSaving(false);
    // 실패하면 쓴 글을 지우지 않는다 — 다시 쓰게 만드는 것이 가장 나쁜 실패다.
    if (ok) {
      reset();
      // 방금 남긴 건이 상자의 숫자에 바로 반영돼야 "저장됐다"가 눈에 보인다.
      void refreshInbox();
    }
  }, [picked, comment, sendRemote, saving, onSubmit, reset, refreshInbox]);

  const startEdit = useCallback((item: VocInboxItem) => {
    setEditingFile(item.file);
    setEditDraft(item.comment);
    setConfirmDeleteFile(null);
  }, []);

  const saveEdit = useCallback(async (file: string) => {
    const next = editDraft.trim();
    if (!next || inboxBusy) return;
    setInboxBusy(file);
    const ok = await onUpdateInboxItem(file, next);
    setInboxBusy(null);
    // 실패하면 편집 상태를 유지한다 — 고쳐 쓴 글을 잃는 것이 가장 나쁜 실패다.
    if (!ok) return;
    setEditingFile(null);
    setInbox(current => (current ?? []).map(item => item.file === file ? { ...item, comment: next } : item));
  }, [editDraft, inboxBusy, onUpdateInboxItem]);

  const removeItem = useCallback(async (file: string) => {
    if (inboxBusy) return;
    setInboxBusy(file);
    const ok = await onDeleteInboxItem(file);
    setInboxBusy(null);
    if (!ok) return;
    setConfirmDeleteFile(null);
    if (editingFile === file) setEditingFile(null);
    setInbox(current => (current ?? []).filter(item => item.file !== file));
  }, [inboxBusy, onDeleteInboxItem, editingFile]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        // 가장 바깥부터 하나씩 닫는다. 목록을 연 채로 Esc가 모드를 통째로 꺼 버리면
        // 방금 읽던 자리를 잃는다.
        if (inboxOpen) setInboxOpen(false);
        else if (picked) repick();
        else onClose();
      }
      // 글 상자 안에서 ⌘/Ctrl+Enter 로 바로 저장
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && picked) {
        e.preventDefault();
        void submit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [picked, repick, onClose, submit, inboxOpen]);

  const rect = picked?.rect ?? (drag ? normalizeBox(drag) : null) ?? hoverRect;
  const formPlacement = picked ? placeVocForm(picked.rect, viewport, BANNER_H) : null;

  return (
    <>
      <div
        data-guide-ui="1"
        data-testid="voc-banner"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: BANNER_H, boxSizing: 'border-box',
          zIndex: GUIDE_Z.banner, background: 'var(--bg-notice)', color:'var(--ink-fde68a)', padding: '8px 14px',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 500,
          borderBottom: '1px solid rgba(251,191,36,0.35)', fontFamily: 'Inter Tight, system-ui, sans-serif',
        }}
      >
        <MessageSquarePlus size={14} style={{ color:'var(--ink-fbbf24)' }} />
        <span style={{ color:'var(--ink-a8a29e)' }}>
          <span style={{ color:'var(--ink-fbbf24)', fontWeight: 600 }}>개선 요청 남기기</span>
          <span style={{ marginLeft: 8 }}>
            {picked
              ? '무엇이 어떻게 되면 좋겠는지 적고 저장하세요 (⌘/Ctrl+Enter) · Esc로 다시 고르기'
              : '개선할 곳을 클릭하거나, 끌어서 영역을 지정하세요. 실제 동작은 일어나지 않아요.'}
          </span>
        </span>
        <span style={{ flex: 1 }} />
        <button
          data-testid="voc-close"
          onClick={onClose}
          style={{
            background: 'transparent', border: '1px solid rgba(251,191,36,0.45)', padding: '3px 10px',
            borderRadius: 5, fontSize: 11.5, fontWeight: 500, cursor: 'pointer', color:'var(--ink-fbbf24)',
            display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit',
          }}
        >
          <X size={11} />
          끄기
        </button>
      </div>

      <div
        data-guide-ui="1"
        onPointerDown={handlePointerDown}
        onPointerMove={handleMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => { if (!picked && !drag) setHoverRect(null); }}
        style={{
          position: 'fixed', top: BANNER_H, left: 0, right: 0, bottom: 0,
          zIndex: GUIDE_Z.overlay, cursor: picked ? 'default' : 'crosshair', background: 'transparent',
        }}
      />

      {rect && (
        <div
          data-guide-ui="1"
          style={{
            position: 'fixed',
            top: rect.top - 3, left: rect.left - 3,
            width: rect.width + 6, height: rect.height + 6,
            border: `1.5px ${drag ? 'dashed' : 'solid'} ${picked ? '#fbbf24' : 'rgba(251,191,36,0.7)'}`,
            background: drag ? 'rgba(251,191,36,0.07)' : 'transparent',
            borderRadius: 7,
            boxShadow: '0 0 0 4px rgba(251,191,36,0.12), 0 4px 14px rgba(251,191,36,0.18)',
            pointerEvents: 'none', zIndex: GUIDE_Z.halo,
          }}
        />
      )}

      {picked && (
        <div
          data-guide-ui="1"
          data-testid="voc-form"
          style={{
            position: 'fixed', top: formPlacement!.top, left: formPlacement!.left, width: formPlacement!.width, zIndex: GUIDE_Z.tooltip,
            background: 'var(--bg-elevated)', border: '1px solid var(--text-faint)', borderRadius: 9, padding: 10,
            maxHeight: formPlacement!.maxHeight, overflowY: 'auto', overscrollBehavior: 'contain', boxSizing: 'border-box',
            boxShadow: 'var(--dialog-shadow)', fontFamily: 'Inter Tight, system-ui, sans-serif',
          }}
        >
          <div data-testid="voc-anchor-label" style={{ fontSize: 10, color:'var(--ink-fbbf24)', fontWeight: 600, marginBottom: 6, wordBreak: 'break-all' }}>
            {describeVocAnchor(picked.anchor)}
          </div>
          {picked.anchor.region && (
            <div data-testid="voc-region-contains" style={{ fontSize: 9.5, color:'var(--text-dim)', marginBottom: 6, lineHeight: 1.5 }}>
              {picked.anchor.region.width}×{picked.anchor.region.height}px
              {picked.anchor.contains?.length
                ? ` · 포함: ${picked.anchor.contains.join(', ')}`
                : ' · 이름 붙은 요소 없음'}
            </div>
          )}
          <textarea
            ref={textareaRef}
            data-testid="voc-comment"
            value={comment}
            onChange={e => { setComment(e.target.value); setCopyState('idle'); }}
            maxLength={4000}
            placeholder="무엇이 불편한지, 어떻게 되면 좋겠는지"
            rows={4}
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '6px 8px',
              background: 'var(--bg-input)', color:'var(--text-primary)', border: '1px solid var(--text-faint)', borderRadius: 6,
              fontSize: 12, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginTop:6}}>
            <label style={{display:'flex',alignItems:'flex-start',gap:6,fontSize:10.5,lineHeight:1.45,color:'var(--text-secondary)',cursor:'pointer'}}>
              <input
                type="checkbox"
                data-testid="voc-send-remote"
                checked={sendRemote}
                onChange={e => setSendRemote(e.target.checked)}
                style={{marginTop:2,accentColor:'#fbbf24'}}
              />
              <span>
                {remoteUnlimited ? '관리자 전송 · 한도 없음' : '개발자에게도 전송'}
                <span style={{display:'block',color:'var(--text-dim)'}}>
                  {remoteUnlimited
                    ? '공식 Supabase 수집 프로젝트의 로컬 관리자 권한이 확인되었습니다.'
                    : '선택 사항 · 내용·앱 버전·선택 위치만 보내며 파일·로그는 보내지 않습니다.'}
                </span>
              </span>
            </label>
            <span data-testid="voc-comment-count" style={{fontSize:9.5,color:comment.length > 3800 ? 'var(--ink-fbbf24)' : 'var(--text-muted)',whiteSpace:'nowrap'}}>
              {comment.length}/4000
            </span>
          </div>
          <div style={{fontSize:9.5,color:'var(--text-dim)',marginTop:6,lineHeight:1.45}}>
            아래 저장 버튼은 항상 이 Mac에 먼저 보관합니다. 복사 버튼은 저장하거나 전송하지 않습니다.
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              data-testid="voc-save"
              onClick={() => void submit()}
              disabled={!comment.trim() || saving}
              style={{
                padding: '4px 12px', borderRadius: 5, fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
                cursor: !comment.trim() || saving ? 'not-allowed' : 'pointer',
                background: !comment.trim() || saving ? 'transparent' : 'rgba(251,191,36,0.16)',
                border: '1px solid', borderColor: !comment.trim() || saving ? 'var(--text-faint)' : 'rgba(251,191,36,0.5)',
                color:!comment.trim() || saving ? 'var(--text-muted)' : 'var(--ink-fbbf24)',
              }}
            >
              {saving ? '저장 중…' : sendRemote ? '저장 및 전송' : '로컬에만 저장'}
            </button>
            <button
              type="button"
              data-testid="voc-copy-prompt"
              onClick={() => void copyPrompt()}
              disabled={!comment.trim()}
              title="선택 위치와 요청을 Claude 또는 Codex에 붙여넣을 작업 프롬프트로 복사"
              style={{
                padding: '4px 10px', borderRadius: 5, fontSize: 11.5, fontFamily: 'inherit',
                background: copyState === 'copied' ? 'rgba(94,234,212,0.12)' : 'transparent',
                border: '1px solid', borderColor: copyState === 'copied' ? 'rgba(94,234,212,0.4)' : 'var(--text-faint)',
                color:!comment.trim() ? 'var(--text-muted)' : copyState === 'failed' ? 'var(--ink-f87171)' : copyState === 'copied' ? 'var(--ink-5eead4)' : 'var(--text-secondary)',
                cursor: !comment.trim() ? 'not-allowed' : 'pointer', display:'flex',alignItems:'center',gap:4,
              }}
            >
              {copyState === 'copied' ? <Check size={11} /> : <Copy size={11} />}
              {copyState === 'copied' ? '복사됨' : copyState === 'failed' ? '복사 실패 · 다시 시도' : 'AI 작업 프롬프트 복사'}
            </button>
            <button
              data-testid="voc-repick"
              onClick={repick}
              style={{
                padding: '4px 10px', borderRadius: 5, fontSize: 11.5, fontFamily: 'inherit',
                background: 'transparent', border: '1px solid var(--text-faint)', color:'var(--text-secondary)', cursor: 'pointer',
              }}
            >
              위치 다시 고르기
            </button>
          </div>
        </div>
      )}

      {/*
        우측 하단에 쌓이는 개선 요청 상자 (VOC 2026-09-01 15:39).

        ⚠️ 이 상자는 선택용 오버레이보다 **위**(GUIDE_Z.tooltip)에 있어야 한다. 같은 층에
        두면 클릭이 오버레이로 내려가 상자를 여는 대신 그 자리에 코멘트를 남기게 된다.
        대신 화면 한 귀퉁이를 가리므로 접었을 때는 칩 하나 크기로만 남는다.
      */}
      <div
        data-guide-ui="1"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: GUIDE_Z.tooltip,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
          fontFamily: 'Inter Tight, system-ui, sans-serif', maxWidth: 'calc(100vw - 32px)',
        }}
      >
        {inboxOpen && (
          <div
            data-testid="voc-inbox-panel"
            style={{
              width: 'min(380px, calc(100vw - 32px))', maxHeight: 'min(58vh, 520px)', overflowY: 'auto',
              overscrollBehavior: 'contain', boxSizing: 'border-box',
              background: 'var(--bg-elevated)', border: '1px solid var(--text-faint)', borderRadius: 9, padding: 10,
              boxShadow: 'var(--dialog-shadow)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color:'var(--ink-fbbf24)' }}>아직 처리되지 않은 개선 요청</span>
              <span style={{ flex: 1 }} />
              <button
                data-testid="voc-inbox-close"
                onClick={() => setInboxOpen(false)}
                aria-label="목록 닫기"
                style={{
                  background: 'transparent', border: '1px solid var(--text-faint)', borderRadius: 5,
                  color:'var(--text-secondary)', cursor: 'pointer', padding: 0, fontFamily: 'inherit',
                  minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <X size={11} />
              </button>
            </div>
            {inboxError && (
              <div data-testid="voc-inbox-error" style={{ fontSize: 10.5, color:'var(--ink-f87171)', marginBottom: 8, lineHeight: 1.5 }}>
                목록을 읽지 못했습니다 · {inboxError}
              </div>
            )}
            {/* 휴대폰 포털에서 보낸 오류. 포털은 이 Mac의 localhost sidecar에 닿을
                수 없어 공유 DB에 남기고, 여기서 되읽는다. 로컬 요청과 출처가 달라
                섞지 않고 따로 보여준다. */}
            <div data-testid="voc-portal-errors" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color:'var(--ink-5eead4)' }}>휴대폰 포털에서 보낸 오류</span>
                <span style={{ flex: 1 }} />
                <button
                  data-testid="voc-portal-errors-refresh"
                  onClick={() => { void loadPortalErrors(); }}
                  disabled={portalErrorsLoading}
                  style={{
                    background: 'transparent', border: '1px solid var(--text-faint)', borderRadius: 5,
                    color:'var(--text-secondary)', cursor: portalErrorsLoading ? 'default' : 'pointer',
                    padding: '4px 8px', fontFamily: 'inherit', fontSize: 10.5,
                  }}
                >
                  {portalErrorsLoading ? '가져오는 중…' : '가져오기'}
                </button>
              </div>
              {portalErrorsMessage && (
                <div style={{ fontSize: 10.5, color:'var(--ink-f87171)', lineHeight: 1.5, marginBottom: 6 }}>
                  {portalErrorsMessage}
                </div>
              )}
              {portalErrors !== null && portalErrors.length === 0 && !portalErrorsMessage && (
                <div style={{ fontSize: 10.5, color:'var(--text-dim)', lineHeight: 1.6 }}>
                  휴대폰에서 보낸 오류가 없습니다.
                </div>
              )}
              {portalErrors?.map(item => (
                <div
                  key={item.id}
                  data-testid="voc-portal-error-item"
                  style={{
                    border: '1px solid var(--text-faint)', borderRadius: 7, padding: 8, marginBottom: 6,
                    background: 'var(--bg-input)',
                  }}
                >
                  <div style={{ fontSize: 10, color:'var(--text-dim)', marginBottom: 3 }}>
                    {new Date(item.created_at).toLocaleString()}
                    {item.device_name ? ` · ${item.device_name}` : ''}
                    {item.surface ? ` · ${item.surface}` : ''}
                  </div>
                  <div style={{ fontSize: 11.5, color:'var(--text-primary)', lineHeight: 1.5 }}>{item.message}</div>
                  <div style={{ fontSize: 10, color:'var(--ink-fbbf24)', fontFamily: 'ui-monospace, Menlo, monospace', marginTop: 3 }}>
                    {item.code}
                  </div>
                  {item.detail && (
                    <div style={{ fontSize: 10, color:'var(--text-secondary)', marginTop: 3, wordBreak: 'break-all' }}>{item.detail}</div>
                  )}
                </div>
              ))}
            </div>
            {inbox === null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color:'var(--text-secondary)', padding: '10px 2px' }}>
                <Loader2 size={12} className="animate-spin" /> 불러오는 중…
              </div>
            )}
            {inbox !== null && inbox.length === 0 && (
              <div data-testid="voc-inbox-empty" style={{ fontSize: 11, color:'var(--text-dim)', lineHeight: 1.6, padding: '6px 2px' }}>
                아직 남긴 개선 요청이 없습니다. 화면에서 개선할 곳을 클릭하거나 끌어서 지정해 보세요.
              </div>
            )}
            {inbox?.map(item => (
              <div
                key={item.file}
                data-testid="voc-inbox-item"
                style={{
                  border: '1px solid var(--border-subtle)', borderRadius: 7, padding: 8, marginBottom: 6,
                  background: 'var(--bg-input)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 9.5, color:'var(--text-dim)', whiteSpace: 'nowrap' }}>{formatVocTime(item.createdAt)}</span>
                  <span style={{ fontSize: 9.5, color:'var(--ink-fbbf24)', wordBreak: 'break-all', minWidth: 0 }}>
                    {item.unreadable ? '읽을 수 없는 파일' : item.anchorLabel || item.file}
                  </span>
                </div>
                {editingFile === item.file ? (
                  <>
                    <textarea
                      data-testid="voc-inbox-edit-input"
                      value={editDraft}
                      onChange={e => setEditDraft(e.target.value)}
                      maxLength={4000}
                      rows={4}
                      style={{
                        width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '6px 8px',
                        background: 'var(--bg-deep)', color:'var(--text-primary)', border: '1px solid var(--text-faint)', borderRadius: 6,
                        fontSize: 12, fontFamily: 'inherit', outline: 'none',
                      }}
                    />
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      <button
                        data-testid="voc-inbox-edit-save"
                        onClick={() => void saveEdit(item.file)}
                        disabled={!editDraft.trim() || inboxBusy === item.file}
                        style={{
                          minHeight: 44, flex: '1 1 96px', padding: '8px 12px', borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
                          background: !editDraft.trim() ? 'transparent' : 'rgba(251,191,36,0.16)',
                          border: '1px solid', borderColor: !editDraft.trim() ? 'var(--text-faint)' : 'rgba(251,191,36,0.5)',
                          color:!editDraft.trim() ? 'var(--text-muted)' : 'var(--ink-fbbf24)',
                          cursor: !editDraft.trim() || inboxBusy === item.file ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {inboxBusy === item.file ? '저장 중…' : '저장'}
                      </button>
                      <button
                        data-testid="voc-inbox-edit-cancel"
                        onClick={() => setEditingFile(null)}
                        style={{
                          minHeight: 44, flex: '1 1 96px', padding: '8px 12px', borderRadius: 5, fontSize: 11, fontFamily: 'inherit',
                          background: 'transparent', border: '1px solid var(--text-faint)', color:'var(--text-secondary)', cursor: 'pointer',
                        }}
                      >
                        취소
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.6, color:'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {item.unreadable
                        ? '이 파일은 내용을 읽을 수 없습니다. 삭제만 할 수 있습니다.'
                        : item.comment}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center' }}>
                      {!item.unreadable && (
                        <button
                          data-testid="voc-inbox-edit"
                          onClick={() => startEdit(item)}
                          style={{
                            minHeight: 44, padding: '8px 10px', borderRadius: 5, fontSize: 10.5, fontFamily: 'inherit',
                            background: 'transparent', border: '1px solid var(--text-faint)', color:'var(--text-secondary)', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          <Pencil size={10} /> 수정
                        </button>
                      )}
                      {confirmDeleteFile === item.file ? (
                        <>
                          <span style={{ fontSize: 10, color:'var(--ink-fca5a5)' }}>지울까요?</span>
                          <button
                            data-testid="voc-inbox-delete-confirm"
                            onClick={() => void removeItem(item.file)}
                            disabled={inboxBusy === item.file}
                            style={{
                              minHeight: 44, padding: '8px 10px', borderRadius: 5, fontSize: 10.5, fontFamily: 'inherit',
                              background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.45)',
                              color:'var(--ink-fca5a5)', cursor: inboxBusy === item.file ? 'not-allowed' : 'pointer',
                            }}
                          >
                            {inboxBusy === item.file ? '삭제 중…' : '삭제'}
                          </button>
                          <button
                            data-testid="voc-inbox-delete-cancel"
                            onClick={() => setConfirmDeleteFile(null)}
                            style={{
                              minHeight: 44, padding: '8px 10px', borderRadius: 5, fontSize: 10.5, fontFamily: 'inherit',
                              background: 'transparent', border: '1px solid var(--text-faint)', color:'var(--text-secondary)', cursor: 'pointer',
                            }}
                          >
                            취소
                          </button>
                        </>
                      ) : (
                        <button
                          data-testid="voc-inbox-delete"
                          onClick={() => setConfirmDeleteFile(item.file)}
                          aria-label="이 개선 요청 삭제"
                          style={{
                            minHeight: 44, padding: '8px 10px', borderRadius: 5, fontSize: 10.5, fontFamily: 'inherit',
                            background: 'transparent', border: '1px solid var(--text-faint)', color:'var(--text-secondary)', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: 4,
                          }}
                        >
                          <Trash2 size={10} /> 삭제
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            <div style={{ fontSize: 9.5, color:'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>
              처리가 끝난 요청은 목록에서 사라집니다. 여기서 지우면 이 Mac에서 영구히 삭제됩니다.
            </div>
          </div>
        )}

        <button
          data-testid="voc-inbox-toggle"
          aria-expanded={inboxOpen}
          onClick={() => setInboxOpen(open => {
            const next = !open;
            // 패널을 열 때 한 번만 가져온다. 매번 자동 조회하면 열고 닫을 때마다
            // 네트워크를 치고, 아예 안 하면 사용자가 '가져오기'를 눌러야 존재를 안다.
            if (next && portalErrors === null && !portalErrorsLoading) void loadPortalErrors();
            return next;
          })}
          title="지금까지 남긴 개선 요청을 보고 수정하거나 지웁니다"
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', gap: 6,
            minHeight: 44, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
            fontSize: 11.5, fontWeight: 600, color:'var(--ink-fbbf24)',
            background: 'var(--bg-notice)', border: '1px solid rgba(251,191,36,0.45)',
            boxShadow: (inbox?.length ?? 0) > 1
              // 쌓여 있다는 것을 형태로 보여준다 — 숫자만으로는 "모아 두는 곳"으로 안 읽힌다.
              ? '3px 3px 0 -1px var(--bg-notice), 3px 3px 0 0 rgba(251,191,36,0.3), 6px 6px 0 -1px var(--bg-notice), 6px 6px 0 0 rgba(251,191,36,0.18), 0 8px 22px rgba(0,0,0,0.5)'
              : '0 8px 22px rgba(0,0,0,0.5)',
          }}
        >
          <Inbox size={12} />
          <span data-testid="voc-inbox-count">개선 요청 {inbox === null ? '…' : inbox.length}</span>
        </button>
      </div>
    </>
  );
}
