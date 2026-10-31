import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {AutomaticSaveNotice} from '../../src/AutomaticSaveNotice';
import {saveTargets} from '../../src/unsavedSessionMemory';
import {MEMORY_SAVE_NOTICE_RECOVERY_PATH,performMemorySaveNoticeRecovery,MemorySaveNoticeRecoveryError} from '../../src/memorySaveNoticeRecoveryRoute';

const kind=new URL(location.href).searchParams.get('kind')??'agent';
const calls:{path:string;body:any}[]=[],opened:string[]=[];
const terminalCalls:any[]=[];
Object.assign(window,{calls,opened,terminalCalls});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const room=(targetId='project-memory-123',agent='codex',id='session-memory-123')=>({id,targetId,agent,state:'running',createdAt:'2026-10-29T06:00:00Z',exitCode:null,cols:100,rows:28});
window.open=((url:string|URL)=>{opened.push(String(url));return kind==='open-fail'&&opened.length===1?null:{} as Window;}) as typeof window.open;
globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=String(input).replace(/^https?:\/\/[^/]+/,''),body=init?.body?JSON.parse(String(init.body)):null;calls.push({path,body});
  if(path==='/api/project-memory/auto-checkpoint/status'||path==='/api/context-usage')return json({sessions:[]});
  if(path==='/api/ports')return json([{id:'project-memory-123',name:'테스트 프로젝트',folderPath:'/fixture/project'}]);
  if(path==='/api/project-memory/detect')return json({exists:true,config:{autoBackup:true},activity:{needsRemember:true}});
  if(path==='/api/project-memory/session-end'){
    if(kind==='conflict')return json({success:false,localSaved:false,preflightConflict:true,backupError:'PRIVATE_REMOTE_REVISION'});
    if(kind==='unknown')throw TypeError('private transport details');
    if(kind==='backup')return json({success:false,localSaved:true,backupError:'PRIVATE_BACKUP_DETAILS'});
    return json({error:'OpenAI Codex v0.163.0\nworkdir: /private/project\nuser\n'+'PRIVATE_MEMORY_PROMPT'.repeat(1000),code:'PROJECT_MEMORY_AGENT_FAILED'},500);
  }
  if(path==='/api/project-memory/resolve-project')return kind==='unregistered'?json({ok:false,code:'PROJECT_AMBIGUOUS'},409):json({ok:true,id:'project-memory-123'});
  if(path===MEMORY_SAVE_NOTICE_RECOVERY_PATH){
    try{return json(await performMemorySaveNoticeRecovery(body,async request=>{
      terminalCalls.push(request);
      if(request.operation==='start'){
        if(kind==='launch-unknown')throw TypeError('lost start reply');
        return {session:room(request.targetId,request.agent)} as any;
      }
      return {sessions:[room(),room('other-project-123','codex','other-session-123'),room('project-memory-123','claude','claude-session-123')]} as any;
    }));}catch(error){const failure=error as MemorySaveNoticeRecoveryError;return json({error:failure.message,code:failure.code},failure.status);}
  }
  throw Error('Unexpected fixture request: '+path);
}) as typeof fetch;
function Fixture(){
  useEffect(()=>{void saveTargets([{folder:'/fixture/project',name:'테스트 프로젝트',agent:'codex'}]);},[]);
  return <main><h1>기억 저장 결과</h1><AutomaticSaveNotice placement="dock"/><label>아젠투지에게 입력<textarea aria-label="아젠투지에게 입력"/></label></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
