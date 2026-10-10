import {memo, useEffect, useId, useMemo, useRef, useState} from 'react';
import {promptGuideClient, type PromptGuideEntry, type PromptGuideSnapshot} from './promptGuideClient';
import {mergePromptGuideImport, type PromptGuideRepository} from './sharedPromptGuideClient';
import type {PromptGuideAnalysis, PromptGuideSuggestion} from './promptGuideSuggestions';
import type {PromptGuideSuggestionSample} from './promptGuideSuggestionLoader';
type DisplayAnalysis = PromptGuideAnalysis & {sample?: PromptGuideSuggestionSample};
import {copyAgentsToZPrompt} from './whatISaidPromptOriginClient';
import {
  PROMPT_KIND_HELP, PROMPT_KIND_LABEL, STANDARD_COMMAND_SECTIONS, buildStandardCommandMetaPrompt, isBuiltinCommandId,
  entriesToStoreAfterReorder, pinnedSimplePrompts, promptKindOf, reorderWithin, withBuiltinCommands, type LibraryEntry, type PromptKind,
} from './promptLibrary';
import {usePromptPreview} from './components/PromptPreview';
import {promptLibraryHub} from './promptLibraryHub';

/** Opens a Workroom draft in a registered project. Only the Mac app provides it. */
export interface PromptWorkroomBridge {
  projects: ReadonlyArray<{id: string; label: string}>;
  defaultProjectId?: string;
  open(targetId: string, title: string, prompt: string): void;
}

export interface PromptGuideBarProps {
  repository?: PromptGuideRepository;
  shared?: boolean;
  importLocal?: () => Promise<PromptGuideSnapshot>;
  copyText?: (text: string) => Promise<void>;
  loadSuggestions?: (signal?: AbortSignal, options?: {includeShortRepeats?: boolean}) => Promise<DisplayAnalysis>;
  /** 「AI로 규격 명령 만들기」 opens a Workroom draft through this. Absent → copy the request instead. */
  workroom?: PromptWorkroomBridge;
  /** The one desktop bar publishes its library to the 「도구·연결」 command buttons. */
  publishToTools?: boolean;
}
type Draft = {id: string; title: string; body: string; pinned: boolean; kind: PromptKind; base: LibraryEntry | null};
const NEW_DRAFT = '__new__';
const NEW_COMMAND = '__new_command__';
const newKey = (kind: PromptKind) => kind === 'command' ? NEW_COMMAND : NEW_DRAFT;
const isNewKey = (key: string) => key === NEW_DRAFT || key === NEW_COMMAND;
const MAX_DRAFTS = 100;
const exclusionLabels: Record<string,string> = {'entry-limit':'표본 개수 제한','invalid-entry':'형식 확인 필요','not-human':'직접 입력 아님','duplicate-identity':'중복 수집','empty':'빈 기록','too-long':'긴 입력','text-budget':'분석 용량 제한','sensitive':'민감정보 포함 가능','quoted-or-code':'인용·코드','app-boilerplate':'앱 안내문','short':'짧은 지시'};
const copyDrafts = (value: Record<string, Draft>): Record<string, Draft> => Object.assign(Object.create(null), value);
const MAX_BODY = 16_384;
const MAX_STORE_BYTES = 1024 * 1024;
const button = 'shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40';
const input = 'w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--sunken)] px-3 py-2 text-sm text-[var(--ink)]';
const emptyDraft = (kind: PromptKind = 'simple'): Draft => ({id: crypto.randomUUID(), title: '', body: '', pinned: false, kind, base: null});
const editDraft = (entry: LibraryEntry): Draft => ({id: entry.id, title: entry.title, body: entry.body, pinned: entry.pinned, kind: promptKindOf(entry), base: {...entry}});
type Content = Pick<PromptGuideEntry, 'title' | 'body' | 'pinned' | 'kind'>;
const sameContent = (left: Content, right: Content) =>
  left.title === right.title && left.body === right.body && left.pinned === right.pinned && promptKindOf(left) === promptKindOf(right);
