import React from 'react';
import {createRoot} from 'react-dom/client';
import {WorkspaceTools} from '../../src/components/WorkspaceTools';
import {WorkspaceToolGroup} from '../../src/components/WorkspaceToolGroup';
import {WorkspaceScreenEntries} from '../../src/WorkspaceScreenEntries';
import '../../src/workspaceDesign.css';

const fixture=window as typeof window&{isTauri:boolean;nativeCalls:string[];toolActions:string[];failStatus:boolean;blocked:boolean;supported:boolean;tickHelpers:()=>void;helperTimerCount:()=>number;__TAURI_INTERNALS__:unknown};
fixture.isTauri=true;fixture.nativeCalls=[];fixture.toolActions=[];fixture.failStatus=false;fixture.blocked=false;fixture.supported=true;
let nextTimer=1000;const timers=new Map<number,TimerHandler>();
const realSet=window.setInterval.bind(window),realClear=window.clearInterval.bind(window);
window.setInterval=((handler:TimerHandler,delay?:number,...args:unknown[])=>{
  if(delay!==5000)return realSet(handler,delay,...args);
  const id=nextTimer++;timers.set(id,handler);return id;
}) as typeof window.setInterval;
window.clearInterval=((id?:number)=>{if(id!==undefined&&timers.delete(id))return;realClear(id);}) as typeof window.clearInterval;
fixture.tickHelpers=()=>{for(const handler of timers.values())if(typeof handler==='function')handler();};
fixture.helperTimerCount=()=>timers.size;
fixture.__TAURI_INTERNALS__={invoke:async(command:string)=>{
  fixture.nativeCalls.push(command);
  if(command==='get_screen_helper'||command==='get_viewer_helper'){
    if(fixture.failStatus)throw Error('fixture status unavailable');
    return {supported:fixture.supported,installed:true,bundled:true,running:false,updatePending:fixture.blocked,otherInstanceRunning:fixture.blocked,instanceStatusUnknown:false,state:null};
  }
  if(command==='open_screen_helper'||command==='open_viewer_helper')return {verified:true};
  throw Error('Unexpected native operation in tools fixture');
}};
const action=(id:string,label:string)=><button type="button" data-testid={id} onClick={()=>fixture.toolActions.push(id)}>{label}</button>;
createRoot(document.getElementById('root')!).render(<div className="workspace-sidebar-footer" style={{position:'absolute',bottom:0,left:0,width:264}}>
  <WorkspaceTools label="도구 및 설정"><div className="workspace-project-tools">
    {action('pinned-project','AgentsToZ_byCS')}
    <WorkspaceToolGroup title="기기 연결"><WorkspaceScreenEntries lang="ko"/>{action('computer-use','컴퓨터 유즈')}</WorkspaceToolGroup>
    <WorkspaceToolGroup title="AI 협업">{action('teams','Teams 원격 작업 허용 프로젝트')}{action('chat','기기 간 대화')}{action('voice','아젠투지 음성 창')}{action('call','아젠투지 호출 열기')}</WorkspaceToolGroup>
    <WorkspaceToolGroup title="설정·지원">{action('effort','외부 앱 에포트')}{action('settings','아젠투지 설정')}{action('helpdesk','아젠투지 헬프데스크')}
      <details className="workspace-tools-advanced"><summary>고급 설정</summary><div className="workspace-tools-advanced__body">{action('ops','AgentsToZ OPS 운영 폴더 열기')}</div></details>
    </WorkspaceToolGroup>
    <div className="workspace-tools-section">데이터</div>{action('data-export','내보내기')}
  </div></WorkspaceTools>
</div>);
