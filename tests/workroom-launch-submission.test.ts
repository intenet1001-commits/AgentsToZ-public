/**
 * New-session first requests carry a durable launch receipt (terminal-start-submission-v1), and receipts stay
 * findable across a reconnect that rotates the transport owner (host-only receiptOwner, terminal-submission-recent-v1).
 *
 * The danger these guard: a start whose response is lost used to be a brand-new request on retry, so a second CLI
 * could open with the same prompt. A launch receipt makes the retry return the first session instead, and the
 * journal fences the spawn exactly like a whole-request submission fences its PTY write.
 */
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {AiTerminalService,type AiTerminalAuthority} from '../src/aiTerminalService';
import {createAiTerminalRemoteGateway} from '../src/aiTerminalRemoteGateway';
import {normalizeAiTerminalRequest,normalizeAiTerminalResponse,type AiTerminalRequest} from '../src/aiTerminalProtocol';
import {normalizeSubmissionReceipt,submissionDigest,WORKROOM_LAUNCH_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_RECENT_FEATURE} from '../src/workroomSubmissionProtocol';
import {submitWorkroomDraft,pendingLaunchKey,readPendingLaunch,writePendingLaunch,readPendingLaunches,writePendingLaunches,withPendingLaunch,blockingPendingLaunch,uncertainRouteLaunchFor,routeDraftClearsOnSettle,PENDING_LAUNCH_LIMIT,pendingLaunchAfterStatus,recoveredPendingSubmission,recoveredPendingLaunch,readDismissedSubmissions,rememberDismissedSubmission,launchNeverStarted,submissionStateLabel,WorkroomSubmissionUnsupportedError,usableSessionStorage,readableSessionStorage,pendingLaunchesOnLoad,pageMemoryStorage} from '../src/workroomSubmissionClient';

