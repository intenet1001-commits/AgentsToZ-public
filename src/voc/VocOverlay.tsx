import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, MessageSquarePlus, X } from 'lucide-react';
import { findTargetAt, namedElementsInRect } from '../guide/pickTarget';
import { GUIDE_Z } from '../guide/GuideMode';
import { buildRegionAnchor, buildVocAnchor, describeVocAnchor, type VocAnchor } from '../vocAnchor';
import { buildVocCopyPrompt } from '../vocCopyPrompt';
import { placeVocForm } from './vocFormPlacement';

interface VocOverlayProps {
  onClose: () => void;
  onSubmit: (input: { anchor: VocAnchor; comment: string; sendRemote: boolean }) => Promise<boolean>;
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
export function VocOverlay({ onClose, onSubmit, tab, appVersion, remoteUnlimited }: VocOverlayProps) {
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
      await navigator.clipboard.writeText(buildVocCopyPrompt({
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
    if (ok) reset();
  }, [picked, comment, sendRemote, saving, onSubmit, reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (picked) repick();
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
  }, [picked, repick, onClose, submit]);

  const rect = picked?.rect ?? (drag ? normalizeBox(drag) : null) ?? hoverRect;
  const formPlacement = picked ? placeVocForm(picked.rect, viewport, BANNER_H) : null;

  return (
    <>
      <div
        data-guide-ui="1"
        data-testid="voc-banner"
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: BANNER_H, boxSizing: 'border-box',
          zIndex: GUIDE_Z.banner, background: '#1a1206', color: '#fde68a', padding: '8px 14px',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 500,
          borderBottom: '1px solid rgba(251,191,36,0.35)', fontFamily: 'Inter Tight, system-ui, sans-serif',
        }}
      >
        <MessageSquarePlus size={14} style={{ color: '#fbbf24' }} />
        <span style={{ color: '#a8a29e' }}>
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>개선 요청 남기기</span>
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
            borderRadius: 5, fontSize: 11.5, fontWeight: 500, cursor: 'pointer', color: '#fbbf24',
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
            background: '#18181b', border: '1px solid #3f3f46', borderRadius: 9, padding: 10,
            maxHeight: formPlacement!.maxHeight, overflowY: 'auto', overscrollBehavior: 'contain', boxSizing: 'border-box',
            boxShadow: '0 12px 32px rgba(0,0,0,0.55)', fontFamily: 'Inter Tight, system-ui, sans-serif',
          }}
        >
          <div data-testid="voc-anchor-label" style={{ fontSize: 10, color: '#fbbf24', fontWeight: 600, marginBottom: 6, wordBreak: 'break-all' }}>
            {describeVocAnchor(picked.anchor)}
          </div>
          {picked.anchor.region && (
            <div data-testid="voc-region-contains" style={{ fontSize: 9.5, color: '#71717a', marginBottom: 6, lineHeight: 1.5 }}>
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
              background: '#0d0d0f', color: '#e4e4e7', border: '1px solid #3f3f46', borderRadius: 6,
              fontSize: 12, fontFamily: 'inherit', outline: 'none',
            }}
          />
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:8,marginTop:6}}>
            <label style={{display:'flex',alignItems:'flex-start',gap:6,fontSize:10.5,lineHeight:1.45,color:'#a1a1aa',cursor:'pointer'}}>
              <input
                type="checkbox"
                data-testid="voc-send-remote"
                checked={sendRemote}
                onChange={e => setSendRemote(e.target.checked)}
                style={{marginTop:2,accentColor:'#fbbf24'}}
              />
              <span>
                {remoteUnlimited ? '관리자 전송 · 한도 없음' : '개발자에게도 전송'}
                <span style={{display:'block',color:'#71717a'}}>
                  {remoteUnlimited
                    ? '공식 Supabase 수집 프로젝트의 로컬 관리자 권한이 확인되었습니다.'
                    : '선택 사항 · 내용·앱 버전·선택 위치만 보내며 파일·로그는 보내지 않습니다.'}
                </span>
              </span>
            </label>
            <span data-testid="voc-comment-count" style={{fontSize:9.5,color:comment.length > 3800 ? '#fbbf24' : '#52525b',whiteSpace:'nowrap'}}>
              {comment.length}/4000
            </span>
          </div>
          <div style={{fontSize:9.5,color:'#71717a',marginTop:6,lineHeight:1.45}}>
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
                border: '1px solid', borderColor: !comment.trim() || saving ? '#3f3f46' : 'rgba(251,191,36,0.5)',
                color: !comment.trim() || saving ? '#52525b' : '#fbbf24',
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
                border: '1px solid', borderColor: copyState === 'copied' ? 'rgba(94,234,212,0.4)' : '#3f3f46',
                color: !comment.trim() ? '#52525b' : copyState === 'failed' ? '#f87171' : copyState === 'copied' ? '#5eead4' : '#d4d4d8',
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
                background: 'transparent', border: '1px solid #3f3f46', color: '#a1a1aa', cursor: 'pointer',
              }}
            >
              위치 다시 고르기
            </button>
          </div>
        </div>
      )}
    </>
  );
}
