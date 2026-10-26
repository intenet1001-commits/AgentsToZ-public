import React, {useEffect, useRef, useState, type CSSProperties} from 'react';
import {IncrementalListMore, useIncrementalRender} from './components/IncrementalListMore';
import {
  normalizeUserProfileSave, normalizeUserProfileSnapshot, USER_PROFILE_MAX_BODY_BYTES,
  USER_PROFILE_MAX_ENTRIES, type UserProfileEntry, type UserProfileSnapshot,
} from './userProfileContract';

export interface UserProfileProject {memoryId: string; name: string}
export interface UserProfilePanelProps {
  request: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    profile?: UserProfileSnapshot; projects?: UserProfileProject[];
  }>;
  language?: 'ko' | 'en';
  projects?: UserProfileProject[];
  onOpenUserMemory?: () => void;
}
type SaveRequest = {operation: 'save'; expectedRevision: string; entries: UserProfileEntry[]; confirmed: true};
const sameEntries = (a: UserProfileEntry[], b: UserProfileEntry[]) => JSON.stringify(a) === JSON.stringify(b);
type ProfileConflict = {id: string; draft: UserProfileEntry | null; saved: UserProfileEntry | null};
// A timestamp alone does not mean that the person changed a preference.
const sameEntryValue = (a: UserProfileEntry | undefined | null, b: UserProfileEntry | undefined | null) =>
  !a || !b ? a == null && b == null : a.id === b.id && a.title === b.title && a.body === b.body
    && a.scope === b.scope && a.projectMemoryId === b.projectMemoryId && a.state === b.state && a.origin === b.origin;
const sameProfileValues = (a: UserProfileEntry[], b: UserProfileEntry[]) =>
  a.length === b.length && a.every((entry, index) => sameEntryValue(entry, b[index]));
