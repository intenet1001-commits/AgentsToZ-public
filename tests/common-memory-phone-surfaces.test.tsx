import {expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {RemoteCommonMemoryPanel,REMOTE_COMMON_MEMORY_NO_OPS} from '../src/RemoteCommonMemoryPanel';
import {RemoteMetaCommonMemoryPanel} from '../src/RemoteMetaCommonMemoryPanel';
import {ProjectCommonMemoryLinksView} from '../src/ProjectCommonMemoryLinks';
import MetaCommonMemoryPicker from '../src/MetaCommonMemoryPicker';
import {fileDownloadsWork,metaMemoryHistoryLabel} from '../src/MetaCommonMemoryPanel';
import {phoneOfflineNotice} from '../src/phoneNetwork';

const transport = async () => { throw Error('not used'); };
const src = (file: string) => readFileSync(join(import.meta.dir, '..', 'src', file), 'utf8');

test('a phone without its own network says so on both common-memory tabs, not "connect a Mac"', () => {
  for (const html of [
    renderToStaticMarkup(<RemoteCommonMemoryPanel visible available online={false} phoneOnline={false} transport={transport as any}/>),
    renderToStaticMarkup(<RemoteMetaCommonMemoryPanel visible available online={false} phoneOnline={false} transport={transport as any}/>),
  ]) { expect(html).toContain(phoneOfflineNotice()); expect(html).not.toContain('관리할 Mac에 연결하면'); }
  expect(renderToStaticMarkup(<RemoteCommonMemoryPanel visible available online={false} transport={transport as any}/>)).toContain('관리할 Mac에 연결하면 그 Mac과 같은 클라우드의 공통기억을 사용할 수 있습니다.');
  expect(renderToStaticMarkup(<RemoteMetaCommonMemoryPanel visible available online={false} transport={transport as any}/>)).toContain('관리할 Mac에 연결하면 이전 로컬 기억을 조회하고 변경할 수 있습니다.');
});

test('the portal hands the phone panel its OPS workroom, and opening it only fills the composer', () => {
  const portal = src('remote-control-portal-main.tsx');
  expect(portal).toContain('workroom={commonMemoryWorkroom}');
  expect(portal).toMatch(/<RemoteCommonMemoryPanel [^>]*phoneOnline=\{phoneOnline\}/);
  expect(portal).toMatch(/<RemoteMetaCommonMemoryPanel [^>]*phoneOnline=\{phoneOnline\}/);
  const open = portal.slice(portal.indexOf('const openCommonMemoryWorkroom='), portal.indexOf('const openCommonMemoryWorkroomRef='));
  // The same entry the VOC flow uses: target, title and prompt into the composer; nothing is sent or started here.
  expect(open).toContain('setTerminalEntry({nonce:++workroomNavigationNonce.current,targetId,title,prompt})');
  expect(open).not.toMatch(/send|start|launch|submit|fetch\(/i);
  expect(portal).toMatch(/commonMemoryWorkroom=useMemo<CommonMemoryWorkroomBridge\|undefined>\(\(\)=>opsControlId\?/);
  // Without OPS the panel says why and where to allow it, instead of the Mac's generic line.
  expect(src('RemoteCommonMemoryPanel.tsx')).toContain('workroomUnavailable={workroom?.targetId?undefined:REMOTE_COMMON_MEMORY_NO_OPS}');
  expect(REMOTE_COMMON_MEMORY_NO_OPS).toContain('아젠투지(OPS)');
  expect(REMOTE_COMMON_MEMORY_NO_OPS).toContain('Mac의 원격제어에서 OPS 프로젝트를 허용');
});

test('a project\'s links read as names and states; the memory ID waits under 고급 정보', () => {
  const html = renderToStaticMarkup(<ProjectCommonMemoryLinksView projectName="등록 A" result={{memoryId: '11111111-1111-4111-8111-111111111111', name: '11111111-1111-4111-8111-111111111111', groups: [
    {id: 'g1', name: '게임 조작', goal: '게임 조작', status: '게시됨', version: 7, publishedVersion: 6},
    {id: 'g2', name: 'iOS', goal: '아이폰 앱의 복귀 검증', status: '검토 중'},
  ]}}/>);
  expect(html).toContain('<b>등록 A</b>');
  expect(html).toContain('연결된 공통기억 2개');
  expect(html.match(/게임 조작/g)?.length).toBe(1);
  expect(html).toContain('아이폰 앱의 복귀 검증');
  expect(html).not.toMatch(/버전|v7|v6/);
  expect(html.indexOf('고급 정보')).toBeLessThan(html.indexOf('장기기억 ID: 11111111'));
  expect(renderToStaticMarkup(<ProjectCommonMemoryLinksView result={{memoryId: 'm', name: 'P', groups: []}}/>)).toContain('연결된 공통기억이 없습니다.');
});

test('each linked group on a project card opens by itself, and the app opens exactly that group', () => {
  const opened: string[] = [];
  const result = {memoryId: 'm1', name: '등록 A', groups: [{id: 'g1', name: '게임 조작', status: '게시됨'}, {id: 'g3', name: 'iOS', status: '검토 중'}]};
  // Walk the element tree the view returns and press the third group's own button, as a click would.
  const buttons: any[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.['data-testid'] === 'project-common-memory-open-group') buttons.push(node);
    walk(node.props?.children);
  };
  walk(ProjectCommonMemoryLinksView({result, onOpenGroup: id => opened.push(id)}));
  expect(buttons.map(b => b.props['aria-label'])).toEqual(['공통기억 「게임 조작」 열기', '공통기억 「iOS」 열기']);
  buttons[1].props.onClick();
  expect(opened).toEqual(['g3']);
  expect(renderToStaticMarkup(<ProjectCommonMemoryLinksView result={result}/>)).not.toContain('project-common-memory-open-group');
  expect(src('ProjectCommonMemoryLinks.tsx')).toContain('onOpenGroup={onManage&&(groupId=>onManage(result?.memoryId??memoryId,groupId))}');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  expect(app).toContain('setCommonMemoryFocusGroupId(typeof groupId === \'string\' && groupId ? groupId : undefined);');
  expect(app).toContain('<CommonMemoryPanel initiallyOpen focusGroupId={commonMemoryFocusGroupId} focusMemoryId={commonMemoryFocusMemoryId} ');
});

test('the new-project picker starts as loading, so "no common memory yet" never flashes before the first list', () => {
  const html = renderToStaticMarkup(<MetaCommonMemoryPicker selected={[]} onChange={() => {}}/>);
  expect(html).toContain('공통기억 조회 중…');
  expect(html).not.toContain('new-project-meta-memory-empty');
  expect(html).not.toContain('공통 기억');
});

test('history rows name the change in words', () => {
  expect(metaMemoryHistoryLabel('cloud-update')).toBe('클라우드에서 변경');
  expect(metaMemoryHistoryLabel('migration')).toBe('이전 기억에서 옮김');
  expect(metaMemoryHistoryLabel('save')).toBe('이름·연결 저장');
  expect(metaMemoryHistoryLabel('review-entries')).toBe('후보 검토');
  expect(metaMemoryHistoryLabel('something-new')).toBe('something-new');
});

test('the Mac app saves an export through its file dialog; another WKWebView shell (the iOS app) shows it to copy', () => {
  expect(fileDownloadsWork({webkit: {messageHandlers: {agentstozOAuth: {}}}})).toBe(false);
  expect(fileDownloadsWork({})).toBe(true);
  expect(fileDownloadsWork(undefined)).toBe(true);
  const panel = src('MetaCommonMemoryPanel.tsx');
  expect(panel).toContain("if (!fileDownloadsWork()) { if (alive.current) { setExported({ memoryId: memory!.id, text }); setExportCopied(''); } return; }");
  expect(panel).toContain('{exported?.memoryId === memory.id && <div data-testid="meta-memory-export-copy"');
  expect(panel).toContain('data-testid="meta-memory-export-copy"');
  // The Mac app is a WKWebView with message handlers too and has no download handler: it must take the dialog first.
  expect(panel.indexOf('if (isTauri()) {')).toBeGreaterThan(-1);
  expect(panel.indexOf('if (isTauri()) {')).toBeLessThan(panel.indexOf('if (!fileDownloadsWork()) {'));
});

test('a phone memory row reaches its common memory: the catalog passes the jump and the portal opens the common chip on it', () => {
  expect(src('portal-main.tsx')).toContain('supabaseClientFactory={getAuthenticatedSupabaseClient} onOpenCommonMemory={onOpenCommonMemory} visible={');
  const portal = src('remote-control-portal-main.tsx');
  expect(portal).toContain("onOpenCommonMemory={memoryId=>{setCommonFocusMemoryId(memoryId);setRecordMode('common');navigateWorkspace('records');}}");
  expect(portal).toContain('focusMemoryId={commonFocusMemoryId} onFocusHandled={()=>setCommonFocusMemoryId(undefined)}/>');
  // Leaving the chip or the tab drops a jump not yet used; a used one is handed back (common-memory-phone-surfaces-ui).
  expect(portal).toContain("useEffect(()=>{if(recordMode!=='common'||workspaceTab!=='records')setCommonFocusMemoryId(undefined);},[recordMode,workspaceTab]);");
  expect(src('RemoteCommonMemoryPanel.tsx')).toContain('<CommonMemoryPanel client={client} initiallyOpen focusMemoryId={keep?undefined:focusMemoryId} onFocusHandled={onFocusHandled} ');
});
