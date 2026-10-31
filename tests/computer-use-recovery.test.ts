import {afterEach,describe,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {type ComputerWorker} from '../src/computerUseHost';
import {testComputerUseHost} from './computer-use-test-helper';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {COMPUTER_USE_RECOVERY_LIMITS,ComputerUseRecovery,type ComputerUseRecoveryStore} from '../src/computerUseRecovery';

const target={bundleId:'com.example.Mail',teamId:'ABCDEFGHIJ',codeHash:'cd'.repeat(20),pid:400,processStart:'1234567',windowId:77};
const otherApp={...target,bundleId:'com.example.Notes',pid:401,windowId:78};
const PRIVATE_VALUE='비밀 초안 본문 do-not-store';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function ledgerPath(){const d=mkdtempSync(join(tmpdir(),'agentstoz-computer-use-recovery-'));dirs.push(d);return join(d,'nested','computer-use-recovery.sqlite');}
function setup(recovery:ComputerUseRecoveryStore,action:()=>Promise<Record<string,any>>=async()=>({success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}})) {
  const callers=new ComputerCallerRegistry();
  const caller=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
  const sent:string[]=[];
  const {host,grantFor}=testComputerUseHost({recovery,createWorker:async()=>({close(){},async request(body){
    if(body.operation==='bind')return {success:true,bound:true,protocolVersion:2};
    if(body.operation==='observe')return {success:true,snapshotId:'ps1_exact',elements:[{id:'elem_1',role:'textField',label:'Private draft label',value:'',enabled:true,settable:true}],truncated:false};
    sent.push(String(body.operation));return action();
  }} satisfies ComputerWorker)});
  const open=async(t=target)=>{const raw=await grantFor(caller,t,'Draft');const g={grant:raw.grant,epoch:raw.epoch};
    const obs=await host.agent(caller,{...g,operation:'observe'});return {g,obs};};
  const write=(o:{g:{grant:string;epoch:number};obs:any},requestId='draft_request_01')=>
    host.agent(caller,{...o.g,operation:'set-value',requestId,observationId:o.obs.observationId,element:'elem_1',value:PRIVATE_VALUE});
  return {host,grantFor,caller,sent,open,write};
}
const until=async(ok:()=>boolean)=>{for(let i=0;i<200&&!ok();i++)await new Promise(r=>setTimeout(r,5));expect(ok()).toBe(true);};

