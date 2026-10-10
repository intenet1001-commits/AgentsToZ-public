/**
 * A Workroom pop-out window: the whole work-session page (session list, terminal,
 * composer, key row, footer) in a minimal shell, outside the main app window.
 * It talks to the same local sidecar through the same transport as the main window.
 * Closing this window only closes the view — the CLI session keeps running.
 */
import React, {Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {invoke} from '@tauri-apps/api/core';
import {type AiTerminalEntry} from './AiTerminalPanel';
// 이 창도 기기 탭을 가진다 — 「호 선택 → 프로젝트 선택 → 열기」가 창 하나에서 끝난다(VOC 2026-10-05).
// 직접 패널을 그리지 않고 같은 전환기를 쓰므로 기기 목록·전달 경로 판정이 한 곳에 남는다.
import {WorkroomDeviceSwitch} from './WorkroomDeviceSwitch';
import {isTauri} from './lib/env';
import {workroomPopoutTitle, type WorkroomPopoutRoute} from './workroomPopout';
import {setWorkroomWindowTitle} from './workroomPopoutClient';
import {workroomProjectsFromPorts, type WorkroomRegisteredProject, type WorkroomRegisteredRow} from './workroomProjects';
import {isVocShortcut} from './vocShortcut';
import {useOverlayHost} from './topLayerHost';
import {createVocClient, type VocNotifyKind, type VocSubmitInput} from './voc/vocClient';
import {resolvePrimaryProject} from './primaryProject';
import {publicGitHubRepositoryUrl} from './selfHosting';
import {BUILD_INFO} from './buildInfo';
import {validateDeviceName} from './deviceName';
import './WorkroomPopout.css';

const VocOverlay = lazy(() => import('./voc/VocOverlay').then(({VocOverlay}) => ({default: VocOverlay})));
const AGENTSTOZ_PUBLIC_REPOSITORY_URL = publicGitHubRepositoryUrl(import.meta.env.VITE_REPO_URL);
const APP_VERSION = `v${BUILD_INFO.buildNumber} ${BUILD_INFO.version}`.trim();
/** VOC 파일의 `tab` 값 — 이 창에서 남긴 요청이 어디서 왔는지 검토할 때 구분한다. */
const POPOUT_VOC_TAB = 'workroom-popout';
type PopoutRow = WorkroomRegisteredRow & {role?: unknown; githubUrl?: unknown; githubUrls?: unknown};
const str = (value: unknown) => typeof value === 'string' ? value : undefined;
/** Registered rows as primary-project candidates (the same rule the main window uses to find AgentsToZ DEV). */
function devProjectCandidates(rows: readonly PopoutRow[]) {
  return rows.map(row => ({
    id: row.id, role: row.role, folderPath: str(row.folderPath), worktreePath: str(row.worktreePath),
    worktreeParentId: str(row.worktreeParentId), githubUrl: str(row.githubUrl),
    githubUrls: Array.isArray(row.githubUrls) ? row.githubUrls.filter((url): url is string => typeof url === 'string') : undefined,
  }));
}

async function loadRegisteredRows(): Promise<WorkroomRegisteredRow[]> {
  if (isTauri()) return invoke<WorkroomRegisteredRow[]>('load_ports');
  const response = await fetch('/api/ports');
  if (!response.ok) throw new Error('프로젝트 목록을 불러오지 못했습니다.');
  return response.json();
}

export function WorkroomPopoutApp({route}: {route: WorkroomPopoutRoute}) {
  const [rows, setRows] = useState<PopoutRow[] | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const projects = useMemo<WorkroomRegisteredProject[] | null>(() => rows ? workroomProjectsFromPorts(rows) : null, [rows]);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [bypassPermissions, setBypassPermissions] = useState(route.bypassPermissions);
  useEffect(() => {
    let stopped = false;
    setError('');
    loadRegisteredRows()
      .then(loaded => { if (!stopped) setRows(Array.isArray(loaded) ? loaded as PopoutRow[] : []); })
      .catch(e => { if (!stopped) setError(e instanceof Error ? e.message : String(e)); });
    return () => { stopped = true; };
  }, [reload]);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true;
    void invoke<Record<string, unknown>>('load_portal').then(config => {
      if (live && typeof config.deviceName === 'string') setDeviceName(config.deviceName);
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  // The pop-out opens on the chosen session, then the user switches freely. A VOC draft replaces the entry.
  const [entry, setEntry] = useState<AiTerminalEntry>(() => ({nonce: 1, targetId: route.targetId, sessionId: route.sessionId, agent: route.agent}));
  const entryNonce = useRef(1);

  // VOC — the same overlay, shortcut and sidecar calls as the main window (CLAUDE.md 「VOC」).
  const [vocMode, setVocMode] = useState(false);
  const [notice, setNotice] = useState<{id: number; message: string; kind: VocNotifyKind} | null>(null);
  const noticeId = useRef(0);
  const notify = useCallback((message: string, kind: VocNotifyKind) => setNotice({id: ++noticeId.current, message, kind}), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(current => current?.id === notice.id ? null : current), notice.kind === 'error' ? 12_000 : 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const vocClient = useMemo(() => createVocClient({notify}), [notify]);
  const [vocRemoteUnlimited, setVocRemoteUnlimited] = useState(false);
  useEffect(() => {
    if (!vocMode) return;
    let stopped = false;
    void vocClient.loadAccess().then(access => { if (!stopped) setVocRemoteUnlimited(access.remoteUnlimited); });
    return () => { stopped = true; };
  }, [vocMode, vocClient]);
  // ⌘/Ctrl+Shift+V — window capture so it runs before any dialog's own key handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isVocShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setVocMode(v => !v);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // A modal <dialog> is top layer and would cover an overlay on <body> — portal into it.
  const overlayHost = useOverlayHost(vocMode);
  const submitVoc = useCallback((input: VocSubmitInput) => vocClient.submit(input, {tab: POPOUT_VOC_TAB, appVersion: APP_VERSION}), [vocClient]);
  // 「워크룸으로 VOC 처리」 fills a draft into THIS window's Workroom for the AgentsToZ DEV project.
  // It never starts anything — the user presses start.
  const devProject = useMemo(() => rows ? resolvePrimaryProject(devProjectCandidates(rows), AGENTSTOZ_PUBLIC_REPOSITORY_URL) : null, [rows]);
  const devTargetId = devProject && projects?.some(project => project.targetId === devProject.id) ? devProject.id : '';
  const openVocInWorkroom = useCallback((title: string, prompt: string) => {
    if (!devTargetId) { notify('AgentsToZ DEV 프로젝트를 찾지 못해 워크룸을 열지 못했습니다.', 'error'); return; }
    setEntry({nonce: ++entryNonce.current, targetId: devTargetId, title, prompt});
    setVocMode(false);
  }, [devTargetId, notify]);
  const onActiveSessionChange = useCallback((session: {label: string; agent: WorkroomPopoutRoute['agent']} | null) => {
    const checkedName = validateDeviceName(deviceName);
    const owner = checkedName.ok ? `총괄(${checkedName.value}) · ` : '';
    setWorkroomWindowTitle(session ? `${owner}${workroomPopoutTitle(session.label, session.agent)}` : `${owner}워크룸`);
  }, [deviceName]);
  return <main className="workroom-popout" data-testid="workroom-popout-window">
    {projects
      ? <WorkroomDeviceSwitch popout projects={projects} entry={entry} sessionScope="popout" bypassPermissions={bypassPermissions} onBypassPermissionsChange={setBypassPermissions} onActiveSessionChange={onActiveSessionChange} deviceName={deviceName}/>
      : error
        ? <div className="workroom-popout-state" role="alert"><p>{error}</p><button type="button" onClick={() => setReload(value => value + 1)}>다시 불러오기</button></div>
        : <p className="workroom-popout-state" role="status">워크룸을 불러오는 중…</p>}
    {notice && <div className={`workroom-popout-notice workroom-popout-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid="workroom-popout-notice">
      <span>{notice.message}</span>
      <button type="button" aria-label="알림 닫기" onClick={() => setNotice(null)}>×</button>
    </div>}
    {vocMode && typeof document !== 'undefined' && createPortal(
      <Suspense fallback={null}>
        <VocOverlay
          onClose={() => setVocMode(false)}
          onSubmit={submitVoc}
          onOpenWorkroom={openVocInWorkroom}
          projectPath={devProject?.folderPath}
          onLoadInbox={vocClient.loadInbox}
          onUpdateInboxItem={vocClient.updateInboxItem}
          onDeleteInboxItem={vocClient.deleteInboxItem}
          onLoadPortalErrors={vocClient.loadPortalErrors}
          tab={POPOUT_VOC_TAB}
          appVersion={APP_VERSION}
          remoteUnlimited={vocRemoteUnlimited}
        />
      </Suspense>,
      overlayHost ?? document.body,
    )}
  </main>;
}
