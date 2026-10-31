import {EFFORT_MODE_CHANGED,WORKROOM_EFFORT_MODES,WORKROOM_EFFORT_MODE_LABELS,type WorkroomEffortMode} from './workroomEffortMode';
import React, {useCallback, useEffect, useId, useRef, useState} from 'react';
import type {WorkroomTransport} from './WorkroomSessionFooter';
import {
  workroomEffortAdviceText,
  workroomEffortBadgeText,
  workroomEffortUnsupported,
  type WorkroomEffortSessionView,
  type WorkroomEffortView,
} from './workroomEffortView';

/**
 * 「에포트 자동」 on the Workroom screens (w16 Build B): the shared settings menu (the Mac's main window and pop-outs, the
 * phone's 「새 작업」 sheet), and the receipt beside the model/effort the CLI shows (the session footer — on the phone, inside
 * the full-screen session view). Everything asks the Mac through `workroom.effort` (src/workroomEffortView.ts): nothing is
 * shown before it answers, and an older Mac that refuses the action hides it for good — no retry loop, no error.
 */
export interface WorkroomEffortState {
  /** null: not answered yet; false: this Mac (or the Mac relaying to it) predates the feature. */
  supported: boolean | null;
  auto: boolean | null;
  mode?: WorkroomEffortMode | null;
  session: WorkroomEffortSessionView | null;
  /** The session `session` belongs to — a screen that moved on shows nothing until its own answer arrives. */
  sessionId: string | null;
  busy: boolean;
  error: string;
}
export const WORKROOM_EFFORT_INITIAL: WorkroomEffortState = {supported: null, auto: null, mode: null, session: null, sessionId: null, busy: false, error: ''};

type EffortRequest = (input: {targetId: string; sessionId?: string; set?: boolean; mode?: WorkroomEffortMode; effortModes?: true}) => Promise<WorkroomEffortView>;
interface EffortTarget {targetId: string; sessionId?: string}

/** Negotiate the wider level enum only on a fresh read. Never retry a setting write. */
export function createWorkroomEffortRequest(transport: WorkroomTransport, extended: boolean): EffortRequest {
  let extendedAvailable = extended;
  return async input => {
    const ask = (includeExtended:boolean) => transport({operation: 'workspace', requestId: crypto.randomUUID(), targetId: input.targetId,
      workspace: {action: 'workroom.effort', effortModes: true, ...(includeExtended ? {effortExtended:true as const} : {}), ...(input.mode ? {mode: input.mode} : {}), ...(input.sessionId ? {sessionId: input.sessionId} : {}), ...(input.set !== undefined ? {set: input.set} : {})}});
    let result;
    try {result = await ask(extendedAvailable);}
    catch (error) {
      if (!extendedAvailable || input.set !== undefined || input.mode !== undefined || !workroomEffortUnsupported(error)) throw error;
      extendedAvailable = false; result = await ask(false);
    }
    if (result.action !== 'workroom.effort' || !result.effort) throw new Error('에포트 자동 응답을 확인하지 못했습니다.');
    return result.effort;
  };
}

/**
 * The reader behind the hook, without React: one read at a time (asks that arrive meanwhile fold into one more), an answer for
 * a target it has left keeps only the Mac-wide setting, and a change is sent only after the Mac has answered, once at a time.
 */