const dirs:string[]=[],cleanups:(()=>Promise<unknown>|unknown)[]=[];
afterEach(async()=>{for(const c of cleanups.splice(0).reverse())await c();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const TARGET='fixture-project',OTHER='other-project';
function fixture(options:{spawnFails?:boolean;beforeResolve?:()=>void;executable?:string}={}){
 const dir=mkdtempSync(join(tmpdir(),'launch-'));chmodSync(dir,0o700);dirs.push(dir);
 const otherDir=mkdtempSync(join(tmpdir(),'launch-other-'));dirs.push(otherDir);
 let store=new WorkroomConversationJournal(dir);
 const spawns:string[][]=[];const finishers:((code:number)=>void)[]=[];
 const service=new AiTerminalService({submissions:()=>store,headlessScreen:false,
  resolveTarget:async(id:string)=>{options.beforeResolve?.();return {cwd:id===OTHER?otherDir:dir};},executable:()=>options.executable??'/fixture/harmless',signalGroup:()=>{for(const f of finishers)f(0);},
  spawn:(args,spawnOptions)=>{
   if(options.spawnFails)throw Error('spawn failed');
   spawns.push(args);const exit=(spawnOptions.terminal as {exit():void}).exit;let finish!:(code:number)=>void;
   const exited=new Promise<number>(resolve=>{finish=resolve;});finishers.push(code=>{exit();finish(code);});
   return {pid:900000000+spawns.length,exited,kill:()=>{},terminal:{write:(text:string)=>Buffer.byteLength(text),resize:()=>{},close:()=>{exit();finish(0);}}};
  }});
 cleanups.push(()=>service.shutdown(),()=>store.close());
 const perform=(r:Omit<AiTerminalRequest,'requestId'>,authority?:AiTerminalAuthority,extra:{receiptOwner?:string}={})=>service.perform({...r,requestId:crypto.randomUUID()},authority,extra);
 return {dir,service,spawns,perform,get store(){return store;},reopen(){store.close();store=new WorkroomConversationJournal(dir);}};
}
const launch={targetId:TARGET,agent:'hermes' as const,cols:80,rows:24};
function single(text:string,id='launch-submission',spec:Record<string,unknown>=launch):any{
 const bytes=new TextEncoder().encode(text);
 return {phase:'single' as const,id,bytes:bytes.length,digest:submissionDigest(bytes),data:Buffer.from(bytes).toString('base64'),launch:spec};
}
const promptOf=(args:string[])=>args.join(' ');

test('a host with a journal advertises launch receipts and the recent lookup beside whole-request submission',async()=>{
 const f=fixture();
 const features=(await f.perform({operation:'list',capabilities:true})).features!;
 expect(features).toEqual(['terminal-submission-v1',WORKROOM_LAUNCH_SUBMISSION_FEATURE,WORKROOM_SUBMISSION_RECENT_FEATURE]);
 // The strict response normalizer (cap 4) still accepts the advertised list.
 expect(normalizeAiTerminalResponse({sessions:[],features}).features).toEqual(features);
});

test('a launch single opens one CLI with the prompt and answers with the new session id; a replay never spawns again',async()=>{
 const f=fixture();
 const first=await f.perform({operation:'submission',submission:single('build the parser\r')});
 const receipt=normalizeSubmissionReceipt(first.submission);
 expect(receipt.state).toBe('written');
 expect(receipt.sessionId).toMatch(/^[0-9a-f-]{36}$/);
 expect(first.session?.id).toBe(receipt.sessionId);
 expect(f.spawns).toHaveLength(1);
 expect(promptOf(f.spawns[0]!)).toContain('build the parser');
 // A lost response: the same request again returns the same receipt and session, no second CLI.
 const replay=await f.perform({operation:'submission',submission:single('build the parser\r')});
 expect(replay.submission).toEqual(receipt);
 // A read-only status without a session id finds the launch receipt.
 const status=await f.perform({operation:'submission',submission:{phase:'status',id:'launch-submission'}});
 expect(status.submission).toEqual(receipt);
 expect(f.spawns).toHaveLength(1);
 // A different request under the same id is refused, not executed.
 await expect(f.perform({operation:'submission',submission:single('something else\r')})).rejects.toThrow();
 expect(f.spawns).toHaveLength(1);
});

test('a long launch travels in chunks with no session id and writes once through the browser sender',async()=>{
 const f=fixture();const text='한글🙂 첫 요청\n'.repeat(700)+'\r';
 const sent:Omit<AiTerminalRequest,'requestId'>[]=[];
 const receipt=await submitWorkroomDraft({id:'long-launch',launch,text,prepared:()=>{},request:async r=>{sent.push(r);normalizeAiTerminalRequest({...r,requestId:crypto.randomUUID()});return f.perform(r);}});
 expect(receipt.state).toBe('written');expect(receipt.sessionId).toBeTruthy();
 expect(sent.every(r=>r.sessionId===undefined)).toBe(true);
 expect(sent.filter(r=>(r.submission as {launch?:unknown}).launch!==undefined)).toHaveLength(1);
 expect(f.spawns).toHaveLength(1);expect(promptOf(f.spawns[0]!)).toContain(text.slice(0,-1));
});

test('a spawn that fails after the write fence is unknown and a later commit never spawns',async()=>{
 const f=fixture({spawnFails:true});
 const result=await f.perform({operation:'submission',submission:single('maybe started\r','spawn-fails')});
 expect(result.submission?.state).toBe('unknown');
 const again=await f.perform({operation:'submission',submission:single('maybe started\r','spawn-fails')});
 expect(again.submission?.state).toBe('unknown');expect(f.spawns).toHaveLength(0);
});

test('write_started across a journal reopen becomes unknown and is never launched',async()=>{
 const f=fixture();
 const begin=await f.perform({operation:'submission',submission:{phase:'begin',id:'crash-launch',bytes:6,digest:submissionDigest(new TextEncoder().encode('crash\r')),chunks:1,launch}});
 expect(begin.submission?.state).toBe('prepared');
 const sessionId=begin.submission!.sessionId!;
 // Simulate a crash right after the durable fence: mark the row write_started, then reopen with a new boot.
 const db=new (await import('bun:sqlite')).Database(join(f.dir,'workroom-history-v1','history.sqlite'));
 db.query("UPDATE workroom_submissions SET state='write_started' WHERE json_extract(body,'$.id')='crash-launch'").run();db.close();
 f.reopen();
 const status=await f.perform({operation:'submission',submission:{phase:'status',id:'crash-launch'}});
 expect(status.submission).toMatchObject({state:'unknown',sessionId});
 await expect(f.perform({operation:'submission',submission:{phase:'chunk',id:'crash-launch',epoch:begin.submission!.epoch,index:0,data:Buffer.from('crash\r').toString('base64'),commit:true}})).resolves.toMatchObject({submission:{state:'unknown'}});
 expect(f.spawns).toHaveLength(0);
});

test('references that push the first request past 24,000 bytes are refused before the fence',async()=>{
 const f=fixture();
 const text='가'.repeat(7990)+'\r';
 await expect(submitWorkroomDraft({id:'too-large-launch',launch,text,references:[OTHER],prepared:()=>{},request:r=>f.perform(r)})).rejects.toThrow('24,000');
 expect(f.spawns).toHaveLength(0);
 // Nothing was started, so the receipt says so definitively; it is no longer offered for recovery.
 const status=await f.perform({operation:'submission',submission:{phase:'status',id:'too-large-launch'}});
 expect(status.submission?.state).toBe('rejected');
 expect((await f.perform({operation:'submission',submission:{phase:'recent'}})).submissions).toEqual([]);
});

test('a remote launch keeps every start guard: target grant, a revoke during an await, and no bypass from another community device',async()=>{
 let active=true;
 const f=fixture({beforeResolve:()=>{if(revokeOnResolve)active=false;}});let revokeOnResolve=false;
 f.service.setRemoteAccess('phone-owner',true);
 const authority:AiTerminalAuthority={owner:'phone-owner',targets:new Set([TARGET]),isActive:()=>active};
 await expect(f.perform({operation:'submission',submission:single('not granted\r','ungranted-launch',{...launch,targetId:OTHER})},authority)).rejects.toThrow();
 await expect(f.perform({operation:'submission',submission:single('bypass\r','community-bypass',{...launch,bypassPermissions:true})},undefined,{receiptOwner:'community:peer'})).rejects.toThrow();
 revokeOnResolve=true;
 await expect(f.perform({operation:'submission',submission:single('revoked\r','revoked-launch')},authority)).rejects.toThrow();
 expect(f.spawns).toHaveLength(0);
 // This Mac and a granted phone keep `start`'s bypass rule (parity, not a new privilege).
 revokeOnResolve=false;active=true;
 const local=await f.perform({operation:'submission',submission:single('local bypass\r','local-bypass',{...launch,bypassPermissions:true})});
 expect(local.submission?.state).toBe('written');expect(f.spawns).toHaveLength(1);
 const phone=await f.perform({operation:'submission',submission:single('phone bypass\r','phone-bypass',{...launch,bypassPermissions:true})},authority);
 expect(phone.submission?.state).toBe('written');expect(f.spawns).toHaveLength(2);
});

test('receipts without a launch keep the five-key shape old clients validate',async()=>{
 const f=fixture();
 const session=(await f.perform({operation:'start',targetId:TARGET,agent:'hermes',cols:80,rows:24})).session!;
 const bytes=new TextEncoder().encode('plain\r');
 const r=await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'single',id:'plain-submission',bytes:bytes.length,digest:submissionDigest(bytes),data:Buffer.from(bytes).toString('base64')}});
 expect(Object.keys(r.submission!).sort()).toEqual(['epoch','id','revision','state','storeId']);
});

