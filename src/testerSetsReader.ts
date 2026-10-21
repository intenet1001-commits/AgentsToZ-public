import {constants} from 'node:fs';
import {lstat,open,opendir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {TesterSets} from './testerAgentContract';

const name=/^[a-z0-9][a-z0-9-]{0,63}$/;
const commonScenarios=['conflict-markers','json-valid','python-syntax'];
const commonPersonas=['first-time-user','regular-user','returning-user'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Visible project rows use this bounded read, never inspect/Python/Git or setup. */
export async function readProjectTesterSets(root:string,clean:(value:unknown,limit:number)=>string):Promise<TesterSets>{
  let budget=2_500_000;
  const fingerprints:string[]=[];
  const read=async(relative:string,max=512_000):Promise<string|null>=>{
    let path=root;
    for(const part of relative.split('/')){
      path=join(path,part);
      try{if((await lstat(path)).isSymbolicLink())throw Error('설정 경로의 심볼릭 링크를 확인하세요.');}
      catch(e:any){if(e.code==='ENOENT'){fingerprints.push(relative+':absent');return null;}throw e;}
    }
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const st=await file.stat();
      if(!st.isFile()||st.size>max||st.size>budget)throw Error('설정 파일 크기 또는 형식을 확인하세요.');
      const buffer=Buffer.alloc(Math.min(max,budget)+1);
      let used=0;
      while(used<buffer.length){const {bytesRead}=await file.read(buffer,used,buffer.length-used,null);if(!bytesRead)break;used+=bytesRead;}
      if(used>max||used>budget)throw Error('설정 읽기 한도를 넘었습니다.');
      budget-=used;const text=buffer.subarray(0,used).toString('utf8');fingerprints.push(relative+':'+sha(text));return text;
    }finally{await file.close();}
  };
  const object=(text:string)=>{const value=JSON.parse(text);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('설정 JSON 형식을 확인하세요.');return value;};
  const lines=(v:unknown,max=16)=>Array.isArray(v)?v.slice(0,max).filter(s=>typeof s==='string').map(s=>clean(s,300)):[];
  const version=(v:unknown)=>typeof v==='string'&&/^\d+\.\d+\.\d+$/.test(v)?v:null;
  let meta:any={},metaProblem='';
  try{const raw=await read('.agentstoz/tester-agent.json',32_000);if(raw){meta=object(raw);if(meta.schemaVersion!==1)throw Error('테스터 메타정보 버전을 확인하세요.');}}
  catch(e){metaProblem=clean(e instanceof Error?e.message:e,160);meta={};}
  const result:TesterSets={revision:'',runnerVersion:version(meta.templateVersion),instructionVersion:Number.isInteger(meta.instructionVersion)?meta.instructionVersion:0,
    general:{state:'none',count:0,unconfigured:0,commonVersion:version(meta.scenarioPack?.version),commonCount:0,commonModified:0,commonItems:[],projectScenarioCount:0,profiles:[],checks:[]},
    personas:{state:'none',count:0,commonVersion:version(meta.personaPack?.version),commonModified:0,templates:[],items:[],truncated:false,candidates:0,needsChecks:0,candidateRoles:[]},agents:[]};
  for(const [kind,ids] of [['scenarios',commonScenarios],['personas',commonPersonas]] as const){
    for(const id of ids){
      try{
        const relative=`.agentstoz/${kind}/common/${id}.json`,raw=await read(relative,24_000);if(!raw)continue;
        const item=object(raw);if(item.schemaVersion!==1||item.id!==(kind==='scenarios'?'common.':'')+id)throw Error('공통 구성 형식을 확인하세요.');
        const hashes=kind==='scenarios'?meta.scenarioPack?.hashes:meta.personaPack?.hashes;
        if(kind==='scenarios'){result.general.commonCount++;result.general.commonItems.push({id:item.id,title:clean(item.title??id,120)});if(typeof hashes?.[relative]==='string'&&hashes[relative]!==sha(raw))result.general.commonModified++;}
        else{result.personas.templates.push({id,title:clean(item.title??id,120)});if(typeof hashes?.[relative]==='string'&&hashes[relative]!==sha(raw))result.personas.commonModified++;}
      }catch(e){const target=kind==='scenarios'?result.general:result.personas;target.state='invalid';target.problem=clean(e instanceof Error?e.message:e,160);}
    }
  }
  try{
    const raw=await read('.agentstoz/maintainer.json');
    if(raw){
      const config=object(raw);
      if(config.schemaVersion!==1||!Array.isArray(config.checks)||!config.checks.length||config.checks.length>96||!config.profiles||typeof config.profiles!=='object'||Array.isArray(config.profiles)||!Object.keys(config.profiles).length||Object.keys(config.profiles).length>16)throw Error('일반 테스트 설정 형식을 확인하세요.');
      const ids=new Set<string>();
      const checks=config.checks.map((c:any)=>{
        if(!c||typeof c.id!=='string'||!name.test(c.id)||ids.has(c.id)||c.argv!==undefined&&(!Array.isArray(c.argv)||!c.argv.length||c.argv.length>128||c.argv.some((v:unknown)=>typeof v!=='string'||v.length>4096)))throw Error('일반 검사 ID 또는 실행 설정을 확인하세요.');
        ids.add(c.id);return {id:c.id,covers:lines(c.covers,32),configured:Array.isArray(c.argv)&&c.argv.length>0};
      });
      const profiles=Object.entries(config.profiles).map(([id,v])=>{if(!name.test(id)||!Array.isArray(v)||!v.length||v.length>96||v.some(c=>!ids.has(c))||new Set(v).size!==v.length)throw Error('검사 범위의 연결을 확인하세요.');return {id,checks:v as string[]};});
      Object.assign(result.general,{state:result.general.problem?'invalid':'configured',count:checks.length,unconfigured:checks.filter((c:any)=>!c.configured).length,checks,profiles});
    }
    // Count only the bounded project-owned scenario directory, never recursive traversal.
    const folder=join(root,'.agentstoz/scenarios/project');
    try{if((await lstat(folder)).isSymbolicLink())throw Error('프로젝트 시나리오 경로를 확인하세요.');const dir=await opendir(folder);let visited=0;for await(const entry of dir){if(++visited>96)break;if(entry.isFile()&&name.test(entry.name.replace(/\.json$/,''))&&entry.name.endsWith('.json'))result.general.projectScenarioCount++;}}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
  }catch(e){result.general.state='invalid';result.general.problem=clean(e instanceof Error?e.message:e,160);}
  try{
    const canonical=await read('.agentstoz/personas.json'),legacy=await read('tests/personas/catalog.json');
    if(canonical&&legacy)throw Error('페르소나 카탈로그가 두 개입니다. 하나로 정리하세요.');
    const raw=canonical??legacy;
    if(raw){
      const catalog=object(raw);if(catalog.schemaVersion!==1||!Array.isArray(catalog.personas)||!catalog.personas.length||catalog.personas.length>256)throw Error('페르소나 설정 형식을 확인하세요.');
      const ids=new Set<string>();
      const items=catalog.personas.map((p:any)=>{
        if(!p||typeof p.id!=='string'||!name.test(p.id)||ids.has(p.id)||typeof p.goal!=='string'||!p.goal.trim()||p.goal.length>500||!Array.isArray(p.tests)||!p.tests.length||p.tests.length>32)throw Error('페르소나 역할·목표·실제 검사 연결을 확인하세요.');
        ids.add(p.id);
        const checks:string[]=[],configured=new Set(result.general.checks.filter(c=>c.configured).map(c=>c.id));
        let embeddedTests=0;
        for(const original of p.tests){const test=typeof original==='string'?{file:original}:original;if(test?.check){if(!configured.has(test.check))throw Error('페르소나에 미구성 검사가 연결돼 있습니다.');checks.push(test.check);}else if(test&&typeof test==='object'&&(typeof test.file==='string'&&/^[^/\\]+(?:\.test\.ts|\.mjs)$/.test(test.file)||Array.isArray(test.argv)&&test.argv.length>0&&test.argv.length<=128&&test.argv.every((v:unknown)=>typeof v==='string'&&!!v&&v.length<=4096)&&['contract','screen'].includes(test.kind)))embeddedTests++;else throw Error('페르소나 검사 연결을 확인하세요.');}
        const template=p.extends?result.personas.templates.find(t=>t.id===p.extends):undefined;
        if(p.extends&&!template)throw Error('공통 페르소나 관점을 먼저 연결하세요.');
        return {id:p.id,role:clean(p.role??p.id,120),goal:clean(p.goal,500),...(template?{templateId:template.id}:{}),reason:clean(p.reason??'',500),situation:clean(p.situation??'',500),journey:lines(p.journey),successCriteria:lines(p.successCriteria??p.explore?.successCriteria),checks,embeddedTests};
      });
      Object.assign(result.personas,{state:result.personas.problem?'invalid':'configured',count:items.length,items:items.slice(0,64),truncated:items.length>64});
    }
    const drafts=await read('.agentstoz/maintainer/persona-evolution-v1.json');
    if(drafts){const value=object(drafts);if(value.schemaVersion!==1||!Array.isArray(value.candidates)||value.candidates.length>64)throw Error('페르소나 후보 형식을 확인하세요.');result.personas.candidates=value.candidates.length;result.personas.needsChecks=value.candidates.filter((c:any)=>Array.isArray(c?.checkIds)&&!c.checkIds.length).length;result.personas.candidateRoles=value.candidates.slice(0,12).map((c:any)=>clean(c.profile?.role??c.goal,120));}
  }catch(e){result.personas.state='invalid';result.personas.problem=clean(e instanceof Error?e.message:e,160);}
  const provided:Record<string,boolean>={};
  for(const file of ['AGENTS.md','CLAUDE.md','GEMINI.md']){
    // Match the runner's guide-only budget. Configuration limits and the total
    // visible-row budget above remain unchanged; a large guide is never edited.
    try{const raw=await read(file,1_000_000);provided[file]=!!raw&&raw.includes('<!-- AgentsToZ tester:start -->')&&raw.includes('<!-- AgentsToZ tester:end -->')&&(result.instructionVersion<2||raw.includes('without waiting for a separate persona-testing request')&&raw.includes('personas propose'));}catch{provided[file]=false;}
  }
  result.agents=[{id:'codex',label:'Codex',instructionsProvided:!!provided['AGENTS.md']},{id:'claude',label:'Claude',instructionsProvided:!!provided['CLAUDE.md']},{id:'hermes',label:'Hermes',instructionsProvided:!!provided['AGENTS.md']},{id:'agy',label:'Antigravity',instructionsProvided:!!provided['GEMINI.md']}];
  if(metaProblem){result.general.state=result.personas.state='invalid';result.general.problem=result.personas.problem=metaProblem;}
  result.revision=sha(fingerprints.join('\n'));
  return result;
}
