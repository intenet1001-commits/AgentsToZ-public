import {describe,expect,test} from 'bun:test';
import {SESSION_DIRECTORY_MAX_DEVICES,SessionDirectoryInventory,sessionDirectoryGroups,sessionDirectoryLiveGroups,sessionDirectoryRowKey,type SessionDirectoryDevice,type SessionDirectoryLoad,type SessionDirectorySnapshot} from '../src/workroomSessionDirectoryModel';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';

const device=(endpointId:string):SessionDirectoryDevice=>({endpointId,deviceId:`device-${endpointId}`,label:`Mac ${endpointId}`,local:endpointId===''});
const session=(id='same-session',targetId='project-root',createdAt='2026-10-12T02:00:00Z',state:'running'|'exited'='running'):AiTerminalSummary=>({id,targetId,createdAt,state,agent:'codex',exitCode:state==='running'?null:0,cols:100,rows:28});
const loaded=(sessions:AiTerminalSummary[]=[session()]):SessionDirectoryLoad=>({projects:[{targetId:'project-root',projectTargetId:'project-root',label:'동명 프로젝트',scope:'main'}],sessions});
const deferred=<T>()=>{let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const snapshot=(endpointId:string):SessionDirectorySnapshot=>({...loaded(),device:device(endpointId),loading:false,error:'',observedAt:123});

describe('device-owned conversation directory',()=>{
  test('identical session and project ids on different Macs stay separately owned',()=>{
    const first=sessionDirectoryGroups(snapshot('one'))[0]!,second=sessionDirectoryGroups(snapshot('two'))[0]!;
    expect(first.label).toBe(second.label);expect(first.key).not.toBe(second.key);
    expect(first.rows[0]!.key).toBe(sessionDirectoryRowKey(device('one'),'same-session'));
    expect(first.rows[0]!.key).not.toBe(second.rows[0]!.key);
  });
  test('groups worktrees with their exact parent, sorts newest first, searches account, and opts into empty/ended rows',()=>{
    const value=snapshot('one');value.projects.push({targetId:'worktree-one',projectTargetId:'project-root',label:'수정 작업',scope:'worktree'},{targetId:'empty-one',label:'빈 프로젝트'});
    value.sessions=[session('old'),{...session('new','worktree-one','2026-10-12T03:00:00Z'),accountLabel:'회사 계정'},session('ended','project-root','2026-10-12T04:00:00Z','exited')];
    const groups=sessionDirectoryGroups(value);
    expect(groups).toHaveLength(1);expect(groups[0]!.rows.map(row=>row.session.id)).toEqual(['new','old']);
    expect(sessionDirectoryGroups(value,'회사')[0]!.rows.map(row=>row.session.id)).toEqual(['new']);
    expect(sessionDirectoryGroups(value,'',true)[0]!.rows[0]!.session.id).toBe('ended');
    expect(sessionDirectoryGroups(value,'',false,true)).toHaveLength(2);
    expect(sessionDirectoryGroups(value,'없는 이름')).toHaveLength(0);
  });
  test('coalesces a slow device while bounding simultaneous requests',async()=>{
    const held=Array.from({length:8},()=>deferred<SessionDirectoryLoad>());let running=0,maximum=0,calls=0;
    const inventory=new SessionDirectoryInventory(async scope=>{calls++;running++;maximum=Math.max(maximum,running);try{return await held[Number(scope.endpointId)]!.promise;}finally{running--; }},()=>{});
    inventory.configure(Array.from({length:8},(_,index)=>device(String(index))));
    const all=inventory.refresh(),one=inventory.refreshDevice('0');
    expect(inventory.refreshDevice('0')).toBe(one);await tick();expect(calls).toBe(4);expect(maximum).toBe(4);
    for(const waiter of held)waiter.resolve(loaded());await all;
    expect(calls).toBe(8);expect(maximum).toBe(4);inventory.dispose();
  });
  test('failure preserves last confirmed inventory and allows an explicit retry',async()=>{
    let fail=false,calls=0;const inventory=new SessionDirectoryInventory(async()=>{calls++;if(fail)throw Error('상대 기기 미응답');return loaded();},()=>{},()=>987);
    inventory.configure([device('one')]);await inventory.refresh();fail=true;await inventory.refresh();
    const failed=inventory.snapshot('one')!;expect(failed.sessions[0]!.id).toBe('same-session');expect(failed.observedAt).toBe(987);expect(failed.error).toBe('상대 기기 미응답');expect(failed.loading).toBe(false);
    fail=false;await inventory.refresh();expect(inventory.snapshot('one')!.error).toBe('');expect(calls).toBe(3);inventory.dispose();
  });
  test('a removed then rejoined endpoint cannot publish its old delayed reply',async()=>{
    const held=deferred<SessionDirectoryLoad>();let calls=0;const inventory=new SessionDirectoryInventory(async()=>++calls===1?held.promise:loaded([session('new-session')]),()=>{});
    inventory.configure([device('one')]);const old=inventory.refreshDevice('one');await tick();
    inventory.configure([]);inventory.configure([device('one')]);await inventory.refreshDevice('one');
    held.resolve(loaded([session('obsolete-session')]));expect(await old).toBeNull();expect(inventory.snapshot('one')!.sessions[0]!.id).toBe('new-session');inventory.dispose();
  });
  test('disposal stops queued loads and late publication without acting on host sessions',async()=>{
    const held=deferred<SessionDirectoryLoad>();let calls=0,changes=0;
    const inventory=new SessionDirectoryInventory(async()=>{calls++;return held.promise;},()=>{changes++;});
    inventory.configure(Array.from({length:10},(_,index)=>device(String(index))));const all=inventory.refresh();await tick();expect(calls).toBe(4);
    inventory.dispose();const before=changes;held.resolve(loaded());await all;
    expect(calls).toBe(4);expect(changes).toBe(before);expect(inventory.snapshots()).toEqual([]);
  });
  test('a replaced owner on the same endpoint cannot retain another device inventory or publish its reply',async()=>{
    const held=deferred<SessionDirectoryLoad>();let calls=0;
    const inventory=new SessionDirectoryInventory(async()=>++calls===1?held.promise:loaded([session('replacement-session')]),()=>{});
    inventory.configure([device('one')]);const old=inventory.refreshDevice('one');await tick();
    inventory.configure([{...device('one'),deviceId:'replacement-device'}]);
    expect(inventory.snapshot('one')!.sessions).toEqual([]);await inventory.refreshDevice('one');
    held.resolve(loaded([session('wrong-owner-session')]));expect(await old).toBeNull();
    expect(inventory.snapshot('one')!.sessions[0]!.id).toBe('replacement-session');inventory.dispose();
  });
  test('cached devices outside the new roster do not consume the inventory budget',()=>{
    const cached=Array.from({length:SESSION_DIRECTORY_MAX_DEVICES},(_,i)=>snapshot(`old-${i}`));
    const inventory=new SessionDirectoryInventory(async()=>loaded(),()=>{},Date.now,cached);
    inventory.configure(Array.from({length:SESSION_DIRECTORY_MAX_DEVICES},(_,i)=>device(`new-${i}`)));
    expect(inventory.snapshots()).toHaveLength(SESSION_DIRECTORY_MAX_DEVICES);
    expect(inventory.snapshot('old-0')).toBeUndefined();inventory.dispose();
  });
  test('owner churn releases obsolete queued jobs even while all four wire slots are stalled',async()=>{
    const held=deferred<SessionDirectoryLoad>();let calls=0,released=0;
    const inventory=new SessionDirectoryInventory(async()=>{calls++;return held.promise;},()=>{});
    const occupied=Array.from({length:4},(_,i)=>device(`occupied-${i}`));
    inventory.configure(occupied);const running=inventory.refresh();await tick();
    for(let i=0;i<100;i++){
      inventory.configure([...occupied,{...device('queued'),deviceId:`queued-owner-${i}`}]);
      void inventory.refreshDevice('queued').then(value=>{if(!value)released++;});
    }
    await tick();expect(calls).toBe(4);expect(released).toBe(99);
    held.resolve(loaded());await running;await tick();expect(calls).toBe(5);inventory.dispose();
  });
  test('limits inventory scopes and retains snapshots when the visible view resumes',async()=>{
    const cached=snapshot('one');const inventory=new SessionDirectoryInventory(async()=>loaded(),()=>{},Date.now,[cached]);
    inventory.configure([device('one'),...Array.from({length:50},(_,index)=>device(String(index)))]);
    expect(inventory.snapshots()).toHaveLength(SESSION_DIRECTORY_MAX_DEVICES);expect(inventory.snapshot('one')!.observedAt).toBe(123);inventory.dispose();
  });
});

describe('live-first directory groups (S1)',()=>{
  const view=(sessionId:string,state:string,extra:object={})=>({sessionId,targetId:'project-root',agent:'codex',state,since:Date.parse('2026-10-12T03:00:00Z'),turn:1,source:'screen',exact:false,lastOutputAt:null,...extra}) as any;
  const local=():SessionDirectorySnapshot=>({...loaded([session('asking-0001'),session('working-0001'),session('finished-001'),session('ended-000001','project-root','2026-10-12T01:00:00Z','exited'),session('unknown-0001')]),device:device(''),loading:false,error:'',observedAt:1});
  const activity=new Map([['asking-0001',view('asking-0001','needs-answer')],['working-0001',view('working-0001','working')],['finished-001',view('finished-001','turn-finished',{exact:true})]]);
  test('attention order, ended rows always shown, unknown running reads 실행 중',()=>{
    const groups=sessionDirectoryLiveGroups(local(),'',activity);
    expect(groups.map(group=>[group.id,group.rows.map(row=>row.presentation.label)])).toEqual([['needs-answer',['응답 필요']],['working',['작업 중']],['finished',['완료']],['running',['실행 중']],['ended',['종료']]]);
  });
  test('every heading is true of its rows: a guessed end is not 「완료」, an unknown state is not 「대기」 (review 2026-10-16)',()=>{
    const all=():SessionDirectorySnapshot=>({...loaded([session('asking-0001'),session('working-0001'),session('finished-001'),session('stopped-0001'),session('waiting-0001'),session('starting-001'),session('unknown-0001'),session('ended-000001','project-root','2026-10-12T01:00:00Z','exited')]),device:device(''),loading:false,error:'',observedAt:1});
    const states=new Map([['asking-0001',view('asking-0001','needs-answer')],['working-0001',view('working-0001','working')],['finished-001',view('finished-001','turn-finished',{exact:true})],
      ['stopped-0001',view('stopped-0001','turn-finished',{exact:false})],['waiting-0001',view('waiting-0001','idle')],['starting-001',view('starting-001','starting')]]);
    const allowed:Record<string,string[]>={'응답 필요':['응답 필요'],'작업 중':['작업 중'],'완료':['완료'],'응답 멈춤':['응답 멈춤'],'대기':['대기'],'실행 중':['실행 중','시작 중'],'종료':['종료']};
    const groups=sessionDirectoryLiveGroups(all(),'',states);
    expect(groups.map(group=>group.title)).toEqual(['응답 필요','작업 중','완료','응답 멈춤','대기','실행 중','종료']);
    for(const group of groups)for(const row of group.rows)expect(allowed[group.title]).toContain(row.presentation.label);
    // Another Mac's sessions and an older sidecar have no state: never under 「대기」.
    expect(sessionDirectoryLiveGroups({...local(),device:device('peer-endpoint-0001')},'',states).map(group=>group.title)).toEqual(['실행 중','종료']);
    expect(sessionDirectoryLiveGroups(local()).map(group=>group.title)).toEqual(['실행 중','종료']);
  });
  test('another Mac never borrows this Mac\'s activity, even with a colliding session id',()=>{
    const peer={...local(),device:device('peer-endpoint-0001')};
    expect(sessionDirectoryLiveGroups(peer,'',activity).map(group=>group.id)).toEqual(['running','ended']);
  });
  test('activity for another target or agent is ignored; search matches the state label',()=>{
    const wrong=new Map([['asking-0001',view('asking-0001','needs-answer',{targetId:'other-target'})]]);
    expect(sessionDirectoryLiveGroups(local(),'',wrong)[0]!.id).toBe('running');
    expect(sessionDirectoryLiveGroups(local(),'응답 필요',activity).flatMap(group=>group.rows.map(row=>row.session.id))).toEqual(['asking-0001']);
  });
});