test('the wire refuses a launch beside a session id, an input revision, or a malformed spec',()=>{
 const base={requestId:crypto.randomUUID(),operation:'submission'};
 expect(()=>normalizeAiTerminalRequest({...base,sessionId:'fixture-session-1',submission:single('x\r')})).toThrow();
 expect(()=>normalizeAiTerminalRequest({...base,expectedInputRevision:0,submission:single('x\r')})).toThrow();
 for(const spec of [{...launch,cols:2},{...launch,agent:'shell'},{...launch,path:'/tmp'},{...launch,bypassPermissions:'yes'}])
  expect(()=>normalizeAiTerminalRequest({...base,submission:single('x\r','bad-launch-spec',spec)})).toThrow();
 // An ordinary begin without a session id is not a launch and is refused as before.
 expect(()=>normalizeAiTerminalRequest({...base,submission:{phase:'begin',id:'no-session-begin',bytes:2,digest:'a'.repeat(64),chunks:1}})).toThrow();
});

test('the receipt owner is a stable lookup namespace across a rotating transport owner, never a grant',async()=>{
 const f=fixture();
 const session=(await f.perform({operation:'start',targetId:TARGET,agent:'hermes',cols:80,rows:24})).session!;
 f.service.setRemoteAccess('lan:first-connection',true);
 const first:AiTerminalAuthority={owner:'lan:first-connection',targets:new Set([TARGET])};
 const bytes=new TextEncoder().encode('survives reconnect\r');
 const submission={phase:'single' as const,id:'reconnect-submission',bytes:bytes.length,digest:submissionDigest(bytes),data:Buffer.from(bytes).toString('base64')};
 const sent=await f.perform({operation:'submission',sessionId:session.id,submission},first,{receiptOwner:'lan-controller:phone-a'});
 expect(sent.submission?.state).toBe('written');
 // The phone restores: a new transport owner, the same controller.
 f.service.setRemoteAccess('lan:second-connection',true);
 const second:AiTerminalAuthority={owner:'lan:second-connection',targets:new Set([TARGET])};
 const status=await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'reconnect-submission'}},second,{receiptOwner:'lan-controller:phone-a'});
 expect(status.submission).toEqual(sent.submission);
 // Another controller does not see it.
 await expect(f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'reconnect-submission'}},second,{receiptOwner:'lan-controller:phone-b'})).rejects.toThrow();
 // The receipt owner grants nothing: a revoked grant is refused, and a target outside the grant is hidden.
 f.service.setRemoteAccess('lan:second-connection',false);
 await expect(f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'reconnect-submission'}},second,{receiptOwner:'lan-controller:phone-a'})).rejects.toThrow();
 f.service.setRemoteAccess('lan:third-connection',true);
 await expect(f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'reconnect-submission'}},{owner:'lan:third-connection',targets:new Set([OTHER])},{receiptOwner:'lan-controller:phone-a'})).rejects.toThrow();
 // 'local' cannot be claimed by a remote authority.
 await expect(f.perform({operation:'list'},{owner:'lan:third-connection',targets:new Set([TARGET])},{receiptOwner:'local'})).rejects.toThrow();
});

test('recent lists only this owner\'s unsettled receipts for one session (or launches), newest first, at most 8',async()=>{
 const f=fixture();
 const session=(await f.perform({operation:'start',targetId:TARGET,agent:'hermes',cols:80,rows:24})).session!;
 const settled=new TextEncoder().encode('settled\r');
 await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'single',id:'mine-written',bytes:settled.length,digest:submissionDigest(settled),data:Buffer.from(settled).toString('base64')}});
 await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'begin',id:'mine-prepared-0',bytes:6,digest:submissionDigest(new TextEncoder().encode('later\r')),chunks:1}});
 const recent=await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'recent'}});
 expect(normalizeAiTerminalResponse(recent).submissions!.map(r=>r.id)).toEqual(['mine-prepared-0']);
 const launches=await f.perform({operation:'submission',submission:{phase:'recent'}});
 expect(launches.submissions).toEqual([]);
 // Bound: never more than 8, newest first. Each row is an unsettled write (crossed the fence, outcome lost).
 const {WorkroomSubmissions}=await import('../src/workroomSubmissions');
 const manager=new WorkroomSubmissions(()=>f.store);cleanups.push(()=>manager.close());
 const context={owner:'bounded-owner',sessionId:'bounded-session',targetId:TARGET,binding:'a'.repeat(64),revision:0};
 const lost=new TextEncoder().encode('later\r');
 const unknown=(id:string,ctx:typeof context)=>manager.perform({phase:'single',id,bytes:lost.length,digest:submissionDigest(lost),data:Buffer.from(lost).toString('base64')},ctx,[],async(_text,start)=>{start();throw Error('fixture: outcome lost');});
 for(let i=0;i<10;i++)expect((await unknown('bounded-'+i,context)).state).toBe('unknown');
 // Another owner's receipt in the same session is never listed.
 await unknown('other-owner-receipt',{...context,owner:'community:peer'});
 expect(manager.recent('community:peer','bounded-session').map(r=>r.receipt.id)).toEqual(['other-owner-receipt']);
 const page=manager.recent('bounded-owner','bounded-session');
 expect(page.map(r=>r.receipt.id)).toEqual(['bounded-9','bounded-8','bounded-7','bounded-6','bounded-5','bounded-4','bounded-3','bounded-2']);
});