export function createWorkroomEffortReader(request: EffortRequest, publish: (state: WorkroomEffortState) => void, options: {readOnly?: boolean} = {}) {
  let state: WorkroomEffortState = {...WORKROOM_EFFORT_INITIAL};
  let target: EffortTarget | null = null, key = '', inFlight = false, again = false, disposed = false, revision = 0;
  const keyOf = (t: EffortTarget | null) => t ? `${t.targetId}\n${t.sessionId ?? ''}` : '';
  const emit = (next: Partial<WorkroomEffortState>) => { if (disposed) return; state = {...state, ...next}; publish(state); };
  const ask = (t: EffortTarget, set?: boolean | WorkroomEffortMode) => request({effortModes: true, targetId: t.targetId, ...(t.sessionId ? {sessionId: t.sessionId} : {}), ...(typeof set === 'boolean' ? {set} : set !== undefined ? {mode: set} : {})});
  const read = async (): Promise<void> => {
    if (disposed || !target || state.supported === false) return;
    if (inFlight || state.busy) { again = true; return; }
    inFlight = true;
    const asked = key, t = target, readRevision = revision;
    try {
      const view = await ask(t);
      if (disposed || readRevision !== revision) return;
      emit(asked === key ? {supported: true, auto: view.auto, mode: view.mode ?? (view.auto ? 'auto' : 'off'), session: view.session ?? null, sessionId: view.session ? t.sessionId ?? null : null} : {supported: true, auto: view.auto, mode: view.mode ?? (view.auto ? 'auto' : 'off')});
    } catch (error) {
      if (disposed || readRevision !== revision) return;
      // A network failure keeps what is shown and is asked again on the next event; only a refusal is final.
      if (workroomEffortUnsupported(error)) emit({supported: false, session: null, sessionId: null});
    } finally {
      inFlight = false;
      if (!disposed && again && !state.busy) { again = false; await read(); }
    }
  };
  const set = async (auto: boolean | WorkroomEffortMode): Promise<void> => {
    if (disposed || options.readOnly || !target || state.supported !== true || state.busy) return;
    const asked = key, t = target;
    revision++;
    emit({busy: true, error: ''});
    try {
      const view = await ask(t, auto);
      emit({auto: view.auto, mode: view.mode ?? (view.auto ? 'auto' : 'off'), ...(asked === key ? {session: view.session ?? null, sessionId: view.session ? t.sessionId ?? null : null} : {})});
    } catch (error) {
      if (workroomEffortUnsupported(error)) emit({supported: false, session: null, sessionId: null});
      else emit({error: error instanceof Error && error.message ? error.message : '에포트 자동 설정을 바꾸지 못했습니다.'});
    } finally {
      emit({busy: false});
      if (!disposed && again && !inFlight) { again = false; await read(); }
    }
  };
  return {
    state: () => state,
    /** A replaced/unmounted panel must never publish an old Mac’s response or drain queued reads. */
    dispose() { disposed = true; again = false; target = null; },
    /** Which project (and session, for its record) to ask through; the setting itself is the Mac's. */
    point(next: EffortTarget | null) {
      if (disposed) return;
      const nextKey = keyOf(next);
      if (nextKey === key) return;
      target = next; key = nextKey;
      if (state.session || state.sessionId) emit({session: null, sessionId: null});
    },
    read, set,
  };
}

/** One per panel and Mac (a new transport — another Mac on the phone — starts over). */
export function useWorkroomEffort({transport, targetId, sessionId, visible, readOnly, extended = false}: {transport: WorkroomTransport; targetId: string | undefined; sessionId: string | undefined; visible: boolean; readOnly: boolean; extended?: boolean}) {
  const [state, setState] = useState<WorkroomEffortState>(WORKROOM_EFFORT_INITIAL);
  const readerRef = useRef<ReturnType<typeof createWorkroomEffortReader> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const visibleRef = useRef(visible); visibleRef.current = visible;
  // The effect owns its reader: replacing a transport (another Mac) or StrictMode's cleanup retires pending replies.
  useEffect(() => {
    const reader = createWorkroomEffortReader(createWorkroomEffortRequest(transport, extended), setState, {readOnly});
    readerRef.current = reader;
    setState(reader.state());
    return () => { reader.dispose(); clearTimeout(timer.current); if (readerRef.current === reader) readerRef.current = null; };
  }, [transport, readOnly, extended]);
  // Asked when the screen shows, the project or session changes, and the window comes back — no timer.
  useEffect(() => {
    const reader = readerRef.current;
    reader?.point(targetId ? {targetId, ...(sessionId ? {sessionId} : {})} : null);
    if (visible && targetId) void reader?.read();
  }, [transport, readOnly, targetId, sessionId, visible]);
  useEffect(() => {
    if (!visible) return;
    const again = () => { if (document.visibilityState !== 'hidden') void readerRef.current?.read(); };
    window.addEventListener('focus', again); window.addEventListener(EFFORT_MODE_CHANGED, again); document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); window.removeEventListener(EFFORT_MODE_CHANGED, again); document.removeEventListener('visibilitychange', again); };
  }, [visible]);
  /** After something the host notices a little later (the CLI's screen, a whole request): ask once, after `delayMs`. */
  const refresh = useCallback((delayMs = 0) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (visibleRef.current) void readerRef.current?.read(); }, delayMs);
  }, []);
  const set = useCallback((auto: boolean | WorkroomEffortMode) => { void readerRef.current?.set(auto).then(() => window.dispatchEvent(new Event(EFFORT_MODE_CHANGED))); }, []);
  return {state, set, refresh};
}

