import {parseTesterOverviewRequest,type TesterOverviewEntry,type TesterOverview} from './testerOverviewContract';
import {createHash} from 'node:crypto';
import {lstat,readFile,opendir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import type {TesterAgentStore} from './testerAgentStore';
import type {TesterReport} from './testerAgentContract';
import {latestTesterRun,mobileTesterRun,normalizeMobileTesterResult} from './mobileTesterProtocol';

async function snapshot(root:string,projectId:string,store:TesterAgentStore):Promise<Pick<TesterOverviewEntry,'state'|'run'>> {
  root=await realpath(root);const stat=await lstat(root);
  const identity=createHash('sha256').update(`${root}\0${stat.dev}\0${stat.ino}`).digest('hex');
  const stored=store.latest(root),active=store.active(root)[0];
  const valid=(r:typeof stored)=>r?.target.portId===projectId&&r.rootIdentity===identity?r:null;
  const finish=(latest:TesterReport|null,state:TesterOverviewEntry['state']='no-result')=>{
    const selected=latestTesterRun({latest,latestRun:valid(stored),active:valid(active??null)});
    const run=selected?mobileTesterRun(selected):null;
    normalizeMobileTesterResult({run,canRun:false,canCancel:false});
    return {state:run?'observed' as const:state,run};
  };
  let dir=root;
  for(const part of ['.agentstoz','maintainer','runs']){
    dir=join(dir,part);
    try{const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Unsafe tester directory');}
    catch(e:any){if(e.code==='ENOENT'){
      try{const config=await lstat(join(root,'.agentstoz','maintainer.json'));return finish(null,config.isFile()?'no-result':'unavailable');}catch{return finish(null,'not-configured');}
    }throw e;}
  }
  const entries:string[]=[];
  for await(const entry of await opendir(dir)){if(entries.length>=64)throw Error('Report inventory limit');entries.push(entry.name);}
  const ids=entries.filter(n=>/^\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(n)).sort().reverse();
  let latest:TesterReport|null=null;
  // Run IDs include random suffixes, so compare actual timestamps within the
  // latest second instead of treating a lexicographic suffix as chronology.
  let budget=5_000_000;
  for(const id of ids.filter(id=>id.slice(0,16)===ids[0]?.slice(0,16))){
    const runDir=join(dir,id),file=join(runDir,'report.json');const ds=await lstat(runDir),fs=await lstat(file);
    if(!ds.isDirectory()||ds.isSymbolicLink()||!fs.isFile()||fs.isSymbolicLink()||fs.size>budget)throw Error('Invalid report');
    budget-=fs.size;
    const raw=JSON.parse(await readFile(file,'utf8'));
    if(raw.runId!==id||!Array.isArray(raw.checks)||raw.checks.length>96||!Number.isFinite(Date.parse(raw.startedAt)))throw Error('Invalid report');
    if(!latest||Date.parse(raw.startedAt)>Date.parse(latest.startedAt))latest=raw;
  }
  return finish(latest);
}
/** One page, two reads at a time. Never launches Python, Git, tests or AI. */
export async function testerOverview(input:unknown,inventory:{targets:{projectId:string;name:string;root:string}[];complete:boolean},store:TesterAgentStore,hostName:string):Promise<TesterOverview> {
  const req=parseTesterOverviewRequest(input);
  const targets=[...inventory.targets].sort((a,b)=>a.projectId.localeCompare(b.projectId));
  const revision=createHash('sha256').update(JSON.stringify(targets)).digest('hex');
  if(req.revision&&req.revision!==revision)throw new Error('프로젝트 목록이 변경되었습니다. 처음부터 새로고침하세요.');
  const offset=req.offset??0,page=targets.slice(offset,offset+20),entries:TesterOverviewEntry[]=[];
  for(let i=0;i<page.length;i+=2){
    const rows=await Promise.all(page.slice(i,i+2).map(async t=>{
      try{return {projectId:t.projectId,name:t.name,...await snapshot(t.root,t.projectId,store)};}
      catch{return {projectId:t.projectId,name:t.name,state:'unavailable' as const,run:null};}
    }));entries.push(...rows);
  }
  return {hostName,checkedAt:new Date().toISOString(),revision,entries,total:targets.length,nextOffset:offset+page.length<targets.length?offset+page.length:null,complete:inventory.complete};
}
