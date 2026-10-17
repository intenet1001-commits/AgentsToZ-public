import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MemorySaveStore} from '../src/memorySaveStore';import {selectAutomaticMemorySources} from '../src/memorySaveSelection';
import type {MemorySaveSource} from '../src/memorySaveContract';
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'memory-selection-')));let now=1000;
 const store=new MemorySaveStore(join(root,'s.sqlite'),()=>now),path=join(root,'source.jsonl');
 const line=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
 const parts=[line({type:'session_meta',payload:{id:'session',cwd:root,source:'cli'}})];let offset=parts[0]!.length;
 const source=(turnId:string,completedAt:number,text='Complete human request'):MemorySaveSource=>{
  const timestamp=new Date(completedAt).toISOString();const bytes=Buffer.concat([
   line({type:'event_msg',timestamp,payload:{type:'task_started',turn_id:turnId}}),
   line({type:'event_msg',timestamp,payload:{type:'user_message',message:text}}),
   line({type:'event_msg',timestamp,payload:{type:'agent_message',message:'Complete response'}}),
   line({type:'event_msg',timestamp,payload:{type:'task_complete',turn_id:turnId}}),
  ]);const startByte=offset;parts.push(bytes);offset+=bytes.length;
  return {agent:'codex',instanceId:'instance',sessionId:'session',turnId,startByte,endByte:offset,sourceDigest:createHash('sha256').update(bytes).digest('hex'),memoryId:'memory',policyEpoch:1,completedAt,coverageKind:'complete-turn'};
 };
 const base={store,memoryId:'memory',policyEpoch:1,revision:1,instanceId:'instance',cwd:root,validateRegistrationAndLease:async()=>true,
  candidates:[{key:'k',stamp:'200:1500',agent:'codex' as const,sessionId:'session',path,transcriptRoot:root}]};
 return {root,store,base,source,write:()=>writeFileSync(path,Buffer.concat(parts)),later:()=>{now=2000;},close:()=>rmSync(root,{recursive:true,force:true})};
}
test('post-consent exact ranges survive pagination, missing files and source reservations',async()=>{
 const f=fixture(),{store}=f;
 try{
  store.observe(f.source('old',100));store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:'a'.repeat(64)});f.later();
  const old=f.source('late-old',100);store.observe(old);for(let i=0;i<130;i++)store.observe(f.source('new-'+i,1500));f.write();
  const page=store.automaticPending('memory',1,1);expect(page.items).toHaveLength(127);expect(page.nextCursor).not.toBeNull();
  expect(store.automaticPending('memory',1,1,page.nextCursor!).items).toHaveLength(3);
  const missing=await selectAutomaticMemorySources({...f.base,candidates:[]});expect(missing.sources).toHaveLength(0);expect(missing.unavailable).toBe(127);
  const selected=await selectAutomaticMemorySources(f.base);
  expect(selected.sources).toHaveLength(8);expect(selected.remaining).toBe(119);
  const keys=page.items.slice(0,8).map(i=>i.sourceKey);store.reserve('memory',1,keys);
  expect(store.automaticPending('memory',1,1).items.every(i=>!keys.includes(i.sourceKey))).toBe(true);
  expect(store.pending('memory',1).items.some(i=>i.sourceKey===store.observe(old))).toBe(true);
  store.setAutomaticPolicy(1,{enabled:false});await expect(selectAutomaticMemorySources(f.base)).rejects.toThrow('POLICY_DISABLED');
 }finally{f.close();}
});
test('an oversized semantic turn stays pending while a later complete small turn is admitted',async()=>{
 const f=fixture();try{
  f.store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:'a'.repeat(64)});f.later();
  f.store.observe(f.source('oversized',1500,'큰'.repeat(7000)));f.store.observe(f.source('small',1501));f.write();
  const result=await selectAutomaticMemorySources(f.base);
  expect(result.oversized).toBe(1);expect(result.sources.map(i=>i.source.turnId)).toEqual(['small']);
  expect(f.store.automaticPending('memory',1,1).items).toHaveLength(2);expect(f.store.page().items).toHaveLength(0);
 }finally{f.close();}
});
test('changed registration aborts the page rather than hiding the error as an unavailable source',async()=>{
 const f=fixture();try{
  f.store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:'a'.repeat(64)});f.later();
  f.store.observe(f.source('small',1501));f.write();
  await expect(selectAutomaticMemorySources({...f.base,validateRegistrationAndLease:async()=>false})).rejects.toThrow('REGISTRATION_CHANGED');
  expect(f.store.automaticPending('memory',1,1).items).toHaveLength(1);
 }finally{f.close();}
});
