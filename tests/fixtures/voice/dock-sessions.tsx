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
const remote=(folder:string)=>{const m=f.memory[folder];return {exists:true,createdAt:ago(m.inSync?89:100),contentHash:m.inSync?'local-'+folder:'baseline',inSync:m.inSync};};
const session=(id:string,agent:'claude'|'codex',cwd:string,usedPercent:number,state:'active'|'idle'|'stale',thread:string)=>({sessionId:id,sourceAgent:agent,cwd,projectDir:null,threadSource:null,threadTitle:thread,projectHint:null,
  modelId:null,modelName:agent==='claude'?'Opus':'GPT',windowSize:200000,usedPercent,remainingPercent:100-usedPercent,usedTokens:usedPercent*2000,costUsd:null,ageMs:1000,state,
  clientLabel:agent==='claude'?'Claude Code':'Codex CLI',surfaceKind:'terminal',surfaceLabel:'Terminal',surfaceDetail:null,surfacePresence:null});
// A stray folder (not registered, no memory): the quick list must not offer to create a memory there.
f.sessions=[session('s-tmp','codex','/fixture/scratch',20,'active','임시 실험'),session('s-ops','codex',B,41,'idle','운영 점검'),session('s-app','claude',A,72,'active','도크 알림 작업'),session('s-old','claude',A,95,'stale','지난 대화')];
f.notices=[
  {sourceAgent:'claude',sessionId:'n1',projectName:'AgentsToZ_byCS',lastCheckpointAt:ago(5),lastCheckpointThreshold:70},
  {sourceAgent:'codex',sessionId:'n2',projectName:'AgentsToZ-OPS',lastCheckpointAt:ago(60),lastCheckpointThreshold:50},
  {sourceAgent:'claude',sessionId:'n3',projectName:'블로그',lastCheckpointAt:ago(120),lastCheckpointThreshold:75},
  {sourceAgent:'codex',sessionId:'n4',projectName:'통역사',lastCheckpointAt:ago(180),lastCheckpointThreshold:90},
];
const realFetch=window.fetch.bind(window);
window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
  const body=init?.body?JSON.parse(String(init.body)):undefined;f.calls.push({path:url.pathname,body});
  const json=(value:unknown,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'Content-Type':'application/json'}});
  switch(url.pathname){
    case '/api/project-memory/auto-checkpoint/status':return json({schemaVersion:1,settings:{enabled:true,enabledAt:ago(999),thresholds:[50,70,75,90]},running:true,sessions:f.notices,recoveryCheckpoints:[]});
    case '/api/context-usage':return json({sessions:f.sessions,captureInstalled:true});
    case '/api/ports':return json([{id:'p-app',name:'AgentsToZ_byCS',folderPath:A},{id:'p-ops',name:'AgentsToZ-OPS',folderPath:B}]);
    case '/api/project-memory/detect':return json(status(body.folderPath));
    case '/api/project-memory/remote-status':return json(remote(body.folderPath));
    case '/api/project-memory/session-end':{
      // The host runs one memory save at a time; the dock must never send two at once.
      f.activeSaves++;f.maxActiveSaves=Math.max(f.maxActiveSaves,f.activeSaves);
      try{await new Promise(r=>setTimeout(r,f.saveDelayMs));f.memory[body.folderPath].needs=false;return json({success:true,localSaved:true,remoteBackedUp:true});}finally{f.activeSaves--;}
    }
    case '/api/project-memory/sync':f.memory[body.folderPath].inSync=true;return json({success:true,action:'push'});
  }
  return realFetch(input,init);
}) as typeof fetch;
async function transport(r:VoiceRequest):Promise<VoiceResponse>{if(r.action==='capabilities')return {configured:false};throw Error('voice is not used in this fixture');}
document.documentElement.dataset.appTheme=new URLSearchParams(location.search).get('theme')??'gray';
Object.assign(document.body.style,{margin:'0',background:'var(--bg)',color:'var(--ink)',fontFamily:'var(--font-sans)',minHeight:'100vh'});
createRoot(document.getElementById('root')!).render(<main style={{padding:24}}><h1>도크 알림 · 열린 AI 세션 검증</h1><p>합성 로컬 API만 씁니다.</p>
  <AgentsToZVoiceDock transport={transport} notifications={<AutomaticSaveNotice placement="dock"/>} localSessions/></main>);
