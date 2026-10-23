import React, { useEffect, useRef, useState } from 'react';
import {commonMemoryUuid,commonMemoryDigest} from './commonMemoryCrypto';
import { Brain, Plus, RefreshCw, Search } from 'lucide-react';
import { metaMemoryApplies, type MetaCommonMemory, type MetaMemoryAssignment, type MetaMemoryProject, type MetaMemorySummary } from './metaCommonMemoryContract';
import { MetaMemoryClientError, metaMemoryRequest, type MetaMemoryRequester } from './metaCommonMemoryClient';
import {readCommonTopicEvidence,withCommonTopicEvidence,type CommonTopicEvidence} from './commonMemoryTopicEvidence';

const input = 'min-h-11 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--ink)]';
const button = 'min-h-11 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40';
const csv = (value: string) => [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
type Draft = { name: string; description: string; tags: string; categories: string };
/** One page of the cloud long-term-memory catalog (the host's `catalog` operation). */
export type MetaMemoryCatalogPage = { sources: Array<{ memoryId: string; name: string; githubUrl?: string | null }>; nextAfter: string | null };
type Props = { /** Phones on a Mac with the `lean-read` capability: the group read leaves the project inventory out. */ leanRead?: boolean; visible?: boolean; request?: MetaMemoryRequester; remote?: boolean; hostName?: string; fixedMemoryId?:string; cloud?:boolean; onSaved?:(memoryId?:string)=>void; onBlockedChange?:(blocked:boolean)=>void; createOnly?:boolean;compact?:boolean;/** The cloud group's version: a new one re-reads in place (no remount). */version?:number;/** From the host's `list` result: forms this Mac understands beyond the originals. */hostCapabilities?:readonly string[];/** Cloud long-term-memory catalog pages; with the memory-members form, memories not registered here can be linked. */catalog?:(after:string|null)=>Promise<MetaMemoryCatalogPage>;/** Creation only: this long-term memory starts linked (include). */presetMemberId?:string };
/** A link target: one long-term memory, with the projects on this Mac that use it (none for a cloud-only memory). */
type LinkRow = { memoryId: string; name: string; githubUrl?: string | null; users: MetaMemoryProject[]; lead?: MetaMemoryProject };
const emptyDraft = (): Draft => ({ name: '', description: '', tags: '', categories: '' });
const entryView=(body:string)=>{try{return {...readCommonTopicEvidence(body),invalid:false};}catch{return {body,evidence:null,invalid:true};}};
export default function MetaCommonMemoryPanel({ leanRead: leanReadAllowed = false, visible = true, request = metaMemoryRequest, remote = false, hostName, fixedMemoryId, cloud=false,onSaved,onBlockedChange,createOnly=false,compact=false,version,hostCapabilities,catalog,presetMemberId }: Props) {
  const [memories, setMemories] = useState<MetaMemorySummary[]>([]);
  const [projects, setProjects] = useState<MetaMemoryProject[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState(false);
  const [memory, setMemory] = useState<MetaCommonMemory | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [assignments, setAssignments] = useState<Record<string, MetaMemoryAssignment>>({});
  const [entry, setEntry] = useState<{id:string;title:string;body:string;evidence?:CommonTopicEvidence}>({ id: '', title: '', body: '' });
  const [selectedCandidates,setSelectedCandidates]=useState<string[]>([]);
  const [history, setHistory] = useState<Array<{ revision: number; operation: string; createdAt: string }>>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  // A new group version re-reads in place; mark it loading in the same render so the parent never sees an idle gap.
  const [seenVersion, setSeenVersion] = useState(version);
  // The version our own save produced: the parent's re-read after onSaved moves the version, and the saved memory is
  // already applied here, so that one change needs no second read.
  const ownSaveAt = useRef<{ from: number | undefined } | null>(null);
  if (seenVersion !== version) { setSeenVersion(version); if (!(ownSaveAt.current && ownSaveAt.current.from === seenVersion)) setLoading(true); }
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [memberForm, setMemberForm] = useState<string | undefined>();
  const [catalogRows, setCatalogRows] = useState<MetaMemoryCatalogPage['sources']>([]);
  // undefined: not loaded yet; null: every page loaded.
  const [catalogNext, setCatalogNext] = useState<string | null | undefined>(undefined);
  const [catalogLoading, setCatalogLoading] = useState(false);
  // A lean read left the project inventory out; it is loaded when the long-term-memory picker opens.
  const [projectsDeferred, setProjectsDeferred] = useState(false);
  // Phones only (the parent decides, from the Mac's `lean-read` capability): the picker links by memoryId from the catalog,
  // so the inventory (about 19 KB, two extra relay frames per group open) is secondary text that can wait.
  // Compact only: there the picker starts closed, so opening it (onToggle) is the moment to load.
  const leanRead = leanReadAllowed && compact && !!catalog && !!hostCapabilities?.includes('memory-members');
  const alive = useRef(true);
  const sequence = useRef(0);
  const readSeq = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const importInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; readAbort.current?.abort(); }; }, []);
  const applyMemory = (value: MetaCommonMemory) => {
    setMemory(value); setEditing(true); setDraft({ name: value.name, description: value.description, tags: value.tags.join(', '), categories: value.categories.join(', ') }); setAssignments({});setSelectedCandidates([]);
    setMemories(previous => previous.map(summary => summary.id === value.id ? { ...summary, ...value, entryCount: value.entries.filter(e => e.state === 'active' || e.state === 'contested').length, candidateCount: value.entries.filter(e => e.state === 'candidate').length, memberCount: value.members.filter(m => m.mode === 'include').length } : summary));
  };
  // The standalone list asks list+projects; creation asks projects only. A fixed group asks nothing here: its read
  // carries the projects.
  const load = async (offset = 0) => {
    const ticket = ++sequence.current;
    readAbort.current?.abort(); const controller = new AbortController(); readAbort.current = controller;
    setLoading(true); setError('');
    try {
      const [catalogPage, inventory] = await Promise.all([createOnly?Promise.resolve({memories:[],nextOffset:null,total:0}):request({ operation: 'list', query: search, offset }, controller.signal), request({ operation: 'projects' }, controller.signal)]);
      if (!alive.current || ticket !== sequence.current) return;
      setMemories(previous => offset ? [...previous, ...catalogPage.memories] : catalogPage.memories); setNextOffset(catalogPage.nextOffset); setTotal(catalogPage.total); setProjects(inventory.projects);
      // A preset member uses this Mac's project-card form when a project here uses it, else the memory form (if the host takes it).
      if (createOnly && presetMemberId) {
        const lead = (inventory.projects as MetaMemoryProject[]).find(p => p.memoryId === presetMemberId);
        const value: MetaMemoryAssignment | null = lead ? { portId: lead.id, expectedMemoryId: presetMemberId, mode: 'include' } : memoryMembers ? { memoryId: presetMemberId, mode: 'include' } : null;
        if (value) setAssignments({ [presetMemberId]: value });
      }
    } catch (e) { if (alive.current && ticket === sequence.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (alive.current && ticket === sequence.current) setLoading(false); }
  };
  useEffect(() => {
    if (!visible) return;
    if (fixedMemoryId) {
      if (ownSaveAt.current && ownSaveAt.current.from !== version) { ownSaveAt.current = null; setLoading(false); return; }
      const controller = new AbortController(); void read(fixedMemoryId, controller.signal);
      return () => controller.abort();
    }
    void load(); if (createOnly) setEditing(true);
    return () => { sequence.current++; readAbort.current?.abort(); };
  }, [visible, request,fixedMemoryId,createOnly,version]);
  const read = async (id: string, signal?: AbortSignal) => {
    const ticket = ++readSeq.current;
    setBusy(true); setError('');
    try {
      const [result, h] = await Promise.all([request({ operation: 'read', memoryId: id, ...(leanRead ? { withProjects: false } : {}) }, signal), request({ operation: 'history', memoryId: id }, signal)]);
      if (!alive.current || ticket !== readSeq.current) return; applyMemory(result.memory); setMemberForm(result.memberForm); setHistory(h.history); setEntry({ id: '', title: '', body: '' });
      // Every current host returns the projects with read; only an older one needs the separate inventory call.
      if (Array.isArray(result.projects)) { setProjects(result.projects); setProjectsDeferred(false); }
      else if (leanRead) setProjectsDeferred(true);
      else { const inventory = await request({ operation: 'projects' }, signal); if (alive.current && ticket === readSeq.current) setProjects(inventory.projects); }
    } catch (e) { if (alive.current && ticket === readSeq.current && !signal?.aborted) setError((e as Error).message); }
    finally { if (alive.current && ticket === readSeq.current) { setBusy(false); if (fixedMemoryId) setLoading(false); } }
  };
  const mutate = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(''); setPending(payload);
    try {
      const result = await request(payload);
      if (!alive.current) return;
      setPending(null); if (result.memory) { applyMemory(result.memory); if (fixedMemoryId) ownSaveAt.current = { from: version }; }
      if (payload.operation === 'save-entry') setEntry({ id: '', title: '', body: '' });
      if (result.projects) setProjects(result.projects);
      setNotice(cloud||result.storage==='cloud'?'클라우드 공통기억에 저장 완료':remote ? '연결한 Mac에 저장 완료' : '로컬 저장 완료');
      // Creation hands over to the group view at once. Otherwise the saved memory is already applied: read the history
      // only, then tell the parent (whose re-read moves the version without a second read here).
      if (createOnly) { onSaved?.(result.memory?.id); return; }
      if (result.memory) {
        const h = await request({ operation: 'history', memoryId: result.memory.id });
        if (alive.current) setHistory(h.history);
      }
      if (!alive.current) return;
      onSaved?.(result.memory?.id);
      if (!fixedMemoryId) await load();
    } catch (e) {
      if (!alive.current) return;
      const uncertain=e instanceof MetaMemoryClientError?e.uncertain:cloud&&!!((e as any)?.uncertain||(e as any)?.unknownOutcome);
      if (!uncertain) setPending(null);
      setError((e as Error).message);
    } finally { if (alive.current) setBusy(false); }
  };
  const base = () => ({ memoryId: memory!.id, expectedRevision: memory!.revision, requestId: commonMemoryUuid() });
  const saveEntry = async () => {
    setError(''); setNotice('');
    try {
      const body = entry.evidence ? withCommonTopicEvidence(entry.body, entry.evidence) : entry.body;
      await mutate({operation: 'save-entry', ...base(), ...(entry.id ? {entryId: entry.id} : {}), title: entry.title, body});
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : '공통 항목의 내용과 원본 근거를 확인하세요.');
    }
  };
  // memory-members: a memory not registered on this Mac can be linked by its memoryId from the cloud catalog. Rows that
  // this Mac uses keep the project-card form (verified here, and it works before the memory reaches the cloud).
  const memoryMembers = !!catalog && (!!hostCapabilities?.includes('memory-members') || memberForm === 'memory');
  const loadCatalog = async (after: string | null = null) => {
    if (!catalog || catalogLoading) return;
    setCatalogLoading(true); setError('');
    try {
      const page = await catalog(after);
      if (!alive.current) return;
      setCatalogRows(previous => { const seen = new Set(previous.map(r => r.memoryId)); return [...previous, ...page.sources.filter(r => !seen.has(r.memoryId))]; });
      setCatalogNext(page.nextAfter ?? null);
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setCatalogLoading(false); }
  };
  const loadDeferredProjects = async () => {
    setProjectsDeferred(false);
    try { const inventory = await request({ operation: 'projects' }); if (alive.current) setProjects(inventory.projects); }
    catch (e) { if (alive.current) { setProjectsDeferred(true); setError((e as Error).message); } }
  };
  const applies = (memoryId: string, category: string) => {
    const override = assignments[memoryId];
    const members = (memory?.members ?? []).filter(m => m.memoryId !== memoryId || !override);
    if (override && override.mode !== 'inherit') members.push({ memoryId, name: memoryId, mode: override.mode });
    return metaMemoryApplies({ archived: false, members, categories: csv(draft.categories) }, memoryId, category);
  };
  const checked = (p: MetaMemoryProject) => !!p.memoryId && applies(p.memoryId, p.category);
  const rowChecked = (row: LinkRow) => row.users.length ? row.users.some(p => applies(row.memoryId, p.category)) : applies(row.memoryId, '');
  const choose = (row: LinkRow, mode: MetaMemoryAssignment['mode']) => {
    // Without the memory-members form only this Mac's rows exist, so lead is always set there.
    const value: MetaMemoryAssignment | null = row.lead ? { portId: row.lead.id, expectedMemoryId: row.memoryId, mode } : memoryMembers ? { memoryId: row.memoryId, mode } : null;
    if (value) setAssignments(previous => ({ ...previous, [row.memoryId]: value }));
  };
  const matches = (p: MetaMemoryProject) => (!category || p.category === category) && `${p.name} ${p.category}`.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase());
  const filteredProjects = projects.filter(matches);
  // A link belongs to a long-term memory (memoryId), not to a registered project: the main checkout and its worktrees
  // share one memory, so the list is one row per memory and the projects using it are secondary text.
  const allMemoryRows: LinkRow[] = (() => {
    const users = new Map<string, MetaMemoryProject[]>();
    for (const p of projects) if (p.state === 'ready' && p.memoryId) users.set(p.memoryId, [...(users.get(p.memoryId) ?? []), p]);
    const cloudName = new Map(catalogRows.map(r => [r.memoryId, r]));
    const rows: LinkRow[] = [...users.entries()].map(([memoryId, used]) => ({ memoryId, name: cloudName.get(memoryId)?.name ?? used[0]!.name, githubUrl: cloudName.get(memoryId)?.githubUrl ?? null, users: used, lead: used[0]! }));
    if (memoryMembers) {
      const known = new Set(rows.map(r => r.memoryId));
      for (const m of memory?.members ?? []) if (!known.has(m.memoryId)) { known.add(m.memoryId); rows.push({ memoryId: m.memoryId, name: cloudName.get(m.memoryId)?.name ?? m.name, githubUrl: cloudName.get(m.memoryId)?.githubUrl ?? null, users: [] }); }
      for (const r of catalogRows) if (!known.has(r.memoryId)) { known.add(r.memoryId); rows.push({ memoryId: r.memoryId, name: r.name, githubUrl: r.githubUrl ?? null, users: [] }); }
    }
    return rows;
  })();
  const query = projectSearch.trim().toLocaleLowerCase();
  const memoryRows = allMemoryRows.filter(row => memoryMembers ? !query || [row.name, row.githubUrl ?? '', row.memoryId, ...row.users.map(p => `${p.name} ${p.category}`)].join(' ').toLocaleLowerCase().includes(query) : row.users.some(matches));
  const projectsWithoutMemory = filteredProjects.filter(p => p.state !== 'ready' || !p.memoryId);
  const linkedMemoryCount = memoryMembers ? allMemoryRows.filter(rowChecked).length : new Set(projects.filter(checked).map(p => p.memoryId)).size;
  const save = () => void mutate({ operation: 'save', ...(memory ? { memoryId: memory.id } : {}), expectedRevision: memory?.revision ?? 0, requestId: commonMemoryUuid(), name: draft.name, description: draft.description, tags: csv(draft.tags), categories: csv(draft.categories), assignments: Object.values(assignments) });
  const exportMemory = async () => {
    setError(''); setBusy(true);
    try {
      const result = await request({ operation: 'export', memoryId: memory!.id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `meta-memory-${memory!.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { if (alive.current) setError((e as Error).message); } finally { if (alive.current) setBusy(false); }
  };
  const importMemory = async (file: File) => {
    try {
      if (file.size > 600 * 1024) throw Error('공통 기억 백업은 600 KiB까지 가져올 수 있습니다.');
      const data = JSON.parse(await file.text());
      if (data.format !== 'agentstoz-meta-common-memory' || data.schemaVersion !== 1 || !data.snapshot) throw Error('AgentsToZ 공통기억 백업을 선택하세요.');
      const hash = await commonMemoryDigest(JSON.stringify(data.snapshot));
      if (hash !== data.checksum) throw Error('백업 내용의 검증 값이 일치하지 않습니다.');
      let expectedRevision = 0;
      try { expectedRevision = (await request({ operation: 'read', memoryId: data.snapshot.id })).memory.revision; }
      catch (e) { if (!(e instanceof MetaMemoryClientError) || e.code !== 'META_MEMORY_NOT_FOUND') throw e; }
      // Existing memory needs an explicit review in the editor; importing never silently overwrites it.
      if (expectedRevision) { await read(data.snapshot.id); throw Error('이미 있는 공통 기억입니다. 현재 내용과 백업을 비교한 뒤 항목을 편집하세요.'); }
      await mutate({ operation: 'import', requestId: commonMemoryUuid(), expectedRevision: 0, snapshot: data.snapshot });
    } catch (e) { if (alive.current) setError((e as Error).message); }
  };
  const blocked = busy || !!pending;
  const hasCategories = (memory?.categories.length ?? 0) > 0;
  // The projects are the ones of the Mac that answers: this Mac, or the named Mac a phone is connected to.
  const here = remote && hostName ? hostName : '이 Mac';
  // Also on every version: the parent blocks when it hands a new version, and a version our own save produced changes
  // neither flag here, so the report must not depend on a flag flipping.
  useEffect(()=>{onBlockedChange?.(blocked||loading);},[blocked,loading,onBlockedChange,version]);
  useEffect(()=>()=>onBlockedChange?.(false),[onBlockedChange]);
  const metadataDirty = !!memory && (draft.name !== memory.name || draft.description !== memory.description || draft.tags !== memory.tags.join(', ') || draft.categories !== memory.categories.join(', ') || Object.keys(assignments).length > 0);
  return <section className="m-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)]" data-testid="meta-common-memory-panel">
    {!fixedMemoryId&&!createOnly&&<div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-semibold"><Brain size={18} />공통기억</h2><p className="mt-1 text-xs text-[var(--ink-3)]">여러 장기기억이 제품·기술·업무의 공통점을 함께 기억합니다. 각 프로젝트의 장기기억은 따로 유지됩니다.</p></div>
      <div className="flex flex-wrap gap-2"><button className={button} disabled={blocked || editing} onClick={() => { setMemory(null); setDraft(emptyDraft()); setAssignments({}); setHistory([]); setEntry({ id: '', title: '', body: '' }); setEditing(true); setNotice(''); }}><Plus size={14} className="mr-1 inline" />공통 기억 만들기</button><button className={button} disabled={blocked || editing} onClick={() => importInput.current?.click()}>백업 가져오기</button><button className={button} disabled={blocked} onClick={() => void load()} aria-label="공통 기억 목록 새로고침"><RefreshCw size={15} /></button></div>
    </div>}
    <p className="mt-2 text-xs text-[var(--ink-3)]">{cloud?'클라우드 공통기억 · 같은 클라우드에 연결된 기기에서 함께 관리합니다.':remote ? `${hostName ?? '연결한 Mac'}의 공통 기억 · 변경은 해당 Mac에 저장됩니다.` : '이 기기에 저장'} · 변경 이력과 이관 원본을 보존합니다.</p>
    {fixedMemoryId&&!editing&&(loading||busy)&&<p role="status" className="mt-3 text-sm">기억 항목과 연결된 장기기억을 조회하는 중…</p>}
    <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void importMemory(file); }} />
    {error && <div role="alert" className="mt-3 rounded-lg bg-[var(--warn-soft)] p-3 text-sm">{error}{memory && !pending && <button className={`${button} ml-2`} disabled={busy} onClick={() => void read(memory.id)}>최신 내용 다시 조회 · 입력 취소</button>}</div>}
    {notice && <p role="status" className="mt-2 text-xs">{notice}</p>}
    {pending && <div className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm">저장 결과를 확인하지 못했습니다. 같은 요청으로 확인해야 중복 저장을 막을 수 있습니다.<button className={`${button} ml-2`} disabled={busy} onClick={() => void mutate(pending)}>같은 요청 다시 확인</button></div>}
    {!fixedMemoryId&&!createOnly&&<><form className="mt-4 flex gap-2" onSubmit={e => { e.preventDefault(); void load(); }}><input aria-label="공통 기억 검색" className={input} placeholder="이름·설명·태그 검색" value={search} onChange={e => setSearch(e.target.value)} /><button className={button} disabled={blocked} aria-label="공통 기억 검색 실행"><Search size={16} /></button></form>
    {loading && <p className="mt-3 text-sm" role="status">공통기억과 장기기억을 조회하는 중…</p>}
    {!loading && !error && !memories.length && <p className="mt-3 text-sm">등록된 공통 기억이 없습니다. 원본 장기기억 없이 만들 수 있습니다.</p>}
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{memories.map(m => <button key={m.id} className="rounded-lg border border-[var(--line)] p-3 text-left disabled:opacity-50" disabled={blocked || editing} onClick={() => void read(m.id)} data-testid="meta-memory-card"><span className="font-medium">{m.name}</span>{m.archived && <span className="ml-2 text-xs">보관됨</span>}<p className="mt-1 text-xs text-[var(--ink-3)]">{m.description}</p><p className="mt-2 text-xs">확정 {m.entryCount} · 후보 {m.candidateCount} · 수동 연결 {m.memberCount} · 리비전 {m.revision}</p><p className="mt-1 text-xs text-[var(--ink-3)]">{m.tags.join(' · ')}{m.categories.length ? ` · 자동 연결: ${m.categories.join(', ')}` : ''}</p></button>)}</div>
    {nextOffset !== null && <button className={`${button} mt-3`} disabled={blocked} onClick={() => void load(nextOffset)}>더 보기 · {memories.length}/{total}</button>}
    </>}
    {editing && <div className="mt-5 rounded-xl border border-[var(--line)] p-4" data-testid="meta-memory-editor">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{fixedMemoryId?'기억 항목·연결할 장기기억':memory ? '공통기억 관리' : '공통기억 만들기'}</h3>{!fixedMemoryId&&<button className={button} disabled={blocked} onClick={() => { if(createOnly)onSaved?.();setEditing(false); setMemory(null); setError(''); setNotice(''); }}>닫기 · 미저장 입력 취소</button>}</div>
      {fixedMemoryId&&<p className="mt-2 text-xs text-[var(--ink-3)]">공유할 내용과 연결할 장기기억을 관리합니다. AI의 제안은 검토 후 확정합니다.</p>}
      <details open={!compact||createOnly} onToggle={e => { if (e.currentTarget.open && !createOnly && memoryMembers && catalogNext === undefined) void loadCatalog(); if (e.currentTarget.open && projectsDeferred) void loadDeferredProjects(); }}><summary className="min-h-11 cursor-pointer text-sm">연결할 장기기억·이름·태그 수정</summary><fieldset data-testid="meta-memory-use-projects" disabled={blocked} className="mt-3 space-y-3">
        <label className="block text-sm">{createOnly?'공통기억 이름':'이름'}<input className={`${input} mt-1`} value={draft.name} maxLength={80} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <details open={!compact&&!createOnly}><summary className="min-h-11 cursor-pointer text-sm">{hasCategories ? '설명·태그·자동 적용 설정' : '설명·태그'}</summary>
        <label className="block text-sm">설명<textarea className={`${input} mt-1`} value={draft.description} maxLength={600} rows={2} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="이 공통기억의 목적과 함께 사용할 내용을 적으세요." /></label>
        <label className="block text-sm">검색 태그 · 쉼표로 구분<input className={`${input} mt-1`} value={draft.tags} placeholder="NHCS, Tauri, macOS, 기획" onChange={e => setDraft({ ...draft, tags: e.target.value })} /></label>
        {/* Categories stay readable and editable for a group that already uses them; new links name long-term memories. */}
        {hasCategories && <label className="block text-sm">카테고리로 자동 적용 · 선택<input className={`${input} mt-1`} value={draft.categories} placeholder="등록된 카테고리 이름을 쉼표로 구분" onChange={e => setDraft({ ...draft, categories: e.target.value })} /><span className="mt-1 block text-xs text-[var(--ink-3)]">입력한 카테고리의 기존·새 프로젝트에 적용합니다. 체크박스의 개별 지정·제외가 우선합니다.</span><span className="mt-1 block text-xs" data-testid="meta-memory-category-notice">이 공통기억은 카테고리 자동 적용을 사용합니다. 새 연결은 아래에서 장기기억을 직접 선택하는 방식을 권장합니다.</span></label>}
        </details>
        <div className="rounded-lg border border-[var(--line)] p-3"><h4 className="m-0 text-sm font-semibold">어느 장기기억에 연결할까요?</h4><p className="m-0 mt-1 text-sm">이 공통기억을 선택한 장기기억에 연결합니다. 그 장기기억을 쓰는 프로젝트·워크트리가 회상할 때 함께 읽습니다.</p><p className="m-0 mt-1 text-xs text-[var(--ink-3)]">공통 내용을 정리할 때 참고할 원본 장기기억은 ‘가져올 기억’에서 따로 고릅니다.</p></div>
        <div className="flex flex-wrap gap-2"><input className={`${input} flex-1`} aria-label="연결할 장기기억 검색" placeholder="장기기억 이름·GitHub 검색" value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />{!memoryMembers && <select className={`${input} sm:w-auto`} aria-label="연결할 장기기억 카테고리" value={category} onChange={e => setCategory(e.target.value)}><option value="">모든 카테고리</option>{[...new Set(projects.map(p => p.category).filter(Boolean))].sort().map(c => <option key={c}>{c}</option>)}</select>}</div>
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm">연결할 장기기억 {linkedMemoryCount}개{memoryMembers ? '' : ' · 이 기기에서 확인한 대상'}</span><button type="button" className={button} onClick={() => memoryRows.forEach(row => choose(row, 'include'))}>표시된 장기기억 선택</button><button type="button" className={button} onClick={() => memoryRows.forEach(row => choose(row, 'exclude'))}>표시된 장기기억 해제</button></div>
        <div className="max-h-64 overflow-auto rounded-lg border border-[var(--line)] p-2" data-testid="meta-memory-link-targets">{memoryRows.map(row => <div key={row.memoryId} className="flex flex-wrap items-center gap-2 py-1"><label className="flex min-h-11 min-w-0 w-full items-center gap-2 text-sm sm:w-auto sm:flex-1"><input type="checkbox" className="shrink-0" checked={rowChecked(row)} onChange={e => choose(row, e.target.checked ? 'include' : 'exclude')} /><span className="min-w-0 flex-1"><span className="block break-words">{row.name} 장기기억</span><span className="block break-words text-xs text-[var(--ink-3)]">{memoryMembers ? (row.users.length ? `${here}: ${row.users.map(p => p.name).join(' · ')}` : `${here}에 없음 · 클라우드 장기기억`) : row.users.length > 1 ? `사용 프로젝트 ${row.users.length}개: ${row.users.map(p => p.name).join(' · ')}` : row.lead?.category || '카테고리 없음'}{memoryMembers && row.githubUrl ? ` · ${row.githubUrl.replace(/^https:\/\/github\.com\//, '')}` : ''} · 기억 {row.memoryId.slice(0, 8)}</span></span></label>{hasCategories && <button type="button" className={button} onClick={() => choose(row, 'inherit')}>자동 적용 규칙 따르기</button>}</div>)}
          {!memoryRows.length && <p className="m-0 py-2 text-sm text-[var(--ink-3)]">조건에 맞는 장기기억이 없습니다.</p>}
          {memoryMembers && catalogNext !== null && <button type="button" className={`${button} mt-2`} disabled={catalogLoading} onClick={() => void loadCatalog(catalogNext ?? null)} data-testid="meta-memory-catalog-more">{catalogLoading ? '클라우드 장기기억을 불러오는 중…' : catalogNext === undefined ? '클라우드의 다른 장기기억 불러오기' : `장기기억 더 보기 · ${catalogRows.length}개 불러옴`}</button>}
          {!!projectsWithoutMemory.length && <div className="mt-2 border-t border-[var(--line)] pt-2"><p className="m-0 text-xs text-[var(--ink-3)]">장기기억이 아직 없는 프로젝트 · 장기기억을 만든 뒤 연결할 수 있습니다.</p>{projectsWithoutMemory.map(p => <div key={p.id} className="flex flex-wrap items-center gap-2 py-1"><span className="min-w-0 flex-1 text-sm"><span className="block break-words">{p.name}</span><span className="block text-xs text-[var(--ink-3)]">{p.category}{p.state === 'unavailable' ? ' · 조회 불가' : ' · 장기기억 미준비'}</span></span>{p.state === 'uninitialized' && <button type="button" className={button} onClick={() => void mutate({ operation: 'prepare-project', portId: p.id })}>장기기억 준비</button>}</div>)}</div>}</div>
        {!memoryMembers && memory?.members.some(m => !projects.some(p => p.memoryId === m.memoryId)) && <p className="text-xs text-[var(--ink-3)]">이 기기에서 조회되지 않는 장기기억 연결도 보존합니다: {memory.members.filter(m => !projects.some(p => p.memoryId === m.memoryId)).map(m => `${m.name} · 기억 ${m.memoryId.slice(0,8)} · ${m.mode==='include'?'연결':'제외'}`).join(', ')}</p>}
        <button className={`${button} bg-[var(--accent-soft)]`} disabled={!draft.name.trim()} onClick={save}>{createOnly?'공통기억 만들기':'연결·정보 저장'}</button>
      </fieldset>
      </details>
      {memory && <fieldset disabled={blocked} className="mt-5 space-y-3 border-t border-[var(--line)] pt-4">
        {metadataDirty && <p className="text-sm text-[var(--ink-3)]">이름·메타정보·연결할 장기기억 변경을 먼저 저장한 뒤 공통 항목을 수정하세요.</p>}
        {memory.archived && <p className="text-sm">보관된 공통 기억입니다. 연결 설정과 내용은 남아 있으며 회상 적용은 중지되었습니다.</p>}
        {cloud&&memory.entries.some(e=>e.state==='candidate')&&<div data-testid="common-memory-candidate-review" className="grid gap-2 rounded-lg border border-[var(--line)] p-3"><b className="text-sm">검토 후보 · {memory.entries.filter(e=>e.state==='candidate').length}개</b><p className="m-0 text-xs">공통 규칙·적용 조건과 원본 근거를 확인하고 선택한 후보만 확정합니다. 기존 항목을 바꾸는 후보는 원본과 변경 전 내용도 다시 검사합니다.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={metadataDirty||memory.archived} onClick={()=>setSelectedCandidates(memory.entries.filter(e=>e.state==='candidate'&&!entryView(e.body).invalid).slice(0,16).map(e=>e.id))}>후보 선택 · 최대 16개</button><button className={button} disabled={metadataDirty||memory.archived||!selectedCandidates.length} onClick={()=>void mutate({operation:'review-entries',...base(),entryIds:selectedCandidates,state:'active'})}>선택한 {selectedCandidates.length}개 검토 후 확정</button><button className={button} disabled={metadataDirty||!selectedCandidates.length} onClick={()=>void mutate({operation:'review-entries',...base(),entryIds:selectedCandidates,state:'superseded'})}>선택한 후보 채택하지 않고 보존</button></div></div>}
        {memory.entries.map(e => {const view=entryView(e.body),prior=view.evidence?.supersedes?memory.entries.find(entry=>entry.id===view.evidence!.supersedes!.entryId):null;return <details key={e.id} className="rounded-lg border border-[var(--line)] p-3" open={e.state === 'candidate'}>
          <summary className="flex min-h-11 cursor-pointer items-center text-sm">{e.title} · {({ active: '확정', candidate: '검토 후보', contested: '충돌 검토', superseded: '이전 항목' })[e.state]}</summary>
          {cloud&&e.state==='candidate'&&<label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" aria-label={`${e.title} 검토 선택`} disabled={metadataDirty||view.invalid||(!selectedCandidates.includes(e.id)&&selectedCandidates.length>=16)} checked={selectedCandidates.includes(e.id)} onChange={event=>setSelectedCandidates(ids=>event.target.checked?[...ids,e.id]:ids.filter(id=>id!==e.id))}/>이 후보 검토 선택</label>}
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{view.body}</p>
          {view.invalid&&<p role="alert" className="text-sm">원본 근거 형식을 확인하지 못했습니다. 후보를 다시 준비하세요.</p>}
          {view.evidence&&<div data-testid="common-memory-candidate-evidence" className="grid gap-2 border-t border-[var(--line)] pt-3"><p className="m-0 text-xs">정리 이유: {view.evidence.reason}</p>{view.evidence.category&&<p className="m-0 text-xs">내용 분류: {view.evidence.category}</p>}<p className="m-0 text-xs">적용 조건: {view.evidence.conditions.join(' · ')||'원본과 작업 조건을 함께 확인하세요.'}</p><ul className="m-0 pl-5 text-xs">{view.evidence.sources.map(source=><li key={`${source.memoryId}:${source.entryId}`} className="break-words">{source.memoryName} · {source.title}<span className="block text-[var(--ink-3)]">기억 {source.memoryId.slice(0,8)} · 리비전 {source.revisionId.slice(0,8)}</span></li>)}</ul>{prior&&e.state==='candidate'&&<details><summary className="min-h-11 cursor-pointer text-xs">변경 전 확정 항목 · {prior.title}</summary><p className="whitespace-pre-wrap break-words text-sm">{entryView(prior.body).body}</p></details>}</div>}
          <div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={memory.archived || metadataDirty||view.invalid} onClick={() => setEntry({ id: e.id, title: e.title, body: view.body,...(view.evidence?{evidence:view.evidence}:{}) })}>편집</button>{e.state !== 'active' && <button className={button} disabled={metadataDirty||memory.archived||view.invalid} onClick={() => void mutate({ operation: 'review-entry', ...base(), entryId: e.id, state: 'active' })}>검토 후 확정</button>}{e.state !== 'contested' && <button className={button} disabled={metadataDirty} onClick={() => void mutate({ operation: 'review-entry', ...base(), entryId: e.id, state: 'contested' })}>충돌로 표시</button>}{e.state !== 'superseded' && <button className={button} disabled={metadataDirty} onClick={() => void mutate({ operation: 'review-entry', ...base(), entryId: e.id, state: 'superseded' })}>이전 항목으로 보존</button>}</div>{e.sourceMemoryId && <p className="mt-2 text-xs text-[var(--ink-3)]">출처 기억 {e.sourceMemoryId}</p>}
        </details>;})}
        {!memory.entries.length && <p className="text-sm">AI로 내용을 정리하거나 직접 기억 항목을 작성하세요.</p>}
        <details open={!!entry.id||!compact}><summary className="min-h-11 cursor-pointer text-sm">직접 기억 항목 작성·수정</summary><label className="block text-sm">{entry.id ? '공통 항목 편집' : '새 공통 항목'}<input className={`${input} mt-1`} aria-label="공통 항목 제목" placeholder="제목" maxLength={80} value={entry.title} onChange={e => setEntry({ ...entry, title: e.target.value })} /></label>
        <textarea className={input} aria-label="공통 항목 내용" placeholder="함께 사용할 결정·규칙·검증된 교훈과 근거" rows={5} maxLength={4000} value={entry.body} onChange={e => setEntry({ ...entry, body: e.target.value })} />
        <button className={button} disabled={metadataDirty || memory.archived || !entry.title.trim() || !entry.body.trim()} onClick={() => void saveEntry()}>공통 항목 저장</button>{entry.id && <button className={`${button} ml-2`} onClick={() => setEntry({ id: '', title: '', body: '' })}>항목 편집 취소</button>}
        </details>
        <details open={!compact}><summary className="min-h-11 cursor-pointer text-sm">보관·백업·이력</summary>
        <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-[var(--ink-3)]">독립 ID {memory.id} · 리비전 {memory.revision}</span><button className={button} onClick={() => void exportMemory()}>{cloud?'사본 내보내기':'백업 내보내기'}</button><button className={button} disabled={metadataDirty} onClick={() => void mutate({ operation: 'archive', ...base(), archived: !memory.archived })}>{memory.archived ? '다시 사용' : '보관 · 적용 중지'}</button></div>
        {cloud&&<p data-testid="cloud-common-memory-export-guidance" className="text-xs">내보낸 JSON 파일은 내용 확인용 사본입니다. 클라우드 공통기억에서는 파일을 가져와 복원할 수 없습니다. 보관한 기억은 목록 관리·휴지통에서 복원하세요.</p>}
        <details><summary className="flex min-h-11 cursor-pointer items-center text-sm">최근 변경 이력</summary><ul className="mt-2 space-y-1 text-xs">{history.map(h => <li key={h.revision}>리비전 {h.revision} · {h.operation} · {new Date(h.createdAt).toLocaleString()}</li>)}</ul></details>
        </details>
      </fieldset>}
    </div>}
  </section>;
}
