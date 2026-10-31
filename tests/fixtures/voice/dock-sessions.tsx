import React from 'react';import {createRoot} from 'react-dom/client';
import {AgentsToZVoiceDock} from '../../../src/components/AgentsToZVoiceDock';
import {AutomaticSaveNotice} from '../../../src/AutomaticSaveNotice';
import type {VoiceRequest,VoiceResponse} from '../../../src/voiceSessionProtocol';
import '../../../src/appearanceTokens.css';

/** The dock's saved-notice stack and 「열린 AI 세션」 list against a synthetic local API (scripts/check-voice-dock-sessions.ts). */
const f=window as any;f.calls=[] as {path:string;body?:any}[];
// A real server keeps lastCheckpointAt stable; keep the fixture's clock across reloads too (it is part of a notice's id).
const now=Number(localStorage.getItem('fixture-now'))||(()=>{const v=Date.now();localStorage.setItem('fixture-now',String(v));return v;})(),ago=(minutes:number)=>new Date(now-minutes*60_000).toISOString();
const A='/fixture/AgentsToZ_byCS',B='/fixture/AgentsToZ-OPS';
// A: new activity, Supabase in sync → 「지금 저장」. B: nothing new, local ahead of Supabase → 「동기화」.
// The check script can preset memory and slow saves down across a reload (the dock's background check runs at mount).
f.memory=JSON.parse(localStorage.getItem('fixture-memory')??'null')??{[A]:{needs:true,inSync:true},[B]:{needs:false,inSync:false}};
f.saveDelayMs=Number(localStorage.getItem('fixture-save-delay')||0);f.activeSaves=0;f.maxActiveSaves=0;
const status=(folder:string)=>{const m=f.memory[folder];if(!m)return {exists:false,projectRoot:folder,modifiedAt:null,contentHash:null,config:null,activity:{needsRemember:false,reasons:[],lastRememberedAt:null}};return {exists:true,projectRoot:folder,modifiedAt:ago(m.needs?90:20),contentHash:'local-'+folder,
  config:{autoBackup:true,lastUpdatedAt:ago(90),lastSyncedHash:m.inSync?'local-'+folder:'baseline',lastBackedUpAt:ago(60)},
  activity:{needsRemember:m.needs,reasons:m.needs?['session-activity']:[],lastRememberedAt:ago(200)}};};
const remote=(folder:string)=>{const m=f.memory[folder];return {exists:true,createdAt:ago(m.inSync?89:100),contentHash:m.conflict?'remote-changed':m.inSync?'local-'+folder:'baseline',inSync:m.inSync};};
// 「비교·해결」: from the agreed base each side added one entry, so the dock may offer 「항목 합치기」. Resolve must echo the hashes back.
const conflictEntry=(title:string,c:string)=>`### ${title}\n<!-- memory-entry-id:${c.repeat(24)} -->\n\n- ${title}\n`;
const conflictDoc=(...entries:string[])=>`# Project Core Memory\n\nIntro.\n\n## Decisions\n\n${[conflictEntry('Keep A','a'),...entries].join('\n')}`;
f.conflictBase=conflictDoc();f.conflictLocal=conflictDoc(conflictEntry('Local decision','c'));f.conflictRemote=conflictDoc(conflictEntry('Remote decision','d'));
const conflictPreview=(folder:string)=>f.memory[folder]?.conflict
  ?{conflict:true,memoryId:'m-'+folder,localContent:f.conflictLocal,localContentHash:'local-'+folder,remoteContent:f.conflictRemote,remoteContentHash:'remote-changed',remoteRevisionId:'rev-remote',remoteCreatedAt:ago(30),remoteDeviceName:'2호 Mac',remoteChangedSinceSync:true,localChangedSinceSync:true,baseRevisionId:'rev-base',baseContent:f.conflictBase}
  :{conflict:false,memoryId:'m-'+folder,localContent:f.conflictLocal,localContentHash:'local-'+folder,remoteContent:f.conflictLocal,remoteContentHash:'local-'+folder,remoteRevisionId:'rev-same',remoteCreatedAt:ago(30),remoteDeviceName:null};
