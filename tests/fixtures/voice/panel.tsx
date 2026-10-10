import React from 'react';import {createRoot} from 'react-dom/client';
import {VoiceButton,VoiceSentReceipt} from '../../../src/VoiceSessionPanel';import {VOICE_SENT_NOTICE} from '../../../src/voiceSessionProtocol';import {AgentsToZVoiceDock} from '../../../src/components/AgentsToZVoiceDock';import {voiceMediaClient} from '../../../src/voiceMediaClient';
import type {VoiceRequest,VoiceResponse,VoiceSnapshot} from '../../../src/voiceSessionProtocol';
const f=window as any;f.requests=[];f.trackStops=0;f.replaced=0;f.sends=0;f.client=voiceMediaClient;f.deny=false;f.loseReceipt=false;f.targetChanges=0;f.olderMac=false;
window.addEventListener('agentstoz:voice-target-change',()=>f.targetChanges++);
const track={stop(){f.trackStops++},onended:null};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{if(f.deny)throw Error('마이크 권한이 거부되었습니다.');return {getTracks:()=>[track]};}},configurable:true});
class Channel extends EventTarget {readyState='open';onmessage:any;onclose:any;send(){}close(){this.readyState='closed';}}
class Peer {connectionState='connected';onconnectionstatechange:any;ontrack:any;addTrack(){}getSenders(){return [{track:null,replaceTrack:async()=>{f.replaced++;}}];}createDataChannel(){const channel=new Channel();f.emit=(e:any)=>channel.onmessage?.({data:JSON.stringify(e)});return channel;}async createOffer(){return {type:'offer',sdp:'v=0'}}async setLocalDescription(){}async setRemoteDescription(){}close(){this.connectionState='closed'}}
f.RTCPeerConnection=Peer;
let session:VoiceSnapshot,receipt:string|null=null;
async function transport(r:VoiceRequest):Promise<VoiceResponse>{
 f.requests.push(r);
 if(r.action==='capabilities')return {configured:true,model:'gpt-realtime-2.1',voice:'marin'};
 if(r.action==='prepare'){receipt=null;session={id:'voice_fixture',state:'prepared',mode:r.mode!,provider:r.provider??'openai',label:r.target?.kind==='ops'?'AgentsToZ OPS':'테스트 프로젝트 · Codex',activeTarget:r.target?.kind==='ops'?{kind:'ops',label:'AgentsToZ OPS'}:r.target?.kind==='workroom'?{kind:'workroom',label:r.target.targetId==='project_other'?'다른 프로젝트':'테스트 프로젝트',targetId:r.target.targetId,sessionId:r.target.sessionId,agent:'codex'}:undefined,draft:null,notice:'준비 중',expiresAt:Date.now()+900000};return {session:{...session}};}
 if(r.action==='connect'){session.state='active';session.notice='음성 연결됨';return {sdp:'v=0',session:{...session}};}
 if(r.action==='state')return {session:{...session}};
 if(r.action==='stop'){session.state='ended';session.draft=null;session.notice='음성 대화를 종료했습니다. 워크룸 작업은 유지됩니다.';return {session:{...session}};}
 if(r.action==='discard'){session.draft=null;return {session:{...session}};}
 if(r.action==='submit'){if(!receipt){receipt=r.requestId;f.sends++;}else if(receipt!==r.requestId)throw Error('DUPLICATE SUBMIT');if(f.loseReceipt){f.loseReceipt=false;throw Error('전송 영수증 연결 끊김');}session.notice=`${VOICE_SENT_NOTICE}: 「${r.text}」 · 입력 접수이며 작업 완료가 아닙니다.`;session.draft=null;return {session:{...session}};}
 // The voice dock (VOC 2026-09-29). An older Mac rejects these like normalizeVoiceRequest does an unknown action.
 if(['partners','partner','caption','projects','relay'].includes(r.action)&&f.olderMac)throw Error('지원하지 않는 음성 요청입니다.');
 const room={kind:'workroom' as const,label:'테스트 프로젝트',targetId:'project_fixture',sessionId:'terminal_fixture',agent:'codex' as const};
 if(r.action==='partners')return {session:{...session},partners:[{kind:'ops',label:'AgentsToZ OPS'},room]};
 if(r.action==='relay')return {session:{...session}};
 if(r.action==='say'){if(f.olderMac)throw Error('지원하지 않는 음성 요청입니다.');if(f.holdSay)await new Promise<void>(resolve=>{f.releaseSay=resolve;});return {session:{...session}};}
 if(r.action==='projects'||r.action==='projects.page'){const all=[{id:'project_fixture',label:'테스트 프로젝트'},{id:'project_other',label:'다른 프로젝트'}];const projects=r.text?all.filter(p=>p.label.includes(r.text!)):all;return r.action==='projects.page'?{projectPage:{projects,total:projects.length,nextOffset:null}}:{projects};}
 if(r.action==='partner'){if(session.draft)throw Error('현재 지시 초안을 먼저 보내거나 버린 뒤 대화 상대를 바꾸세요.');const p=r.partner!;session.activeTarget=p.kind==='ops'?{kind:'ops',label:'AgentsToZ OPS'}:p.kind==='project'?{kind:'workroom',label:p.targetId==='project_other'?'다른 프로젝트':'테스트 프로젝트',targetId:p.targetId,sessionId:'terminal_'+p.targetId.slice(8),agent:p.agent??'codex'}:room;return {session:{...session}};}
 if(r.action==='caption'){const ko=/[가-힣]/.test(r.text!);return {caption:{text:r.text!,translation:ko?'(EN) '+r.text:'(KO) '+r.text,source:ko?'ko':'en'}};}
 throw Error('unexpected');
}
f.transcribe=()=>{session.draft={id:'draft_fixture',text:'음성 입력 테스트',label:session.label};};
function Fixture(){
 const [secondary,setSecondary]=React.useState(false);React.useEffect(()=>{f.setSecondaryOps=setSecondary;},[]);
 return <main><h1>음성 기능 검증 · 가상 마이크/제공자</h1><VoiceSentReceipt sessionId="terminal_fixture"/><VoiceButton target={{kind:'ops'}} label="AgentsToZ OPS" transport={transport} openOnEvent/>{location.search.includes('no-ops')?<AgentsToZVoiceDock transport={transport} remote opsMissing workroomFallback={{list:async()=>(f.rooms??[]),transport:()=>transport}}/>:<AgentsToZVoiceDock transport={transport}/>}{secondary&&<VoiceButton target={{kind:'ops'}} label="비활성 OPS" disabled transport={transport}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