test('the remote gateway hands the transport\'s stable receipt owner to the service; durable consent keeps its own',async()=>{
 const seen:unknown[]=[];
 const service={perform:async(_r:unknown,authority:AiTerminalAuthority,options:{receiptOwner?:string})=>{seen.push([authority.owner,options.receiptOwner]);return {sessions:[]};},remoteAllowed:()=>true} as unknown as AiTerminalService;
 const resolve=async()=>[{controlId:'control-1234',runtimeTargetId:TARGET}];
 const plain=createAiTerminalRemoteGateway({service,active:()=>true,resolve});
 await plain({requestId:crypto.randomUUID(),operation:'list'},[],'lan:rotating-1',()=>true,undefined,'lan-controller:stable');
 await plain({requestId:crypto.randomUUID(),operation:'list'},[],'internet:relay-session');
 const consented=createAiTerminalRemoteGateway({service,active:()=>true,resolve,consent:async()=>({targetIds:new Set([TARGET]),isActive:()=>true,requestOwner:'device:durable'})});
 await consented({requestId:crypto.randomUUID(),operation:'list'},[],'lan:rotating-2',()=>true,undefined,'lan-controller:stable');
 expect(seen).toEqual([['lan:rotating-1','lan-controller:stable'],['internet:relay-session','internet:relay-session'],['device:durable','device:durable']]);
});

test('pending launch records keep metadata only and refuse foreign shapes',()=>{
 const data=new Map<string,string>();
 const storage={get length(){return data.size;},key:(n:number)=>[...data.keys()][n]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);},clear:()=>data.clear()} as Storage;
 const key=pendingLaunchKey('fixture-scope');
 writePendingLaunch(storage,key,{id:'pending-launch-1',targetId:TARGET,agent:'hermes',receipt:null});
 expect(readPendingLaunch(storage,key)).toEqual({id:'pending-launch-1',targetId:TARGET,agent:'hermes',receipt:null});
 expect([...data.values()].join('')).not.toContain('prompt');
 storage.setItem(key,JSON.stringify({id:'pending-launch-1',targetId:TARGET,agent:'hermes',receipt:null,prompt:'secret'}));
 expect(()=>readPendingLaunch(storage,key)).toThrow();
 writePendingLaunch(storage,key,null);expect(readPendingLaunch(storage,key)).toBeNull();
});

test('recovery after lost client memory: written settles a launch, unsettled stays, dismissed ids never return',()=>{
 const base={storeId:'fixture-store',epoch:'fixture-epoch',revision:0};
 const launch={id:'launch-recover-1',targetId:TARGET,agent:'hermes' as const,receipt:null};
 expect(pendingLaunchAfterStatus(launch,{...base,id:launch.id,state:'written',sessionId:'fixture-session-1'})).toBeNull();
 for(const state of ['prepared','write_started','unknown'] as const)
  expect(pendingLaunchAfterStatus(launch,{...base,id:launch.id,state,sessionId:'fixture-session-1'})).toMatchObject({id:launch.id,receipt:{state}});
 // rejected (refused before the spawn fence) and held (prepared before a restart, never started) are definitive: nothing
 // started, so the launch is settled and the same target and AI may start again by hand.
 for(const state of ['rejected','held'] as const){
  expect(launchNeverStarted({...base,id:launch.id,state,sessionId:'fixture-session-1'})).toBe(true);
  expect(pendingLaunchAfterStatus(launch,{...base,id:launch.id,state,sessionId:'fixture-session-1'})).toBeNull();
 }
 for(const state of ['prepared','write_started','unknown','written'] as const)expect(launchNeverStarted({...base,id:launch.id,state})).toBe(false);
 // A written receipt without its session cannot select anything, so it stays pending rather than being trusted.
 expect(pendingLaunchAfterStatus(launch,{...base,id:launch.id,state:'written'})).not.toBeNull();
 const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
 rememberDismissedSubmission(storage,'dismissed-receipt');
 expect([...readDismissedSubmissions(storage)]).toEqual(['dismissed-receipt']);
 const receipts=[{...base,id:'dismissed-receipt',state:'unknown' as const},{...base,id:'older-receipt',state:'held' as const}];
 expect(recoveredPendingSubmission(receipts,readDismissedSubmissions(storage),'fixture-session-1')).toEqual({id:'older-receipt',sessionId:'fixture-session-1',receipt:receipts[1]!});
 expect(recoveredPendingLaunch(receipts,readDismissedSubmissions(storage))).toBeNull();
 // A recovered launch blocks only its own target and AI (the receipt names them), never every start.
 const launches=[{...base,id:'launch-recover-2',state:'unknown' as const,sessionId:'fixture-session-2',targetId:TARGET,agent:'codex' as const}];
 expect(recoveredPendingLaunch(launches,new Set())).toEqual({id:'launch-recover-2',targetId:TARGET,agent:'codex',receipt:launches[0]!});
 const store=new Map<string,string>();const st={getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}};
 writePendingLaunch(st,pendingLaunchKey('scope'),recoveredPendingLaunch(launches,new Set()));
 expect(readPendingLaunch(st,pendingLaunchKey('scope'))).toMatchObject({targetId:TARGET,agent:'codex'});
 // A legacy record without a target (written before receipts named it) still reads and stays fail-closed.
 writePendingLaunch(st,pendingLaunchKey('scope'),{id:'launch-recover-3',targetId:null,agent:null,receipt:null});
 expect(readPendingLaunch(st,pendingLaunchKey('scope'))?.targetId).toBeNull();
 for(let i=0;i<70;i++)rememberDismissedSubmission(storage,'bounded-dismissed-'+i);
 expect(readDismissedSubmissions(storage).size).toBe(64);
 data.set('agentstoz:dismissed-submissions:v1','not json');expect(readDismissedSubmissions(storage).size).toBe(0);
});

