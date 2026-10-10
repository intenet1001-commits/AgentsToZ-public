/** Explicit paid smoke test: synthetic Korean audio + isolated PTY, never the user's microphone/project. */
import {chromium} from 'playwright';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {VoiceCredentials} from '../src/voiceCredentials';
import {connectVoiceRealtime} from '../src/voiceRealtimeProvider';
import {VoiceSessionHost} from '../src/voiceSessionHost';
import {AiTerminalService} from '../src/aiTerminalService';
import {bindVoiceRuntime} from '../src/voiceRuntimeBinding';
if(!process.argv.includes('--live'))throw Error('Requires --live: uses the configured OpenAI key for one synthetic audio conversation.');
const opsMode=process.argv.includes('--ops'),mixed=process.argv.includes('--mixed');
const dir=mkdtempSync(join(tmpdir(),'voice-live-')),exe=join(dir,'fixture-cli');
writeFileSync(exe,'#!/bin/sh\nstty -echo\nprintf "현재 별빛 정원 프로젝트에서 로그인 오류를 수정 중입니다. 아직 테스트 완료 전입니다.\\n"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n',{mode:0o755});
const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>exe});
const authority={owner:'local',active:()=>true},targetId='voice_live_fixture';let readCalls=0;
const credentials=new VoiceCredentials(join(homedir(),'Library/Application Support/com.portmanager.portmanager/voice'),{});
const deps={terminal,targets:async()=>[{id:targetId,label:'별빛 정원'}],target:async()=>({label:'별빛 정원',fingerprint:'live-fixture'}),ops:()=>({fingerprint:'fixture-ops',projectId:targetId}),recall:()=>({hits:[]}),propose:async()=>{throw Error('Not a memory test');}};
 const host=new VoiceSessionHost({credentials,provider:input=>connectVoiceRealtime({...input,onEvent:e=>{if(e.type==='error')console.log(JSON.stringify({providerError:{code:e.error?.code,param:e.error?.param,type:e.error?.type}}));input.onEvent(e);}}),bind:async(target,a)=>{const b=await bindVoiceRuntime(deps,target,a),run=b.run;b.run=async(...args)=>{if(['read_workroom','read_delegate_workroom','connect_project_delegate'].includes(args[0]))readCalls++;return run(...args);};return b;}});
let heartbeat:ReturnType<typeof setInterval>|undefined;
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try{
 const session=(await terminal.perform({operation:'start',requestId:crypto.randomUUID(),targetId,agent:'claude',cols:80,rows:24})).session!;
 const ready=Date.now()+5000;while(Date.now()<ready){const r=await terminal.perform({operation:'read',requestId:crypto.randomUUID(),sessionId:session.id,after:0});if(r.chunks?.some(c=>c.text.includes('로그인 오류')))break;await Bun.sleep(30);}
 execFileSync('/usr/bin/say',['-v','Yuna','-o',join(dir,'question.aiff'),mixed?'OpenAI Realtime API와 TestFlight에 관해 말하려고 합니다. 지금 연결된 프로젝트와 작업 내용을 알려 주세요.':opsMode?'아젠투지, 별빛 정원 프로젝트에서 지금 무슨 작업을 하고 있는지 알려 주세요.':'지금 연결된 프로젝트 이름과 현재 작업 내용을 알려 주세요.']);
 execFileSync('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@48000','-c','1',join(dir,'question.aiff'),join(dir,'question.wav')]);
 const prepared=await host.perform({action:'prepare',requestId:crypto.randomUUID(),target:opsMode?{kind:'ops'}:{kind:'workroom',targetId,sessionId:session.id},mode:'conversation',consent:true},authority);
 heartbeat=setInterval(()=>{void host.perform({action:'state',requestId:crypto.randomUUID(),sessionId:prepared.session!.id},authority).catch(()=>{});},5000);
 browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});const page=await browser.newPage();
 await page.exposeFunction('connectHost',async(sdp:string)=>{const result=await host.perform({action:'connect',requestId:crypto.randomUUID(),sessionId:prepared.session!.id,sdp},authority);return result.sdp;});
 const bytes=Array.from(new Uint8Array(await Bun.file(join(dir,'question.wav')).arrayBuffer()));
 const result=await page.evaluate(async bytes=>{
  const events:any[]=[],ctx=new AudioContext({sampleRate:48000}),destination=ctx.createMediaStreamDestination(),peer=new RTCPeerConnection();
  const audio=document.createElement('audio');audio.autoplay=true;peer.ontrack=e=>{audio.srcObject=e.streams[0];void audio.play().catch(()=>{});};
  for(const track of destination.stream.getTracks())peer.addTrack(track,destination.stream);
  const channel=peer.createDataChannel('oai-events');channel.onmessage=e=>{const data=JSON.parse(e.data);events.push(data);};
  try{
   const offer=await peer.createOffer();await peer.setLocalDescription(offer);
   const sdp=await (window as any).connectHost(offer.sdp);await peer.setRemoteDescription({type:'answer',sdp});
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('channel timeout')),15000);channel.onopen=()=>{clearTimeout(timer);resolve();};if(channel.readyState==='open'){clearTimeout(timer);resolve();}});
   await ctx.resume();const source=ctx.createBufferSource();const decoded=await ctx.decodeAudioData(new Uint8Array(bytes).buffer);const padded=ctx.createBuffer(1,decoded.length+ctx.sampleRate*3,ctx.sampleRate);padded.copyToChannel(decoded.getChannelData(0),0);source.buffer=padded;source.connect(destination);source.start(ctx.currentTime+0.6);
   const end=Date.now()+45000;
   while(Date.now()<end){if(events.some(e=>e.type==='response.output_audio_transcript.done'&&/로그인/.test(e.transcript)))break;await new Promise(r=>setTimeout(r,200));}
   const stats=await peer.getStats();let receivedAudioBytes=0;stats.forEach(s=>{if(s.type==='inbound-rtp'&&s.kind==='audio')receivedAudioBytes+=s.bytesReceived??0;});
   return {speechDetected:events.some(e=>e.type==='input_audio_buffer.speech_started'),transcripts:events.filter(e=>e.type==='conversation.item.input_audio_transcription.completed').map(e=>e.transcript),answers:events.filter(e=>e.type==='response.output_audio_transcript.done').map(e=>e.transcript),eventTypes:[...new Set(events.map(e=>e.type))],errorCodes:events.filter(e=>e.type==='error').map(e=>e.error?.code),receivedAudioBytes};
  }finally{peer.close();destination.stream.getTracks().forEach(t=>t.stop());await ctx.close();}
 },bytes);
 const passed=result.errorCodes.length===0&&(!mixed||result.transcripts.some(t=>/OpenAI|Realtime|TestFlight/i.test(t)))&&result.speechDetected&&result.transcripts.some(t=>t.trim().length>5)&&result.answers.some(t=>/별빛/.test(t)&&/로그인/.test(t))&&readCalls>0&&result.receivedAudioBytes>0;
 console.log(JSON.stringify({passed,target:opsMode?'ops':'workroom',model:credentials.status().model,readCalls,...result},null,2));if(!passed)process.exitCode=1;
}finally{clearInterval(heartbeat);await host.shutdown();await browser?.close();await terminal.shutdown();rmSync(dir,{recursive:true,force:true});}