/** The global preference in Workroom settings. Nothing until the host has answered. */
export function WorkroomEffortOption({state, onChange, remote, deviceName, readOnly}: {state: WorkroomEffortState; onChange: (auto: boolean | WorkroomEffortMode) => void; remote: boolean; deviceName?: string; readOnly?: string}) {
  const modeId=useId();
  if (state.supported !== true || state.auto === null) return null;
  const mode = state.mode ?? (state.auto ? 'auto' : 'off');
  if (readOnly) return <p className="ai-terminal-hint" data-testid="workroom-effort-auto-readonly">에포트 {WORKROOM_EFFORT_MODE_LABELS[mode]} — {readOnly}</p>;
  const where = remote ? `${deviceName || '연결한 Mac'}의 프로젝트 워크룸과 연동된 외부 CLI에 공통으로 적용됩니다.` : '이 Mac의 프로젝트 워크룸과 연동된 외부 CLI에 공통으로 적용됩니다. 휴대폰에서 연 작업도 같은 설정을 따릅니다.';
  return <div className="ai-terminal-effort-option">
    <label data-help-key="workroom-effort-auto" htmlFor={modeId}>에포트 조정</label>
    <select id={modeId} aria-label="에포트 조정 모드" data-testid="workroom-effort-mode" value={mode} disabled={state.busy} onChange={event => onChange(event.target.value as WorkroomEffortMode)}>
      {WORKROOM_EFFORT_MODES.map(value => <option key={value} value={value}>{WORKROOM_EFFORT_MODE_LABELS[value]}{value === 'auto' ? ' (기본)' : ''}</option>)}
    </select>
    <p className="ai-terminal-hint">{mode === 'auto' ? '첫 요청과 후속 요청의 난이도에 따라 낮음·보통·높음 중에서 추론 강도를 자동으로 바꿉니다. 응답을 중단하지 않고 입력 가능한 시점에 현재 세션에만 적용합니다.' : mode === 'recommend' ? '요청에 맞는 추론 강도를 추천합니다. 실제 강도는 직접 선택합니다.' : '자동 변경과 추천을 끄고 CLI에서 선택한 강도를 따릅니다.'}</p>
    <p className="ai-terminal-hint">{where} Codex · Claude Code · Hermes에 적용되며, 모델과 계정은 바꾸지 않습니다. 자동 ON은 수동 선택 후에도 다음 요청의 맥락에 따라 다시 조절합니다. 강도를 고정하려면 자동 OFF를 선택하세요.</p>
    {state.error && <p className="ai-terminal-error" role="alert" data-testid="workroom-effort-auto-error">{state.error}</p>}
  </div>;
}

/** The receipt beside the model/effort the CLI shows (the session footer). */
export function WorkroomEffortBadge({session}: {session: WorkroomEffortSessionView | null}) {
  const text = workroomEffortBadgeText(session ?? undefined);
  if (!text || !session) return null;
  const title = session.manual || session.skipped === 'manual'
    ? '직접 선택한 강도입니다. 자동 ON이면 다음 요청에서 맥락에 따라 다시 조절합니다.'
    : '자동선택은 후속 요청마다 난이도를 다시 판단하고 입력 대기 시점에 강도를 바꿉니다. 옆의 「에포트」는 CLI 화면에 표시된 값입니다.';
  return <span className="workroom-effort-badge" data-testid="workroom-effort-badge" data-help-key="workroom-effort-badge" title={title}
    {...(session.level ? {'data-effort-level': session.level} : {})} {...(session.manual ? {'data-effort-manual': 'true'} : {})}>{text}</span>;
}

/** A later whole request seemed to need another level — said under the footer; nothing is typed for the person. */
export function WorkroomEffortAdvice({session}: {session: WorkroomEffortSessionView | null}) {
  const text = workroomEffortAdviceText(session ?? undefined);
  return text ? <p className="workroom-effort-advice" data-testid="workroom-effort-advice" role="status">{text}</p> : null;
}

/** The shared preference lives outside project launch permissions. */
export function WorkroomSettings({children,onOpen}:{children:React.ReactNode;onOpen?:()=>void}) {
  const root=useRef<HTMLDetailsElement>(null),body=useRef<HTMLDivElement>(null);
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open)return;
    const place=()=>{const host=root.current,panel=body.current;if(!host||!panel)return;const box=host.getBoundingClientRect(),width=Math.min(360,window.innerWidth-32),height=Math.min(panel.scrollHeight,window.innerHeight*.7);panel.style.left=Math.max(16,Math.min(box.left,window.innerWidth-width-16))+'px';panel.style.top=Math.max(16,Math.min(box.bottom+6,window.innerHeight-height-16))+'px';};
    const outside=(e:PointerEvent)=>{if(root.current&&!root.current.contains(e.target as Node))root.current.open=false;};
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.isComposing&&e.keyCode!==229&&root.current?.open){e.preventDefault();e.stopPropagation();root.current.open=false;root.current.querySelector('summary')?.focus();}};
    place();document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[open]);
  // Native <details> opens before React's toggle/effect attaches the document listener. Handle a
  // keyboard Escape within the control synchronously, so the parent session does not close first.
  return <details ref={root} className="workroom-settings" data-testid="workroom-settings" onToggle={event=>{setOpen(event.currentTarget.open);if(event.currentTarget.open)onOpen?.();}} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing&&event.keyCode!==229&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary>워크룸 설정</summary><div ref={body} className="workroom-settings-body">{children}</div></details>;
}