test('an old client never sees a sixth receipt key: status and recent within a session carry no sessionId',async()=>{
 const f=fixture();
 const session=(await f.perform({operation:'start',targetId:TARGET,agent:'hermes',cols:80,rows:24})).session!;
 await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'begin',id:'held-for-status',bytes:6,digest:submissionDigest(new TextEncoder().encode('later\r')),chunks:1}});
 const status=await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'status',id:'held-for-status'}});
 expect(Object.keys(status).sort()).toEqual(['submission']);expect(Object.keys(status.submission!)).toHaveLength(5);
 const recent=await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'recent'}});
 expect(recent.submissions!.every(r=>Object.keys(r).length===5)).toBe(true);
 // The launch scope never leaks into a session's recent list, nor a session's receipt into the launch list.
 await f.perform({operation:'submission',submission:single('separate launch\r','separate-launch')});
 expect((await f.perform({operation:'submission',sessionId:session.id,submission:{phase:'recent'}})).submissions!.map(r=>r.id)).toEqual(['held-for-status']);
 expect((await f.perform({operation:'submission',submission:{phase:'recent'}})).submissions).toEqual([]);
});

test('a launch the host refuses before the spawn fence is settled as rejected: no recent row, a replay never spawns',async()=>{
 // Reviewer probe: hermes is not installed (no absolute executable). Nothing was started, so the receipt must say so.
 const f=fixture({executable:'hermes'});
 await expect(f.perform({operation:'submission',submission:single('needs hermes\r','missing-cli')})).rejects.toThrow('hermes CLI가 설치되어 있지 않습니다.');
 const status=await f.perform({operation:'submission',submission:{phase:'status',id:'missing-cli'}});
 expect(status.submission).toMatchObject({state:'rejected',targetId:TARGET,agent:'hermes'});
 expect(status.session).toBeUndefined();
 expect((await f.perform({operation:'submission',submission:{phase:'recent'}})).submissions).toEqual([]);
 // A replay of the same request returns the definitive receipt and never starts anything.
 expect((await f.perform({operation:'submission',submission:single('needs hermes\r','missing-cli')})).submission?.state).toBe('rejected');
 expect(f.spawns).toHaveLength(0);
});

test('launch receipts name their target and AI; the receipt normalizer requires both beside the session id',async()=>{
 const f=fixture();
 const sent=await f.perform({operation:'submission',submission:single('named launch\r','named-launch',{...launch,agent:'codex'})});
 const receipt=normalizeSubmissionReceipt(sent.submission);
 expect(receipt).toMatchObject({state:'written',targetId:TARGET,agent:'codex'});
 expect(Object.keys(receipt).sort()).toEqual(['agent','epoch','id','revision','sessionId','state','storeId','targetId']);
 const {targetId:_t,agent:_a,...sixKeys}=receipt;
 expect(()=>normalizeSubmissionReceipt(sixKeys)).toThrow();
 expect(()=>normalizeSubmissionReceipt({...receipt,agent:'shell'})).toThrow();
 expect(()=>normalizeSubmissionReceipt({...receipt,targetId:'../x'})).toThrow();
 // Without a session id it is an ordinary receipt and must stay five keys.
 const {sessionId:_s,...noSession}=receipt;
 expect(()=>normalizeSubmissionReceipt(noSession)).toThrow();
});

test('recent offers only receipts that could have started: a held (pre-restart) or expired prepare is not listed',async()=>{
 const f=fixture();
 const bytes=new TextEncoder().encode('crash\r');
 const begin=await f.perform({operation:'submission',submission:{phase:'begin',id:'held-launch',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1,launch}});
 expect(begin.submission?.state).toBe('prepared');
 // While its assembly is live (this boot, in flight) it is still unsettled for this owner.
 expect((await f.perform({operation:'submission',submission:{phase:'recent'}})).submissions!.map(r=>r.id)).toEqual(['held-launch']);
 f.reopen();
 expect((await f.perform({operation:'submission',submission:{phase:'status',id:'held-launch'}})).submission?.state).toBe('held');
 expect((await f.perform({operation:'submission',submission:{phase:'recent'}})).submissions).toEqual([]);
 // A launch whose assembly expires (the client vanished between begin and commit) can never start: rejected.
 const {WorkroomSubmissions}=await import('../src/workroomSubmissions');
 const {WORKROOM_LAUNCH_SCOPE}=await import('../src/workroomSubmissionProtocol');
 let now=0;const manager=new WorkroomSubmissions(()=>f.store,()=>now,1000);cleanups.push(()=>manager.close());
 const context={owner:'expiring-owner',sessionId:'expiring-session',targetId:TARGET,binding:'b'.repeat(64),revision:0,scope:WORKROOM_LAUNCH_SCOPE,agent:'hermes' as const};
 await manager.perform({phase:'begin',id:'expiring-begin',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1,launch},context,[],async()=>{});
 expect(manager.recent('expiring-owner',WORKROOM_LAUNCH_SCOPE).map(r=>r.receipt.state)).toEqual(['prepared']);
 now=5000;
 expect(manager.recent('expiring-owner',WORKROOM_LAUNCH_SCOPE)).toEqual([]);
 expect(manager.status('expiring-begin',context).receipt.state).toBe('rejected');
 // A session close releases its assemblies the same way.
 await manager.perform({phase:'begin',id:'released-begin',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1,launch},context,[],async()=>{});
 manager.release(context.sessionId);
 expect(manager.status('released-begin',context).receipt.state).toBe('rejected');
 // An input submission keeps its prepared receipt (its existing contract), but a dead one is not offered by `recent`.
 const input={owner:'expiring-owner',sessionId:'input-session',targetId:TARGET,binding:'b'.repeat(64),revision:0};
 await manager.perform({phase:'begin',id:'input-expiring',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1},input,[],async()=>{});
 expect(manager.recent('expiring-owner','input-session').map(r=>r.receipt.id)).toEqual(['input-expiring']);
 now=10_000;
 expect(manager.recent('expiring-owner','input-session')).toEqual([]);
 expect(manager.status('input-expiring',input).receipt.state).toBe('prepared');
});

