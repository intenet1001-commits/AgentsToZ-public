import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testerOverview} from '../src/testerOverview';
import {TesterAgentStore} from '../src/testerAgentStore';
import {parseTesterOverviewRequest} from '../src/testerOverviewContract';

test('Control lists a bounded page with same-second latest evidence and no commands or raw logs',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tester-overview-')),store=new TesterAgentStore(join(dir,'data'));
 try{
  const targets=Array.from({length:23},(_,i)=>({projectId:'project-'+String(i).padStart(2,'0'),name:'Project '+i,root:join(dir,'project-'+i)}));
  for(const t of targets)mkdirSync(t.root);
  const root=targets[0]!.root;
  for(const [suffix,time] of [['ffffffff','100'],['11111111','900']]){
   const id='20260914T000000Z-'+suffix,path=join(root,'.agentstoz/maintainer/runs',id);mkdirSync(path,{recursive:true});
   writeFileSync(join(path,'report.json'),JSON.stringify({runId:id,state:'passed',profile:'quick',startedAt:'2026-09-14T00:00:00.'+time+'Z',checks:[{id:'core',state:'passed',output:'secret /private',reason:'private evidence'}]}));
  }
  symlinkSync(root,join(targets[1]!.root,'.agentstoz'));
  const first=await testerOverview({}, {targets,complete:true},store,'Test Mac');
  expect(first.entries).toHaveLength(20);expect(first.nextOffset).toBe(20);
  expect(first.entries[0]!.run!.id).toBe('20260914T000000Z-11111111');
  expect(first.entries[1]!.state).toBe('unavailable');
  expect(JSON.stringify(first)).not.toContain('/private');expect(JSON.stringify(first)).not.toContain('secret');expect(JSON.stringify(first)).not.toContain(dir);
  const second=await testerOverview({offset:20,revision:first.revision},{targets,complete:false},store,'Test Mac');
  expect(second.entries).toHaveLength(3);expect(second.nextOffset).toBeNull();expect(second.complete).toBe(false);
  await expect(testerOverview({offset:20,revision:first.revision},{targets:targets.slice(1),complete:true},store,'Mac')).rejects.toThrow('목록이 변경');
  expect(()=>parseTesterOverviewRequest({path:'/tmp'})).toThrow();expect(()=>parseTesterOverviewRequest({offset:20})).toThrow();
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
