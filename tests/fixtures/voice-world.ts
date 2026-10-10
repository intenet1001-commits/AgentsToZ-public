import {chmodSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {AiTerminalService} from '../../src/aiTerminalService';
import {bindVoiceRuntime,type VoiceRuntimeDependencies} from '../../src/voiceRuntimeBinding';
import {VoiceSessionHost,type VoiceAuthority,type VoiceHostDependencies} from '../../src/voiceSessionHost';
import {VoiceHistoryStore} from '../../src/voiceHistoryStore';
import {opsVoiceIdentity} from '../../src/voiceOpsIdentity';
import {voiceConversationTargets,type ConversationDirectoryRuntimeTarget} from '../../src/conversationTargetDirectory';
import type {VoiceProviderInput} from '../../src/voiceRealtimeProvider';
import type {VoiceTarget} from '../../src/voiceSessionProtocol';

/**
 * The whole voice orchestration path with only the speech provider scripted: the real host, the
 * real OPS binding over the shared target directory, real PTYs running fake AI CLIs, and the real
 * encrypted history store. Shared by the orchestration and voice-dock suites.
 */
export const OPS='359150c5-7ed4-4b99-9b81-d864190342d3',VIBE='0b7a2c1e-1111-4a4a-8b8b-000000000001',VIBE2='0b7a2c1e-2222-4a4a-8b8b-000000000002',HERMES='4e1f7c2a-3333-4b4b-9c9c-000000000003';
const opsBinding={profileId:'profile_fixture',memoryId:'memory_ops',root:'/Users/fixture/product_2026/AgentsToZ-Control',projectId:OPS,backend:'control-folder'};
export const authority:VoiceAuthority={owner:'local',active:()=>true};
export const request=(action:string,other:Record<string,unknown>={})=>({action,requestId:crypto.randomUUID(),...other});
export type ScriptedProvider={event:VoiceProviderInput['onEvent'];outputs:Record<string,any>[];input?:VoiceProviderInput};

export async function voiceWorld(cleanup:(()=>Promise<void>|void)[],options:{translate?:VoiceHostDependencies['translate'];
  /** This agent first asks a folder-trust question (like agy/Claude) and only then reads instructions. */
  trustPrompt?:string;
  /** Claude Code's newer trust screen: unnumbered, 「❯ No, exit」 highlighted, so a bare Enter ends the CLI. */
  exitFirst?:boolean}={}){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'voice-world-')));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const folders:Record<string,string>={};
  for(const [id,leaf] of [[OPS,'AgentsToZ-Control'],[VIBE,'vibe'],[VIBE2,'vibe2'],[HERMES,'hermes']] as const){folders[id]=join(root,'projects',leaf);mkdirSync(folders[id]!,{recursive:true});}
  const executables:Record<string,string>={};
  for(const agent of ['codex','claude','hermes','agy']){
    const path=join(root,'bin',agent);mkdirSync(join(root,'bin'),{recursive:true});
    // Reads one key at a time like a real TUI: arrows move the highlight, Enter confirms it.
    const trust=options.trustPrompt===agent&&options.exitFirst?`stty -icanon min 1 -echo
sel=0
draw(){ printf '\\033[2J\\033[HQuick safety check: Is this a project you trust?\\n\\n'; if [ $sel = 0 ]; then printf '\\342\\235\\257 No, exit\\n  Yes, I trust this folder\\n'; else printf '  No, exit\\n\\342\\235\\257 Yes, I trust this folder\\n'; fi; printf '\\nEnter to confirm \\302\\267 Esc to cancel\\n'; }
draw
while :; do c=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n'); case $c in 42) sel=1; draw;; 41) sel=0; draw;; 0a|0d) break;; esac; done
if [ $sel = 0 ]; then printf 'EXITED\\n'; exit 1; fi
stty icanon
printf '\\033[2J\\033[HTRUSTED\\n'
`
      :options.trustPrompt===agent?`printf 'Do you trust the contents of this directory?\\n> 1. Yes, I trust this folder\\n  2. No, exit\\n'\nIFS= read -r answer\nprintf '\\033[2J\\033[HTRUSTED:%s\\n' "$answer"\n`:''; // a real TUI clears the dialog once answered
    writeFileSync(path,`#!/bin/sh\nstty -echo\nprintf 'ARGS:%s\\n' "$*"\n${trust}printf 'READY:${agent}\\n'\nwhile IFS= read -r line; do printf 'GOT:${agent}:%s\\n' "$line"; done\n`);chmodSync(path,0o755);executables[agent]=path;
  }
  const terminal=new AiTerminalService({resolveTarget:async id=>{const cwd=folders[id];if(!cwd)throw new Error('unknown target');return {cwd};},executable:agent=>executables[agent]??null});
  cleanup.push(()=>terminal.shutdown());
  // Registered rows shaped like the real ones: no stored roles, aiName-first runtime labels.
  const ports=[
    {id:OPS,name:'AgentsToZ-Control',folderPath:folders[OPS]},
    {id:VIBE,name:'vibe',aiName:'vibe claude guide',folderPath:folders[VIBE]},
    {id:VIBE2,name:'vibe2',aiName:'Vibe Coding Guide v2',folderPath:folders[VIBE2]},
    {id:HERMES,name:'헤르메스',aiName:'Claude Agent Config',folderPath:folders[HERMES]},
  ];
  const runtimeTargets:ConversationDirectoryRuntimeTarget[]=ports.map(port=>({targetId:port.id,projectTargetId:port.id,label:port.aiName??port.name,scope:'main',branch:'main'}));
  const directory=()=>voiceConversationTargets(ports,runtimeTargets,{opsProjectId:OPS});
  const deps:VoiceRuntimeDependencies={
    terminal,targets:async()=>directory(),
    target:async id=>{const entry=directory().find(item=>item.id===id);if(!entry)throw new Error('등록된 음성 대상을 확인하세요.');return {label:entry.name,fingerprint:'registered:'+id,...(id===OPS?{opsMemoryFingerprint:'ops-memory'}:{})};},
    ops:()=>({fingerprint:'ops-fixture',projectId:OPS}),opsAgent:()=>null,
    recall:()=>({scope:'operating',hits:[]}),projectRecall:async(id,query)=>({scope:'project',id,query,hits:[]}),propose:async()=>({state:'pending'}),
  };
  let key:Buffer|null=null;
  const store=new VoiceHistoryStore(join(root,'voice-records'),{read:async()=>key?Buffer.from(key):null,create:async()=>{key=randomBytes(32);return Buffer.from(key);}});
  const identity=async(target:VoiceTarget)=>target.kind==='ops'?opsVoiceIdentity(target,opsBinding,'memory_ops'):{target,memoryId:'memory_'+target.targetId.slice(0,8),binding:'project:'+target.targetId};
  const provider:ScriptedProvider={event:()=>{},outputs:[]};
  const host=new VoiceSessionHost({wait:async(ms,signal)=>{if(signal.aborted)throw new Error('ended');await Bun.sleep(Math.min(ms,50));},
    credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'test-only',configure:async()=>({})},
    history:{store,identity,review:async()=>'',remember:async()=>''},bind:(target,a)=>bindVoiceRuntime(deps,target,a),
    ...(options.translate?{translate:options.translate}:{}),
    provider:async input=>{provider.event=input.onEvent;provider.outputs=[];provider.input=input;return {sdp:'v=0',send:event=>provider.outputs.push(event),close:async()=>{}};}});
  cleanup.push(()=>host.shutdown());
  return {terminal,host,store,provider,folders};
}

export async function output(terminal:AiTerminalService,sessionId:string){
  const page=await terminal.perform({operation:'read',requestId:crypto.randomUUID(),sessionId,after:0});
  return (page.chunks??[]).map(chunk=>chunk.text).join('');
}
export async function until(check:()=>Promise<boolean>|boolean,what:string,ms=8000){
  const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await Bun.sleep(25);}throw new Error('timed out waiting for '+what);
}
/** What the realtime model does: call a tool, then read the host's function_call_output. */
export async function call(provider:ScriptedProvider,name:string,args:Record<string,unknown>){
  const callId='call_'+crypto.randomUUID().replaceAll('-','').slice(0,20);
  provider.event({type:'response.function_call_arguments.done',call_id:callId,name,arguments:JSON.stringify(args)});
  let result:any;
  await until(()=>{const item=provider.outputs.find(event=>event.type==='conversation.item.create'&&event.item?.call_id===callId);if(item)result=JSON.parse(item.item.output);return !!item;},'tool output of '+name);
  return result;
}