test('a duplicate commit while the first is writing is refused without touching the first',async()=>{
 const f=fixture();
 const {WorkroomSubmissions}=await import('../src/workroomSubmissions');
 const manager=new WorkroomSubmissions(()=>f.store);cleanups.push(()=>manager.close());
 const context={owner:'dup-owner',sessionId:'dup-session',targetId:TARGET,binding:'c'.repeat(64),revision:0};
 const bytes=new TextEncoder().encode('once\r');
 const begun=await manager.perform({phase:'begin',id:'dup-commit',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1,firstData:Buffer.from(bytes).toString('base64')},context,[],async()=>{});
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let writes=0;
 const write=async(_t:string,start:()=>void)=>{writes++;await gate;start();};
 const first=manager.perform({phase:'commit',id:'dup-commit',epoch:begun.epoch},context,[],write);
 await Promise.resolve();
 await expect(manager.perform({phase:'commit',id:'dup-commit',epoch:begun.epoch},context,[],async()=>{throw Error('fixture: a duplicate must not reach the writer');})).rejects.toThrow('처리하고');
 release();
 expect((await first).state).toBe('written');expect(writes).toBe(1);
});

test('a launch refused because the path could not parse it (an older forwarding Mac) falls back; after an answer it does not',async()=>{
 const invalid=Object.assign(new Error('터미널 요청 형식이 올바르지 않습니다.'),{code:'TERMINAL_REQUEST_INVALID'});
 for(const error of [invalid,new Error('터미널 세션 ID가 올바르지 않습니다.'),new Error('허용되지 않은 터미널 요청입니다.')])
  await expect(submitWorkroomDraft({id:'old-forwarder',launch,text:'hello\r',prepared:()=>{},request:async()=>{throw error;}})).rejects.toBeInstanceOf(WorkroomSubmissionUnsupportedError);
 // The same refusal of an ordinary submission keeps its old meaning (no silent switch to raw input).
 await expect(submitWorkroomDraft({id:'old-forwarder-2',sessionId:'fixture-session-1',text:'hello\r',prepared:()=>{},request:async()=>{throw invalid;}})).rejects.not.toBeInstanceOf(WorkroomSubmissionUnsupportedError);
 // Once a receipt came back the host has the request: any later error is an unknown outcome, never "unsupported".
 const text='가'.repeat(2000)+'\r';let calls=0;
 const receipt={id:'answered-launch',storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:'prepared',sessionId:'fixture-session-9',targetId:TARGET,agent:'hermes'};
 await expect(submitWorkroomDraft({id:'answered-launch',launch,text,prepared:()=>{},request:async()=>{if(calls++===0)return {submission:receipt as never};throw invalid;}})).rejects.not.toBeInstanceOf(WorkroomSubmissionUnsupportedError);
});

test('receipt states are shown in Korean words, never as raw state names',()=>{
 for(const state of ['prepared','write_started','written','unknown','rejected','held'] as const){
  const label=submissionStateLabel(state);
  expect(label).not.toMatch(/[a-z_]{4,}/);expect(label.length).toBeGreaterThan(1);
 }
 expect(submissionStateLabel('unknown')).toContain('확인');
});

test('through the remote gateway a launch receipt names the phone\'s control id, never the Mac\'s runtime target',async()=>{
 const f=fixture();
 f.service.setRemoteAccess('internet:phone',true);
 const gateway=createAiTerminalRemoteGateway({service:f.service,active:()=>true,resolve:async()=>[{controlId:'control-alpha',runtimeTargetId:TARGET}]});
 const call=(r:Omit<AiTerminalRequest,'requestId'>)=>gateway({...r,requestId:crypto.randomUUID()} as AiTerminalRequest,[],'internet:phone');
 const sent=await call({operation:'submission',submission:single('from the phone\r','phone-launch',{...launch,targetId:'control-alpha'})});
 expect(sent.submission).toMatchObject({state:'written',targetId:'control-alpha',agent:'hermes'});
 expect(sent.session?.targetId).toBe('control-alpha');
 const status=await call({operation:'submission',submission:{phase:'status',id:'phone-launch'}});
 expect(status.submission?.targetId).toBe('control-alpha');
 // An unsettled one listed by `recent` is mapped the same way.
 const bytes=new TextEncoder().encode('pending\r');
 await call({operation:'submission',submission:{phase:'begin',id:'phone-pending',bytes:bytes.length,digest:submissionDigest(bytes),chunks:1,launch:{...launch,targetId:'control-alpha'}}});
 const recent=normalizeAiTerminalResponse(await call({operation:'submission',submission:{phase:'recent'}}));
 expect(recent.submissions!.map(r=>[r.id,r.targetId])).toEqual([['phone-pending','control-alpha']]);
 expect(JSON.stringify([sent,status,recent])).not.toContain(TARGET);
});

