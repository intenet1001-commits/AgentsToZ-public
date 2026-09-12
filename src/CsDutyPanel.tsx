import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { suggestDutyAlias } from './csDutyRouting';
import { CsDutyKnowledgePanel } from './CsDutyKnowledgePanel';
import { terminalLocalRequest } from './aiTerminalClient';
import type { DutyConfig } from './csDuty';
import {DUTY_MODEL_PRESETS,type DutyProvider} from './csDutyModels';
const path = '/api/agent-runtime/cs-duty';
const inputStyle = { width: '100%', padding: 8, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)', color: 'var(--ink)', font: 'inherit' };
const buttonStyle = { padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)', color: 'var(--ink)', cursor: 'pointer', font: 'inherit' };
const blank = (targetId: string, projectName = ''): DutyConfig => ({ targetId, projectAlias: suggestDutyAlias(projectName), revision: 0, profileLabel: '', chatId: '', chatTitle: '', knowledge: '', faqs: [], provider: 'claude', modelId: 'claude-haiku-4-5', autoFaq: true, aiEnabled: false, dailyAiLimit: 10 });
type PanelProps = { targetId: string; projectName: string };
type DutyView = ReturnType<import('./csDuty').CsDuty['status']> & { supported: boolean };
const sameConfig = (a: DutyConfig, b: DutyConfig) => JSON.stringify(a) === JSON.stringify(b);
/** The consent is about this Mac's profile, the target room and whether AI runs — not about
 * every keystroke. Clearing it on unrelated edits, a diagnosis or a background poll made the
 * checkbox appear to tick itself off while the operator was reaching for the ON button. */
const consentFacts = (c: DutyConfig) => [c.profileLabel, c.chatId, c.projectAlias, c.aiEnabled, c.provider, c.modelId].join('\u0000');
const stateLabels: Record<string, string> = { off: 'OFF', starting: '연결 확인 중', on: 'ON · 새 질문 대기', answering: '답변 처리 중', paused: '일시 중지' };
const stateTone: Record<string, { fg: string; bg: string }> = {
    off: { fg: 'var(--ink-2)', bg: 'var(--sunken)' },
    starting: { fg: 'var(--info)', bg: 'var(--info-soft)' },
    on: { fg: 'var(--ok)', bg: 'var(--ok-soft)' },
    answering: { fg: 'var(--ok)', bg: 'var(--ok-soft)' },
    paused: { fg: 'var(--warn)', bg: 'var(--warn-soft)' },
};

export function CsDutyPanel(props: PanelProps) {
    const [open, setOpen] = useState(false);
    const [connection, setConnection] = useState(props.targetId);
    return <section data-testid="cs-duty-project" style={{ marginBottom: 18 }}>
        <button type="button" style={buttonStyle} onClick={() => setOpen(true)}>CS 대직 · 질문 응답 설정</button>
        {open && <CsDutyDialog key={connection} {...props} targetId={connection} projectTargetId={props.targetId} onSwitch={setConnection} onClose={() => setOpen(false)}/>}
    </section>;
}

/** Each opening owns its requests. A response from a closed dialog cannot initialize
 * a new one, and status polling never replaces a locally edited draft. */
