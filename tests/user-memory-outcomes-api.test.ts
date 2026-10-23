import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory,appendProjectMemoryJournal,buildProjectMemoryJournalEntry} from '../project-memory-server';
import {startTestApiServer} from './startTestApiServer';
const roots:string[]=[],children:Bun.Subprocess[]=[];
afterEach(async()=>{for(const child of children.splice(0)){child.kill();await child.exited;}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

test('native-protected outcomes report truncation and preserve recent contiguous records without inventing a device',async()=>{
  const home=mkdtempSync(join(tmpdir(),'user-outcomes-'));roots.push(home);
  const data=join(home,'data'),project=join(home,'project');mkdirSync(data);mkdirSync(project);
  const memory=initializeProjectMemory({folderPath:project,projectName:'Outcome fixture',autoBackup:false});
  const memoryId=memory.config!.memoryId;
  writeFileSync(join(data,'ports.json'),JSON.stringify([{id:'outcome-project',name:'Outcome fixture',folderPath:project}]));
  for(let i=0;i<502;i++)appendProjectMemoryJournal(project,buildProjectMemoryJournalEntry({recordedAt:new Date(Date.UTC(2026,9,22,0,i)).toISOString(),agent:'codex',narrative:`Fixture outcome ${i}`}));
  const {child,baseUrl}=await startTestApiServer({cwd:join(import.meta.dir,'..'),env:{...process.env,HOME:home,APP_DATA_DIR:data,NODE_ENV:'test',PORTMGR_BUNDLED_SIDECAR:'1',PORTMGR_WHAT_I_SAID_CAPABILITY:'c'.repeat(64),AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP:'1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC:'1'}});children.push(child);
  const read=async(memoryIds:string[],authorized=true)=>{
    const response=await fetch(baseUrl+'/api/what-i-said/outcomes',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://tauri.localhost',...(authorized?{'X-AgentsToZ-What-I-Said-Capability':'c'.repeat(64)}:{})},body:JSON.stringify({memoryIds})});
    return {status:response.status,body:await response.json() as any};
  };
  expect((await read([memoryId],false)).status).toBe(403);
  const page=await read([memoryId]);expect(page.status).toBe(200);expect(page.body.complete).toBe(false);expect(page.body.outcomes).toHaveLength(500);
  expect(page.body.outcomes.some((row:any)=>row.summary==='Fixture outcome 501')).toBe(true);
  expect(page.body.outcomes.some((row:any)=>row.summary==='Fixture outcome 0')).toBe(false);
  expect(page.body.outcomes.every((row:any)=>row.memoryId===memoryId&&row.deviceId===null&&row.deviceName===null)).toBe(true);
  const unavailable=await read(['unregistered-memory']);expect(unavailable.body).toMatchObject({complete:false,outcomes:[]});
  const tooMany=await read(Array.from({length:65},(_,i)=>`unknown-${i}`));expect(tooMany.body.complete).toBe(false);
},20_000);
