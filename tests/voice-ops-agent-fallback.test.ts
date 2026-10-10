import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import type {AiTerminalAgent} from '../src/aiTerminalProtocol';
import {bindVoiceRuntime} from '../src/voiceRuntimeBinding';
import {VoiceSessionHost,type VoiceResolvedTarget} from '../src/voiceSessionHost';

/**
 * The OPS voice opens the OPS workroom with the AI this device last opened OPS with. That preference
 * is also recorded when OPS was opened in a desktop app (e.g. Hermes), so its CLI may be missing:
 * 「prepare_ops_instruction」 then failed with 「hermes CLI가 설치되어 있지 않습니다」 instead of using codex.
 */
const cleanup:(()=>unknown)[]=[];afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});
const OPS='ops_project_fixture';
const authority={owner:'local',active:()=>true};

function world(saved:AiTerminalAgent|null){
  const dir=mkdtempSync(join(tmpdir(),'voice-ops-fallback-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const exe=join(dir,'fixture-cli');writeFileSync(exe,'#!/bin/sh\nstty -echo\nprintf "READY\\n"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n',{mode:0o755});
  // Only the hermes CLI is missing on this Mac.
  const terminal=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:agent=>agent==='hermes'?null:exe});cleanup.push(()=>terminal.shutdown());
  return {terminal,bind:()=>bindVoiceRuntime({terminal,targets:async()=>[{id:OPS,name:'AgentsToZ-OPS',role:'ops',scope:'main'}],target:async()=>({label:'AgentsToZ-OPS',fingerprint:'f'}),
    ops:()=>({fingerprint:'o',projectId:OPS}),opsAgent:()=>saved,recall:()=>({}),projectRecall:async()=>({}),propose:async()=>({})},{kind:'ops'},authority)};
}

test('a remembered OPS AI that cannot start falls back to codex and says so',async()=>{
  const w=world('hermes'),b=await w.bind();
  const review=await b.reviewOps!();
  expect(review).toMatchObject({agent:'codex',reused:false,fallbackFrom:'hermes'});
  const running=(await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.filter(session=>session.state==='running');
  expect(running.map(session=>session.agent)).toEqual(['codex']);
  // The codex workroom it opened is reused next time, without another fallback.
  expect(await b.reviewOps!()).toMatchObject({agent:'codex',reused:true});
  expect((await b.reviewOps!()).fallbackFrom).toBeUndefined();
});

test('an AI the person named is never swapped: the failure is reported',async()=>{
  const w=world('codex'),b=await w.bind();
  await expect(b.reviewOps!('hermes')).rejects.toThrow('hermes CLI가 설치되어 있지 않습니다');
  expect((await w.terminal.perform({operation:'list',requestId:crypto.randomUUID()})).sessions!.filter(session=>session.state==='running')).toEqual([]);
});

test('prepare_ops_instruction tells the model which AI it fell back from',async()=>{
  const outputs:Record<string,any>[]=[];let onEvent:(event:Record<string,unknown>)=>void=()=>{};
  const ops:VoiceResolvedTarget={label:'AgentsToZ OPS',key:'ops-fallback',validate:async()=>{},tools:[],run:async()=>({}),
    reviewOps:async()=>({label:'AgentsToZ-OPS · codex',agent:'codex',reused:false,fallbackFrom:'hermes',send:async()=>{}})};
  const host=new VoiceSessionHost({wait:async()=>{},credentials:{status:()=>({configured:true,model:'gpt-realtime-2.1',voice:'marin'}),key:async()=>'test-only',configure:async()=>({})},bind:async()=>ops,
    provider:async input=>{onEvent=input.onEvent;return {sdp:'v=0',send:event=>outputs.push(event),close:async()=>{}};}});cleanup.push(()=>host.shutdown());
  const id=(await host.perform({action:'prepare',requestId:crypto.randomUUID(),target:{kind:'ops'},mode:'conversation',consent:true},authority)).session!.id;
  await host.perform({action:'connect',requestId:crypto.randomUUID(),sessionId:id,sdp:'v=0'},authority);
  onEvent({type:'response.function_call_arguments.done',call_id:'call_fallback',name:'prepare_ops_instruction',arguments:JSON.stringify({text:'대시보드 열어 줘'})});
  let item:any;for(const deadline=Date.now()+3000;Date.now()<deadline&&!(item=outputs.find(event=>event.item?.call_id==='call_fallback'));)await Bun.sleep(10);
  expect(JSON.parse(item.item.output)).toMatchObject({state:'awaiting-user',agent:'codex',reused:false,fallbackFrom:'hermes'});
});
