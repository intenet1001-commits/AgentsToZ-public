/** The phone Workroom history panel alone, for tests/remote-workroom-history-confirm.e2e.mjs. The fake Mac records every
 *  history action in `window.__historyCalls`; nothing leaves the page. */
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteWorkroomHistoryPanel} from '../../src/RemoteWorkroomHistoryPanel';
import type {RemoteHistoryTransport} from '../../src/remoteWorkroomHistoryClient';

const now = new Date().toISOString();
const rows = [
  {id: 'conv_fixture_0000001', title: '이어 열 대화', agent: 'claude', state: 'ended', resumable: true, updatedAt: now, revision: 1},
  {id: 'conv_fixture_0000002', title: '다른 대화', agent: 'codex', state: 'detached', resumable: true, updatedAt: now, revision: 2},
];
const calls: string[] = [];
(window as unknown as {__historyCalls: string[]}).__historyCalls = calls;
const fixture={duplicates:false,reviewed:[] as string[],holdList:false,listWaiting:false,releaseList:()=>{},switchHost:(_host:string)=>{},mount:(_value:boolean)=>{},executeSettled:false,visibility:(_value:boolean)=>{},availability:(_value:boolean)=>{},connection:(_value:boolean)=>{},emptyProjects:(_value:boolean)=>{},listError:'',completed:false,holdExecute:false,executeWaiting:false,releaseExecute:()=>{},selected:[] as string[]};
(window as any).__historyFixture=fixture;
const transport = (async request => {
  const {action} = (request as unknown as {workspace: {action: string}}).workspace;
  calls.push(action);
  if (action === 'history.list') {
    if(fixture.listError)throw Error(fixture.listError);
    if(fixture.holdList){fixture.listWaiting=true;await new Promise<void>(resolve=>{fixture.releaseList=()=>{fixture.holdList=false;fixture.listWaiting=false;resolve();};});}
    const records=fixture.duplicates?rows.map((row,index)=>({...row,title:'Codex CLI 대화',state:'ended',updatedAt:new Date(2026,9,21,0,12,5+index).toISOString()})):rows;
    return {action, history: {records:request.targetId==='control_fixture_0001'?records:[{...rows[0],id:'conv_fixture_other_0001',title:'두번째 Mac의 대화'}], nextBefore: null}};
  }
  if (action === 'history.resume.review') {fixture.reviewed.push((request.workspace as any).history.conversationId);return {action, history: {review: {id: 'review_fixture_0001', expiresAt: Date.now() + 60_000, available: true, reason: '', revision: 1}}};}
  if (action === 'history.resume.execute') {
    if(fixture.holdExecute){fixture.executeWaiting=true;await new Promise<void>(resolve=>{fixture.releaseExecute=()=>{fixture.executeWaiting=false;resolve();};});}
    fixture.executeSettled=true;return {action, history: {resume: fixture.completed?{state:'completed',sessionId:'resumed_fixture_0001'}:{state: 'unknown'}}};
  }
  if (action === 'history.resume.status') return {action, history: {resume: {state:'completed',sessionId:'resumed_fixture_0001'}}};
  throw new Error('unexpected ' + action);
}) as RemoteHistoryTransport;
const map = new Map<string, string>();
const storage = {getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, String(value)); }};

function Fixture(){
 const [host,setHost]=useState('host_fixture_0001'),[mounted,setMounted]=useState(true),[visible,setVisible]=useState(true),[available,setAvailable]=useState(true),[online,setOnline]=useState(true),[empty,setEmpty]=useState(false);fixture.switchHost=setHost;fixture.mount=setMounted;fixture.visibility=setVisible;fixture.availability=setAvailable;fixture.connection=setOnline;fixture.emptyProjects=setEmpty;
 return (
  <main className="remote-shell" data-workspace-tab="workroom">
    <div className="remote-panel remote-workroom-content" data-testid="history-fixture-context" data-visibility={visible} data-availability={available} data-connection={online}>
      {mounted?<RemoteWorkroomHistoryPanel available={available} visible={visible} online={online} host={host} pairing="p_fixture_pairing_0001" knownHosts={['host_fixture_0001','host_fixture_0002']}
        projects={empty?[]:host==='host_fixture_0001'?[{targetId: 'control_fixture_0001', label: '블로그'}]:[{targetId:'control_fixture_0002',label:'두번째 Mac 프로젝트'}]} transport={transport} storage={storage} onResumed={async id=>{fixture.selected.push(id);return true;}}/>:<p>대화 목록을 닫았습니다.</p>}
    </div>
  </main>
 );
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