describe('C4 · durable unknown actions survive a restart and need a person before that app is controlled again',()=>{
  test('an action still in flight is already durable; after a restart the app cannot be granted again until reviewed',async()=>{
    const path=ledgerPath();const first=new ComputerUseRecovery(path);
    const a=setup(first,()=>new Promise<Record<string,any>>(()=>{}));
    void a.write(await a.open());await until(()=>a.sent.length===1);
    // A second process opens the same ledger, as the app would after a crash or restart.
    const restarted=new ComputerUseRecovery(path);
    const pending=restarted.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({bundleId:'com.example.mail',windowId:77,operation:'set-value',requestId:'draft_request_01',
      sessionId:'workroom_session_a',lane:'leader',state:'unknown',reviewedAt:null});
    const b=setup(restarted);
    await expect(b.grantFor(b.caller,target,'again')).rejects.toThrow('확인하지 못한 작업');
    await expect(b.grantFor(b.caller,{...target,pid:500,processStart:'7654321',windowId:99},'relaunched app')).rejects.toThrow('확인하지 못한 작업');
    expect((await b.grantFor(b.caller,otherApp,'another app')).success).toBe(true);
    expect(restarted.review(pending[0]!.id)).toBe(true);expect(restarted.review(pending[0]!.id)).toBe(false);
    expect(restarted.pending()).toHaveLength(0);
    expect((await b.grantFor(b.caller,target,'after review')).success).toBe(true);
    a.host.dispose();b.host.dispose();first.close();restarted.close();
  });
  test('definite answers leave nothing to review; unknown ones stay, also under a human takeover',async()=>{
    const cases:[Record<string,any>,number,string][]=[
      [{success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}},0,'confirmed'],
      [{success:false,code:'human-active',notDispatched:true,halted:false,retryAfterMs:400},0,'refused'],
      [{success:true,halted:false,humanStatePreserved:true,outcome:{state:'dispatched_unverified'}},0,'dispatched-unverified'],
      [{success:true,halted:true,humanStatePreserved:false,outcome:{state:'confirmed_change'}},0,'human-takeover'],
      [{success:true,halted:true,humanStatePreserved:false,outcome:{state:'indeterminate'}},1,'human-takeover'],
      [{success:true,halted:false,humanStatePreserved:true,outcome:{state:'partial'}},1,'unknown'],
      [{success:false,code:'native-operation-unconfirmed',halted:true},1,'unknown']];
    for(const [answer,rows,state] of cases) {
      const recovery=new ComputerUseRecovery(':memory:');const f=setup(recovery,async()=>answer);
      expect((await f.write(await f.open())).receipt.state).toBe(state);
      expect(recovery.pending()).toHaveLength(rows);
      if(rows)await expect(f.grantFor(f.caller,target,'again')).rejects.toThrow('확인하지 못한 작업');
      f.host.dispose();recovery.close();
    }
  });
  test('another grant on the same app cannot send while an action of that app awaits review',async()=>{
    const recovery=new ComputerUseRecovery(':memory:');let answer:Record<string,any>={success:false,code:'native-operation-unconfirmed',halted:true};
    const f=setup(recovery,async()=>answer);
    const a=await f.open(),b=await f.open({...target,windowId:79});
    expect((await f.write(a)).receipt.state).toBe('unknown');
    answer={success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}};
    const fresh=await f.host.agent(f.caller,{...b.g,operation:'observe'});
    await expect(f.write({g:b.g,obs:fresh},'draft_request_02')).rejects.toThrow('확인하지 못한 작업');
    expect(f.sent).toEqual(['set-value']);
    f.host.dispose();recovery.close();
  });
  test('a ledger that cannot record or be read blocks sending and granting instead of guessing',async()=>{
    const store:ComputerUseRecoveryStore={begin(){throw Error('disk full');},settle(){},unresolved(){return [];}};
    const f=setup(store);
    await expect(f.write(await f.open())).rejects.toThrow('작업 기록을 남기지 못해');
    expect(f.sent).toHaveLength(0);
    const unreadable=setup({begin(){return 'x';},settle(){},unresolved(){throw Error('locked');}});
    await expect(unreadable.grantFor(unreadable.caller,target,'locked ledger')).rejects.toThrow('확인하지 못한 작업');
    f.host.dispose();unreadable.host.dispose();
  });
});