function CsDutyDialog({ targetId, projectName, projectTargetId, onSwitch, onClose }: PanelProps & {projectTargetId:string; onSwitch:(id:string)=>void; onClose: () => void }) {
    const [view, setView] = useState<DutyView | null>(null);
    const [draft, setDraftValue] = useState<DutyConfig>(() => blank(targetId, projectName));
    const [addingRoom,setAddingRoom]=useState(false), [newChat,setNewChat]=useState('');
    const [rooms, setRooms] = useState<{ id: string; title: string }[]>([]);
    const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
    const [stopping, setStopping] = useState(false), stopPending = useRef(false);
    const [error, setError] = useState(''), [readError, setReadError] = useState('');
    const [notice, setNotice] = useState(''), [consent, setConsent] = useState(false);
    const [checks, setChecks] = useState<{ id: string; label: string; ok: boolean; detail: string }[] | null>(null);
    const [docs, setDocs] = useState<{ path: string; bytes: number; warning?: string }[] | null>(null);
    const [picked, setPicked] = useState<string[]>([]);
    const [sourceChanges, setSourceChanges] = useState<string | null>(null);
    const [pendingDismiss, setPendingDismiss] = useState<'close' | 'reload' | null>(null);
    const knowledgeRevision = useRef(0);
    const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0);
    const operation = useRef(false), sequence = useRef(0);
    const draftRef = useRef(draft), baseRef = useRef(draft);
    const retryRead = useRef<() => Promise<void>>(async () => {});
    const dismissPrompt = useRef<HTMLDivElement>(null), errorPanel = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
        if (pendingDismiss) {
            dismissPrompt.current?.scrollIntoView({ block: 'nearest' });
            dismissPrompt.current?.querySelector('button')?.focus();
        }
    }, [pendingDismiss]);
    useEffect(() => {
        if (error || readError) errorPanel.current?.focus();
    }, [error, readError]);
    const setDraft = (next: DutyConfig) => {
        if (consentFacts(next) !== consentFacts(draftRef.current)) setConsent(false);
        draftRef.current = next;
        setDraftValue(next);
        setNotice('');
    };
    const acceptStatus = (r: DutyView, replaceDraft = false) => {
        if (knowledgeRevision.current !== (r.knowledge?.revision ?? 0)) setConsent(false);
        knowledgeRevision.current = r.knowledge?.revision ?? 0;
        setView(r);
        setLoaded(true);
        if (replaceDraft || sameConfig(draftRef.current, baseRef.current)) {
            const next = r.config ?? blank(targetId, projectName);
            if (consentFacts(baseRef.current) !== consentFacts(next)) setConsent(false);
            baseRef.current = next;
            const suggested = !next.projectAlias && suggestDutyAlias(projectName) ? { ...next, projectAlias: suggestDutyAlias(projectName) } : next;
            draftRef.current = suggested;
            setDraftValue(suggested);
        }
    };
    useEffect(() => {
        dialog.current?.showModal();
        const gen = ++generation.current;
        let reading = false;
        const read = async () => {
            if (reading || operation.current || stopPending.current) return;
            reading = true;
            const seq = sequence.current;
            try {
                const r = await terminalLocalRequest(path, { operation: 'status', targetId });
                if (generation.current !== gen || sequence.current !== seq) return;
                acceptStatus(r);
                setReadError('');
            } catch (e) {
                if (generation.current === gen && sequence.current === seq)
                    setReadError(e instanceof Error ? e.message : '상태 확인 실패');
            } finally { reading = false; }
        };
        retryRead.current = read;
        void read();
        const timer = setInterval(() => void read(), 5000);
        return () => { generation.current++; clearInterval(timer); };
    }, [targetId]);
    const act = async (body: { operation: string; [key: string]: unknown }, closeAfterSave = false, useApprovedSnapshot = false) => {
        if (operation.current || stopPending.current) return;
        operation.current = true;
        setBusy(true);
        setError('');
        setNotice('');
        const gen = generation.current, seq = ++sequence.current;
        try {
            if (body.operation === 'enable' && view?.knowledge?.snapshotId && !useApprovedSnapshot) {
                const update = await terminalLocalRequest(path, { operation: 'checkKnowledgeUpdates', targetId });
                if (generation.current !== gen || sequence.current !== seq) return;
                if (update.changed.length || update.removed.length) { setSourceChanges(`원본 변경 ${update.changed.length}개 · 삭제 ${update.removed.length}개가 있습니다. 자료를 업데이트하거나 기존 승인 자료로 시작할 수 있습니다.`); return; }
            }
            const r = await terminalLocalRequest(path, body);
            if (body.operation === 'enable') setSourceChanges(null);
            if (generation.current !== gen || sequence.current !== seq) return;
            if (body.operation === 'revealChat') { setConsent(false); setNotice('채팅창을 앞으로 열었습니다. 최신 대화가 보이는지 확인한 뒤 대직을 다시 켜세요.'); }
            if (body.operation === 'createConnection') { onSwitch(r.config.targetId); return; }
            if (body.operation === 'discover') setRooms(r.chats);
            else if (body.operation === 'documents') { setDocs(r.documents); setPicked([]); }
            else if (body.operation === 'documentText') {
                const merged = (draftRef.current.knowledge.trim() ? draftRef.current.knowledge.trim() + '\n\n' : '') + r.text;
                if (new TextEncoder().encode(merged).length > 24000 || merged.length > 12000) throw new Error('안내 자료 한도를 넘습니다. 검색 자료 만들기를 사용하거나 선택을 줄여 주세요.');
                setDraft({ ...draftRef.current, knowledge: merged });
                setNotice('선택한 문서를 안내 자료에 넣었습니다. 내용을 확인하고 저장하세요.');
            }
            else if (body.operation === 'diagnose') setChecks(r.checks);
            else {
                acceptStatus(r, body.operation === 'save' || body.operation === 'status');
                setReadError('');
                if (body.operation === 'save') {
                    setNotice('설정을 저장했습니다. 창을 다시 열거나 앱을 재시작해도 유지됩니다. 대직은 OFF입니다.');
                    setChecks(null);
                    setConsent(false);
                }
            }
            setPendingDismiss(null);
            if (closeAfterSave && body.operation === 'save') onClose();
        } catch (e) {
            if (generation.current === gen && sequence.current === seq)
                setError(e instanceof Error ? e.message : '대직 요청 실패');
        } finally {
            operation.current = false;
            if (generation.current === gen) setBusy(false);
        }
    };
    const dirty = !sameConfig(draft, baseRef.current);
    const disabled = busy || stopping || view?.supported === false;
    const conflict = dirty && draft.revision !== (view?.config?.revision ?? 0);
    const running = ['on', 'starting', 'answering'].includes(view?.state ?? '');
    const saved = view?.config;
    const hollow = !!saved && saved.knowledge.trim().length < 20 && saved.faqs.filter(f => !f.learnedFrom || f.approved).length === 0 && !view?.knowledge?.snapshotId;
    const blockers = [
        !view?.config && '설정 저장',
        dirty && '저장하지 않은 변경사항 저장',
        readError ? '상태 확인 복구' : '',
        draft.aiEnabled && draft.provider !== 'claude' ? (draft.provider === 'codex' ? 'Codex' : 'Antigravity') + ' 대신 Claude 선택' : '',
        !consent && '아래 확인란 체크',
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    const stop = async () => {
        if (stopPending.current) return;
        stopPending.current = true;
        setStopping(true);
        const gen = generation.current, seq = ++sequence.current;
        setConsent(false);
        setError('');
        try {
            const r = await terminalLocalRequest(path, { operation: 'disable', targetId });
            if (generation.current === gen && sequence.current === seq) acceptStatus(r);
        } catch (e) {
            if (generation.current === gen && sequence.current === seq)
                setError(e instanceof Error ? e.message : '대직 중지 실패');
        } finally {
            stopPending.current = false;
            if (generation.current === gen) setStopping(false);
        }
    };
    const close = () => {
        if (operation.current || stopPending.current) return;
        if (!sameConfig(draftRef.current, baseRef.current)) setPendingDismiss('close');
        else onClose();
    };
    const reload = () => {
        if (dirty) setPendingDismiss('reload');
        else void act({ operation: 'status', targetId });
    };
    return createPortal(<dialog ref={dialog} onCancel={e => { e.preventDefault(); close(); }} aria-labelledby="cs-duty-title" data-testid="cs-duty-dialog" style={{ width: 'min(680px, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)', padding: 20, border: '1px solid var(--line)', borderRadius: 14, background: 'var(--surface)', color: 'var(--ink)', overflowY: 'auto' }}>
   <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', position: 'sticky', top: -20, paddingTop: 20, marginTop: -20, zIndex: 2, background: 'var(--surface)', paddingBottom: 8 }}><h2 id="cs-duty-title" style={{ fontSize: 18 }}>CS 대직 · {projectName}</h2><button type="button" style={buttonStyle} disabled={busy || stopping} onClick={close} aria-label="CS 대직 닫기">닫기</button><button type="button" style={{ ...buttonStyle, ...(running ? { borderColor: 'var(--danger)', color: 'var(--danger)', fontWeight: 700 } : {}) }} disabled={stopping || !view?.supported} onClick={() => void stop()}>대직 OFF</button></div>
   {pendingDismiss && <div ref={dismissPrompt} role="alert" data-testid="cs-duty-unsaved" style={{ padding: 12, border: '1px solid var(--accent)', borderRadius: 8 }}>
    <p>아직 저장하지 않은 변경사항이 있습니다.{pendingDismiss === 'reload' ? ' 저장된 설정을 불러오면 현재 입력은 사라집니다.' : ' 저장하고 닫으면 다음에 그대로 이어서 설정할 수 있습니다.'}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
     {pendingDismiss === 'close' ? <>
      <button type="button" style={buttonStyle} disabled={busy || stopping} onClick={() => void act({ operation: 'save', targetId, config: draft }, true)}>저장하고 닫기</button>
      <button type="button" style={buttonStyle} disabled={busy || stopping} onClick={onClose}>저장하지 않고 닫기</button>
     </> : <button type="button" style={buttonStyle} disabled={busy || stopping} onClick={() => void act({ operation: 'status', targetId })}>변경사항 버리고 불러오기</button>}
     <button type="button" style={buttonStyle} disabled={busy || stopping} onClick={() => setPendingDismiss(null)}>계속 편집</button>
    </div>
   </div>}
   <p>이 Mac의 카카오톡에서 <strong>/cs 질문</strong> 또는 <strong>#프로젝트별칭 질문</strong>으로 부르면 답합니다. 파일·명령·서비스 데이터 변경 권한은 없습니다.</p>
   <p role="status" data-testid="cs-duty-state" data-state={view?.state ?? 'unknown'} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '10px 0 6px', padding: '10px 14px', borderRadius: 10, fontSize: 15, fontWeight: 700, color: (stateTone[view?.state ?? ''] ?? stateTone.off)!.fg, background: (stateTone[view?.state ?? ''] ?? stateTone.off)!.bg }}>
    <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }}/>
    {view ? stateLabels[view.state] : '상태 확인 중'}
    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-2)' }}>AI {view?.aiUsed ?? 0}회 / 최근 24시간 · 이번 연결 답변 {view?.replied ?? 0}건</span>
   </p>
   {view?.state === 'on' && <p data-testid="cs-duty-waiting" style={{ fontSize: 12 }}>켤 때 이미 있던 {view.baseline ?? 0}건은 기준점이라 답하지 않습니다. <strong>지금부터 새로 올라오는 <code>/cs 질문</code></strong>에만 답합니다{view.checkedAt ? ' · 마지막 확인 ' + new Date(view.checkedAt).toLocaleTimeString() : ''}.</p>}
   {view?.supported === false && <p role="alert">설치된 macOS 앱에서 사용할 수 있습니다.</p>}
   {(error || readError || view?.error) && <p ref={errorPanel} tabIndex={-1} role="alert" data-testid="cs-duty-error" style={{ color: 'var(--danger)' }}>{error || readError || view?.error}</p>}
   {!loaded && <div><p>저장된 설정을 확인하고 있습니다. 확인이 끝나면 편집할 수 있습니다.</p>{readError && <button type="button" style={buttonStyle} onClick={() => void retryRead.current()}>설정 다시 확인</button>}</div>}
   {loaded && <>
   <div style={{display:'grid',gap:8,padding:12,border:'1px solid var(--line)',borderRadius:8}}>
    <strong>이 프로젝트에 연결된 채팅방</strong>
    <select aria-label="대직 연결 선택" style={inputStyle} disabled={disabled || dirty} value={targetId} onChange={e=>onSwitch(e.target.value)}>
     {(view?.projectConnections?.length ? view.projectConnections : [{targetId,chatTitle:'첫 채팅방 설정',state:'off'}]).map(c=><option key={c.targetId} value={c.targetId}>{c.chatTitle} · {stateLabels[c.state]??c.state}</option>)}
    </select>
    <small>프로젝트 하나를 여러 방에, 한 방을 여러 프로젝트에 연결할 수 있습니다. 자료 승인과 ON/OFF는 연결별로 따로 관리합니다.</small>
    <button type="button" style={buttonStyle} disabled={disabled || dirty || !view?.config || (view?.projectConnections?.length??0)>=8} onClick={()=>{setAddingRoom(true);void act({operation:'discover',targetId});}}>다른 채팅방 추가</button>
    {addingRoom && <div style={{display:'grid',gap:8}}>
     <select aria-label="추가할 채팅방" style={inputStyle} disabled={disabled} value={newChat} onChange={e=>setNewChat(e.target.value)}><option value="">새로 연결할 방 선택</option>{rooms.filter(r=>!view?.projectConnections?.some(c=>c.chatId===r.id)).map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select>
     <small>새 연결은 자료 미공유·대직 OFF로 만들어집니다. 이 방에서 공유할 자료를 선택한 뒤 켜세요.</small>
     <button type="button" style={buttonStyle} disabled={disabled || dirty || !newChat} onClick={()=>void act({operation:'createConnection',targetId:projectTargetId,chatId:newChat,chatTitle:rooms.find(r=>r.id===newChat)?.title})}>선택한 방 연결</button>
     <button type="button" style={buttonStyle} disabled={disabled} onClick={()=>setAddingRoom(false)}>취소</button>
    </div>}
   </div>
   <p data-testid="cs-duty-save-state" aria-live="polite">{dirty ? '저장하지 않은 변경사항이 있습니다.' : view?.config ? '저장된 설정입니다.' : '이 프로젝트에 저장된 설정이 없습니다.'} {notice}</p>
   {conflict && <p role="alert" data-testid="cs-duty-conflict">다른 화면 또는 자동 FAQ로 저장된 설정이 바뀌었습니다. 현재 입력은 보존했습니다. 저장된 설정을 다시 불러온 뒤 수정하세요.</p>}
   <div style={{ display: 'grid', gap: 8, marginBottom: 4 }}>
    <button type="button" data-testid="cs-duty-diagnose" style={buttonStyle} disabled={busy || stopping || view?.supported === false || !view?.config} onClick={() => void act({ operation: 'diagnose', targetId })}>연결 진단 · 어느 단계가 막혔는지 확인</button>
    {!view?.config && <small>저장된 설정이 있어야 진단할 수 있습니다. 먼저 아래에서 저장하세요.</small>}
    <button type="button" style={buttonStyle} disabled={disabled || dirty || !view?.config} onClick={() => void act({ operation: 'revealChat', targetId })}>채팅창 다시 열기</button>
   <small>이 채팅방의 대직을 끄고 카카오톡 창을 앞으로 엽니다. 맨 아래 최신 대화를 확인한 뒤 다시 켜세요. 메시지는 보내지 않습니다.</small>
   {checks && <ul data-testid="cs-duty-checks" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>{checks.map(c => <li key={c.id} data-testid={'cs-duty-check-' + c.id} style={{ color: c.ok ? 'var(--ink)' : 'var(--danger)' }}><strong>{c.ok ? '통과' : '실패'}</strong> · {c.label} — {c.detail}</li>)}</ul>}
   </div>
   <fieldset disabled={disabled} style={{ display: 'grid', gap: 14, border: 0, padding: 0, minWidth: 0 }}>
    <strong style={{ fontSize: 13 }}>1단계 · 설정</strong>
    <label>대직용 카카오톡 프로필 이름<input aria-label="대직용 카카오톡 프로필 이름" style={inputStyle} maxLength={100} value={draft.profileLabel} onChange={e => { setDraft({ ...draft, profileLabel: e.target.value }); setConsent(false); }}/></label>
    <small>이 단말에 로그인한 프로필을 직접 확인해 적으세요. 계정 인증값이 아닙니다. 계정을 바꾸기 전에 대직을 꺼 주세요.</small>
    <div><button type="button" style={buttonStyle} onClick={() => void act({ operation: 'discover', targetId })}>카카오톡 채팅방 목록 확인</button><p style={{ fontSize: 12 }}>카카오톡 창이 열리거나 앞으로 이동할 수 있습니다. 동명 채팅방은 선택할 수 없습니다.</p></div>
    <label>응대할 채팅방<select aria-label="응대할 채팅방" style={inputStyle} value={draft.chatId} onChange={e => { const r = rooms.find(x => x.id === e.target.value); setDraft({ ...draft, chatId: r?.id ?? '', chatTitle: r?.title ?? '' }); setConsent(false); }}><option value="">채팅방 선택</option>{draft.chatId && !rooms.some(r => r.id === draft.chatId) && <option value={draft.chatId}>{draft.chatTitle}</option>}{rooms.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
    {!view?.config?.projectAlias && view?.config && <p role="alert">기존 설정에는 호출 별칭이 없습니다. 아래 별칭을 확인하고 설정 저장을 눌러 주세요.</p>}
    <label>프로젝트 호출 별칭<input aria-label="프로젝트 호출 별칭" style={inputStyle} maxLength={31} placeholder="예: 포털" value={draft.projectAlias ?? ''} onChange={e => setDraft({ ...draft, projectAlias: e.target.value })}/></label>
    <small>한글·영문·숫자·하이픈, 공백 없이 30자까지. 같은 방에서는 서로 다른 별칭을 사용하세요. 예: <code>#{draft.projectAlias?.replace(/^#/, '') || '포털'} 이용 방법 알려줘</code></small>
    <div data-testid="cs-duty-room-projects" style={{ padding: 10, background: 'var(--sunken)', borderRadius: 8 }}>
     <strong>한 채팅방에 여러 프로젝트 연결 가능</strong>
     <p style={{ margin: '6px 0' }}>프로젝트가 하나면 <code>/cs 질문</code>으로 바로 답합니다. 여러 개면 <code>#별칭 질문</code>으로 지정하고, <code>/cs</code>만 부르면 어느 프로젝트인지 묻습니다.</p>
     {!!view?.roomProjects?.length && <small>저장된 채팅방의 연결: {view.roomProjects.map(p => `${p.alias ? '#' + p.alias : '별칭 미설정'} (${stateLabels[p.state] ?? p.state})`).join(' · ')}</small>}
    </div>
    <label>공유를 허용한 안내 자료<textarea aria-label="공유 안내 자료" style={{ ...inputStyle, minHeight: 140 }} maxLength={12000} value={draft.knowledge} onChange={e => setDraft({ ...draft, knowledge: e.target.value })}/></label>
    <small>짧은 안내는 여기에 직접 적으세요. 긴 문서·PDF·장기기억은 2단계에서 검색 자료로 만들면 됩니다. 승인한 검색 자료와 이 안내·FAQ를 함께 사용합니다.</small>
    <div data-testid="cs-duty-documents" style={{ display: 'grid', gap: 8, padding: 12, border: '1px dashed var(--line-2)', borderRadius: 8 }}>
     <button type="button" style={buttonStyle} onClick={() => void act({ operation: 'documents', targetId })}>프로젝트 문서 불러오기</button>
     <small>프로젝트 폴더의 <code>.md</code>·<code>.markdown</code>·<code>.txt</code>·<code>.pdf</code> 문서를 골라 위 자료에 넣습니다. <code>.git</code>·<code>.agent-memory</code>·<code>.claude</code> 같은 숨김 폴더와 설정 파일은 목록에 나오지 않습니다. 넣은 뒤 내용을 확인하고 저장해야 실제로 사용됩니다.</small>
     {docs && (docs.length === 0
      ? <small data-testid="cs-duty-documents-empty">공유할 수 있는 문서를 찾지 못했습니다. 자료를 직접 입력하세요.</small>
      : <>
       <div style={{ display: 'grid', gap: 4, maxHeight: 160, overflowY: 'auto' }}>{docs.map(d => <label key={d.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <input type="checkbox" disabled={!!d.warning} checked={picked.includes(d.path)} onChange={e => setPicked(prev => e.target.checked ? [...prev, d.path] : prev.filter(x => x !== d.path))}/>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.path}</span>
        <span style={{ color: 'var(--ink-3)' }}>{d.warning ?? `${Math.max(1, Math.round(d.bytes / 100) / 10)}KB`}</span>
       </label>)}</div>
       <button type="button" style={buttonStyle} disabled={!picked.length} onClick={() => void act({ operation: 'documentText', targetId, paths: picked })}>선택한 {picked.length}개를 자료에 넣기</button>
      </>)}
    </div>
    <div><strong>FAQ · 같은 질문에는 AI 호출 없이 답변</strong>{draft.faqs.map((f, i) => <div key={i} style={{ display: 'grid', gap: 6, marginTop: 10 }}><small>{f.learnedFrom ? (f.approved ? '자동 답변 · 검토 승인됨' : '자동 답변 · 검토 대기') : '직접 작성'}</small><input aria-label={`FAQ 질문 ${i + 1}`} placeholder="질문" style={inputStyle} value={f.question} onChange={e => setDraft({ ...draft, faqs: draft.faqs.map((x, j) => j === i ? { ...x, question:e.target.value, ...(x.learnedFrom ? {approved:false} : {}) } : x) })}/><textarea aria-label={`FAQ 답변 ${i + 1}`} placeholder="답변" style={inputStyle} value={f.answer} onChange={e => setDraft({ ...draft, faqs: draft.faqs.map((x, j) => j === i ? { ...x, answer: e.target.value, ...(x.learnedFrom ? {approved:false} : {}) } : x) })}/><label hidden={!f.learnedFrom}><input type="checkbox" checked={f.approved === true} onChange={e => setDraft({...draft,faqs:draft.faqs.map((x,j)=>j===i?{...x,approved:e.target.checked}:x)})}/> 이 자동 답변을 검토했고 FAQ 재사용을 허용합니다.</label><button type="button" style={buttonStyle} onClick={() => setDraft({ ...draft, faqs: draft.faqs.filter((_, j) => j !== i) })}>FAQ {i + 1} 삭제</button></div>)}<button type="button" style={{ ...buttonStyle, marginTop: 8 }} disabled={draft.faqs.length >= 30} onClick={() => setDraft({ ...draft, faqs: [...draft.faqs, { question: '', answer: '' }] })}>FAQ 추가</button></div>
    <label><input type="checkbox" checked={draft.aiEnabled} onChange={e => { setDraft({ ...draft, aiEnabled: e.target.checked }); setConsent(false); }}/> FAQ에 없는 질문은 선택한 AI로 답변</label>
    <label>답변 담당 AI<select aria-label="답변 담당 AI" style={inputStyle} value={draft.provider} onChange={e=>{const provider=e.target.value as DutyProvider;setDraft({...draft,provider,modelId:DUTY_MODEL_PRESETS[provider][0]!.id});setConsent(false);}}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="agy">Antigravity</option></select></label>
    <label>세부 모델<select aria-label="세부 모델" style={inputStyle} value={draft.modelId} onChange={e=>{setDraft({...draft,modelId:e.target.value});setConsent(false);}}>{!DUTY_MODEL_PRESETS[draft.provider].some(m => m.id === draft.modelId) && <option value={draft.modelId}>{draft.modelId}</option>}{DUTY_MODEL_PRESETS[draft.provider].map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
    <small>AI는 질문에 답할 때만 호출합니다. 목록은 모델 선택 후보이며 계정별 사용 가능 여부·요금은 다를 수 있습니다. 다른 AI나 고가 모델로 자동 전환하지 않습니다.</small>
    {draft.aiEnabled&&draft.provider!=='claude'&&<p role="alert">{draft.provider==='codex'?'Codex':'Antigravity'} 모델 선택은 저장할 수 있지만 도구 없는 자동 응답 연결은 검증 중입니다. 현재 이 AI로 ON할 수 없습니다.</p>}
    <label><input type="checkbox" checked={draft.autoFaq} onChange={e=>setDraft({...draft,autoFaq:e.target.checked})}/> AI 답변을 검토 대기 FAQ로 모으기</label>
    <small>검토하고 승인한 답변만 같은 질문에 재사용합니다. 자료가 바뀌거나 공유를 해제하면 이전 자동 FAQ는 재사용하지 않습니다. 문구를 고쳐도 출처는 유지됩니다. 최대 30개·자료 포함 40KB이며 가득 차면 추가 적재를 멈춥니다.</small>
    <button type="button" style={buttonStyle} onClick={reload}>저장된 설정·자동 FAQ 다시 불러오기</button>
    <label>최근 24시간 AI 호출 상한<input aria-label="AI 호출 상한" type="number" min={1} max={20} style={inputStyle} value={draft.dailyAiLimit} onChange={e => setDraft({ ...draft, dailyAiLimit: Number(e.target.value) })}/></label>
    <button type="button" style={buttonStyle} onClick={() => void act({ operation: 'save', targetId, config: draft })}>{running ? '저장하고 대직 중지' : '설정 저장'}</button>
    <small>{running ? '변경한 설정을 저장하면 이 프로젝트의 자동 답변이 중지됩니다. 3단계에서 다시 켜세요.' : '1단계의 연결·안내·FAQ 설정을 저장합니다. 저장한 뒤 2단계에서 검색 자료를 만들 수 있습니다.'} 기존 검색 자료는 삭제하지 않습니다.</small>
   </fieldset>
   <CsDutyKnowledgePanel targetId={targetId} status={view?.knowledge} job={view?.knowledgeJob} disabled={disabled || dirty || !view?.config} configRevision={view?.config?.revision ?? 0} onChanged={r => { acceptStatus(r); setConsent(false); }}/>
   <div data-testid="cs-duty-run" style={{ display: 'grid', gap: 10, marginTop: 18, padding: 14, border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--bg)' }}>
    <strong style={{ fontSize: 13 }}>{running ? '3단계 · 실행 중' : '3단계 · 자동 답변 켜기'}</strong>
    {running && <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-2)' }}>지금 이 채팅방의 새 <code>/cs 질문</code>·<code>#별칭 질문</code>에 자동으로 답하고 있습니다. 설정을 바꾸려면 먼저 끄세요.</p>}
    {/* The consent stays on screen while running so its state is always readable, but it only
      * authorises the next ON — it is never carried over from the run that is already going. */}
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, opacity: running ? 0.55 : 1 }}><input type="checkbox" checked={consent} disabled={disabled || running} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 3 }}/><span>이 Mac의 프로필과 채팅방을 확인했고, 저장한 자료로 실제 자동 답변 전송{draft.aiEnabled ? '과 AI 사용' : ''}을 허용합니다.</span></label>
    {!running && blockers.length > 0 && <p data-testid="cs-duty-blockers" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>켜기 전에 필요합니다 — {blockers.join(' · ')}</p>}
    {sourceChanges && !running && <div role="alert"><p>{sourceChanges}</p><button type="button" style={buttonStyle} disabled={disabled || blockers.length > 0} onClick={() => void act({operation:'enable',targetId,revision:view!.config!.revision,knowledgeRevision:view?.knowledge?.revision??0,consent:true},false,true)}>기존 승인 자료로 켜기</button></div>}
    {hollow && <p data-testid="cs-duty-hollow" style={{ margin: 0, padding: '8px 10px', borderRadius: 8, background: 'var(--warn-soft)', fontSize: 12, color: 'var(--ink)' }}><strong style={{ color: 'var(--warn)' }}>안내 자료가 비어 있습니다.</strong> 답변에 필요한 내용이 충분한지 확인하세요. 직접 안내를 보충하거나 검색 자료를 만들 수 있습니다. 근거가 없는 질문에는 확인할 수 없다고 답합니다.</p>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
     <button type="button" style={{ ...buttonStyle, background: running ? 'var(--sunken)' : 'var(--accent)', color: running ? 'var(--ink-3)' : 'var(--on-accent)', borderColor: 'transparent', fontWeight: 700 }} disabled={disabled || blockers.length > 0 || running} onClick={() => void act({ operation: 'enable', targetId, revision: view!.config!.revision, knowledgeRevision: view?.knowledge?.revision ?? 0, consent: true })}>대직 ON · 자동 답변 허용</button>

    </div>
    <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-3)' }}>선택한 채팅방을 카카오톡에서 먼저 열어 두세요. 켜기 전의 대화에는 답하지 않습니다. 설정은 저장되어 유지되지만, 앱을 재시작하면 대직만 OFF이며 전송 동의를 다시 확인해야 합니다. 계정을 바꾸기 전에 끄세요 — 프로필만으로는 계정 변경을 완전히 감지할 수 없습니다.</p>
    <p style={{ margin: 0, fontSize: 12, color: 'var(--ink-3)' }}>OFF는 새 답변과 대기 실행을 중단합니다. 이미 전송된 메시지는 회수하지 않으며 전송 결과가 불명확하면 자동 재시도하지 않습니다. 이 창을 닫아도 ON 상태는 유지됩니다.</p>
   </div>
   </>}
  </dialog>, document.body);
}
