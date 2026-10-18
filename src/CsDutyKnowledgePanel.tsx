import { useEffect, useRef, useState } from 'react';
import { terminalLocalRequest } from './aiTerminalClient';
import { EMPTY_DUTY_KNOWLEDGE, type DutyKnowledgeStatus, type DutyKnowledgeJob, type DutySource, type DutySourceBody, type DutyPreview } from './csDutyKnowledgeTypes';

const button = { padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface)', color: 'var(--ink)', font: 'inherit' };
const box = { display: 'grid', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 10, minWidth: 0 } as const;
type Props = { targetId: string; status?: DutyKnowledgeStatus; job?: DutyKnowledgeJob | null; disabled: boolean; configRevision: number; onChanged: (result: any) => void };

export function CsDutyKnowledgePanel({ targetId, status = EMPTY_DUTY_KNOWLEDGE, job: remoteJob, disabled, configRevision, onChanged }: Props) {
    const [includeMemory, setIncludeMemory] = useState(status.sources.some(s => s.kind === 'memory'));
    const [catalog, setCatalog] = useState<DutySource[] | null>(null), [selected, setSelected] = useState<string[]>(status.sources.map(s => s.id));
    const [source, setSource] = useState<DutySourceBody | null>(null), [job, setJob] = useState<DutyKnowledgeJob | null>(remoteJob ?? null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
    const [reviewed, setReviewed] = useState(false), [question, setQuestion] = useState(''), [preview, setPreview] = useState<DutyPreview | null>(null);
    const [confirmRevoke, setConfirmRevoke] = useState(false);
    const alive = useRef(true), pending = useRef(false), sequence = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
    useEffect(() => { if (!pending.current) setJob(remoteJob ?? null); }, [remoteJob]);
    useEffect(() => { setReviewed(false); setPreview(null); setSource(null); setConfirmRevoke(false); }, [status.revision]);
    useEffect(() => { setReviewed(false); setSource(null); }, [job?.id]);
    const request = async (operation: string, args: Record<string, unknown> = {}) => {
        if (pending.current && operation !== 'revokeKnowledge') return;
        const seq = ++sequence.current;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        try {
            const r = await terminalLocalRequest('/api/agent-runtime/cs-duty', { operation, targetId, ...args });
            if (!alive.current || seq !== sequence.current) return;
            if (operation === 'sources') {
                setCatalog(r.sources); setSelected(prev => prev.filter(id => r.sources.some((s: DutySource) => s.id === id && !s.unavailable)));
                setNotice(r.warnings?.join(' · ') || '공유할 자료를 선택하고 본문을 확인하세요. 새 항목은 자동 선택하지 않습니다.');
            } else if (operation === 'sourcePreview' || operation === 'candidatePreview') setSource(r.source);
            else if (operation === 'prepareKnowledge' || operation === 'cancelKnowledgeJob') { setJob(r.job); setReviewed(false); setSource(null); }
            else if (operation === 'checkKnowledgeUpdates') setNotice(r.changed.length || r.removed.length ? `변경 ${r.changed.length}개 · 삭제 ${r.removed.length}개. 목록을 확인하고 검색 자료를 업데이트하세요. 현재 승인 자료는 그대로 유지됩니다.` : '현재 선택된 원본은 승인 자료와 같습니다.');
            else if (operation === 'previewAnswer') setPreview(r.preview);
            else if (operation === 'applyKnowledge' || operation === 'revokeKnowledge') {
                onChanged(r); setJob(null); setReviewed(false); setPreview(null); setSource(null);
                if (operation === 'revokeKnowledge') setSelected([]);
                setConfirmRevoke(false);
                setNotice(operation === 'applyKnowledge' ? '검색 자료가 준비되었습니다. 3단계에서 대직을 켜면 답변에 사용합니다.' : '검색 자료 공유를 해제하고 이 프로젝트의 대직을 껐습니다. 원본 파일·장기기억과 직접 작성한 안내·FAQ는 유지됩니다.');
            }
        } catch (e) { if (alive.current && seq === sequence.current) setError(e instanceof Error ? e.message : '자료 요청 실패'); }
        finally { if (alive.current && seq === sequence.current) { pending.current = false; setBusy(false); } }
    };
    const blocked = disabled || busy, building = job?.state === 'building', candidate = job?.state === 'ready' ? job.candidate : null;
    const selections = (catalog ?? []).filter(s => selected.includes(s.id) && !s.unavailable).map(s => ({ id: s.id, hash: s.hash }));
    return <section data-testid="cs-duty-knowledge" style={{ ...box, marginTop: 16 }}>
        <strong>2단계 · 검색 자료(RAG) 만들기</strong>
        <p data-testid="knowledge-state" style={{ margin: 0 }}>자료 {status.state === 'ready' ? '사용 가능' : status.state === 'expired' ? '공유 기간 만료' : status.state === 'revoked' ? '공유 해제됨' : '미설정'} · {status.sourceCount}개
            {status.createdAt && <> · 만든 시각 {new Date(status.createdAt).toLocaleString()}</>}
            {status.expiresAt && <> · 만료 {new Date(status.expiresAt).toLocaleDateString()}</>}
        </p>
        <small>질문마다 원본을 읽지 않고 승인한 자료에서 관련 부분만 검색합니다. 장기기억도 선택한 항목만 공유합니다. 자료 생성·검색은 AI를 호출하지 않습니다.</small>
        <p style={{ margin: 0 }}>① 자료 선택 → ② 검색 자료 만들기 → ③ 내용 확인 후 사용</p>
        <small>지원 파일: PDF·MD·MARKDOWN·TXT. PDF는 50MiB·300쪽까지, 추출한 텍스트는 200KB까지입니다. 스캔 PDF는 먼저 OCR 처리가 필요합니다.</small>
        {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
        {notice && <p aria-live="polite">{notice}</p>}
        {disabled && <small>연결 설정의 변경사항을 먼저 저장하세요.</small>}
        <label><input type="checkbox" aria-label="장기기억 항목도 선택" checked={includeMemory} disabled={blocked || building} onChange={e => {
            setIncludeMemory(e.target.checked); setCatalog(null); setSource(null); setReviewed(false);
            if (!e.target.checked) setSelected(prev => prev.filter(id => !(catalog ?? status.sources).some(s => s.id === id && s.kind === 'memory')));
        }}/> 장기기억 항목도 선택 — 세션 일지·원문 대화 제외</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button type="button" style={button} disabled={blocked || building} onClick={() => void request('sources', { includeMemory })}>자료 선택하기</button>
            <button type="button" style={button} disabled={blocked || !status.snapshotId} onClick={() => void request('checkKnowledgeUpdates')}>원본 변경 확인</button>
        </div>
        {catalog && <>
            <div style={{ display: 'flex', gap: 8 }}><button type="button" style={button} disabled={blocked || building || catalog.length > 200} onClick={() => setSelected(catalog.filter(s => !s.unavailable).map(s => s.id))}>현재 목록 전체 선택</button><button type="button" style={button} disabled={blocked || building} onClick={() => setSelected([])}>선택 해제</button><span>{selected.length}개 선택</span></div>
            {!catalog.length && <p>선택 가능한 자료가 없습니다.</p>}
            <div style={{ maxHeight: 240, overflowY: 'auto', display: 'grid', gap: 8 }}>
                {catalog.map(s => <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'start', minWidth: 0 }}>
                    <label style={{ flex: 1, overflowWrap: 'anywhere' }}><input type="checkbox" checked={selected.includes(s.id)} disabled={blocked || building || s.unavailable} onChange={e => setSelected(prev => e.target.checked ? [...prev, s.id] : prev.filter(id => id !== s.id))}/> {s.kind === 'memory' ? '기억' : '문서'} · {s.title} <small>({Math.ceil(s.bytes / 1024)}KB)</small>{s.warning && <small style={{ display: 'block', color: s.unavailable ? 'var(--danger)' : 'var(--ink-2)' }}>{s.warning}</small>}</label>
                    <button type="button" style={button} disabled={blocked || s.unavailable} aria-label={s.title + ' 본문 확인'} onClick={() => void request('sourcePreview', { selection: { id: s.id, hash: s.hash }, includeMemory })}>본문</button>
                </div>)}
            </div>
        </>}
        <small>{selected.length ? `${selected.length}개 선택됨 · 생성한 뒤 본문을 확인하고 적용하세요.` : '위의 자료 선택하기에서 검색할 문서·기억을 골라 주세요.'}</small>
        <button type="button" style={{ ...button, background: 'var(--accent)', color: 'var(--on-accent)' }} disabled={blocked || building || !selections.length || selections.length > 200} onClick={() => void request('prepareKnowledge', { selections, includeMemory, revision: status.revision })}>{status.snapshotId ? '선택한 자료로 검색 자료 업데이트' : '선택한 자료로 검색 자료 만들기'}</button>
        {building && <div aria-live="polite">검색 자료를 만드는 중입니다. 이 창을 닫아도 작업은 유지됩니다. <button type="button" style={button} disabled={busy} onClick={() => void request('cancelKnowledgeJob')}>자료 생성 취소</button></div>}
        {job?.state === 'failed' && <p role="alert">{job.error}</p>}
        {job?.state === 'cancelled' && <p>자료 생성을 취소했습니다.</p>}
        {candidate && <div style={box} data-testid="knowledge-candidate">
            <strong>적용 전 검토 · {candidate.sources.length}개 / {Math.ceil(candidate.bytes / 1024)}KB</strong>
            <small>새로 구성 {candidate.changed}개 · 그대로 재사용 {candidate.reused}개 · 제외 {candidate.removed}개. 적용하면 대직이 OFF가 됩니다.</small>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>{candidate.sources.map(s => <div key={s.id}><button type="button" style={{ ...button, textAlign: 'left', maxWidth: '100%', overflowWrap: 'anywhere' }} disabled={busy} onClick={() => void request('candidatePreview', { candidateId: candidate.id, sourceId: s.id })}>{s.title} · 승인할 본문 보기</button></div>)}</div>
            <label><input type="checkbox" checked={reviewed} disabled={blocked} onChange={e => setReviewed(e.target.checked)}/> 선택한 본문이 이 채팅방에 공유되어도 되는지 확인했습니다. 90일 동안 이 자료를 답변에 사용합니다.</label>
            <button type="button" style={button} disabled={blocked || !reviewed} onClick={() => void request('applyKnowledge', { candidateId: candidate.id, manifestHash: candidate.manifestHash, revision: status.revision, configRevision, consent: true })}>이 자료를 답변에 사용</button>
        </div>}
        {source && <div style={box}><strong>{source.title}</strong>{source.warning && <small>{source.warning}</small>}<pre data-testid="knowledge-source-body" style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{source.body}</pre><button type="button" style={button} onClick={() => setSource(null)}>본문 접기</button></div>}
        <label>시험 질문<input aria-label="자료 시험 질문" maxLength={500} value={question} onChange={e => { setQuestion(e.target.value); setPreview(null); }} style={{ display: 'block', width: '100%', padding: 8, font: 'inherit' }}/></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={button} disabled={blocked || !question.trim()} onClick={() => void request('previewAnswer', { question, generate: false })}>검색만 시험 · AI 사용 없음</button>
            <button type="button" style={button} disabled={blocked || !question.trim()} onClick={() => void request('previewAnswer', { question, generate: true })}>AI 답변 시험 · 호출 한도 사용</button>
        </div>
        <small>시험 결과는 이 화면에만 표시하며 카카오톡에 전송하지 않습니다.</small>
        {preview && <div data-testid="knowledge-preview" style={box}>
            <strong>시험 결과 · {preview.aiUsed ? 'AI 호출 사용' : 'AI 호출 없음'}</strong>
            {preview.answer && <p style={{ whiteSpace: 'pre-wrap' }}>{preview.answer}</p>}
            {!preview.evidence.length && <p>검색 근거가 없습니다. 직접 안내·승인된 FAQ가 없다면 답변을 확인할 수 없습니다.</p>}
            {preview.evidence.map(e => <details key={e.id}><summary>{e.title}</summary><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.body}</p></details>)}
        </div>}
        {(status.snapshotId || building) && <details style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <summary>검색 자료 관리</summary>
            <p>공유를 해제하면 이 프로젝트의 검색 자료 사본을 삭제하고 대직을 중지합니다. 원본 파일·장기기억과 1단계에 직접 작성한 안내·FAQ는 유지됩니다.</p>
            {!confirmRevoke ? <button type="button" style={{ ...button, color: 'var(--danger)' }} onClick={() => setConfirmRevoke(true)}>검색 자료 공유 해제</button> : <div role="alert">
                <p>검색 자료 공유를 해제할까요? 다시 사용하려면 검색 자료를 새로 만들어야 합니다.</p>
                <button type="button" disabled={busy} style={{ ...button, color: 'var(--danger)' }} onClick={() => void request('revokeKnowledge')}>공유 해제하기</button>{' '}
                <button type="button" style={button} onClick={() => setConfirmRevoke(false)}>유지하기</button>
            </div>}
        </details>}
    </section>;
}
