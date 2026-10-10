/** Research probe, run with Bun from the repository root. No model/API calls.
 * Uses owned temporary shell PTYs. This is NOT a UI or provider benchmark. */
import {mkdtempSync,writeFileSync,chmodSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const {AiTerminalService,aiTerminalRegistrationEvidence}=await import(pathToFileURL(resolve(root,'src/aiTerminalService.ts')).href);
const {terminalOutputPage}=await import(pathToFileURL(resolve(root,'src/aiTerminalOutput.ts')).href);
const {createTerminalReadCadence}=await import(pathToFileURL(resolve(root,'src/aiTerminalScheduling.ts')).href);
const owned=mkdtempSync(join(tmpdir(),'atz-workroom-research-'));
const executable=join(owned,'echo-fixture');
writeFileSync(executable,'#!/bin/sh\nstty -echo\nprintf "READY\\n"\nwhile IFS= read -r line; do printf "GOT:%s\\n" "$line"; done\n');
chmodSync(executable,0o700);
const request=(r:any)=>({...r,requestId:crypto.randomUUID()});
const stats=(values:number[])=>{
  const sorted=[...values].sort((a,b)=>a-b);
  const q=(p:number)=>Number(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]!.toFixed(3));
  return {n:values.length,p50Ms:q(.5),p95Ms:q(.95),maxMs:q(1)};
};
async function until(check:()=>boolean|Promise<boolean>){
  const deadline=performance.now()+5000;
  while(performance.now()<deadline){if(await check())return;await Bun.sleep(1);}
  throw new Error('Owned fixture did not respond within five seconds');
}
let service:any,raw:any;
try{
  let rawText='';
  const decoder=new TextDecoder();
  raw=Bun.spawn([executable,'-c','tui.status_line=["context-remaining"]'],{cwd:owned,env:{PATH:'/usr/bin:/bin',TERM:'xterm-256color',COLORTERM:'truecolor'},detached:true,terminal:{cols:100,rows:28,data:(_t:any,data:Uint8Array)=>{rawText+=decoder.decode(data,{stream:true});}}});
  await until(()=>rawText.includes('READY'));
  service=new AiTerminalService({resolveTarget:async()=>({cwd:owned}),executable:()=>executable,env:{PATH:'/usr/bin:/bin'}});
  const session=(await service.perform(request({operation:'start',targetId:'research-project',agent:'codex',cols:100,rows:28}))).session.id;
  let cursor=0,serviceText='';
  const readUntil=async(marker:string)=>until(async()=>{
    const page=await service.perform(request({operation:'read',sessionId:session,after:cursor}));
    serviceText+=(page.chunks??[]).map((c:any)=>c.text).join('');cursor=page.nextCursor;
    return serviceText.includes(marker);
  });
  await readUntil('READY');
  const samples={directPty:[] as number[],serviceSeparateEnter:[] as number[],serviceCombinedEnter:[] as number[]};
  // Rotate order to reduce systematic ordering bias; first triplet is warmup.
  for(let i=0;i<31;i++){
    const modes=['directPty','serviceSeparateEnter','serviceCombinedEnter'] as const;
    for(let j=0;j<3;j++){
      const mode=modes[(j+i)%3]!;const marker=`probe-${mode}-${i}`;const start=performance.now();
      if(mode==='directPty'){
        raw.terminal.write(marker+'\r');await until(()=>rawText.includes('GOT:'+marker+'\r\n'));
      }else{
        if(mode==='serviceSeparateEnter'){
          await service.perform(request({operation:'input',sessionId:session,data:marker}));
          await service.perform(request({operation:'input',sessionId:session,data:'\r'}));
        }else await service.perform(request({operation:'input',sessionId:session,data:marker+'\r'}));
        await readUntil('GOT:'+marker+'\r\n');
      }
      if(i>0)samples[mode].push(performance.now()-start);
    }
  }
  const registry:any[]=[];const registration:any[]=[];
  for(let i=0;i<1000;i++){const folderPath=join(owned,'project-'+i);mkdirSync(folderPath);registry.push({id:'project-'+i,folderPath});}
  for(const count of [1,100,1000]){
    const rows=registry.slice(0,count);aiTerminalRegistrationEvidence(rows);
    const values:number[]=[];
    for(let i=0;i<20;i++){const start=performance.now();aiTerminalRegistrationEvidence(rows);values.push(performance.now()-start);}
    registration.push({registeredLocalDirectories:count,...stats(values)});
  }
  const scan:any[]=[];
  for(const count of [1000,10000,100000]){
    const chunks=Array.from({length:count},(_,i)=>({seq:i+1,text:'x'}));
    terminalOutputPage(chunks,count-1);const values:number[]=[];
    for(let i=0;i<20;i++){const start=performance.now();terminalOutputPage(chunks,count-1);values.push(performance.now()-start);}
    scan.push({retainedOneCharacterChunks:count,...stats(values)});
  }
  const chunks=Array.from({length:Math.ceil(1_000_000/1024)},(_,i)=>({seq:i+1,text:'x'.repeat(Math.min(1024,1_000_000-i*1024))}));
  let after=0,pages=0,chars=0;
  for(;;){const page=terminalOutputPage(chunks,after);pages++;chars+=page.chunks.reduce((n:number,c:any)=>n+c.text.length,0);after=page.nextCursor;if(!page.hasMore)break;}
  const cadence=(remote:boolean)=>{const c=createTerminalReadCadence(remote,()=>10_000);return Array.from({length:7},()=>c.next(false,false));};
  console.log(JSON.stringify({
    measuredAt:new Date().toISOString(),bun:Bun.version,platform:process.platform,architecture:process.arch,
    method:'30 samples per mode after one warmup, rotated order, identical shell echo fixture, 1ms polling in both routes. Service target resolver is a trivial temporary root. No production registry/API/Tauri/xterm/Orca/Codex app/model is measured.',
    latency:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,stats(values)])),
    registrationEvidence:registration,tailReadScan:scan,
    replay:{asciiCharacters:chars,pages,idealRemoteSchedulingFloorMs:(pages-1)*140,note:'Calculated from current 140ms minimum request-start spacing; excludes RTT, contention, encryption, paint and all real relay polling. Not a measured transfer.'},
    idleEmptyReadDelaysMs:{local:cadence(false),remote:cadence(true)},
  },null,2));
}finally{
  if(service)await service.shutdown();
  if(raw){try{process.kill(-raw.pid,'SIGTERM');}catch{}await raw.exited;raw.terminal.close();}
  rmSync(owned,{recursive:true,force:true});
}