const commandTemplate = () => STANDARD_COMMAND_SECTIONS.map(section => `## ${section}\n- `).join('\n\n');
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
const draftContent = (draft: Draft): Content => ({title: draft.title, body: draft.body, pinned: draft.pinned, ...(draft.kind === 'command' ? {kind: 'command' as const} : {})});
const dirty = (draft: Draft) => draft.base ? !sameContent(draftContent(draft), draft.base) : !!(draft.title || draft.body || draft.pinned);
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Saved prompts. Typing, opening and finding suggestions never save. Memoized: the host App re-renders often. */
export const PromptGuideBar = memo(function PromptGuideBar({loadSuggestions, repository = promptGuideClient, shared = false, importLocal, copyText = copyAgentsToZPrompt, workroom, publishToTools = false}: PromptGuideBarProps) {
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
  const [kindTab, setKindTab] = useState<PromptKind>('simple');
  const [aiDescription, setAiDescription] = useState('');
  const [aiProjectId, setAiProjectId] = useState('');
  const preview = usePromptPreview();

  const receiveSnapshot = (value: PromptGuideSnapshot) => {
    snapshotRef.current = value; setSnapshot(value); setReadError(''); setNeedsReload(false);
    if (publishToTools) promptLibraryHub.publish(value.entries);
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
  const openFromToolsRef = useRef<(kind: PromptKind) => void>(() => {});
  useEffect(() => {
    if (!publishToTools) return;
    promptLibraryHub.setOpenHandler(kind => openFromToolsRef.current(kind));
    return () => {promptLibraryHub.setOpenHandler(null); promptLibraryHub.publish(null);};
  }, [publishToTools]);
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
  const chooseEntry = (entry: LibraryEntry) => {
    if (mutationBusy.current) return;
    const cached = draftsRef.current[entry.id];
    if (rememberDraft(entry.id, cached && dirty(cached) ? cached : editDraft(entry))) {
      setActiveKey(entry.id); setKindTab(promptKindOf(entry)); setDeleteConfirm(false);
    }
  };
  const chooseNew = (kind: PromptKind = kindTab) => {
    if (mutationBusy.current) return;
    const key = newKey(kind);
    if (rememberDraft(key, draftsRef.current[key] ?? emptyDraft(kind))) {
      setActiveKey(key); setKindTab(kind); setDeleteConfirm(false);
    }
  };
  const chooseDraftKey = (key: string) => {setActiveKey(key); const found = draftsRef.current[key]; if (found) setKindTab(found.kind); setDeleteConfirm(false);};
  const showDialog = (kind?: PromptKind) => {
    const activeKind = activeKey ? draftsRef.current[activeKey]?.kind : undefined;
    if (kind && activeKind !== kind) {
      // Opening to manage a kind shows its first saved item rather than a blank draft.
      const first = snapshotRef.current ? withBuiltinCommands(snapshotRef.current.entries).find(entry => promptKindOf(entry) === kind) : undefined;
      if (first) chooseEntry(first); else chooseNew(kind);
    } else if (!activeKey) chooseNew();
    if (!dialog.current?.open) {dialog.current?.showModal(); if (shared) void reload(true);}
  };
  openFromToolsRef.current = kind => showDialog(kind);
  const closeSuggestions = () => {
    suggestionAbort.current?.abort(); suggestionAbort.current = null;
    setAnalysis(null); setAnalyzedAt(null); setSuggestionError(''); setSuggesting(false); setDeleteConfirm(false);
  };
  const libraryEntries = useMemo(() => snapshot ? withBuiltinCommands(snapshot.entries) : [], [snapshot]);
  const draft = activeKey ? drafts[activeKey] ?? null : null;
  const currentSaved = draft ? libraryEntries.find(entry => entry.id === draft.id) : undefined;
  const normalizedDraft = draft ? {...draftContent(draft), title: draft.title.trim()} : null;
  const alreadySavedNew = !!(draft && !draft.base && currentSaved && normalizedDraft && sameContent(currentSaved, normalizedDraft));
  const changedSaved = !!(draft && snapshot && (draft.base
    ? !sameEntry(currentSaved, draft.base)
    : currentSaved && !alreadySavedNew));
  const blocked = !snapshot || reading || saving || !!readError || needsReload;
  const pinned = useMemo(() => pinnedSimplePrompts(snapshot?.entries ?? []), [snapshot]);
  const orphanDraftKeys = Object.keys(drafts).filter(key => !isNewKey(key) && dirty(drafts[key]!) && !libraryEntries.some(entry => entry.id === key));
  // An untouched blank new draft is not worth listing unless it is the one being edited.
  const showNewDraft = (key: string) => !!drafts[key] && (dirty(drafts[key]!) || activeKey !== key);
  const visibleEntries = libraryEntries.filter(entry => promptKindOf(entry) === kindTab
    && `${entry.title} ${entry.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

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
    if (alreadySavedNew && currentSaved && !currentSaved.virtual) {
      const next = copyDrafts(draftsRef.current);
      const separateDraft = activeKey !== currentSaved.id ? next[currentSaved.id] : undefined;
      delete next[activeKey];
      next[currentSaved.id] = separateDraft && dirty(separateDraft) ? separateDraft : editDraft(currentSaved);
      draftsRef.current = next; setDrafts(next); setActiveKey(currentSaved.id); setActionError(''); setNotice('같은 가이드가 이미 저장되어 있음을 확인했습니다.'); return;
    }
    const entry: PromptGuideEntry = {id: draft.id, title: draft.title.trim(), body: draft.body, pinned: draft.pinned, updatedAt: new Date().toISOString(),
      ...(draft.kind === 'command' ? {kind: 'command' as const} : {})};
    // A built-in 규격 명령 is not stored until the user first changes it; then its copy is appended.
    const entries = draft.base && current.entries.some(item => item.id === entry.id)
      ? current.entries.map(item => item.id === entry.id ? entry : item) : [...current.entries, entry];
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
      draftsRef.current = next; setDrafts(next); setActiveKey(saved.id); setNotice(shared ? 'Supabase 보관함에 저장했습니다. 다른 기기에서도 사용할 수 있습니다.' : `${PROMPT_KIND_LABEL[draft.kind]}을 이 기기에 암호화해 저장했습니다.`);
    } catch (error) {if (mounted.current) storeFailure(error);}
    finally {mutationBusy.current = false; if (mounted.current) setSaving(false);}
  };
  const remove = async () => {
    const current = snapshotRef.current;
    if (!current || !draft?.base || draft.base.virtual || isBuiltinCommandId(draft.id) || !activeKey || blocked || changedSaved || mutationBusy.current) return;
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
  const asNew = (source: Pick<Draft, 'title' | 'body' | 'pinned'> & {kind?: PromptKind}): boolean => {
    const kind = source.kind ?? 'simple', key = newKey(kind);
    const cached = draftsRef.current[key];
    if (cached && dirty(cached)) {setActionError(`새 ${PROMPT_KIND_LABEL[kind]} 초안이 남아 있습니다. 먼저 저장하거나 새 초안을 비운 뒤 다시 선택해 주세요.`); return false;}
    if (rememberDraft(key, {...emptyDraft(kind), title: source.title, body: source.body, pinned: source.pinned})) {setActiveKey(key); setKindTab(kind); setDeleteConfirm(false); setNotice('새 초안에 넣었습니다. 저장 버튼을 눌러야 저장됩니다.'); return true;}
    return false;
  };
  const move = async (id: string, delta: -1 | 1) => {
    const current = snapshotRef.current;
    if (!current || blocked || mutationBusy.current) return;
    const listed = withBuiltinCommands(current.entries);
    const reordered = reorderWithin(listed, id, delta);
    if (reordered === listed) return;
    // A built-in command is stored only when its position can no longer be reproduced by appending it.
    const entries = entriesToStoreAfterReorder(reordered);
    if (entries.length > 100) {setActionError('항목은 최대 100개까지 저장할 수 있습니다. 기존 항목을 정리해 주세요.'); return;}
    mutationBusy.current = true; setSaving(true); setActionError('');
    try {
      const value = await repository.save(current.revision, entries);
      if (!mounted.current) return;
      assertSubmittedReceipt(value, entries, current);
      receiveSnapshot(value); setNotice('순서를 바꿔 저장했습니다.');
    } catch (error) {if (mounted.current) storeFailure(error);}
    finally {mutationBusy.current = false; if (mounted.current) setSaving(false);}
  };
  const aiRequest = () => {try {return buildStandardCommandMetaPrompt(aiDescription);} catch (error) {setActionError(message(error, '만들 작업을 설명해 주세요.')); return null;}};
  const aiTitle = () => aiDescription.trim().split('\n')[0]!.slice(0, 60);
  const openAiWorkroom = () => {
    const prompt = aiRequest();
    const projectId = aiProjectId || workroom?.defaultProjectId || workroom?.projects[0]?.id;
    if (!prompt || !workroom || !projectId) return;
    // Prepare the empty 규격 명령 draft first: if it cannot be prepared, do not open a Workroom.
    if (!asNew({title: aiTitle(), body: '', pinned: true, kind: 'command'})) return;
    setNotice('워크룸에 요청문을 넣었습니다. AI가 쓴 완성본을 확인한 뒤 이 「규격 명령」 본문에 붙여 넣고 직접 저장하세요. 자동으로 저장되지 않습니다.');
    dialog.current?.close();
    workroom.open(projectId, '규격 명령 만들기', prompt);
  };
  const copyAiRequest = async () => {
    const prompt = aiRequest();
    if (!prompt) return;
    await copy(prompt, 'AI 규격 명령 요청문');
    if (!draftsRef.current[NEW_COMMAND] || !dirty(draftsRef.current[NEW_COMMAND]!)) asNew({title: aiTitle(), body: '', pinned: true, kind: 'command'});
  };
  const clearDraft = () => {
    if (!draft || !activeKey || mutationBusy.current) return;
    // This explicit discard action is the only path that replaces user input.
    if (isNewKey(activeKey)) rememberDraft(activeKey, emptyDraft(draft.kind));
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
      <button type="button" data-testid="prompt-guide-open" onClick={() => showDialog()} title={readError || actionError || '간단 프롬프트와 규격 명령 모음'} className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-2 text-[var(--ink)]">
        자주 쓰는 프롬프트{readError || actionError ? ' · 확인 필요' : ''}
      </button>
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {/* No title attribute: the hover preview below replaces the one-line tooltip. */}
        {pinned.slice(0, 3).map(entry => <button key={entry.id} type="button" data-testid="prompt-guide-pinned-copy" data-guide-id={entry.id}
          aria-label={`${entry.title} 프롬프트 복사`} disabled={copying} onClick={() => void copy(entry.body, entry.title)}
          {...preview.bind('chip:' + entry.id, entry.title, entry.body)}
          className="h-8 min-w-0 max-w-32 truncate rounded-lg border border-[var(--line)] px-2 text-[var(--ink-2)] disabled:opacity-40">{copiedTitle?.title === entry.title ? '복사됨 ✓' : entry.title}</button>)}
      </div>
      {pinned.length > 3 && <button type="button" data-testid="prompt-guide-more" aria-label={`고정한 간단 프롬프트 ${pinned.length - 3}개 더 보기`} onClick={() => showDialog('simple')} className="h-8 shrink-0 whitespace-nowrap rounded-lg border border-[var(--line)] px-2">+{pinned.length - 3}</button>}
      <span className="sr-only" role="status" aria-live="polite">{reading ? '프롬프트 불러오는 중' : readError || actionError || notice}</span>
    </div>
    {preview.popover}
    <dialog ref={dialog} onClick={event => {if(event.target === dialog.current) {const r=dialog.current.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) dialog.current.close();}}} data-testid="prompt-guide-dialog" aria-labelledby={dialogTitle} onClose={() => {closeSuggestions(); preview.hide();}}
      className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-2xl backdrop:bg-black/45"
      style={{width: 'min(54rem, calc(100vw - 24px))', maxHeight: 'calc(100dvh - 24px)', padding: 0, whiteSpace: 'normal', overflowWrap: 'anywhere'}}>
      <div className="flex max-h-[calc(100dvh-24px)] min-w-0 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--line)] p-4">
          <div className="min-w-0"><h2 id={dialogTitle} className="text-base font-semibold">자주 쓰는 프롬프트</h2>
            <p className="mt-1 text-xs text-[var(--ink-3)]">{shared ? '개인 Supabase의 허용 회원끼리 공유합니다. 모바일에서도 복사해 원하는 AI에 붙여 넣으세요.' : '이 기기에서 암호화해 보관합니다. 복사한 뒤 원하는 AI에 붙여 넣으세요.'}</p></div>
          <button type="button" data-testid="prompt-guide-close" autoFocus aria-label="자주 쓰는 프롬프트 닫기" onClick={() => dialog.current?.close()} className={button}>닫기</button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">
          <div role="tablist" aria-label="프롬프트 종류" className="mb-2 grid grid-cols-2 gap-2">
            {(['simple', 'command'] as const).map(kind => <button key={kind} type="button" role="tab" data-testid={`prompt-library-tab-${kind}`}
              aria-selected={kindTab === kind} onClick={() => {setKindTab(kind); const key = newKey(kind); if (activeKey && drafts[activeKey]?.kind !== kind) {if (drafts[key]) chooseDraftKey(key); else setActiveKey(null);}}}
              className="rounded-lg border border-[var(--line)] px-3 py-2 text-left text-xs aria-selected:border-[var(--accent)] aria-selected:bg-[var(--sunken)]">
              <span className="block text-sm font-semibold">{PROMPT_KIND_LABEL[kind]}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-[var(--ink-3)]">{PROMPT_KIND_HELP[kind]}</span>
            </button>)}
          </div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--ink-3)]">{reading ? '불러오는 중…' : snapshot ? `저장 ${snapshot.entries.length} / 100개 (두 종류 합계)` : '저장 목록 확인 필요'}</p>
            <div className="flex flex-wrap gap-2">
              {importLocal && <button type="button" disabled={saving || reading || needsReload || !snapshot} onClick={() => void importSaved()} className={button}>이 기기 프롬프트 가져오기</button>}
              {loadSuggestions && kindTab === 'simple' && <button type="button" data-testid="prompt-guide-suggestions-load" disabled={!loadSuggestions || suggesting || saving} onClick={() => void findSuggestions()} className={button}>{suggesting ? '직접 입력한 기록 확인 중…' : '최근 입력·추천 찾기'}</button>}
              <button type="button" data-testid="prompt-guide-reload" onClick={() => void reload()} disabled={reading || saving} className={button}>목록 다시 읽기</button>
              <button type="button" data-testid="prompt-guide-new" onClick={() => chooseNew()} disabled={saving} className={button}>새 {PROMPT_KIND_LABEL[kindTab]} 작성</button>
            </div>
          </div>
          {readError && <p role="alert" data-testid="prompt-guide-read-error" className="mb-3 whitespace-pre-wrap break-words text-sm text-red-400 [overflow-wrap:anywhere]">{readError} 저장 목록을 확인할 때까지 저장·삭제하지 않습니다. 초안은 유지됩니다.</p>}
          {actionError && <p role="alert" data-testid="prompt-guide-action-error" className="mb-3 whitespace-pre-wrap break-words text-sm text-red-400 [overflow-wrap:anywhere]">{actionError}</p>}
          {notice && <p role="status" data-testid="prompt-guide-notice" className="mb-3 break-words text-xs text-[var(--ink-3)] [overflow-wrap:anywhere]">{notice}</p>}
          {kindTab === 'command' && <details data-testid="prompt-command-ai" className="mb-3 rounded-lg border border-[var(--line)] p-3">
            <summary data-testid="prompt-command-ai-toggle" className="cursor-pointer text-sm font-semibold">AI로 규격 명령 만들기 <span className="text-xs font-normal text-[var(--ink-3)]">— 짧게 설명하면 AI가 양식에 맞춰 초안을 씁니다</span></summary>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-[var(--ink-3)]">
              <li>반복하고 싶은 작업을 한두 줄로 적습니다.</li>
              <li>{workroom ? '고른 워크룸(기본: OPS 운영 워크룸)에' : 'AI에'} 요청문이 들어갑니다. AI가 목적·전제·단계·확인 기준·금지 사항·보고 형식 양식으로 초안을 씁니다.</li>
              <li>결과를 읽어 보고, 완성본을 「규격 명령」 본문에 붙여 넣은 뒤 직접 저장합니다. AI 결과는 자동으로 저장되지 않습니다.</li>
            </ol>
            <label className="mt-2 block text-xs">어떤 작업을 규격 명령으로 만들까요?
              <textarea data-testid="prompt-command-ai-description" value={aiDescription} rows={2} maxLength={4000} onChange={event => setAiDescription(event.target.value)}
                placeholder="예: 매주 월요일 의존성 보안 점검 후 결과를 표로 보고" className={`${input} mt-1 resize-y`} /></label>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {workroom && workroom.projects.length > 0 && <label className="flex min-w-0 items-center gap-2 text-xs" title="규격 명령은 어느 프로젝트에도 묶이지 않습니다. 초안을 쓸 AI를 어느 워크룸에서 띄울지만 고릅니다.">초안을 쓸 워크룸
                <select data-testid="prompt-command-ai-project" value={aiProjectId || workroom.defaultProjectId || workroom.projects[0]!.id} onChange={event => setAiProjectId(event.target.value)} className={`${input} w-auto max-w-56`}>
                  {workroom.projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}
                </select></label>}
              {workroom && workroom.projects.length > 0 && <button type="button" data-testid="prompt-command-ai-open" disabled={!aiDescription.trim() || saving} onClick={openAiWorkroom} className={button}>워크룸에서 AI로 만들기</button>}
              <button type="button" data-testid="prompt-command-ai-copy" disabled={!aiDescription.trim() || copying} onClick={() => void copyAiRequest()} className={button}>요청문만 복사</button>
            </div>
            {workroom && workroom.projects.length > 0 && <p data-testid="prompt-command-ai-project-hint" className="mt-2 text-xs text-[var(--ink-3)]">규격 명령은 어느 프로젝트에도 묶이지 않고 어디서나 씁니다. 이 칸은 초안을 쓸 AI를 띄울 곳만 정합니다. 특정 프로젝트 전용 명령이라면 그 프로젝트를 고르세요 — AI가 그 코드와 기억을 참고해 더 정확하게 씁니다.</p>}
            {workroom && workroom.projects.length === 0 && <p className="mt-2 text-xs text-[var(--ink-3)]">워크룸을 열 프로젝트(폴더가 있는 프로젝트)가 아직 없습니다. 「요청문만 복사」로 원하는 AI에 붙여 넣으세요.</p>}
            {!workroom && <p className="mt-2 text-xs text-[var(--ink-3)]">워크룸은 Mac 앱에서만 열 수 있습니다. 「요청문만 복사」로 원하는 AI에 붙여 넣으세요.</p>}
          </details>}
          <div className="grid min-w-0 grid-cols-1 gap-4 min-[720px]:grid-cols-[16rem_minmax(0,1fr)]">
            <aside className="min-w-0">
              <h3 className="mb-2 text-xs font-semibold">저장한 {PROMPT_KIND_LABEL[kindTab]}</h3>
              <input type="search" aria-label="프롬프트 검색" placeholder="제목·내용 검색" value={search} onChange={event => setSearch(event.target.value)} className={`${input} mb-2`}/>
              {snapshot && !readError && !libraryEntries.some(entry => promptKindOf(entry) === kindTab) && <p className="text-xs text-[var(--ink-3)]">아직 저장한 {PROMPT_KIND_LABEL[kindTab]}이 없습니다. 「새 {PROMPT_KIND_LABEL[kindTab]} 작성」을 눌러 만들어 주세요.</p>}
              <ul data-testid="prompt-guide-saved-list" className="max-h-64 space-y-1 overflow-y-auto">
                {visibleEntries.map((entry, index) => <li key={entry.id} className="flex min-w-0 items-center gap-1">
                  <button type="button" data-testid="prompt-guide-edit" data-guide-id={entry.id} aria-pressed={activeKey === entry.id} disabled={saving}
                    onClick={() => chooseEntry(entry)} {...preview.bind('list:' + entry.id, entry.title, entry.body, '누르면 고칠 수 있습니다')}
                    className="min-w-0 flex-1 rounded-lg border border-[var(--line)] px-2 py-2 text-left text-xs aria-pressed:bg-[var(--sunken)]">
                    <span className="block truncate">{entry.pinned ? '★ ' : ''}{entry.title}{entry.virtual ? ' · 기본' : ''}{drafts[entry.id] && dirty(drafts[entry.id]!) ? ' · 초안' : ''}</span>
                  </button>
                  {!search.trim() && <>
                    <button type="button" data-testid="prompt-guide-move-up" data-guide-id={entry.id} aria-label={`${entry.title} 위로 옮기기`} disabled={blocked || index === 0} onClick={() => void move(entry.id, -1)} className="shrink-0 rounded-lg border border-[var(--line)] px-1.5 py-2 text-xs disabled:opacity-30">↑</button>
                    <button type="button" data-testid="prompt-guide-move-down" data-guide-id={entry.id} aria-label={`${entry.title} 아래로 옮기기`} disabled={blocked || index === visibleEntries.length - 1} onClick={() => void move(entry.id, 1)} className="shrink-0 rounded-lg border border-[var(--line)] px-1.5 py-2 text-xs disabled:opacity-30">↓</button>
                  </>}
                  <button type="button" data-testid="prompt-guide-list-copy" data-guide-id={entry.id} aria-label={`${entry.title} 복사`} disabled={copying} onClick={() => void copy(entry.body, entry.title)} {...preview.bind('copy:' + entry.id, entry.title, entry.body)} className="shrink-0 rounded-lg border border-[var(--line)] px-2 py-2 text-xs">복사</button>
                </li>)}
              </ul>
              {(showNewDraft(NEW_DRAFT) || showNewDraft(NEW_COMMAND) || orphanDraftKeys.length > 0) && <div className="mt-3 space-y-1 border-t border-[var(--line)] pt-3">
                <h3 className="text-xs font-semibold">저장되지 않은 초안</h3>
                {showNewDraft(NEW_DRAFT) && <button type="button" onClick={() => chooseDraftKey(NEW_DRAFT)} disabled={saving} className="block max-w-full truncate py-1 text-left text-xs">새 간단 프롬프트 초안</button>}
                {showNewDraft(NEW_COMMAND) && <button type="button" onClick={() => chooseDraftKey(NEW_COMMAND)} disabled={saving} className="block max-w-full truncate py-1 text-left text-xs">새 규격 명령 초안</button>}
                {orphanDraftKeys.map(key => <button type="button" key={key} onClick={() => chooseDraftKey(key)} disabled={saving} className="block max-w-full truncate py-1 text-left text-xs">{drafts[key]!.title || '이름 없는 초안'} · 저장본 없음</button>)}
              </div>}
            </aside>
            <div className="min-w-0">
              {draft ? <form onSubmit={event => {event.preventDefault(); void persist();}} className="min-w-0 space-y-3" data-kind={draft.kind}>
                <p className="text-[11px] text-[var(--ink-3)]">종류: {PROMPT_KIND_LABEL[draft.kind]}{currentSaved?.virtual ? ' · 앱 기본 항목 (고치거나 순서를 바꾸면 내 사본으로 저장됩니다)' : ''}</p>
                <label className="block text-xs">제목 <span className="text-[var(--ink-3)]">{draft.title.length}/120</span>
                  <input data-testid="prompt-guide-title" value={draft.title} maxLength={120} disabled={saving} onChange={event => changeDraft({title: event.target.value})} className={`${input} mt-1`} /></label>
                <label className="block text-xs">{draft.kind === 'command' ? '규격 명령 본문 (목적 · 전제 · 단계 · 확인 기준 · 금지 사항 · 보고 형식)' : '붙여 넣을 프롬프트'} <span className="text-[var(--ink-3)]">{draft.body.length.toLocaleString('ko-KR')}/16,384</span>
                  <textarea data-testid="prompt-guide-body" value={draft.body} maxLength={MAX_BODY} rows={draft.kind === 'command' ? 14 : 9} disabled={saving} onChange={event => changeDraft({body: event.target.value})}
                    placeholder={draft.kind === 'command' ? 'AI가 만든 완성본을 여기에 붙여 넣거나, 「빈 양식 넣기」로 직접 채우세요.' : undefined}
                    className={`${input} mt-1 resize-y whitespace-pre-wrap break-words [overflow-wrap:anywhere]`} /></label>
                {draft.kind === 'command' && !draft.body.trim() && <button type="button" data-testid="prompt-command-template" disabled={saving} onClick={() => changeDraft({body: commandTemplate()})} className={button}>빈 양식 넣기</button>}
                <label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid="prompt-guide-pin" checked={draft.pinned} disabled={saving} onChange={event => changeDraft({pinned: event.target.checked})} />
                  {draft.kind === 'command' ? '「도구 및 설정 → 도구·연결」에 복사 버튼으로 고정' : '화면 위 막대에 버튼으로 고정'}</label>
                {changedSaved && <div role="alert" data-testid="prompt-guide-conflict" className="rounded-lg border border-amber-500/40 p-3 text-xs leading-relaxed">
                  <p>저장본이 변경되거나 삭제되었습니다. 현재 초안으로 덮어쓰지 않습니다.</p>
                  {currentSaved && <details className="mt-2"><summary className="cursor-pointer">현재 저장본 비교</summary><p className="mt-2 break-words font-semibold [overflow-wrap:anywhere]">{currentSaved.title}</p><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-sans [overflow-wrap:anywhere]">{currentSaved.body}</pre></details>}
                  <button type="button" data-testid="prompt-guide-as-new" disabled={saving} onClick={() => asNew(draft)} className={`${button} mt-2`}>현재 초안을 새 항목으로 작성</button>
                </div>}
                <div className="flex flex-wrap items-center gap-2">
                  <button type="submit" data-testid="prompt-guide-save" disabled={blocked || changedSaved || !draft.title.trim() || !draft.body.trim()} className={button}>{saving ? '저장 중…' : `${PROMPT_KIND_LABEL[draft.kind]} 저장`}</button>
                  <button type="button" data-testid="prompt-guide-copy-draft" disabled={copying || !draft.body.trim()} onClick={() => void copy(draft.body, draft.title)} className={button}>본문 복사</button>
                  <button type="button" data-testid="prompt-guide-clear-draft" disabled={saving} onClick={clearDraft} className={button}>{currentSaved ? '초안 버리고 저장본 보기' : '초안 비우기'}</button>
                  {draft.base && currentSaved && !currentSaved.virtual && !isBuiltinCommandId(draft.id) && <button type="button" data-testid="prompt-guide-delete" disabled={blocked || changedSaved} onClick={() => setDeleteConfirm(true)} className={button}>저장본 삭제</button>}
                </div>
                {isBuiltinCommandId(draft.id) && <p className="text-[11px] text-[var(--ink-3)]">앱 기본 규격 명령은 삭제 대신 고정을 해제해 도구 영역에서 숨길 수 있습니다.</p>}
                {deleteConfirm && <div className="rounded-lg border border-red-400/40 p-3 text-xs">
                  <p>이 항목의 저장본을 삭제할까요? 수정 중인 초안은 유지합니다.</p>
                  <div className="mt-2 flex flex-wrap gap-2"><button type="button" data-testid="prompt-guide-confirm-delete" disabled={blocked || changedSaved} onClick={() => void remove()} className={button}>삭제하기</button><button type="button" data-testid="prompt-guide-cancel-delete" disabled={saving} onClick={() => setDeleteConfirm(false)} className={button}>돌아가기</button></div>
                </div>}
              </form> : <p className="text-sm text-[var(--ink-3)]">왼쪽에서 항목을 고르거나 「새 {PROMPT_KIND_LABEL[kindTab]} 작성」을 눌러 주세요.</p>}
            </div>
          </div>
          {loadSuggestions && kindTab === 'simple' && <div ref={suggestionSection} className="mt-5 border-t border-[var(--line)] pt-4">
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
});
