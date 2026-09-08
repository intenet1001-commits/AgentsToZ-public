import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';import {selectAutomaticMemorySources} from '../src/memorySaveSelection';
import type {MemorySaveSource} from '../src/memorySaveContract';
test('post-consent exact ranges survive pagination, missing files and source reservations',()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-selection-'));let now=1000;const store=new MemorySaveStore(join(root,'s.sqlite'),()=>now);
 const source=(turnId:string,completedAt:number):MemorySaveSource=>({agent:'codex',instanceId:'instance',sessionId:'session',turnId,startByte:0,endByte:200,sourceDigest:'a'.repeat(64),memoryId:'memory',policyEpoch:1,completedAt,coverageKind:'complete-turn'});
 try{
  store.observe(source('old',100));store.setAutomaticPolicy(0,{enabled:true,consentVersion:1,providerBindingDigest:'a'.repeat(64)});now=2000;
  store.observe(source('late-old',100));for(let i=0;i<130;i++)store.observe(source('new-'+i,1500));
  const page=store.automaticPending('memory',1,1);expect(page.items).toHaveLength(127);expect(page.nextCursor).not.toBeNull();
  expect(store.automaticPending('memory',1,1,page.nextCursor!).items).toHaveLength(3);
  const base={store,memoryId:'memory',policyEpoch:1,revision:1,instanceId:'instance',cwd:root};
  const missing=selectAutomaticMemorySources({...base,candidates:[]});expect(missing.sources).toHaveLength(0);expect(missing.unavailable).toBe(127);
  const selected=selectAutomaticMemorySources({...base,candidates:[{key:'k',stamp:'200:1500',agent:'codex',sessionId:'session',path:join(root,'source.jsonl'),transcriptRoot:root}]});
  expect(selected.sources).toHaveLength(8);expect(selected.remaining).toBe(119);
  const keys=page.items.slice(0,8).map(i=>i.sourceKey);store.reserve('memory',1,keys);
  expect(store.automaticPending('memory',1,1).items.every(i=>!keys.includes(i.sourceKey))).toBe(true);
  expect(store.pending('memory',1).items.some(i=>i.sourceKey===store.observe(source('old',100)))).toBe(true);
  store.setAutomaticPolicy(1,{enabled:false});expect(()=>store.automaticPending('memory',1,1)).toThrow('POLICY_DISABLED');
 }finally{rmSync(root,{recursive:true,force:true});}
});