// Review 2026-10-15 (finding 1): a scope held one launch record, so a launch of another target overwrote, and then on
// success deleted, an earlier launch whose outcome was unknown. Records are now kept per launch id.
test('pending launch records are kept per launch: another target never erases an unsettled one',async()=>{

 const data=new Map<string,string>();const st={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);},removeItem:(k:string)=>{data.delete(k);}};
 const key=pendingLaunchKey('scope');
 const a={id:'launch-target-a',targetId:TARGET,agent:'codex' as const,receipt:null};
 const b={id:'launch-target-b',targetId:OTHER,agent:'codex' as const,receipt:null};
 expect(readPendingLaunches(st,key)).toEqual([]);
 // A single record written by the previous release still reads.
 writePendingLaunch(st,key,a);expect(readPendingLaunches(st,key)).toEqual([a]);
 writePendingLaunches(st,key,withPendingLaunch(readPendingLaunches(st,key),b.id,b));
 expect(readPendingLaunches(st,key)).toEqual([a,b]);
 // B settles: only B's entry goes.
 writePendingLaunches(st,key,withPendingLaunch(readPendingLaunches(st,key),b.id,null));
 expect(readPendingLaunches(st,key)).toEqual([a]);
 // One entry is stored in the single-record shape, so a page of the previous release still reads it.
 expect(readPendingLaunch(st,key)).toEqual(a);
 // Updating A's receipt keeps its place; removing an id that is not there changes nothing.
 const receipt={id:a.id,storeId:'fixture-store',epoch:'fixture-epoch',revision:0,state:'unknown' as const,sessionId:'fixture-session-1',targetId:TARGET,agent:'codex' as const};
 expect(withPendingLaunch([a,b],a.id,{...a,receipt})).toEqual([{...a,receipt},b]);
 expect(withPendingLaunch([a],'launch-absent-1',null)).toEqual([a]);
 // Blocking: the same target and AI, or a record that names none.
 expect(blockingPendingLaunch([a,b],TARGET,'codex')).toEqual(a);
 expect(blockingPendingLaunch([a,b],TARGET,'claude')).toBeNull();
 expect(blockingPendingLaunch([{id:'launch-legacy-1',targetId:null,agent:null,receipt:null}],TARGET,'claude')?.id).toBe('launch-legacy-1');
 // Bounded: past the limit a new launch is refused instead of dropping an unsettled one.
 let many:any[]=[];for(let i=0;i<PENDING_LAUNCH_LIMIT;i++)many=withPendingLaunch(many,'launch-many-'+i,{id:'launch-many-'+i,targetId:TARGET,agent:'codex',receipt:null});
 expect(()=>withPendingLaunch(many,'launch-one-more',{id:'launch-one-more',targetId:OTHER,agent:'codex',receipt:null})).toThrow();
 // A malformed list is unreadable (fail-closed), as a malformed single record is.
 data.set(key,JSON.stringify([a,{...b,prompt:'secret'}]));expect(()=>readPendingLaunches(st,key)).toThrow();
 data.set(key,JSON.stringify([a,a]));expect(()=>readPendingLaunches(st,key)).toThrow();
 data.set(key,'[]');expect(()=>readPendingLaunches(st,key)).toThrow();
});

// Integration review 2026-10-15 (A1). Choosing another session clears the `@` chip, and the route-keyed protection of an
// uncertain launch used to depend on that chip: the composer (or an `@` that resolves to the current session) could then
// type the same handoff into the very session that launch may have opened. The guard keys on the session being written.
test('an uncertain @ launch refuses the same draft into a session of its target and AI, whatever the chip says',()=>{
 const entries=new Map([['L1',{draft:'deploy it',targetId:'t-x',deviceId:'',agent:'codex'}],['L2',{draft:'other',targetId:'t-y',deviceId:'dev-2',agent:'claude'}]]);
 expect(uncertainRouteLaunchFor(entries,{draft:'deploy it',targetId:'t-x',deviceId:'',agent:'codex'})).toBe('L1');
 // Another draft, target, AI or device is a different request and goes as before.
 expect(uncertainRouteLaunchFor(entries,{draft:'deploy it!',targetId:'t-x',deviceId:'',agent:'codex'})).toBeNull();
 expect(uncertainRouteLaunchFor(entries,{draft:'deploy it',targetId:'t-z',deviceId:'',agent:'codex'})).toBeNull();
 expect(uncertainRouteLaunchFor(entries,{draft:'deploy it',targetId:'t-x',deviceId:'',agent:'claude'})).toBeNull();
 expect(uncertainRouteLaunchFor(entries,{draft:'other',targetId:'t-y',deviceId:'',agent:'claude'})).toBeNull();
 expect(uncertainRouteLaunchFor(entries,{draft:'other',targetId:'t-y',deviceId:'dev-2',agent:'claude'})).toBe('L2');
});

