import React from 'react';import {createRoot} from 'react-dom/client';
import {VoiceHistoryPanel} from '../../../src/VoiceHistoryPanel';
import type {VoiceRequest} from '../../../src/voiceSessionProtocol';
// Labels are what older builds recorded (aiName-first runtime label + AI); titles come from the project list.
const sessions=[
 {id:'voice_workroom',kind:'workroom' as const,label:'Star Garden · claude',targetId:'project_star',createdAt:'2026-09-24T06:00:00Z',endedAt:'2026-09-24T06:01:00Z',mode:'conversation' as const,model:'gpt-realtime-2.1',turnCount:2,reviewed:false,complete:true},
 {id:'voice_partial',kind:'workroom' as const,label:'Star Garden · codex',targetId:'project_star',createdAt:'2026-09-24T05:30:00Z',endedAt:'2026-09-24T05:31:00Z',mode:'conversation' as const,model:'gpt-realtime-2.1',turnCount:1,reviewed:false,complete:false},
 {id:'voice_ops',kind:'ops' as const,label:'AgentsToZ-Control · Codex',targetId:'project_control',createdAt:'2026-09-24T05:00:00Z',endedAt:'2026-09-24T05:01:00Z',mode:'conversation' as const,model:'gpt-realtime-2.1',turnCount:1,reviewed:false,complete:true},
];
const scopes=[{key:'project_star',kind:'workroom' as const,label:'Star Garden'},{key:'ops',kind:'ops' as const,label:'AgentsToZ OPS'}];
(window as any).requests=[];
const transport=async(r:VoiceRequest)=>{(window as any).requests.push(r);
 if(r.action==='history.list'){const listed=sessions.filter(s=>!r.scope||(r.scope==='ops'?s.kind==='ops':s.targetId===r.scope));return {history:{sessions:listed,nextBefore:null,...(r.before?{}:{scopes})}};}
 if(r.action==='history.read')return {detail:{session:sessions.find(s=>s.id===r.sessionId)!,turn:{id:'item_fixture',role:r.cursor?'assistant' as const:'user' as const,recordedAt:'2026-09-24T06:00:30Z',text:r.cursor?'확인 전에는 완료로 기록하지 않겠습니다.':'OpenAI Realtime API 영어 이름은 유지해 주세요.',continued:false},nextCursor:r.cursor?null:'2:0'}};
 if(r.action==='history.remember')return {reviewMessage:'세션 기억 저장 중입니다.'};if(r.action==='history.memory-status')return {reviewMessage:'음성 대화를 포함해 프로젝트 기억을 정리했습니다.'};if(r.action==='history.review')return {reviewMessage:'OPS 운영 기억 후보로 제출했습니다.'};throw Error('unexpected action');};
createRoot(document.getElementById('root')!).render(<VoiceHistoryPanel transport={transport} projects={[{id:'project_star',name:'별빛 프로젝트'}]}/>);
