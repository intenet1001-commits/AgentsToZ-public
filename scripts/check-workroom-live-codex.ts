/** Explicit, bounded real-provider smoke. Never included in automatic profiles. */
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {AiTerminalService} from '../src/aiTerminalService';
import {createWorkroomTranscriptSignals} from '../src/aiTerminalActivityTranscript';
import {processGroupOpenFiles} from '../src/aiTerminalResume';
import {workroomScreenAwaitsAnswer} from '../src/workroomRouteDelivery';
import {renderTerminalPlainText} from '../src/terminalPlainText';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
normalizeAiTerminalRequest({operation:'read',requestId:randomUUID(),sessionId:randomUUID(),after:0,snapshot:true});
const inspectStartup=process.argv[2]==='--inspect-startup';
if(!inspectStartup&&process.argv[2]!=='--live-codex')throw Error('Real inference requires --live-codex; no automatic run or retry');
const executable=Bun.which('codex');if(!executable)throw Error('Existing Codex CLI required');
const root=resolve(import.meta.dir,'..'),temp=mkdtempSync(join(tmpdir(),'workroom-live-qa-')),project=join(temp,'project'),wrapper=join(temp,'codex-readonly');mkdirSync(project);
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
writeFileSync(wrapper,'#!/bin/sh\nexec '+quote(executable)+' --sandbox read-only "$@"\n',{mode:0o700});
const initialized=Bun.spawnSync(['git','init','--quiet',project]);if(initialized.exitCode)throw Error('Isolated Git workspace unavailable');
const evidence=join(root,'.agentstoz/maintainer/evidence/quality-stages');mkdirSync(evidence,{recursive:true});
const proof:any={schemaVersion:1,startedAt:new Date().toISOString(),realAI:!inspectStartup,nativeUI:false,provider:'codex',account:'existing default; unchanged',sandbox:'read-only',fixtureTrust:'not approved',maximumInferences:inspectStartup?0:3,automaticRetry:false,cases:[],state:'running',source:createHash('sha256').update(readFileSync(join(root,'src/aiTerminalService.ts'))).update(readFileSync(join(root,'src/aiTerminalResume.ts'))).digest('hex')};
const save=()=>writeFileSync(join(evidence,inspectStartup?'codex-startup.json':'live-codex.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});save();
const completed=new Map<string,string>();let lastFrame='';
const targetId='quality_live_project',service=new AiTerminalService({resolveTarget:async id=>{if(id!==targetId)throw Error('Unknown test target');return {cwd:project};},executable:agent=>agent==='codex'?wrapper:null,codexHookTrustSupported:async()=>false,activitySampler:false,turnSignals:createWorkroomTranscriptSignals({openFiles:processGroupOpenFiles}),threadCompleted:async(id,completion)=>{completed.set(id,completion.resultText);}});
const request=async(value:Record<string,unknown>)=>service.perform({requestId:randomUUID(),...value});
const deadline=Date.now()+240000;let fixtureTrustApproved=false;
async function waitForComposer(id:string){
 const until=Math.min(deadline,Date.now()+30000);let stableSince=0;
 while(Date.now()<until){const screen=await request({operation:'read',sessionId:id,after:0,snapshot:true});const text=await renderTerminalPlainText((screen.chunks??[]).map(c=>c.text).join(''),120,40);lastFrame=text;const rows=text.split('\n');
  const ready=rows.slice(-12).some(row=>/^\s*[›❯>]\s*(?!\d+[.)])/.test(row))&&!workroomScreenAwaitsAnswer(rows)&&!/esc to interrupt|starting.*MCP|MCP.*starting/i.test(text);
  if(ready){stableSince ||= Date.now();if(Date.now()-stableSince>=1200)return;}else stableSince=0;
  await Bun.sleep(300);
 }throw Error('Resumed CLI composer was not ready; no follow-up was sent');
}
async function expectAnswer(id:string,marker:string){
 const until=Math.min(deadline,Date.now()+90000);
 while(Date.now()<until){const result=await request({operation:'read',sessionId:id,after:0,snapshot:true});const text=await renderTerminalPlainText((result.chunks??[]).map(c=>c.text).join(''),120,40);
  lastFrame=text;await service.sampleActivity();
  if(text.includes(marker)&&completed.get(id)?.includes(marker))return;
  if(result.session?.state==='exited')throw Error('CLI ended before the expected answer');
  if(/Trust this folder\?/i.test(text)&&process.argv.includes('--trust-empty-fixture')){
   if(!fixtureTrustApproved){
    if(!text.includes(realpathSync(project))||readdirSync(project).some(name=>name!=='.git'))throw Error('Fixture trust cannot be verified');
    fixtureTrustApproved=true;await request({operation:'input',sessionId:id,data:'\r'});proof.fixtureTrust='Explicit test option approved only the owned empty Git folder; native CLI saves that folder decision';save();
   }
   await Bun.sleep(400);continue;
  }
  if(/Do you trust|trust this (?:folder|directory)|Sign in to|Sign in with|API key.*required/i.test(text))throw Error('CLI requires a native trust or sign-in action; no automatic approval');
  await Bun.sleep(400);
 }
 throw Error('Expected answer not observed within the bounded wait; not replayed');
}
try{
 if(inspectStartup){
  const launched=await request({operation:'start',targetId,agent:'codex',cols:120,rows:40});await Bun.sleep(6000);
  const screen=await request({operation:'read',sessionId:launched.session!.id,after:0,snapshot:true});
  proof.startup=(await renderTerminalPlainText((screen.chunks??[]).map(c=>c.text).join(''),120,40)).replaceAll(project,'<temporary-project>').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'<email>').slice(-4000);
  proof.state='observed';console.log(proof.startup);
 }else{
 const started=await request({operation:'start',targetId,agent:'codex',cols:120,rows:40,prompt:'This is a short Workroom functionality check in an empty temporary workspace. Do not use tools, MCP, files, commands, web, or background agents. Calculate 731 + 226 mentally, and reply with WORKROOM_QA_ followed by the sum. Then wait.'});
 const first=started.session!.id;await expectAnswer(first,'WORKROOM_QA_957');proof.cases.push({id:'first-answer',passed:true});save();console.log('Real first answer observed');
 const submission={requestId:randomUUID(),operation:'input' as const,sessionId:first,data:'Without using tools, add 43 to the previous answer and reply in the same WORKROOM_QA_ format.\r'};
 await service.perform(submission);await service.perform(submission);await expectAnswer(first,'WORKROOM_QA_1000');proof.cases.push({id:'followup-and-same-request-retry',passed:true});save();console.log('Real follow-up answer observed');
 const resumed=await request({operation:'start',targetId,agent:'codex',cols:120,rows:40,resumeFrom:first});if(resumed.resumed!==true)throw Error('The provider conversation was not proven to resume');
 await waitForComposer(resumed.session!.id);
 await request({operation:'input',sessionId:resumed.session!.id,data:'Without using tools, subtract 1 from our most recent answer and reply in the same WORKROOM_QA_ format.\r'});
 await expectAnswer(resumed.session!.id,'WORKROOM_QA_999');proof.cases.push({id:'same-provider-conversation-resumed',passed:true});proof.state='passed';console.log('Same real provider conversation resumed and answered');
 }
}catch(error){proof.state='blocked';proof.reason=error instanceof Error?error.message:'Live check did not complete';proof.lastFrame=lastFrame.replaceAll(project,'<temporary-project>').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'<email>').slice(-3500);console.error(proof.reason);process.exitCode=1;}
finally{proof.finishedAt=new Date().toISOString();save();await service.shutdown();rmSync(temp,{recursive:true,force:true});}
