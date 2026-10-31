import {expect, test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {initializeProjectMemory} from '../project-memory-server';
import {resolveAppDataDir} from '../src/appDataDir';
import {captureWhatISaidPrompt, configureWhatISaidCapture, whatISaidDatabasePath} from '../src/whatISaidStore';
import {startTestApiServer} from './startTestApiServer';

test('bounded unfiltered pages do not decrypt unrelated later rows; sparse filtered pagination stays complete', async () => {
  const home = mkdtempSync(join(tmpdir(), 'what-i-said-scan-bound-'));
  const key = Buffer.alloc(32, 0x31), capability = 'c'.repeat(64);
  let child: Bun.Subprocess | undefined;
  try {
    const env = {...process.env, HOME:home, APPDATA:join(home,'AppData','Roaming'), XDG_CONFIG_HOME:join(home,'.config'),
      NODE_ENV:'test', PORT:'9000', PORTMGR_ALLOWED_ORIGINS:'', PORTMGR_BUNDLED_SIDECAR:'1',
      PORTMGR_WHAT_I_SAID_CAPABILITY:capability, PORTMGR_WHAT_I_SAID_TEST_KEY:key.toString('hex'), AGENTSTOZ_SKIP_HERMES_SYNC:'1'};
    const appDataDir = resolveAppDataDir(process.platform, env, home);
    const projectRoot = join(home,'projects','sample');
    mkdirSync(projectRoot,{recursive:true}); mkdirSync(appDataDir,{recursive:true});
    const memory = initializeProjectMemory({folderPath:projectRoot,projectName:'Sample',autoBackup:false});
    const location = {appDataDir,projectRoot,memoryId:memory.config!.memoryId};
    writeFileSync(join(appDataDir,'ports.json'),JSON.stringify([{id:'sample',name:'Sample',folderPath:projectRoot}]));
    configureWhatISaidCapture({...location,enabled:true,retention:365,analysisAllowed:false,now:'2026-10-20T00:00:00Z'});
    for(let n=0;n<205;n++) {
      const stored = captureWhatISaidPrompt({...location,key,agent:'codex',sourceIdentity:'fixture.jsonl',sourceEventIdentity:String(n),
        recordedAt:'2026-10-20T00:01:00Z',now:'2026-10-20T00:01:01Z',text:`row-${n}${n%73===0?' needle':''}`});
      expect(stored.stored).toBe(true);
    }
    const started = await startTestApiServer({cwd:join(import.meta.dir,'..'),env}); child = started.child;
    const request = async (body: Record<string, unknown>) => {
      const response=await fetch(`${started.baseUrl}/api/what-i-said/list`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://tauri.localhost','X-AgentsToZ-What-I-Said-Capability':capability},body:JSON.stringify({memoryIds:[location.memoryId],source:'local',...body})});
      return {status:response.status,body:await response.json() as any};
    };
    // Unfiltered pages at the exact 100-row boundary, including the last page.
    let beforeSeq: string | undefined; const seen: string[]=[];
    for(let n=0;n<4;n++) {
      const page=await request({limit:100,...(beforeSeq?{beforeSeq}:{})});
      expect(page.status).toBe(200); seen.push(...page.body.items.map((item: {seq:string})=>item.seq));
      if(!page.body.hasMore) {expect(page.body.nextBeforeSeq).toBeNull();break;}
      beforeSeq=page.body.nextBeforeSeq;
    }
    expect(seen).toEqual(Array.from({length:205},(_,n)=>String(205-n)));
    // Filtered scans may have to advance through > one 200-row source batch.
    beforeSeq=undefined; const matches: string[]=[];
    for(let n=0;n<4;n++) {
      const page=await request({limit:2,query:'needle',...(beforeSeq?{beforeSeq}:{})});
      expect(page.status).toBe(200); matches.push(...page.body.items.map((item:{text:string})=>item.text));
      if(!page.body.hasMore)break; beforeSeq=page.body.nextBeforeSeq;
    }
    expect(matches).toEqual(['row-146 needle','row-73 needle','row-0 needle']);
    // Corrupt the third-newest encrypted row. A limit-1 unfiltered page needs
    // only the first two rows; the next page must still surface the bad row.
    const db=new Database(whatISaidDatabasePath(location));
    try {db.query('UPDATE what_i_said_events SET auth_tag = ? WHERE seq = ?').run(Buffer.alloc(16,0),203);} finally {db.close();}
    const first=await request({limit:1});
    expect(first.status).toBe(200); expect(first.body.items.map((x:{seq:string})=>x.seq)).toEqual(['205']);
    expect(first.body.hasMore).toBe(true); expect(first.body.nextBeforeSeq).toBe('205');
    expect((await request({limit:1,beforeSeq:'205'})).status).toBeGreaterThanOrEqual(400);
    expect((await request({limit:1,query:'needle'})).status).toBeGreaterThanOrEqual(400);
  } finally {
    if(child){try{child.kill();}catch{} await child.exited.catch(()=>undefined);}
    rmSync(home,{recursive:true,force:true});
  }
},30_000);
