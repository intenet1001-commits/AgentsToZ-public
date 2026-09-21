import React from 'react';
import {createRoot} from 'react-dom/client';
import {MobileWorkspacePanel} from '../../../src/MobileWorkspacePanel';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from '../../../src/mobileWorkspaceProtocol';
const fixture=window as unknown as Window&{requests:MobileWorkspaceRequest[];draft:string};fixture.requests=[];fixture.draft='';
const prose='이전에 요청했던 프로젝트 작업 내용입니다. '.repeat(100);
const projects=[{controlId:'project_1234',name:'검증 프로젝트',alias:null,workspaceRoot:null,branch:'topic',port:null,kind:'worktree' as const,status:'stopped' as const,actions:[]}];
async function transport(r:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>{
 fixture.requests.push(r);const action=r.workspace.action;
 if(action==='said.list'||action==='said.read'){
  const offset=action==='said.read'?r.workspace.offset!:0,limit=action==='said.read'?1500:500;
  return {kind:'workspace',action,source:'local',scanComplete:true,hasMore:false,nextBeforeSeq:null,nextOffset:offset+limit<prose.length?offset+limit:null,records:[{id:'record_1234',text:prose.slice(offset,offset+limit),textHash:'a'.repeat(64),truncated:offset+limit<prose.length,recordedAt:'2026-09-11T01:00:00Z',agent:'codex',deviceName:'검증 Mac',origin:'human'}]};
 }
 if(action.startsWith('memory.'))return {kind:'workspace',action,memory:{state:action==='memory.save'?'saving':'saved',localSaved:action==='memory.status',backupSaved:false,message:action==='memory.save'?'세션 기억 저장 중':'로컬 저장 완료 · 백업 대기'}};
 if(action==='duty.status')return {kind:'workspace',action,supported:true,connections:[{id:'connection_1234',title:'검증 대화방',alias:'프로젝트',profile:'검증 프로필',state:'off',revision:4,knowledgeRevision:7,replied:0,checkedAt:null}]};
 if(action==='duty.enable')return {kind:'workspace',action,supported:true,connections:[]};
 throw new Error('unsupported fixture request');
}
createRoot(document.getElementById('root')!).render(<><MobileWorkspacePanel mode="records" projects={projects} available online transport={transport} onDraft={(_,text)=>{fixture.draft=text}}/><MobileWorkspacePanel mode="manage" projects={projects} available online transport={transport} onDraft={()=>{}}/></>);
