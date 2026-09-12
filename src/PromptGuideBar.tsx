import {useEffect, useId, useRef, useState} from 'react';
import {promptGuideClient, type PromptGuideEntry, type PromptGuideSnapshot} from './promptGuideClient';
import {mergePromptGuideImport, type PromptGuideRepository} from './sharedPromptGuideClient';
import type {PromptGuideAnalysis, PromptGuideSuggestion} from './promptGuideSuggestions';
import type {PromptGuideSuggestionSample} from './promptGuideSuggestionLoader';
type DisplayAnalysis = PromptGuideAnalysis & {sample?: PromptGuideSuggestionSample};
import {copyAgentsToZPrompt} from './whatISaidPromptOriginClient';

export interface PromptGuideBarProps {
  repository?: PromptGuideRepository;
  shared?: boolean;
  importLocal?: () => Promise<PromptGuideSnapshot>;
  copyText?: (text: string) => Promise<void>;
  loadSuggestions?: (signal?: AbortSignal, options?: {includeShortRepeats?: boolean}) => Promise<DisplayAnalysis>;
}
type Draft = {id: string; title: string; body: string; pinned: boolean; base: PromptGuideEntry | null};
const NEW_DRAFT = '__new__';
const MAX_DRAFTS = 100;
const exclusionLabels: Record<string,string> = {'entry-limit':'표본 개수 제한','invalid-entry':'형식 확인 필요','not-human':'직접 입력 아님','duplicate-identity':'중복 수집','empty':'빈 기록','too-long':'긴 입력','text-budget':'분석 용량 제한','sensitive':'민감정보 포함 가능','quoted-or-code':'인용·코드','app-boilerplate':'앱 안내문','short':'짧은 지시'};
const copyDrafts = (value: Record<string, Draft>): Record<string, Draft> => Object.assign(Object.create(null), value);
const MAX_BODY = 16_384;
const MAX_STORE_BYTES = 1024 * 1024;
const button = 'shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40';
const input = 'w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--ink)]';
const emptyDraft = (): Draft => ({id: crypto.randomUUID(), title: '', body: '', pinned: false, base: null});
const editDraft = (entry: PromptGuideEntry): Draft => ({...entry, base: {...entry}});
const sameContent = (left: Pick<PromptGuideEntry, 'title' | 'body' | 'pinned'>, right: Pick<PromptGuideEntry, 'title' | 'body' | 'pinned'>) =>
  left.title === right.title && left.body === right.body && left.pinned === right.pinned;
const sameEntry = (left: PromptGuideEntry | undefined, right: PromptGuideEntry) =>
  !!left && left.id === right.id && left.updatedAt === right.updatedAt && sameContent(left, right);