describe('C4 · the ledger is private and bounded',()=>{
  test('upgrading an existing ledger preserves unknown and reviewed rows and records click across restart',()=>{
    const path=ledgerPath();
    // Build an actual old-format database, including independently created schema objects.
    mkdirSync(dirname(path),{recursive:true});
    const old=new Database(path,{create:true});
    old.exec(`CREATE TABLE computer_use_actions(id TEXT PRIMARY KEY,bundleId TEXT NOT NULL,windowId INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('press','set-value')),requestId TEXT NOT NULL,sessionId TEXT NOT NULL,
      lane TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('unknown','reviewed')),createdAt INTEGER NOT NULL,reviewedAt INTEGER);
      CREATE INDEX extra_history_index ON computer_use_actions(reviewedAt);
      INSERT INTO computer_use_actions VALUES('legacy-1','com.example.old',5,'press','old-request','session','leader','unknown',100,NULL);
      INSERT INTO computer_use_actions VALUES('legacy-2','com.example.done',6,'set-value','old-review','session','leader','reviewed',101,102);`);
    old.close();
    const migrated=new ComputerUseRecovery(path,{now:()=>110});
    expect(migrated.pending()).toMatchObject([{id:'legacy-1',operation:'press',state:'unknown',createdAt:100}]);
    const id=migrated.begin({bundleId:'com.example.click',windowId:7,operation:'click',requestId:'click-1',sessionId:'session',lane:'leader'});
    migrated.close();
    const reopened=new ComputerUseRecovery(path);
    expect(reopened.pending()).toMatchObject([{id:'legacy-1',operation:'press'},{id,operation:'click',state:'unknown'}]);
    expect(()=>reopened.begin({bundleId:'com.example.click',windowId:7,operation:'press',requestId:'repeat',sessionId:'session',lane:'leader'})).toThrow('결과를 모르는');
    reopened.close();
    const check=new Database(path,{readonly:true});
    expect(check.query("SELECT state,reviewedAt FROM computer_use_actions WHERE id='legacy-2'").get()).toEqual({state:'reviewed',reviewedAt:102});
    expect(check.query("SELECT name FROM sqlite_master WHERE type='index' AND name='extra_history_index'").get()).toBeTruthy();
    check.close();
  });
  test('a legacy table with unrecognized columns is left intact instead of discarding data',()=>{
    const path=ledgerPath();mkdirSync(dirname(path),{recursive:true});
    const old=new Database(path,{create:true});
    old.exec(`CREATE TABLE computer_use_actions(id TEXT PRIMARY KEY,bundleId TEXT NOT NULL,windowId INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('press','set-value')),requestId TEXT NOT NULL,sessionId TEXT NOT NULL,
      lane TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('unknown','reviewed')),createdAt INTEGER NOT NULL,reviewedAt INTEGER,extra TEXT);
      INSERT INTO computer_use_actions VALUES('keep','com.example.old',1,'press','request','session','leader','unknown',1,NULL,'preserve');`);
    old.close();
    expect(()=>new ComputerUseRecovery(path)).toThrow('알 수 없는 복구 기록 열');
    const check=new Database(path,{readonly:true});
    expect(check.query("SELECT extra FROM computer_use_actions WHERE id='keep'").get()).toEqual({extra:'preserve'});
    expect(check.query("SELECT name FROM sqlite_master WHERE name='computer_use_actions_migrating'").get()).toBeNull();
    check.close();
  });
  test('owner-only files, no typed values, labels or secrets on disk',async()=>{
    const path=ledgerPath();const recovery=new ComputerUseRecovery(path);
    const f=setup(recovery,async()=>({success:false,code:'native-operation-unconfirmed',halted:true}));
    const o=await f.open();await f.write(o);recovery.close();
    expect(statSync(path).mode&0o777).toBe(0o600);expect(statSync(dirname(path)).mode&0o777).toBe(0o700);
    const raw=readFileSync(path).toString('latin1')+readFileSync(path).toString('utf8');
    for(const secret of [PRIVATE_VALUE,'Private draft label',o.g.grant,'ps1_exact'])expect(raw).not.toContain(secret);
    f.host.dispose();
  });
  test('a full ledger refuses new actions instead of evicting unknown ones; only reviewed history is evicted or expires',()=>{
    let now=1_000;const recovery=new ComputerUseRecovery(':memory:',{now:()=>now});
    // One app admits one unknown action at a time, so filling the ledger takes as many apps as rows.
    const entry=(i:number)=>({bundleId:`com.example.mail${i}`,windowId:77,operation:'press' as const,requestId:`press_request_${i}`,sessionId:'workroom_session_a',lane:'leader'});
    const ids=Array.from({length:COMPUTER_USE_RECOVERY_LIMITS.rows},(_,i)=>recovery.begin(entry(i)));
    expect(()=>recovery.begin(entry(999))).toThrow('너무 많습니다');
    expect(recovery.review(ids[0]!)).toBe(true);
    const next=recovery.begin(entry(1000));expect(recovery.pending()).toHaveLength(COMPUTER_USE_RECOVERY_LIMITS.rows);
    expect(recovery.pending().some(r=>r.id===ids[0])).toBe(false);
    for(const id of ids.slice(1,11))recovery.review(id);recovery.settle(next);
    now+=COMPUTER_USE_RECOVERY_LIMITS.reviewedRetentionMs+1;
    recovery.begin(entry(1001));
    expect(recovery.pending()).toHaveLength(COMPUTER_USE_RECOVERY_LIMITS.rows-10);
    for(const bad of [{...entry(1),bundleId:'com.example/../x'},{...entry(1),windowId:0},{...entry(1),operation:'shell'},{...entry(1),lane:'x'.repeat(65)}])
      expect(()=>recovery.begin(bad as any)).toThrow('올바르지 않습니다');
    recovery.close();
  });
});