test('a launch settled as written clears its draft even after the chip was cleared, but not one re-aimed elsewhere',()=>{
 const routed={draft:'deploy it',targetId:'t-x',deviceId:'',agent:'codex'};
 // The chip still names the launch target: draft and chip go (unchanged behaviour).
 expect(routeDraftClearsOnSettle(routed,{draft:'deploy it',targetId:'t-x',deviceId:''})).toEqual({clearDraft:true,clearChip:true});
 // A session switch cleared the chip: the draft that would repeat the launch still goes.
 expect(routeDraftClearsOnSettle(routed,{draft:'deploy it',targetId:'',deviceId:''})).toEqual({clearDraft:true,clearChip:false});
 // The user re-aimed the same text at another target: that is their new request, kept.
 expect(routeDraftClearsOnSettle(routed,{draft:'deploy it',targetId:'t-y',deviceId:''})).toEqual({clearDraft:false,clearChip:false});
 expect(routeDraftClearsOnSettle(routed,{draft:'deploy it',targetId:'t-x',deviceId:'dev-2'})).toEqual({clearDraft:false,clearChip:false});
 // An edited draft is the user's, kept.
 expect(routeDraftClearsOnSettle(routed,{draft:'deploy it now',targetId:'',deviceId:''})).toEqual({clearDraft:false,clearChip:false});
});

// w4 L2: with site data blocked the sessionStorage getter throws. The panel's mount used to read that as an unreadable
// launch record (targetId null) and refuse every start until the user dismissed a banner. Storage that cannot be used at
// all is not a record: the panel cannot keep launch records there, so it starts plainly and says so once. A record that
// is there but corrupt stays a block.
test('blocked storage is no storage, not an unreadable launch record; a corrupt record still blocks',()=>{
 const blocked=()=>{throw new Error('SecurityError: The operation is insecure.');};
 expect(usableSessionStorage(blocked as never)).toBeNull();
 const refusesWrites={getItem:()=>null,setItem:()=>{throw new Error('QuotaExceededError');},removeItem:()=>{},key:()=>null,length:0,clear:()=>{}} as unknown as Storage;
 expect(usableSessionStorage(()=>refusesWrites)).toBeNull();
 const memory=pageMemoryStorage();
 expect(usableSessionStorage(()=>memory)).toBe(memory);
 // The probe leaves nothing behind.
 expect(memory.length).toBe(0);
 expect(pendingLaunchesOnLoad(null,pendingLaunchKey('scope'))).toEqual({list:[],storageUnusable:true});
 expect(pendingLaunchesOnLoad(memory,pendingLaunchKey('scope'))).toEqual({list:[],storageUnusable:false});
 memory.setItem(pendingLaunchKey('scope'),'not json');
 const corrupt=pendingLaunchesOnLoad(memory,pendingLaunchKey('scope'));
 expect(corrupt.storageUnusable).toBe(false);
 expect(corrupt.list).toEqual([{id:'unreadable-launch',targetId:null,agent:null,receipt:null}]);
 expect(blockingPendingLaunch(corrupt.list,'any-target','codex')).not.toBeNull();
 const record={id:'launch-0000001',targetId:TARGET,agent:'codex' as const,receipt:null};
 writePendingLaunches(memory,pendingLaunchKey('scope'),[record]);
 expect(pendingLaunchesOnLoad(memory,pendingLaunchKey('scope')).list).toEqual([record]);
});

test('page memory behaves as a Storage for the records the panel keeps there',()=>{
 const memory=pageMemoryStorage();
 memory.setItem('a','1');memory.setItem('b','2');
 expect(memory.length).toBe(2);expect(memory.key(0)).toBe('a');expect(memory.getItem('b')).toBe('2');
 memory.removeItem('a');expect(memory.getItem('a')).toBeNull();expect(memory.length).toBe(1);
 memory.clear();expect(memory.length).toBe(0);
});

// w4 review, finding 3: the write probe was also the gate for *reading*. Storage that is full (writes refused) but still
// readable then showed no records, so a real unsettled launch or submission stopped blocking: the start went plainly, the
// send went as raw input. Reading and creating are two questions: a readable record still blocks; the write probe decides
// only whether a new record can be kept (launch versus plain start, submission versus raw input).
test('full storage still reads its records; only blocked or unreadable storage is no storage',()=>{
 const key=pendingLaunchKey('scope'),items=new Map<string,string>();
 const record={id:'launch-0000001',targetId:TARGET,agent:'codex' as const,receipt:null};
 items.set(key,JSON.stringify(record));
 const full={get length(){return items.size;},key:()=>null,getItem:(k:string)=>items.get(k)??null,setItem:()=>{throw new Error('QuotaExceededError');},removeItem:(k:string)=>{items.delete(k);},clear:()=>{}} as unknown as Storage;
 expect(usableSessionStorage(()=>full)).toBeNull();
 expect(readableSessionStorage(()=>full)).toBe(full);
 const loaded=pendingLaunchesOnLoad(readableSessionStorage(()=>full),key,false);
 expect(loaded).toEqual({list:[record],storageUnusable:true});
 expect(blockingPendingLaunch(loaded.list,TARGET,'codex')).toEqual(record);
 // Blocked site data (the getter throws) and a store whose reads throw hold no records this page can see.
 expect(readableSessionStorage((()=>{throw new Error('SecurityError: The operation is insecure.');}) as never)).toBeNull();
 expect(readableSessionStorage(()=>({getItem(){throw new Error('blocked');}}) as unknown as Storage)).toBeNull();
 expect(pendingLaunchesOnLoad(null,key,false)).toEqual({list:[],storageUnusable:true});
 // Usable storage is reported as such, and a corrupt record in readable storage still blocks.
 const memory=pageMemoryStorage();
 expect(readableSessionStorage(()=>memory)).toBe(memory);
 memory.setItem(key,'not json');
 expect(pendingLaunchesOnLoad(memory,key,true)).toEqual({list:[{id:'unreadable-launch',targetId:null,agent:null,receipt:null}],storageUnusable:false});
});
