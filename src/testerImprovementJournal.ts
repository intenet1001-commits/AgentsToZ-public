import {constants} from 'node:fs';
import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseTesterImprovement,type TesterImprovementInput,type TesterImprovements} from './testerImprovements';

const LIMIT=256,MAX_BYTES=1_048_576;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const empty=():TesterImprovements=>({schemaVersion:1,items:[],limit:LIMIT,class:'exploratory/observed',verdict:null});
async function pathFor(root:string,create=false){
 let path=root;
 for(const part of ['.agentstoz','maintainer']){path=join(path,part);if(create)await mkdir(path,{recursive:true});try{const st=await lstat(path);if(st.isSymbolicLink()||!st.isDirectory())throw Error('개선 기록 폴더를 확인하세요.');}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
 return join(path,'improvements.json');
}
export async function readTesterImprovements(root:string):Promise<TesterImprovements>{
 const path=await pathFor(root);if(!path)return empty();
 let file;try{file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));}catch(e:any){if(e.code==='ENOENT')return empty();throw e;}
 try{
  const st=await file.stat();if(!st.isFile()||st.size>MAX_BYTES)throw Error('개선 기록 크기나 파일 형식을 확인하세요.');
  const data=JSON.parse(await file.readFile('utf8')) as TesterImprovements;
  if(data.schemaVersion!==1||data.class!=='exploratory/observed'||data.verdict!==null||!Array.isArray(data.items)||data.items.length>LIMIT)throw Error('기존 개선 기록 형식을 확인하세요. 원본은 보존됩니다.');
  const ids=new Set<string>();
  for(const item of data.items){
   const validTime=(s:unknown)=>typeof s==='string'&&s.length<40&&Number.isFinite(Date.parse(s));
   if(!item||!/^improvement_[a-f0-9]{24}$/.test(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||![item.observations,item.changes,item.rechecks].every(n=>Number.isSafeInteger(n)&&n>=0)||item.observations+item.changes+item.rechecks!==item.revision||!validTime(item.firstSeenAt)||!validTime(item.updatedAt)||!Array.isArray(item.events)||item.events.length<1||item.events.length>Math.min(6,item.revision)||!Array.isArray(item.receipts)||item.receipts.length<1||item.receipts.length>16||item.receipts.some(r=>!r||!/^[-a-zA-Z0-9_]{8,96}$/.test(r.id)||!/^[a-f0-9]{64}$/.test(r.digest)))throw Error('기존 개선 기록을 확인하세요. 원본은 보존됩니다.');
   ids.add(item.id);
   for(const [index,event] of item.events.entries()){
    parseTesterImprovement(Object.fromEntries(Object.entries(event).filter(([k])=>k!=='at')));
    if(!validTime(event.at)||event.persona!==item.persona||event.scenario!==item.scenario||event.expectedRevision!==item.revision-item.events.length+index)throw Error('기존 개선 이력의 순서를 확인하세요. 원본은 보존됩니다.');
   }
   const latest=item.events.at(-1)!;
   if(item.stage!==latest.stage||item.outcome!==latest.outcome||item.expected!==latest.expected)throw Error('기존 개선 이력의 요약을 확인하세요. 원본은 보존됩니다.');
  }
  return {...data,limit:LIMIT};
 }finally{await file.close();}
}
/** The caller holds the existing project workspace lease across this read/CAS/atomic write. */
export async function recordTesterImprovement(root:string,raw:TesterImprovementInput):Promise<TesterImprovements>{
 const input=parseTesterImprovement(raw),data=await readTesterImprovements(root);
 const id='improvement_'+hash([input.persona,input.scenario].join('\0')).slice(0,24),digest=hash(JSON.stringify(input));
 let item=data.items.find(x=>x.id===id);const replay=item?.receipts.find(x=>x.id===input.requestId);
 if(replay){if(replay.digest!==digest)throw Error('같은 기록 요청의 내용이 바뀌었습니다. 현재 기록을 다시 읽으세요.');return data;}
 if((item?.revision??0)!==input.expectedRevision)throw Error('개선 기록이 변경되었습니다. 새로 고친 뒤 관측을 남기세요.');
 if(!item){
  if(input.stage!=='observed')throw Error('첫 관측을 남긴 뒤 개선과 재확인을 기록하세요.');
  if(data.items.length>=LIMIT)throw Error('개선 시나리오 한도에 도달했습니다. 기존 기록은 보존됩니다.');
  const at=new Date().toISOString();item={id,revision:0,persona:input.persona,scenario:input.scenario,expected:input.expected,firstSeenAt:at,updatedAt:at,observations:0,changes:0,rechecks:0,stage:'observed',events:[],receipts:[]};data.items.push(item);
 }
 const at=new Date().toISOString();item.revision++;item.updatedAt=at;item.expected=input.expected;item.stage=input.stage;item.outcome=input.outcome;
 if(input.stage==='observed')item.observations++;else if(input.stage==='changed')item.changes++;else item.rechecks++;
 item.events=[...item.events,{...input,at}].slice(-6);item.receipts=[...item.receipts,{id:input.requestId,digest}].slice(-16);
 data.items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
 const body=JSON.stringify(data,null,2)+'\n';if(Buffer.byteLength(body)>MAX_BYTES)throw Error('개선 기록 저장 한도에 도달했습니다. 기존 기록은 보존됩니다.');
 const path=(await pathFor(root,true))!,temporary=path+'.'+randomUUID()+'.tmp';
 try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}await rename(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
 return data;
}