function mergeProfileDraft(base: UserProfileEntry[], draft: UserProfileEntry[], saved: UserProfileEntry[]) {
  const before = new Map(base.map(entry => [entry.id, entry])), local = new Map(draft.map(entry => [entry.id, entry]));
  const remote = new Map(saved.map(entry => [entry.id, entry]));
  const entries: UserProfileEntry[] = [], conflicts: ProfileConflict[] = [];
  for (const id of new Set([...remote.keys(), ...local.keys()])) {
    const original = before.get(id), ours = local.get(id), theirs = remote.get(id);
    let chosen: UserProfileEntry | undefined;
    if (sameEntryValue(ours, theirs)) chosen = theirs;
    else if (sameEntryValue(ours, original)) chosen = theirs;
    else if (sameEntryValue(theirs, original)) chosen = ours;
    else {conflicts.push({id, draft: ours ?? null, saved: theirs ?? null}); chosen = ours;}
    if (chosen) entries.push(chosen);
  }
  return {entries, conflicts};
}
const box: CSSProperties = {boxSizing: 'border-box', minWidth: 0, width: '100%'};
const button: CSSProperties = {minHeight: 44, padding: '8px 12px', border: '1px solid var(--line-2)', borderRadius: 10, background: 'var(--surface)', color: 'var(--ink)', font: 'inherit', cursor: 'pointer', overflowWrap: 'anywhere'};
const field: CSSProperties = {...box, minHeight: 44, padding: '8px 10px', fontSize: 16, border: '1px solid var(--line-2)', borderRadius: 8, background: 'var(--sunken)', color: 'var(--ink)'};
const row: CSSProperties = {display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8};
const ko = {
  title: '내 프로필', localOnly: '이 Mac의 현재 OS 사용자 전용입니다. 암호화해 이 기기에 저장하며 다른 기기와 동기화하지 않습니다.',
  authority: '내가 직접 확인한 선호와 일하는 방식을 적습니다. 「내가 한 말」의 원문이나 AI의 추측을 자동으로 확정하지 않으며, 지금 명시한 지시가 우선합니다. 계정·권한·모델 설정을 자동으로 바꾸지 않습니다.',
  openOriginals: '내가 한 말 원문 보기', checking: '저장본 확인 중…', checkSave: '저장 상태 확인', reread: '저장본 다시 읽기',
  items: '개', unsaved: '저장하지 않은 변경 있음', clean: '저장본과 같음',
  savedConfirmed: '저장한 내용이 확인되었습니다.', loaded: '저장된 프로필을 읽었습니다.', draftKept: '저장본을 다시 확인했습니다. 작성 중인 내용은 그대로 보존했습니다.',
  readError: '저장된 프로필을 읽지 못했습니다. 작성 중인 내용은 보존했습니다. 다시 확인해 주세요.',
  projectsError: '프로젝트 목록을 읽지 못했습니다. 프로젝트를 고르는 항목은 목록을 다시 확인한 뒤 저장해 주세요.',
  projectRequired: '항목에 적용할 등록 프로젝트를 다시 선택해 주세요.',
  invalid: '각 항목의 제목과 내용을 확인해 주세요. 제목은 120자, 내용은 4,000바이트까지이며 적용할 프로젝트를 선택해야 합니다.',
  saved: '직접 확인한 프로필을 이 Mac에 저장했습니다.',
  conflictError: '저장본이 바뀌어 저장하지 않았습니다. 초안은 보존했습니다. 저장본을 다시 읽고 변경 내용을 검토해 주세요.',
  uncertain: '저장 여부를 확인하지 못했습니다. 작성한 내용은 보존했습니다. 먼저 저장 상태를 확인해 주세요.',
  compareNotice: '같은 항목이 양쪽에서 바뀌었습니다. 내용을 비교하고 사용할 값을 직접 골라 주세요.',
  merged: '다른 창의 추가와 변경을 보존했습니다. 합쳐진 내용과 적용 범위를 직접 확인해 주세요.',
  same: '초안과 최신 저장 내용이 같습니다. 추가 저장은 필요하지 않습니다.',
  selected: '선택한 내용을 반영했습니다. 남은 비교 항목과 적용 범위를 확인해 주세요.',
  reviewHint: '확인한 저장본과 작성 중인 초안을 함께 검토해 주세요. 다른 창의 추가와 변경도 보존합니다.',
  review: '이 초안을 최신 기준으로 검토', comparison: '같은 항목 변경 비교', compareHeading: '같은 항목 변경 비교 · 사용할 내용을 골라 주세요',
  draft: '작성 중인 초안', latest: '최신 저장값', entryTitle: '제목', body: '내용', scope: '적용 범위', state: '사용 상태', absent: '항목 없음',
  chooseDraft: '이 초안 사용', chooseSaved: '최신 저장값 사용', loading: '프로필을 읽는 중…', readFirst: '저장본을 먼저 확인해 주세요.', empty: '아직 직접 저장한 프로필이 없습니다.',
  entry: '항목', active: '사용 중', inactive: '사용 중지', deactivate: '사용 중지', restore: '다시 사용', cancelAddition: '추가 취소',
  titleLabel: '프로필 항목 제목', bodyLabel: '프로필 항목 내용', scopeLabel: '프로필 적용 범위', projectLabel: '프로필 적용 프로젝트',
  bytes: '바이트', allProjects: '이 Mac의 모든 프로젝트', projectOnly: '선택한 프로젝트만', project: '프로젝트', chooseProject: '프로젝트를 선택하세요', missingProject: '연결되지 않은 프로젝트',
  more: '더 보기', add: '새 항목 추가', inactiveHint: '「사용 중지」한 항목은 회상에 쓰지 않으며 「다시 사용」으로 복원할 수 있습니다. 원문 기록은 바꾸지 않습니다.',
  confirmLabel: '프로필 직접 확인', confirmation: '이 내용과 적용 범위를 직접 확인했습니다.', saving: '저장 중…', save: '직접 확인한 내용 저장',
};
const en: Record<keyof typeof ko, string> = {
  title: 'My profile', localOnly: 'For the current OS user on this Mac only. Stored encrypted on this device, with no sync to other devices.',
  authority: 'Record preferences and ways of working you have personally reviewed. What I Said originals and AI guesses are never automatically confirmed. Your current explicit instructions take priority. This does not automatically change accounts, permissions or model settings.',
  openOriginals: 'View What I Said originals', checking: 'Checking saved profile…', checkSave: 'Check save status', reread: 'Read saved profile again',
  items: ' entries', unsaved: 'Unsaved changes', clean: 'Matches saved profile',
  savedConfirmed: 'Your saved content has been confirmed.', loaded: 'Saved profile loaded.', draftKept: 'Saved profile checked. Your draft has been preserved.',
  readError: 'Could not read the saved profile. Your draft has been preserved. Please check again.',
  projectsError: 'Could not read the project list. Check the list before saving entries that select a project.',
  projectRequired: 'Please select a registered project for this entry again.',
  invalid: 'Check each entry’s title and content. Titles allow up to 120 characters and content up to 4,000 bytes. Select a project where required.',
  saved: 'Your personally reviewed profile was saved on this Mac.',
  conflictError: 'Nothing was saved because the saved profile changed. Your draft has been preserved. Read the saved profile again and review the changes.',
  uncertain: 'Could not confirm whether the save completed. Your draft has been preserved. Check the save status first.',
  compareNotice: 'The same entry changed in both places. Compare the content and choose which values to use.',
  merged: 'Additions and changes from the other window were preserved. Review the merged content and scope yourself.',
  same: 'Your draft matches the latest saved content. No additional save is needed.',
  selected: 'Your choice has been applied. Check any remaining comparisons and the scope.',
  reviewHint: 'Review the checked saved profile together with your draft. Additions and changes from other windows will also be preserved.',
  review: 'Review draft against latest profile', comparison: 'Compare changes to the same entry', compareHeading: 'Same entry changed · choose which content to use',
  draft: 'Your draft', latest: 'Latest saved values', entryTitle: 'Title', body: 'Content', scope: 'Scope', state: 'Usage', absent: 'No entry',
  chooseDraft: 'Use this draft', chooseSaved: 'Use latest saved values', loading: 'Reading profile…', readFirst: 'Check the saved profile first.', empty: 'No personally reviewed profile entries yet.',
  entry: 'Entry', active: 'In use', inactive: 'Inactive', deactivate: 'Stop using', restore: 'Use again', cancelAddition: 'Cancel addition',
  titleLabel: 'Profile entry title', bodyLabel: 'Profile entry content', scopeLabel: 'Profile scope', projectLabel: 'Profile project',
  bytes: ' bytes', allProjects: 'All projects on this Mac', projectOnly: 'Selected project only', project: 'Project', chooseProject: 'Select a project', missingProject: 'Project no longer connected',
  more: 'Show more', add: 'Add entry', inactiveHint: 'Inactive entries are excluded from recall. Use “Use again” to restore them. Original records are unchanged.',
  confirmLabel: 'Personally confirm profile', confirmation: 'I have personally reviewed this content and its scope.', saving: 'Saving…', save: 'Save personally reviewed content',
};
type CopyKey = keyof typeof ko;

