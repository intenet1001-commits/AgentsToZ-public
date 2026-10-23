import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../../src/index.css';
import '../../src/workspaceDesign.css';
import '../../src/remote-control-portal.css';
import {CommunityWorkspace} from '../../src/CommunityWorkspace';
import {RemoteWorkroomHistoryPanel} from '../../src/RemoteWorkroomHistoryPanel';
import type {WorkroomTransport} from '../../src/WorkroomSessionFooter';
import type {RemoteHistoryTransport} from '../../src/remoteWorkroomHistoryClient';
import {TesterImprovementPanel} from '../../src/TesterImprovementPanel';

const targetId=/iPhone/.test(navigator.userAgent)?'native_phone_project_01':'native_mac_project_01';
const workspace:WorkroomTransport=async request=>{
 const response=await fetch('/fixture/workspace',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
 const value=await response.json();if(!response.ok)throw Error(value.error);return value;
};
const history:RemoteHistoryTransport=async request=>{
 const response=await fetch('/fixture/history',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
 const value=await response.json();if(!response.ok)throw Error(value.error);return value;
};
function Fixture(){
 const [pane,setPane]=useState('task'),[granted,setGranted]=useState(false),[selected,setSelected]=useState('');
 (window as any).__nativePersona={pane,selected,granted};
 const choose=(value:string)=>{setPane(value);window.scrollTo(0,0);};
 return <main data-testid="native-persona-root" style={{maxWidth:1100,margin:'auto',paddingBottom:100,color:'var(--ink)'}}>
  <header style={{padding:16}}><h1 style={{fontSize:20}}>워크룸 실기 검증</h1><p>가상 프로젝트 · 실제 AI와 개인 데이터는 사용하지 않습니다.</p>
   <nav aria-label="검증 흐름" style={{display:'flex',gap:8,flexWrap:'wrap'}}>{[['task','첫 업무'],['history','지난 워크룸'],['improvements','개선 기록']].map(([key,label])=><button style={{minHeight:44,padding:10}} key={key} aria-pressed={pane===key} onClick={()=>choose(key!)}>{label}</button>)}</nav>
  </header>
  {pane==='improvements'?<section style={{padding:16}}><TesterImprovementPanel target={{portId:'native-persona'}} transport={async request=>{const response=await fetch('/fixture/tester',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});const value=await response.json();if(!response.ok)throw Error(value.error);return value;}}/></section>:pane==='task'?<CommunityWorkspace channels={[{id:'native-device',label:'검증 Mac',projects:async()=>[{targetId,label:'실기 검증 프로젝트'}],transport:workspace}]} onOpenWorkroom={()=>{}}/>:<div className="remote-panel remote-workroom-content">
   <button style={{minHeight:44,padding:10}} onClick={async()=>{await fetch('/fixture/grant',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({targetId})});setGranted(true);}}>검증 권한 허용</button>
   <p>{granted?'검증 프로젝트의 기록 보기·이어 열기를 허용했습니다.':'지난 대화는 별도 권한이 필요합니다.'}</p>
   <RemoteWorkroomHistoryPanel available visible online host="native_persona_host_01" pairing="native_persona_pair_01" projects={[{targetId,label:'실기 검증 프로젝트'}]} transport={history} onResumed={async id=>{setSelected(id);return true;}}/>
   {selected&&<p role="status">재개한 세션을 선택했습니다.</p>}
  </div>}
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