const session=(id:string,agent:'claude'|'codex',cwd:string,usedPercent:number,state:'active'|'idle'|'stale',thread:string)=>({sessionId:id,sourceAgent:agent,cwd,projectDir:null,threadSource:null,threadTitle:thread,projectHint:null,
  modelId:null,modelName:agent==='claude'?'Opus':'GPT',windowSize:200000,usedPercent,remainingPercent:100-usedPercent,usedTokens:usedPercent*2000,costUsd:null,ageMs:1000,capturedAt:ago(1),state,
  clientLabel:agent==='claude'?'Claude Code':'Codex CLI',surfaceKind:'terminal',surfaceLabel:'Terminal',surfaceDetail:null,surfacePresence:null});
// A stray folder (not registered, no memory): the quick list must not offer to create a memory there.
f.sessions=[session('s-tmp','codex','/fixture/scratch',20,'active','임시 실험'),{...session('s-ops','codex',B,41,'idle','운영 점검'),clientLabel:'ChatGPT 앱 · Codex',surfaceKind:'desktop-app',navigation:{available:true,exact:true,kind:'chatgpt-thread',actionLabel:'창으로 이동',detail:'같은 대화 열기'}},session('session-app-001','claude',A,72,'active','도크 알림 작업'),session('s-old','claude',A,95,'stale','지난 대화'),{...session('s-guardian','codex',A,99,'active','Guardian review'),threadSource:'guardian_review'}];
f.commandCalls=[];f.commandReceipts={};f.contextFailure='';f.captureInstalled=true;
// 「휴대폰 알림」 (src/weeklyUsagePushHost.ts): OFF until the person turns it on; AgentsToZ Screen is on with two devices.
f.weeklyPush={enabled:false,screen:{state:'on',devices:2}};
f.weekly=[{provider:'claude',buckets:[{label:'주간',remainingPercent:72,resetsAt:Math.floor(now/1000)+86400}],checkedAt:new Date(now).toISOString(),source:'statusline',connected:true,canConnect:true},{provider:'codex',buckets:[{label:'주간',remainingPercent:39,resetsAt:Math.floor(now/1000)+86400}],checkedAt:new Date(now).toISOString(),source:'live',connected:true,canConnect:false},{provider:'agy',buckets:[],checkedAt:null,source:'unavailable',connected:false,canConnect:true}];
f.notices=[
  {sourceAgent:'claude',sessionId:'n1',projectName:'AgentsToZ_byCS',lastCheckpointAt:ago(5),lastCheckpointThreshold:70},
  {sourceAgent:'codex',sessionId:'n2',projectName:'AgentsToZ-OPS',lastCheckpointAt:ago(60),lastCheckpointThreshold:50},
  {sourceAgent:'claude',sessionId:'n3',projectName:'블로그',lastCheckpointAt:ago(120),lastCheckpointThreshold:75},
  {sourceAgent:'codex',sessionId:'n4',projectName:'통역사',lastCheckpointAt:ago(180),lastCheckpointThreshold:90},
];
// A Claude in exactly one live Orca terminal: idle, so bulk cleanup must still keep it (live), and its /compact·/clear go
// through the Orca receipts (context.orca.*) once its memory is saved and synced. The check adds it to f.sessions itself.
f.orcaSession={...session('session-orca-001','claude',A,55,'idle','Orca 터미널 작업'),surfaceKind:'orca-worktree',surfaceLabel:'Orca 워크트리',surfacePresence:'live'};f.orcaCalls=[];f.orcaReceipts={};f.orcaAcks={};f.orcaFailure='';
const realFetch=window.fetch.bind(window);
window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  const body=init?.body?JSON.parse(String(init.body)):undefined;f.calls.push({path:url.pathname,body});
  const json=(value:unknown,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'Content-Type':'application/json'}});
  switch(url.pathname){
    case '/api/agent-runtime/weekly-usage':if(body.operation==='status')return json({items:f.weekly});
      if(body.operation==='alerts'){if(typeof body.enabled==='boolean')f.weeklyPush={...f.weeklyPush,enabled:body.enabled};return json(f.weeklyPush);}
     {const row=f.weekly.find((r:any)=>r.provider===body.provider);if(row)row.connected=body.operation==='connect';return json({connected:row?.connected});}
    case '/api/project-memory/auto-checkpoint/status':return json({schemaVersion:1,settings:{enabled:true,enabledAt:ago(999),thresholds:[50,70,75,90]},running:true,sessions:f.notices,recoveryCheckpoints:[]});
    case '/api/context-usage':return json({sessions:f.sessions,captureInstalled:f.captureInstalled});
    case '/api/context-sessions/navigate':return f.navigationFailure?json({success:false,error:'대상 대화를 찾지 못했습니다.'},409):json({success:true,exact:true,message:'원본 Codex 대화로 이동했습니다.'});
    case '/api/ports':return json([{id:'p-app',name:'AgentsToZ_byCS',folderPath:A},{id:'p-ops',name:'AgentsToZ-OPS',folderPath:B}]);
    case '/api/project-memory/detect':return json(status(body.folderPath));
    case '/api/project-memory/remote-status':return json(remote(body.folderPath));
    case '/api/project-memory/session-end':{
      // The host runs one memory save at a time; the dock must never send two at once.
      f.activeSaves++;f.maxActiveSaves=Math.max(f.maxActiveSaves,f.activeSaves);
      try{await new Promise(r=>setTimeout(r,f.saveDelayMs));f.memory[body.folderPath].needs=false;return json({success:true,localSaved:true,remoteBackedUp:true});}finally{f.activeSaves--;}
    }
    case '/api/project-memory/conflict-preview':return json(conflictPreview(body.folderPath));
    case '/api/project-memory/resolve-conflict':{const m=f.memory[body.folderPath];
      if(!m?.conflict||body.expectedLocalHash!=='local-'+body.folderPath||body.expectedRemoteRevisionId!=='rev-remote'||body.expectedRemoteContentHash!=='remote-changed')return json({success:false,stale:true,error:'비교한 뒤 바뀌었습니다.'},409);
      m.conflict=false;m.inSync=true;return json({success:true,strategy:body.strategy});}
    case '/api/project-memory/sync':if(f.contextFailure==='sync')return json({ok:false,conflict:true},409);f.memory[body.folderPath].inSync=true;return json({ok:true,action:'push'});
    case '/api/agent-runtime/context-sessions':{
      if(body.operation==='context.status')return json({bindings:[{providerSessionId:'session-app-001',sessionId:'workroom-app-001',targetId:'p-app',inputRevision:1}]});
      if(body.operation==='context.save'||body.operation==='context.save-status'){if(f.contextFailure!=='save')f.memory[A].needs=false;return json({kind:'workspace',action:body.operation==='context.save'?'workroom.save':'workroom.status',workroom:{sessionId:body.sessionId,save:{requestId:body.saveRequestId,state:f.contextFailure==='save'?'recovery-required':'saved',localSaved:f.contextFailure!=='save'}}});}
      if(body.operation==='context.execute'){f.commandCalls.push(body.command);f.commandReceipts[body.requestId]=f.contextFailure==='execute'?'unknown':'written';return json({state:f.commandReceipts[body.requestId]});}
      if(body.operation==='context.receipt')return json({state:f.commandReceipts[body.requestId]??'not-found'});
      if(body.operation==='context.orca.execute'){f.orcaCalls.push(body.command);f.orcaReceipts[body.requestId]=f.orcaFailure||'written';return json(f.orcaFailure?{state:'unknown',error:'Orca 전송 결과를 확인하지 못했습니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.'}:{state:'written'});}
      if(body.operation==='context.orca.receipt'||body.operation==='context.orca.acknowledge'){const state=f.orcaReceipts[body.requestId];if(!state&&body.operation==='context.orca.acknowledge'){f.orcaReceipts[body.requestId]='rejected';f.orcaAcks[body.requestId]=true;return json({state:'not-found',acknowledged:true});}if(!state)return json({state:'not-found'});if(body.operation==='context.orca.acknowledge')f.orcaAcks[body.requestId]=true;return json({state,acknowledged:!!f.orcaAcks[body.requestId]});}
      return json({error:'unknown fixture command'},400);
    }
  }
  return realFetch(input,init);
}) as typeof fetch;
async function transport(r:VoiceRequest):Promise<VoiceResponse>{if(r.action==='capabilities')return {configured:false};throw Error('voice is not used in this fixture');}
document.documentElement.dataset.appTheme=new URLSearchParams(location.search).get('theme')??'gray';
Object.assign(document.body.style,{margin:'0',background:'var(--bg)',color:'var(--ink)',fontFamily:'var(--font-sans)',minHeight:'100vh'});
createRoot(document.getElementById('root')!).render(<main style={{padding:24}}><h1>도크 알림 · 열린 AI 세션 검증</h1><p>합성 로컬 API만 씁니다.</p>
  <AgentsToZVoiceDock transport={transport} notifications={<AutomaticSaveNotice placement="dock"/>} localSessions/></main>);