function assertSubmittedReceipt(value: PromptGuideSnapshot, submitted: PromptGuideEntry[], before: PromptGuideSnapshot): void {
  const noChange = submitted.length === before.entries.length && submitted.every((entry,index)=>sameEntry(before.entries[index],entry));
  if ((value.revision === before.revision && !noChange) || value.entries.length !== submitted.length
    || submitted.some((entry, index) => !sameEntry(value.entries[index], entry))) {
    const error = new Error('저장 응답을 확인하지 못했습니다.') as Error & {code: string};
    error.code = 'PROMPT_GUIDES_RECEIPT_UNCONFIRMED'; throw error;
  }
}
const dirty = (draft: Draft) => draft.base ? !sameContent(draft, draft.base) : !!(draft.title || draft.body || draft.pinned);
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Saved prompts. Typing, opening and finding suggestions never save. */
export function PromptGuideBar({loadSuggestions, repository = promptGuideClient, shared = false, importLocal, copyText = copyAgentsToZPrompt}: PromptGuideBarProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogTitle = useId();
  const [snapshot, setSnapshot] = useState<PromptGuideSnapshot | null>(null);
  const snapshotRef = useRef<PromptGuideSnapshot | null>(null);
  const initialRead = useRef<Promise<PromptGuideSnapshot> | null>(null);
  const mounted = useRef(false);
  const [reading, setReading] = useState(true);
  const [saving, setSaving] = useState(false);
  const mutationBusy = useRef(false);
  const readBusy = useRef(true);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.create(null));
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [search, setSearch] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copiedTitle, setCopiedTitle] = useState<{title: string} | null>(null);
  const copyBusy = useRef(false);
  const [analysis, setAnalysis] = useState<DisplayAnalysis | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [includeShort, setIncludeShort] = useState(false);
  const [analyzedAt, setAnalyzedAt] = useState<string | null>(null);
  const suggestionSection = useRef<HTMLDivElement>(null);
  const suggestionAbort = useRef<AbortController | null>(null);

  const receiveSnapshot = (value: PromptGuideSnapshot) => {
    snapshotRef.current = value; setSnapshot(value); setReadError(''); setNeedsReload(false);
  };
  useEffect(() => {
    let active = true;
    mounted.current = true;
    // StrictMode's repeated effect setup attaches to the same initial request.
    initialRead.current ??= repository.read();
    void initialRead.current.then(value => {if (active) receiveSnapshot(value);})
      .catch(error => {if (active) setReadError(message(error, '저장한 가이드를 읽지 못했습니다.'));})
      .finally(() => {if (active) {readBusy.current = false; setReading(false);}});
    return () => {active = false; mounted.current = false; suggestionAbort.current?.abort();};
  }, []);
  useEffect(() => {
    if (!copiedTitle) return;
    const timer = setTimeout(() => setCopiedTitle(null), 3_000);
    return () => clearTimeout(timer);
  }, [copiedTitle]);

  const importSaved = async () => {
    if (!importLocal || needsReload || mutationBusy.current || readBusy.current || !snapshotRef.current) return;
    mutationBusy.current = true; setSaving(true); setActionError('');
    try {
      const before = snapshotRef.current;
      const imported = await importLocal();
      const entries = mergePromptGuideImport(before.entries, imported.entries);
      const result = await repository.save(before.revision, entries);
      assertSubmittedReceipt(result, entries, before);
      if (mounted.current) {receiveSnapshot(result); setNotice('이 기기에서 저장한 프롬프트를 Supabase 보관함에 가져왔습니다.');}
    } catch (error) {if (mounted.current) storeFailure(error);}
    finally {mutationBusy.current = false; if(mounted.current) setSaving(false);}
  };
  const reload = async (quiet = false) => {
    if (readBusy.current || mutationBusy.current) return;
    readBusy.current = true; setReading(true);
    try {
      const value = await repository.read();
      if (mounted.current) {receiveSnapshot(value); if (!quiet) setNotice('저장 목록을 다시 읽었습니다. 작성 중인 초안은 유지했습니다.');}
    } catch (error) {if (mounted.current) setReadError(message(error, '저장한 가이드를 읽지 못했습니다.'));}
    finally {readBusy.current = false; if (mounted.current) setReading(false);}
  };
  const rememberDraft = (key: string, value: Draft): boolean => {
    const next = copyDrafts(draftsRef.current);
    if (!next[key] && Object.keys(next).length >= MAX_DRAFTS) {
      const disposable = Object.keys(next).find(id => id !== activeKey && !dirty(next[id]!));
      if (!disposable) {setActionError('작성 중인 초안이 100개입니다. 일부 초안을 저장하거나 비운 뒤 다시 선택해 주세요.'); return false;}
      delete next[disposable];
    }
    next[key] = value; draftsRef.current = next; setDrafts(next); return true;
  };
  const chooseEntry = (entry: PromptGuideEntry) => {
    if (mutationBusy.current) return;
    const cached = draftsRef.current[entry.id];
    if (rememberDraft(entry.id, cached && dirty(cached) ? cached : editDraft(entry))) {
      setActiveKey(entry.id); setDeleteConfirm(false);
    }
  };
  const chooseNew = () => {
    if (mutationBusy.current) return;
    if (rememberDraft(NEW_DRAFT, draftsRef.current[NEW_DRAFT] ?? emptyDraft())) {
      setActiveKey(NEW_DRAFT); setDeleteConfirm(false);
    }
  };
  const showDialog = () => {
    if (!activeKey) chooseNew();
    if (!dialog.current?.open) {dialog.current?.showModal(); if (shared) void reload(true);}
  };
  const closeSuggestions = () => {
    suggestionAbort.current?.abort(); suggestionAbort.current = null;
    setAnalysis(null); setAnalyzedAt(null); setSuggestionError(''); setSuggesting(false); setDeleteConfirm(false);
  };
  const draft = activeKey ? drafts[activeKey] ?? null : null;
  const currentSaved = draft ? snapshot?.entries.find(entry => entry.id === draft.id) : undefined;
  const normalizedDraft = draft ? {...draft, title: draft.title.trim()} : null;
  const alreadySavedNew = !!(draft && !draft.base && currentSaved && normalizedDraft && sameContent(currentSaved, normalizedDraft));
  const changedSaved = !!(draft && snapshot && (draft.base
    ? !sameEntry(currentSaved, draft.base)
    : currentSaved && !alreadySavedNew));
  const blocked = !snapshot || reading || saving || !!readError || needsReload;
  const pinned = snapshot?.entries.filter(entry => entry.pinned) ?? [];
  const orphanDraftKeys = Object.keys(drafts).filter(key => key !== NEW_DRAFT && dirty(drafts[key]!) && !snapshot?.entries.some(entry => entry.id === key));

  const changeDraft = (changes: Partial<Pick<Draft, 'title' | 'body' | 'pinned'>>) => {
    if (!activeKey || !draft || mutationBusy.current) return;
    rememberDraft(activeKey, {...draft, ...changes}); setDeleteConfirm(false);
  };
  const copy = async (body: string, title: string) => {
    if (copyBusy.current || !body.trim()) return;
    copyBusy.current = true; setCopying(true); setCopiedTitle(null);
    try {await copyText(body); if (mounted.current) {setNotice(`“${title || '작성 중인 프롬프트'}” 복사됨`); setCopiedTitle({title});}}
    catch (error) {if (mounted.current) setActionError(message(error, '프롬프트를 복사하지 못했습니다.'));}
    finally {copyBusy.current = false; if (mounted.current) setCopying(false);}
  };
  const storeFailure = (error: unknown) => {
    // Transport/JSON failures can occur after a committed write. Reload before retry.
    setNeedsReload(true);
    if (['PROMPT_GUIDES_CONFLICT', 'PROMPT_GUIDES_RECEIPT_UNCONFIRMED', 'PROMPT_GUIDES_RESULT_UNCERTAIN', 'PROMPT_GUIDE_REQUEST_TIMEOUT'].includes((error as {code?: string} | null)?.code ?? '')) {
      setNeedsReload(true);
      setActionError((error as {code?:string})?.code === 'PROMPT_GUIDES_CONFLICT'
        ? '다른 창에서 저장 목록이 바뀌었습니다. 덮어쓰지 않았습니다. 목록을 다시 읽어 비교해 주세요. 현재 초안은 유지했습니다.'
        : '저장 결과를 확인해야 합니다. 목록을 다시 읽어 비교해 주세요. 현재 초안은 유지했습니다.');
    } else setActionError(message(error, '저장 결과를 확인하지 못했습니다. 현재 초안은 유지했습니다.'));
  };
  const persist = async () => {
    const current = snapshotRef.current;
    if (!draft || !activeKey || !current || blocked || mutationBusy.current) return;
    if (changedSaved) {setActionError('저장본이 변경되거나 삭제되어 덮어쓰지 않았습니다. 현재 초안은 새 가이드로 작성할 수 있습니다.'); return;}
    if (!draft.title.trim() || draft.title.length > 120 || !draft.body.trim() || draft.body.length > MAX_BODY
      || /[\x00-\x1f\x7f]/.test(draft.title) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(draft.body)) {
      setActionError('제목은 1~120자, 본문은 1~16,384자로 입력해 주세요. 제어 문자는 저장할 수 없습니다.'); return;
    }
    if (alreadySavedNew && currentSaved) {
      const next = copyDrafts(draftsRef.current);
      const separateDraft = activeKey !== currentSaved.id ? next[currentSaved.id] : undefined;
      delete next[activeKey];
      next[currentSaved.id] = separateDraft && dirty(separateDraft) ? separateDraft : editDraft(currentSaved);
      draftsRef.current = next; setDrafts(next); setActiveKey(currentSaved.id); setActionError(''); setNotice('같은 가이드가 이미 저장되어 있음을 확인했습니다.'); return;
    }
    const entry: PromptGuideEntry = {id: draft.id, title: draft.title.trim(), body: draft.body, pinned: draft.pinned, updatedAt: new Date().toISOString()};
    const entries = draft.base ? current.entries.map(item => item.id === entry.id ? entry : item) : [...current.entries, entry];
    if (entries.length > 100) {setActionError('가이드는 최대 100개까지 저장할 수 있습니다. 기존 가이드를 정리해 주세요. 초안은 유지했습니다.'); return;}
    if (new TextEncoder().encode(JSON.stringify({expectedRevision: current.revision, entries})).byteLength > MAX_STORE_BYTES) {
      setActionError('전체 저장 용량 1 MiB를 넘었습니다. 일부 내용을 줄인 뒤 다시 저장해 주세요. 초안은 유지했습니다.'); return;
    }
    mutationBusy.current = true; setSaving(true); setActionError('');
    const savedKey = activeKey;
    try {
      const value = await repository.save(current.revision, entries);
      if (!mounted.current) return;
      assertSubmittedReceipt(value, entries, current);
      const saved = value.entries.find(item => item.id === entry.id);
      receiveSnapshot(value);
      if (!saved) throw new Error('저장 결과에서 해당 가이드를 확인하지 못했습니다. 초안은 유지했습니다.');
      const next = copyDrafts(draftsRef.current);
      // A lost new-guide receipt can leave both NEW_DRAFT and an edited saved-id
      // draft. Confirming that receipt must not overwrite the separate edit.
      const separateDraft = savedKey !== saved.id ? next[saved.id] : undefined;
      delete next[savedKey];
      next[saved.id] = separateDraft && dirty(separateDraft) ? separateDraft : editDraft(saved);
      draftsRef.current = next; setDrafts(next); setActiveKey(saved.id); setNotice(shared ? 'Supabase 보관함에 저장했습니다. 다른 기기에서도 사용할 수 있습니다.' : '가이드를 이 기기에 암호화해 저장했습니다.');
    } catch (error) {if (mounted.current) storeFailure(error);}
    finally {mutationBusy.current = false; if (mounted.current) setSaving(false);}
  };
  const remove = async () => {
    const current = snapshotRef.current;
    if (!current || !draft?.base || !activeKey || blocked || changedSaved || mutationBusy.current) return;
    mutationBusy.current = true; setSaving(true); setActionError('');
    const removingKey = activeKey;
    try {
      const submitted = current.entries.filter(entry => entry.id !== draft.id);
      const value = await repository.save(current.revision, submitted);
      if (!mounted.current) return;
      assertSubmittedReceipt(value, submitted, current);
      receiveSnapshot(value);
      if (value.entries.some(entry => entry.id === draft.id)) throw new Error('삭제 결과를 확인하지 못했습니다. 현재 초안은 유지했습니다.');
      setDeleteConfirm(false);
      if (!dirty(draft)) {
        const next = copyDrafts(draftsRef.current); delete next[removingKey]; draftsRef.current = next; setDrafts(next); setActiveKey(null);
      }
      setNotice(dirty(draft) ? '저장본을 삭제했습니다. 작성 중인 초안은 유지했습니다.' : '가이드를 삭제했습니다.');
    } catch (error) {if (mounted.current) storeFailure(error);}
    finally {mutationBusy.current = false; if (mounted.current) setSaving(false);}
  };
  const asNew = (source: Pick<Draft, 'title' | 'body' | 'pinned'>) => {
    const cached = draftsRef.current[NEW_DRAFT];
    if (cached && dirty(cached)) {setActionError('새 가이드 초안이 남아 있습니다. 먼저 저장하거나 새 초안을 비운 뒤 다시 선택해 주세요.'); return;}
    if (rememberDraft(NEW_DRAFT, {...emptyDraft(), title: source.title, body: source.body, pinned: source.pinned})) {setActiveKey(NEW_DRAFT); setDeleteConfirm(false); setNotice('새 초안에 넣었습니다. 저장 버튼을 눌러야 저장됩니다.');}
  };
  const clearDraft = () => {
    if (!draft || !activeKey || mutationBusy.current) return;
    // This explicit discard action is the only path that replaces user input.
    if (activeKey === NEW_DRAFT) rememberDraft(NEW_DRAFT, emptyDraft());
    else if (currentSaved) rememberDraft(activeKey, editDraft(currentSaved));
    else {const next = copyDrafts(draftsRef.current); delete next[activeKey]; draftsRef.current = next; setDrafts(next); setActiveKey(null);}
    setDeleteConfirm(false); setActionError('');
  };
  const findSuggestions = async () => {
    if (!loadSuggestions || suggesting || mutationBusy.current) return;
    const controller = new AbortController(); suggestionAbort.current?.abort(); suggestionAbort.current = controller;
    setSuggesting(true); setSuggestionError(''); setAnalysis(null); setAnalyzedAt(null);
    suggestionSection.current?.scrollIntoView({block: 'start'});
    try {
      const result = await loadSuggestions(controller.signal, {includeShortRepeats: includeShort});
      if (mounted.current && !controller.signal.aborted && dialog.current?.open && suggestionAbort.current === controller) {setAnalysis(result); setAnalyzedAt(new Date().toISOString());}
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && suggestionAbort.current === controller) setSuggestionError(message(error, '반복 요청을 확인하지 못했습니다.'));
    } finally {
      if (suggestionAbort.current === controller) {suggestionAbort.current = null; if (mounted.current) setSuggesting(false);}
    }
  };
  const chooseSuggestion = (candidate: PromptGuideSuggestion) => {
    if (candidate.title.length > 120 || candidate.body.length > MAX_BODY || !candidate.title.trim() || !candidate.body.trim()) {
      setSuggestionError('추천 내용이 가이드 입력 범위를 벗어났습니다. 저장하지 않았습니다.'); return;
    }
    asNew({title: candidate.title, body: candidate.body, pinned: false});
  };

  return <>
    <div data-testid="prompt-guide-bar" className="flex h-8 min-w-0 max-w-full items-center gap-1 text-xs whitespace-normal">
      <button type="button" data-testid="prompt-guide-open" onClick={showDialog} title={readError || actionError || '자주 쓰는 프롬프트 가이드'} className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-2 text-[var(--ink)]">
        자주 쓰는 프롬프트{readError || actionError ? ' · 확인 필요' : ''}
      </button>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {pinned.slice(0, 3).map(entry => <button key={entry.id} type="button" data-testid="prompt-guide-pinned-copy" data-guide-id={entry.id}
          aria-label={`${entry.title} 프롬프트 복사`} title={`${entry.title} · 복사`} disabled={copying} onClick={() => void copy(entry.body, entry.title)}
          className="h-8 min-w-0 max-w-32 truncate rounded-lg border border-[var(--line)] px-2 text-[var(--ink-2)] disabled:opacity-40">{copiedTitle?.title === entry.title ? '복사됨 ✓' : entry.title}</button>)}
      </div>
      {pinned.length > 3 && <button type="button" data-testid="prompt-guide-more" aria-label={`고정 가이드 ${pinned.length - 3}개 더 보기`} onClick={showDialog} className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-2">+{pinned.length - 3}</button>}
      <span className="sr-only" role="status" aria-live="polite">{reading ? '가이드 불러오는 중' : readError || actionError || notice}</span>
    </div>
    <dialog ref={dialog} onClick={event => {if(event.target === dialog.current) {const r=dialog.current.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) dialog.current.close();}}} data-testid="prompt-guide-dialog" aria-labelledby={dialogTitle} onClose={closeSuggestions}
      className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-2xl backdrop:bg-black/45"
      style={{width: 'min(54rem, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)', padding: 0, whiteSpace: 'normal', overflowWrap: 'anywhere'}}>
      <div className="flex max-h-[calc(100dvh-24px)] min-w-0 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--line)] p-4">
          <div className="min-w-0"><h2 id={dialogTitle} className="text-base font-semibold">자주 쓰는 프롬프트 가이드</h2>
            <p className="mt-1 text-xs text-[var(--ink-3)]">{shared ? '개인 Supabase의 허용 회원끼리 공유합니다. 모바일에서도 복사해 원하는 AI에 붙여 넣으세요.' : '저장한 가이드는 이 기기에서 암호화해 보관합니다. 복사한 뒤 원하는 AI에 붙여 넣으세요.'}</p></div>
          <button type="button" data-testid="prompt-guide-close" autoFocus aria-label="프롬프트 가이드 닫기" onClick={() => dialog.current?.close()} className={button}>닫기</button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--ink-3)]">{reading ? '불러오는 중…' : snapshot ? `저장 ${snapshot.entries.length} / 100개` : '저장 목록 확인 필요'}</p>
            <div className="flex flex-wrap gap-2">
              {importLocal && <button type="button" disabled={saving || reading || needsReload || !snapshot} onClick={() => void importSaved()} className={button}>이 기기 프롬프트 가져오기</button>}
              {loadSuggestions && <button type="button" data-testid="prompt-guide-suggestions-load" disabled={!loadSuggestions || suggesting || saving} onClick={() => void findSuggestions()} className={button}>{suggesting ? '직접 입력한 기록 확인 중…' : '최근 입력·추천 찾기'}</button>}
              <button type="button" data-testid="prompt-guide-reload" onClick={() => void reload()} disabled={reading || saving} className={button}>목록 다시 읽기</button>
              <button type="button" data-testid="prompt-guide-new" onClick={chooseNew} disabled={saving} className={button}>새 가이드 작성</button>
            </div>
          </div>
          {readError && <p role="alert" data-testid="prompt-guide-read-error" className="mb-3 whitespace-pre-wrap break-words text-sm text-red-400 [overflow-wrap:anywhere]">{readError} 저장 목록을 확인할 때까지 저장·삭제하지 않습니다. 초안은 유지됩니다.</p>}
          {actionError && <p role="alert" data-testid="prompt-guide-action-error" className="mb-3 whitespace-pre-wrap break-words text-sm text-red-400 [overflow-wrap:anywhere]">{actionError}</p>}
          {notice && <p role="status" className="mb-3 break-words text-xs text-[var(--ink-3)] [overflow-wrap:anywhere]">{notice}</p>}
          <div className="grid min-w-0 grid-cols-1 gap-4 min-[720px]:grid-cols-[14rem_minmax(0,1fr)]">
            <aside className="min-w-0">
              <h3 className="mb-2 text-xs font-semibold">저장한 가이드</h3>
              <input type="search" aria-label="프롬프트 검색" placeholder="제목·내용 검색" value={search} onChange={event => setSearch(event.target.value)} className={`${input} mb-2`}/>
              {snapshot?.entries.length === 0 && !readError && <p className="text-xs text-[var(--ink-3)]">아직 저장한 가이드가 없습니다. 새 가이드를 작성해 주세요.</p>}
              <ul data-testid="prompt-guide-saved-list" className="max-h-64 space-y-1 overflow-y-auto">
                {snapshot?.entries.filter(entry => `${entry.title} ${entry.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(entry => <li key={entry.id} className="flex min-w-0 items-center gap-1">
                  <button type="button" data-testid="prompt-guide-edit" data-guide-id={entry.id} aria-pressed={activeKey === entry.id} disabled={saving}
                    onClick={() => chooseEntry(entry)} className="min-w-0 flex-1 rounded-lg border border-[var(--line)] px-2 py-2 text-left text-xs aria-pressed:bg-[var(--sunken)]">
                    <span className="block truncate" title={entry.title}>{entry.pinned ? '★ ' : ''}{entry.title}{drafts[entry.id] && dirty(drafts[entry.id]!) ? ' · 초안' : ''}</span>
                  </button>
                  <button type="button" data-testid="prompt-guide-list-copy" data-guide-id={entry.id} aria-label={`${entry.title} 복사`} disabled={copying} onClick={() => void copy(entry.body, entry.title)} className="shrink-0 rounded-lg border border-[var(--line)] px-2 py-2 text-xs">복사</button>
                </li>)}
              </ul>
              {(drafts[NEW_DRAFT] || orphanDraftKeys.length > 0) && <div className="mt-3 space-y-1 border-t border-[var(--line)] pt-3">
                <h3 className="text-xs font-semibold">저장되지 않은 초안</h3>
                {drafts[NEW_DRAFT] && <button type="button" onClick={() => {setActiveKey(NEW_DRAFT); setDeleteConfirm(false);}} disabled={saving} className="block max-w-full truncate py-1 text-left text-xs">새 가이드 초안</button>}
                {orphanDraftKeys.map(key => <button type="button" key={key} onClick={() => {setActiveKey(key); setDeleteConfirm(false);}} disabled={saving} className="block max-w-full truncate py-1 text-left text-xs">{drafts[key]!.title || '이름 없는 초안'} · 저장본 없음</button>)}
              </div>}
            </aside>
            <div className="min-w-0">
              {draft ? <form onSubmit={event => {event.preventDefault(); void persist();}} className="min-w-0 space-y-3">
                <label className="block text-xs">제목 <span className="text-[var(--ink-3)]">{draft.title.length}/120</span>
                  <input data-testid="prompt-guide-title" value={draft.title} maxLength={120} disabled={saving} onChange={event => changeDraft({title: event.target.value})} className={`${input} mt-1`} /></label>
                <label className="block text-xs">붙여 넣을 프롬프트 <span className="text-[var(--ink-3)]">{draft.body.length.toLocaleString('ko-KR')}/16,384</span>
                  <textarea data-testid="prompt-guide-body" value={draft.body} maxLength={MAX_BODY} rows={9} disabled={saving} onChange={event => changeDraft({body: event.target.value})} className={`${input} mt-1 resize-y whitespace-pre-wrap break-words [overflow-wrap:anywhere]`} /></label>
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid="prompt-guide-pin" checked={draft.pinned} disabled={saving} onChange={event => changeDraft({pinned: event.target.checked})} />저장 후 상단에 고정</label>
                {changedSaved && <div role="alert" data-testid="prompt-guide-conflict" className="rounded-lg border border-amber-500/40 p-3 text-xs leading-relaxed">
                  <p>저장본이 변경되거나 삭제되었습니다. 현재 초안으로 덮어쓰지 않습니다.</p>
                  {currentSaved && <details className="mt-2"><summary className="cursor-pointer">현재 저장본 비교</summary><p className="mt-2 break-words font-semibold [overflow-wrap:anywhere]">{currentSaved.title}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans [overflow-wrap:anywhere]">{currentSaved.body}</pre></details>}
                  <button type="button" data-testid="prompt-guide-as-new" disabled={saving} onClick={() => asNew(draft)} className={`${button} mt-2`}>현재 초안을 새 가이드로 작성</button>
                </div>}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" data-testid="prompt-guide-save" disabled={blocked || changedSaved || !draft.title.trim() || !draft.body.trim()} className={button}>{saving ? '저장 중…' : '가이드 저장'}</button>
                  <button type="button" data-testid="prompt-guide-copy-draft" disabled={copying || !draft.body.trim()} onClick={() => void copy(draft.body, draft.title)} className={button}>프롬프트 복사</button>
                  <button type="button" data-testid="prompt-guide-clear-draft" disabled={saving} onClick={clearDraft} className={button}>{currentSaved ? '초안 버리고 저장본 보기' : '초안 비우기'}</button>
                  {draft.base && currentSaved && <button type="button" data-testid="prompt-guide-delete" disabled={blocked || changedSaved} onClick={() => setDeleteConfirm(true)} className={button}>저장본 삭제</button>}
                </div>
                {deleteConfirm && <div className="rounded-lg border border-red-400/40 p-3 text-xs">
                  <p>이 가이드의 저장본을 삭제할까요? 수정 중인 초안은 유지합니다.</p>
                  <div className="mt-2 flex flex-wrap gap-2"><button type="button" data-testid="prompt-guide-confirm-delete" disabled={blocked || changedSaved} onClick={() => void remove()} className={button}>삭제하기</button><button type="button" data-testid="prompt-guide-cancel-delete" disabled={saving} onClick={() => setDeleteConfirm(false)} className={button}>돌아가기</button></div>
                </div>}
              </form> : <p className="text-sm text-[var(--ink-3)]">가이드를 선택하거나 새 가이드를 작성해 주세요.</p>}
            </div>
          </div>
          {loadSuggestions && <div ref={suggestionSection} className="mt-5 border-t border-[var(--line)] pt-4">
            <h3 className="text-sm font-semibold">직접 입력한 기록에서 가이드 찾기</h3>
            <p className="mt-1 text-xs text-[var(--ink-3)]">최대 500개 표본에서 최근 입력과 반복 요청을 확인합니다. 같은 문장 또는 경로·숫자만 다른 요청이 2회 이상일 때 추천합니다. 의미가 비슷한 문장을 AI로 묶지는 않습니다. {'{변수}'} 부분은 수정한 뒤 저장해 주세요.</p>
            <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" data-testid="prompt-guide-include-short" checked={includeShort} disabled={suggesting} onChange={event => {setIncludeShort(event.target.checked); setAnalysis(null); setAnalyzedAt(null);}}/>짧은 지시도 포함 (예: 진행해) · 변경 후 다시 조회</label>
            <button type="button" data-testid="prompt-guide-suggestions-refresh" disabled={!loadSuggestions || suggesting || saving} onClick={() => void findSuggestions()} className={`${button} mt-2`}>{suggesting ? '조회 중…' : '입력 기록 다시 조회'}</button>
            {!analysis && !suggesting && !suggestionError && <p className="mt-2 text-xs text-[var(--ink-3)]">위의 ‘최근 입력·추천 찾기’를 누르세요. 조회나 초안 선택만으로 저장되지는 않습니다.</p>}
            {suggestionError && <p role="alert" data-testid="prompt-guide-suggestions-error" className="mt-2 break-words text-sm text-red-400 [overflow-wrap:anywhere]">{suggestionError}</p>}
            {analysis && <div className="mt-3">
              <p role="status" className="mb-2 text-xs text-[var(--ink-3)]">입력 기록 {analysis.stats.receivedEntries}개 표본 · 실제 분석 {analysis.stats.sampledEntries}개 · 제외 {analysis.stats.excludedEntries}개 · 추천 {analysis.candidates.length}개{analysis.stats.candidatesOmitted ? ` · 제한으로 생략 ${analysis.stats.candidatesOmitted}개` : ''}</p>
              {analyzedAt && <p data-testid="prompt-guide-analysis-time" className="mb-2 text-xs text-[var(--ink-3)]">조회 완료 {new Date(analyzedAt).toLocaleTimeString('ko-KR')}{analysis.sample?.recordedRange?.newest ? ` · 표본의 최신 입력 ${new Date(analysis.sample.recordedRange.newest).toLocaleString('ko-KR')}` : ''}</p>}
              {analysis.sample && <p className="mb-2 text-xs text-[var(--ink-3)]" data-testid="prompt-guide-sample-scope">
                {analysis.sample.source === 'supabase' ? '동기화한 입력 기록' : '이 기기의 입력 기록'} · {analysis.sample.fetched}개 조회
                {analysis.sample.hasMore ? ' · 표본 밖의 기록이 더 있습니다.' : ''}
                {analysis.sample.scan.complete === false ? ' · 일부 기록은 읽지 못해 표본이 제한되었습니다.' : analysis.sample.scan.complete === null ? ' · 전체 조회 상태는 확인되지 않았습니다.' : ''}
              </p>}
              {analysis.stats.excludedEntries > 0 && <details className="mb-2 text-xs text-[var(--ink-3)]"><summary>제외한 기록 기준</summary>
                <p className="mt-1">{Object.entries(analysis.stats.excludedByReason).filter(([,count])=>count>0).map(([reason,count])=>`${exclusionLabels[reason] ?? reason} ${count}개`).join(' · ')}</p>
              </details>}
              <h4 className="mb-2 text-xs font-semibold">자주 쓰는 요청 추천</h4>
              {analysis.candidates.length === 0 ? <p className="text-xs">반복 조건에 맞는 추천이 없습니다. 아래 최근 입력에서 직접 골라 가이드로 만들 수 있습니다.</p> : <ul className="max-h-56 space-y-2 overflow-y-auto">
                {analysis.candidates.map(candidate => <li key={candidate.id} className="rounded-lg border border-[var(--line)] p-3">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2"><strong className="min-w-0 break-words text-xs [overflow-wrap:anywhere]">{candidate.title} · {candidate.count}회</strong><button type="button" data-testid="prompt-guide-suggestion-use" data-suggestion-id={candidate.id} disabled={saving} onClick={() => chooseSuggestion(candidate)} className={button}>새 초안으로 사용</button></div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs text-[var(--ink-3)] [overflow-wrap:anywhere]">{candidate.body}</p>
                </li>)}
              </ul>}
              <h4 className="mb-2 mt-4 text-xs font-semibold">표본 안의 최근 입력 · 최대 10개</h4>
              <p className="mb-2 text-xs text-[var(--ink-3)]">입력 시각순으로 표시합니다. 같은 본문은 한 번만 표시하고 민감정보·시스템 알림 등은 제외합니다.</p>
              {!analysis.recent?.length ? <p className="text-xs">표시 조건에 맞는 최근 입력이 없습니다. 제외 기준과 조회 범위를 확인해 주세요.</p> : <ul data-testid="prompt-guide-recent-list" className="max-h-72 space-y-2 overflow-y-auto">
                {analysis.recent.map(entry => <li key={entry.id} className="rounded-lg border border-[var(--line)] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2"><time className="text-xs text-[var(--ink-3)]" dateTime={entry.recordedAt}>{new Date(entry.recordedAt).toLocaleString('ko-KR')}{entry.generalized ? ' · 경로 등은 변수로 표시' : ''}</time><button type="button" data-testid="prompt-guide-recent-use" disabled={saving} onClick={() => asNew({title: entry.title, body: entry.body, pinned: false})} className={button}>새 초안으로 사용</button></div>
                  <p className="mt-2 whitespace-pre-wrap break-words text-xs [overflow-wrap:anywhere]">{entry.body}</p>
                </li>)}
              </ul>}
            </div>}
          </div>}
        </div>
      </div>
    </dialog>
  </>;
}
