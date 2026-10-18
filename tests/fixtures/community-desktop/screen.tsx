import React from 'react';
import {createRoot} from 'react-dom/client';
import '../../../src/index.css';
import '../../../src/workspaceDesign.css';
import {WorkroomDeviceSwitch} from '../../../src/WorkroomDeviceSwitch';
import {applyZoomToDocument} from '../../../src/uiZoom';

// Invented local data only. No installed app, project files, CLI, relay or paid AI.
const projectId='desktop-project-001',peerId='10000000-0000-4000-8000-000000000002';
const projects=[{targetId:projectId,label:'AgentsToZ 모바일 앱'},{targetId:'desktop-project-002',label:'디자인 시스템'},{targetId:'desktop-project-003',label:'고객 지원 포털'}];
const at='2026-10-17T01:00:00Z';
const summary=(id:string,title:string,state='running',agent='codex')=>({id,title,state,agent,sessionId:'session-'+id,revision:1,createdAt:at,updatedAt:at});
const threads=[summary('desktop-thread-001','iPhone 워크룸 연결 흐름 개선','needs-answer'),summary('desktop-thread-002','채널별 프로젝트 목록 정리','running','claude'),summary('desktop-thread-003','모바일 키보드 회귀 확인','completed')];
const messages=new Map(threads.map(t=>[t.id,[{id:t.id+'-request',seq:1,role:'user',kind:'request',text:t.title,at,delivery:'written'},{id:t.id+'-answer',seq:2,role:'assistant',kind:t.state==='needs-answer'?'question':t.state==='completed'?'result':'progress',text:t.state==='needs-answer'?'연결 버튼을 누르면 기존 세션을 이어 열까요, 새 업무를 시작할까요?':t.state==='completed'?'세로·가로 화면과 키보드 입력을 확인했습니다.':'기기별 프로젝트 구성을 확인하고 있습니다.',at,delivery:'written'}]]));
const fixture={requests:[] as any[],holdRead:false,readWaiting:false,readResolvers:[] as (()=>void)[],failRead:false,loseReply:false,releaseRead:()=>{},empty:false,completeOther:()=>{threads[1]!.state='completed';}};
fixture.releaseRead=()=>{fixture.holdRead=false;fixture.readWaiting=false;fixture.readResolvers.splice(0).forEach(resolve=>resolve());};
(window as any).communityFixture=fixture;
const session={id:'desktop-session-001',targetId:projectId,agent:'codex',state:'running',createdAt:at,exitCode:null,cols:100,rows:28};
async function workspace(request:any):Promise<any>{
 fixture.requests.push(request);const {action,thread,sessionId}=request.workspace;
 if(action==='workroom.status')return {kind:'workspace',action,workroom:{sessionId,initialized:true,lastSavedAt:null,context:{usedPercent:null,observedAt:null,source:'unavailable'},save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}}};
 if(action==='workroom.threads.list')return {kind:'workspace',action,threads:{threads:fixture.empty?[]:threads,nextThreadId:null}};
 if(action==='workroom.threads.read'){
  if(fixture.holdRead){fixture.readWaiting=true;await new Promise<void>(resolve=>fixture.readResolvers.push(resolve));}
  if(fixture.failRead)throw Error('스레드를 불러오지 못했습니다. 다시 확인해 주세요.');
  const t=threads.find(t=>t.id===thread.threadId);if(!t)throw Error('Fixture thread missing');
  return {kind:'workspace',action,threads:{thread:{...t},messages:messages.get(t.id),nextBefore:null}};
 }
 if(action==='workroom.threads.reply'){
  const t=threads.find(t=>t.id===thread.threadId)!;t.revision++;messages.get(t.id)!.push({id:request.requestId,seq:3,role:'user',kind:'reply',text:thread.text,at,delivery:'written'});
  if(fixture.loseReply)throw Error('응답을 확인하지 못했습니다.');
  return {kind:'workspace',action,threads:{thread:{...t},messages:messages.get(t.id),nextBefore:null}};
 }
 if(action==='workroom.threads.create')throw Error('이 화면 검증은 새 CLI를 실행하지 않습니다.');
 throw Error('Fixture workspace request blocked');
}
const terminal=(request:any):any=>{
 if(request.operation==='workspace')return workspace(request);
 if(request.operation==='list')return {sessions:[session]};
 if(request.operation==='read')return {session,chunks:request.after?[]:[{seq:1,text:'격리 화면 검증 · 실제 CLI가 아닙니다.\r\n'}],nextCursor:1,truncated:false,hasMore:false};
 if(request.operation==='accounts')return {accounts:{agent:request.agent,selectedAccountId:'host-default',items:[{id:'host-default',agent:request.agent,label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}};
 if(request.operation==='resize')return {session};
 throw Error('Fixture terminal action blocked: '+request.operation);
};
const fixtureFetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const body=init?.body?JSON.parse(String(init.body)):{};
 try{
  if(url.pathname==='/api/agent-dialogue/control'){
   if(body.operation==='devices')return Response.json({success:true,inside:true,deviceId:'desktop-device-001',devices:[{endpointId:peerId,deviceId:'desktop-peer-device',displayName:'아젠투지 2호',kind:'ops',lastSeenAt:at}],unread:0,lastMessageAt:null});
   if(body.operation==='call')return Response.json({success:true,response:{ok:true,body:body.request.kind==='projects'?{projects,deviceName:'아젠투지 2호'}:{result:await terminal(body.request.body)}}});
  }
  if(url.pathname==='/api/agent-dialogue/manage')return Response.json({success:true,community:{inside:true,roomId:peerId,unread:0,members:[],messages:[],nextSeq:0,devices:[]}});
  if(url.pathname==='/api/agent-runtime/targets')return Response.json({protocolVersion:'agentstoz-tasks-v2',complete:true,targets:projects.map(p=>({...p,projectTargetId:p.targetId,scope:'main',branch:null,locked:false,worktreeCapable:false}))});
  if(url.pathname==='/api/agent-runtime/terminals')return Response.json(await terminal(body));
  if(url.pathname.endsWith('/access'))return Response.json({connections:[],workspaceRoots:[]});
  if(url.pathname.endsWith('/memory'))return Response.json({jobs:[]});
  throw Error('격리 화면: 실제 API 접근 차단');
 }catch(e){return Response.json({error:String(e instanceof Error?e.message:e)},{status:400});}
};
Object.defineProperty(window,'fetch',{value:fixtureFetch,configurable:true,writable:true});
const query=new URLSearchParams(location.search);document.documentElement.dataset.appTheme=query.get('theme')??'gray';
applyZoomToDocument(document,Number(query.get('zoom')??1));
createRoot(document.getElementById('root')!).render(<div className="workspace-shell" style={{height:'var(--ui-viewport-height,100dvh)'}} data-mobile="false">
 <aside data-testid="top-toolbar"><div className="workspace-brand"><span className="workspace-brand-mark">AZ</span><span>AgentsToZ</span></div><div className="workspace-navigation"><div role="tablist"><button role="tab">프로젝트·폴더</button><button role="tab" aria-selected="true">대화 세션</button><button role="tab">북마크</button><button role="tab">장기기억</button></div></div></aside>
 <div className="workspace-content"><main style={{flex:1,minHeight:0,overflow:'auto'}}><WorkroomDeviceSwitch sessionDirectory projects={projects} visible deviceName="아젠투지 1호" workspaceTransport={workspace}/></main></div>
</div>);