/** A directly reviewed local preference draft. Reading never saves or applies it to an execution setting. */
export function UserProfilePanel({request, language = 'ko', projects: suppliedProjects, onOpenUserMemory}: UserProfilePanelProps) {
  const t = language === 'ko' ? ko : en, locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const [base, setBase] = useState<UserProfileSnapshot | null>(null);
  const [entries, setEntries] = useState<UserProfileEntry[]>([]);
  const [projects, setProjects] = useState<UserProfileProject[]>(suppliedProjects ?? []);
  const [projectsReady, setProjectsReady] = useState(suppliedProjects !== undefined);
  const [projectError, setProjectError] = useState<CopyKey | ''>('');
  const [latest, setLatest] = useState<UserProfileSnapshot | null>(null);
  const [conflicts, setConflicts] = useState<ProfileConflict[]>([]);
  const [confirmed, setConfirmed] = useState(false), [dirty, setDirty] = useState(false);
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<SaveRequest | null>(null);
  const [error, setError] = useState<CopyKey | ''>(''), [notice, setNotice] = useState<CopyKey | ''>('');
  const alive = useRef(true), generation = useRef(0), readSerial = useRef(0), newIds = useRef(new Set<string>());
  const editVersion = useRef(0), dirtyRef = useRef(false), draftRef = useRef(entries);
  const pendingRef = useRef<SaveRequest | null>(null), saveLock = useRef(false);
  const page = useIncrementalRender(entries.length, 'user-profile', 12);
  const rememberPending = (value: SaveRequest | null) => {pendingRef.current = value; setPending(value);};
  const accept = (profile: UserProfileSnapshot) => {
    setBase(profile); setLatest(null); setConflicts([]); setEntries(profile.entries); draftRef.current = profile.entries;
    dirtyRef.current = false; newIds.current.clear(); setDirty(false); setConfirmed(false); rememberPending(null);
  };
  const read = async (signal?: AbortSignal) => {
    const serial = ++readSerial.current, version = generation.current, edits = editVersion.current;
    setReading(true); setError('');
    try {
      const result = await request({operation: 'read'}, signal);
      const profile = normalizeUserProfileSnapshot(result.profile);
      if (!alive.current || signal?.aborted || version !== generation.current || serial !== readSerial.current) return;
      const attempt = pendingRef.current;
      if (attempt && sameEntries(profile.entries, attempt.entries)) {
        accept(profile); setNotice('savedConfirmed');
      } else if (!dirtyRef.current && edits === editVersion.current) {
        accept(profile); setNotice('loaded');
      } else {
        // A refresh can observe a new revision, but may never silently rebase a whole-snapshot draft.
        setLatest(profile); setConfirmed(false); rememberPending(null);
        setNotice('draftKept');
      }
    } catch {
      if (alive.current && !signal?.aborted && version === generation.current && serial === readSerial.current)
        setError('readError');
    } finally {
      if (alive.current && version === generation.current && serial === readSerial.current) setReading(false);
    }
  };
  useEffect(() => {
    alive.current = true; generation.current++;
    const controller = new AbortController(); void read(controller.signal);
    return () => {alive.current = false; generation.current++; readSerial.current++; controller.abort();};
  }, [request]);
  useEffect(() => {
    if (suppliedProjects !== undefined) {setProjects(suppliedProjects); setProjectsReady(true); setProjectError(''); return;}
    let current = true; const controller = new AbortController(); setProjectsReady(false);
    void request({operation: 'projects'}, controller.signal).then(result => {
      if (!current || controller.signal.aborted) return;
      if (!Array.isArray(result.projects)) throw Error('invalid projects');
      setProjects(result.projects); setProjectsReady(true); setProjectError('');
    }).catch(() => {if (current && !controller.signal.aborted) setProjectError('projectsError');});
    return () => {current = false; controller.abort();};
  }, [request, suppliedProjects]);
  const change = (next: UserProfileEntry[]) => {
    if (saveLock.current || pendingRef.current || conflicts.length) return;
    const changed = !base || !sameProfileValues(next, base.entries);
    editVersion.current++; dirtyRef.current = changed; draftRef.current = next;
    setEntries(next); setDirty(changed); setConfirmed(false); setError(''); setNotice('');
  };
  const edit = (id: string, patch: Partial<UserProfileEntry>) => change(draftRef.current.map(entry =>
    entry.id === id ? {...entry, ...patch, updatedAt: new Date().toISOString()} : entry));
  const add = () => {
    if (draftRef.current.length >= USER_PROFILE_MAX_ENTRIES) return;
    const id = crypto.randomUUID(); newIds.current.add(id);
    change([...draftRef.current, {id, title: '', body: '', scope: 'all-projects', projectMemoryId: null, state: 'active', updatedAt: new Date().toISOString(), origin: 'user-confirmed'}]);
  };
  const save = async () => {
    if (!base || !confirmed || !dirtyRef.current || saveLock.current || pendingRef.current || latest || conflicts.length) return;
    let payload: SaveRequest;
    try {
      const normalized = normalizeUserProfileSave({expectedRevision: base.revision, entries: draftRef.current});
      if (normalized.entries.some(entry => entry.state === 'active' && entry.scope === 'project' && (!projectsReady || !projects.some(project => project.memoryId === entry.projectMemoryId)))) {
        setError('projectRequired'); return;
      }
      payload = {operation: 'save', ...normalized, confirmed: true};
    } catch {setError('invalid'); return;}
    const version = generation.current;
    // A read started before this write must not replace the just-saved snapshot when it finishes late.
    readSerial.current++; setReading(false);
    saveLock.current = true; setSaving(true); setError(''); setNotice(''); rememberPending(payload);
    try {
      const result = await request(payload);
      const profile = normalizeUserProfileSnapshot(result.profile);
      if (!alive.current || version !== generation.current) return;
      accept(profile); setNotice('saved');
    } catch (failure) {
      if (!alive.current || version !== generation.current) return;
      const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (/CONFLICT|REVISION/.test(code)) {
        rememberPending(null); setConfirmed(false);
        setError('conflictError');
      } else {
        setError('uncertain');
      }
    } finally {
      saveLock.current = false;
      if (alive.current && version === generation.current) setSaving(false);
    }
  };
  const reviewLatest = () => {
    if (!base || !latest || pending || saving || reading) return;
    const merged = mergeProfileDraft(base.entries, draftRef.current, latest.entries);
    const changed = !sameProfileValues(merged.entries, latest.entries);
    newIds.current = new Set([...newIds.current].filter(id => !latest.entries.some(entry => entry.id === id)));
    editVersion.current++; draftRef.current = merged.entries; dirtyRef.current = changed;
    setBase(latest); setLatest(null); setEntries(merged.entries); setConflicts(merged.conflicts);
    setDirty(changed); setConfirmed(false); setError('');
    setNotice(merged.conflicts.length ? 'compareNotice' : changed ? 'merged' : 'same');
  };
  const resolveConflict = (conflict: ProfileConflict, choice: 'draft' | 'saved') => {
    if (!base || saving || pending) return;
    const selected = conflict[choice], next = draftRef.current.filter(entry => entry.id !== conflict.id);
    const previousIndex = draftRef.current.findIndex(entry => entry.id === conflict.id);
    if (selected) next.splice(previousIndex < 0 ? next.length : previousIndex, 0, selected);
    const changed = !sameProfileValues(next, base.entries);
    editVersion.current++; draftRef.current = next; dirtyRef.current = changed;
    setEntries(next); setDirty(changed); setConfirmed(false); setError(''); setNotice('selected');
    setConflicts(items => items.filter(item => item.id !== conflict.id));
  };
  const describeScope = (entry: UserProfileEntry) => entry.scope === 'all-projects' ? t.allProjects
    : `${t.projectOnly} · ${projects.find(project => project.memoryId === entry.projectMemoryId)?.name ?? t.missingProject}`;
  return <section lang={language} className="user-profile-panel" data-testid="user-profile-panel" aria-labelledby="user-profile-title" style={{...box, display: 'grid', gap: 16, color: 'var(--ink)', fontSize: 14, lineHeight: 1.55}}>
    <style>{'.user-profile-panel .incremental-list-more button{min-height:44px;padding:8px 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);color:var(--ink);font:inherit}.user-profile-panel select{appearance:none;height:44px;padding-right:32px}.user-profile-select{position:relative;display:block}.user-profile-select:after{content:"⌄";position:absolute;right:12px;bottom:10px;pointer-events:none}'}</style>
    <header><h2 id="user-profile-title" style={{margin: 0, fontSize: 20, fontWeight: 700}}>{t.title}</h2>
      <p style={{margin: '8px 0 0'}}>{t.localOnly}</p>
      <p style={{margin: '8px 0 0', color: 'var(--ink-2)'}}>{t.authority}</p>
      {onOpenUserMemory && <button type="button" style={{...button, marginTop: 10}} onClick={onOpenUserMemory}>{t.openOriginals}</button>}
    </header>
    <div style={row}><button type="button" style={button} disabled={reading || saving || conflicts.length > 0} onClick={() => void read()}>{reading ? t.checking : pending ? t.checkSave : t.reread}</button>
      {base && <span style={{color: 'var(--ink-2)'}}>{entries.length}/{USER_PROFILE_MAX_ENTRIES}{t.items} · {dirty ? t.unsaved : t.clean}</span>}</div>
    {notice && <p role="status" style={{margin: 0}}>{t[notice]}</p>}
    {error && <p role="alert" style={{margin: 0, color: 'var(--danger)', overflowWrap: 'anywhere'}}>{t[error]}</p>}
    {projectError && <p role="alert" style={{margin: 0, color: 'var(--warn)'}}>{t[projectError]}</p>}
    {latest && base && <div style={{padding: 12, border: '1px solid var(--line-2)', borderRadius: 10}}>
      <p style={{margin: '0 0 8px'}}>{t.reviewHint}</p>
      <button type="button" style={button} disabled={reading || saving || !!pending} onClick={reviewLatest}>{t.review}</button>
    </div>}
    {conflicts.map(conflict => <section key={conflict.id} data-testid="user-profile-conflict" data-entry-id={conflict.id} aria-label={t.comparison} style={{...box, padding: 12, border: '1px solid var(--line-2)', borderRadius: 10}}>
      <h3 style={{margin: '0 0 10px', fontSize: 16}}>{t.compareHeading}</h3>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,260px),1fr))', gap: 12}}>
        {(['draft', 'saved'] as const).map(choice => <div key={choice} data-testid={`user-profile-conflict-${choice}`} style={{minWidth: 0, padding: 10, background: 'var(--sunken)', borderRadius: 8, overflowWrap: 'anywhere'}}>
          <strong>{choice === 'draft' ? t.draft : t.latest}</strong>
          {conflict[choice] ? <dl style={{margin: '8px 0', whiteSpace: 'pre-wrap'}}><dt>{t.entryTitle}</dt><dd style={{margin: '0 0 8px'}}>{conflict[choice].title}</dd><dt>{t.body}</dt><dd style={{margin: '0 0 8px'}}>{conflict[choice].body}</dd><dt>{t.scope}</dt><dd style={{margin: '0 0 8px'}}>{describeScope(conflict[choice])}</dd><dt>{t.state}</dt><dd style={{margin: 0}}>{conflict[choice].state === 'active' ? t.active : t.inactive}</dd></dl> : <p>{t.absent}</p>}
          <button type="button" style={button} onClick={() => resolveConflict(conflict, choice)}>{choice === 'draft' ? t.chooseDraft : t.chooseSaved}</button>
        </div>)}
      </div>
    </section>)}
    {!base ? <p style={{margin: 0}}>{reading ? t.loading : t.readFirst}</p> : <>
      {entries.length === 0 && <p style={{margin: 0}}>{t.empty}</p>}
      <fieldset disabled={saving || !!pending || conflicts.length > 0} style={{...box, border: 0, padding: 0, margin: 0, display: 'grid', gap: 12}}>
        {entries.map((entry, index) => index < page.limit || newIds.current.has(entry.id) ? <article key={entry.id} data-testid="user-profile-entry" data-entry-id={entry.id} data-state={entry.state} style={{...box, display: 'grid', gap: 10, padding: 14, border: '1px solid var(--line)', borderRadius: 12}}>
          <div style={{...row, justifyContent: 'space-between'}}><strong>{t.entry} {index + 1} · {entry.state === 'active' ? t.active : t.inactive}</strong>
            <div style={row}><button type="button" style={button} onClick={() => edit(entry.id, {state: entry.state === 'active' ? 'inactive' : 'active'})}>{entry.state === 'active' ? t.deactivate : t.restore}</button>
              {newIds.current.has(entry.id) && <button type="button" style={button} onClick={() => {newIds.current.delete(entry.id); change(draftRef.current.filter(item => item.id !== entry.id));}}>{t.cancelAddition}</button>}</div></div>
          <label>{t.entryTitle}<input aria-label={t.titleLabel} maxLength={120} style={field} value={entry.title} onChange={event => edit(entry.id, {title: event.target.value})}/></label>
          <label>{t.body}<textarea aria-label={t.bodyLabel} rows={3} style={{...field, resize: 'vertical'}} value={entry.body} onChange={event => edit(entry.id, {body: event.target.value})}/><span style={{fontSize: 12, color: 'var(--ink-2)'}}>{new TextEncoder().encode(entry.body).byteLength.toLocaleString(locale)}/{USER_PROFILE_MAX_BODY_BYTES.toLocaleString(locale)}{t.bytes}</span></label>
          <label className="user-profile-select">{t.scope}<select aria-label={t.scopeLabel} style={field} value={entry.scope} onChange={event => edit(entry.id, {scope: event.target.value as UserProfileEntry['scope'], projectMemoryId: null})}><option value="all-projects">{t.allProjects}</option><option value="project">{t.projectOnly}</option></select></label>
          {entry.scope === 'project' && <label className="user-profile-select">{t.project}<select aria-label={t.projectLabel} style={field} value={entry.projectMemoryId ?? ''} disabled={!projectsReady} onChange={event => edit(entry.id, {projectMemoryId: event.target.value || null})}>
            <option value="">{t.chooseProject}</option>
            {entry.projectMemoryId && !projects.some(project => project.memoryId === entry.projectMemoryId) && <option value={entry.projectMemoryId}>{t.missingProject}</option>}
            {projects.map(project => <option key={project.memoryId} value={project.memoryId}>{project.name}</option>)}
          </select></label>}
        </article> : null)}
        <IncrementalListMore shown={page.limit} total={entries.length} onMore={page.showMore} testId="user-profile-more" label={t.more}/>
        <button type="button" style={{...button, justifySelf: 'start'}} disabled={entries.length >= USER_PROFILE_MAX_ENTRIES} onClick={add}>{t.add}</button>
      </fieldset>
      <p style={{margin: 0, fontSize: 13, color: 'var(--ink-2)'}}>{t.inactiveHint}</p>
      <label style={{...row, minHeight: 44, alignItems: 'flex-start'}}><input type="checkbox" aria-label={t.confirmLabel} style={{width: 20, height: 20, marginTop: 2, flexShrink: 0}} disabled={saving || !!pending || !dirty || !!latest || conflicts.length > 0} checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/><span>{t.confirmation}</span></label>
      <button type="button" data-testid="user-profile-save" style={{...button, background: 'var(--raised)', fontWeight: 700, justifySelf: 'start'}} disabled={!dirty || !confirmed || saving || !!pending || !!latest || conflicts.length > 0} onClick={() => void save()}>{saving ? t.saving : t.save}</button>
    </>}
  </section>;
}
