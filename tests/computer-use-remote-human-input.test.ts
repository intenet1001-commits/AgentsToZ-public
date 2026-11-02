/**
 * A person controlling this Mac from another device through AgentsToZ Screen goes first (DESIGN mac-to-mac SR-34, 6.7):
 * while Screen has injected that person's input within 10 s, computer use refuses an AI's input before it reaches
 * Control, in the shape of the Control bar's 「직접 하기」 — a settled refused receipt (person-has-control), not
 * dispatched, not halted, no recovery row. Observe and capture go on. A missing, malformed or old file, or Screen not
 * running, changes nothing.
 */
import {describe,expect,test} from 'bun:test';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComputerApprovalVerifier} from '../src/computerUseApproval';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {remoteCallerHost,type ComputerCallerHost} from '../src/computerUseCallerHost';
import {ComputerUseHost} from '../src/computerUseHost';
import {computerScopeApprovalBytes} from '../src/computerUseScopeApproval';
import {COMPUTER_USE_SCOPE_OPERATIONS,COMPUTER_USE_SCOPE_PERMISSIONS} from '../src/computerUseScopeProtocol';
import {ComputerUseRecovery} from '../src/computerUseRecovery';
import {ComputerUseRuntime} from '../src/computerUseRuntime';
import {ComputerUseScopeHost} from '../src/computerUseScopeHost';
import {REMOTE_HUMAN_INPUT_GUIDANCE,REMOTE_HUMAN_INPUT_WINDOW_MS,REMOTE_HUMAN_INPUT_WRITE_INTERVAL_MS,createRemoteHumanInputReader,noRemoteHumanInput,parseRemoteHumanInput,remoteHumanInputGuidance,remoteHumanInputPath,remoteHumanInputRecent,screenHelperRunning,type RemoteHumanInput,type RemoteHumanInputReader} from '../src/computerUseRemoteHumanInput';
import {testApprovalHelper} from './computer-use-test-helper';

const NOW=1_793_500_000_000;
const file=(o:Record<string,unknown>)=>JSON.stringify(o);

describe('remote person input file (AgentsToZ Screen remote-input.json)',()=>{
  test('only format 1 with a positive integer time and a short lowercase session word is read; newer keys are ignored',()=>{
    expect(parseRemoteHumanInput(file({format:1,lastInputAt:NOW,session:'phone'}))).toEqual({session:'phone',lastInputAt:NOW});
    expect(parseRemoteHumanInput(file({format:1,lastInputAt:NOW,session:'controller',seat:'b'}))).toEqual({session:'controller',lastInputAt:NOW});
    for(const bad of [file({format:2,lastInputAt:NOW,session:'phone'}),file({format:1,lastInputAt:-1,session:'phone'}),file({format:1,lastInputAt:0,session:'phone'}),
      file({format:1,lastInputAt:1.5,session:'phone'}),file({format:1,lastInputAt:String(NOW),session:'phone'}),file({format:1,lastInputAt:NOW,session:'Phone'}),
      file({format:1,lastInputAt:NOW,session:'x'.repeat(33)}),file({format:1,lastInputAt:NOW}),'[1]','null','{','',' '])
      expect(parseRemoteHumanInput(bad)).toBeNull();
  });
  test('the hold covers the coalesced write interval; far-future times still hold nothing',()=>{
    const at=(lastInputAt:number)=>remoteHumanInputRecent({session:'phone',lastInputAt},NOW);
    expect(REMOTE_HUMAN_INPUT_WINDOW_MS).toBe(10_000);
    expect(REMOTE_HUMAN_INPUT_WRITE_INTERVAL_MS).toBe(2_000);
    // Screen wrote at t=0, then coalesced an input at t=1.999 s: at t=11.998 s that input is still <10 s old.
    expect(at(NOW)).toBe(true);expect(at(NOW-10_000)).toBe(true);expect(at(NOW-11_998)).toBe(true);
    expect(at(NOW-11_999)).toBe(true);expect(at(NOW-12_000)).toBe(false);
    expect(at(NOW+9_999)).toBe(true);expect(at(NOW+10_000)).toBe(false);
    const marker=readFileSync(join(import.meta.dir,'..','native/screen-control/Sources/ScreenHost/RemoteInputMarker.swift'),'utf8');
    expect(marker).toContain('public static let interval: TimeInterval = 2');
  });
  test('Screen counts as running unless pgrep cleanly says none (exit 1)',async()=>{
    const calls:string[][]=[];
    const with_=(answer:()=>Promise<{code:number}>)=>screenHelperRunning(async(f,args)=>{calls.push([f,...args]);return answer();});
    expect(await with_(async()=>({code:0}))()).toBe(true);
    expect(await with_(async()=>({code:1}))()).toBe(false);
    expect(await with_(async()=>({code:2}))()).toBe(true);
    expect(await with_(async()=>{throw Error('timed out');})()).toBe(true);
    expect(calls[0]).toEqual(['/usr/bin/pgrep','-x','AgentsToZScreen']);
  });
  test('the reader: macOS only, the file first, Screen asked only inside the window',async()=>{
    let text:string|null=file({format:1,lastInputAt:NOW-2_000,session:'phone'}),running=true,asked=0,reads=0,clock=NOW;
    const reader=(platform:NodeJS.Platform)=>createRemoteHumanInputReader({platform,now:()=>clock,readText:async()=>{reads++;return text;},screenRunning:async()=>{asked++;return running;}});
    expect(await reader('win32')()).toBeNull();expect(reads).toBe(0);
    expect(await reader('darwin')()).toEqual({session:'phone',lastInputAt:NOW-2_000});expect(asked).toBe(1);
    running=false;expect(await reader('darwin')()).toBeNull();
    running=true;clock=NOW+8_000;asked=0;expect(await reader('darwin')()).not.toBeNull();expect(asked).toBe(1);
    clock=NOW+10_000;asked=0;expect(await reader('darwin')()).toBeNull();expect(asked).toBe(0);
    clock=NOW;text=null;expect(await reader('darwin')()).toBeNull();
    text='x'.repeat(5000);expect(await reader('darwin')()).toBeNull();
    expect(await createRemoteHumanInputReader({platform:'darwin',readText:async()=>{throw Error('EACCES');},screenRunning:async()=>true})()).toBeNull();
    expect(remoteHumanInputPath('/Users/someone')).toBe('/Users/someone/Library/Application Support/AgentsToZ Screen/remote-input.json');
    expect(await noRemoteHumanInput()).toBeNull();
  });
  test('the default file read: a regular file of at most 4 KB, nothing else',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'cu-remote-input-')),path=join(dir,'remote-input.json');
    const reader=()=>createRemoteHumanInputReader({platform:'darwin',path,now:()=>NOW,screenRunning:async()=>true})();
    try{
      expect(await reader()).toBeNull();// missing
      writeFileSync(path,file({format:1,lastInputAt:NOW-1_000,session:'controller'}));
      expect(await reader()).toEqual({session:'controller',lastInputAt:NOW-1_000});
      writeFileSync(path,file({format:1,lastInputAt:NOW-1_000,session:'controller',pad:'x'.repeat(5000)}));
      expect(await reader()).toBeNull();// oversized
      rmSync(path);mkdirSync(path);
      expect(await reader()).toBeNull();// not a file
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
});

const keys=()=>{const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});const jwk=pair.publicKey.export({format:'jwk'});return {...pair,point:Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])};};
const owner={pid:912,start:'100001'},desktop={kind:'desktop' as const};
const calculator={id:'app_1',name:'Calculator',bundleId:'com.apple.calculator'};
const INPUT=['scope-click','scope-type-text','scope-key','scope-scroll','scope-drag','scope-focus-app'];

/** A whole-Mac grant on the scope host with a fake Control, and a remote person reader the test sets. `host`: the caller's. */
async function fixture(options:{host?:ComputerCallerHost;now?:()=>number;reader?:RemoteHumanInputReader}={}){
  const k=keys(),recovery=new ComputerUseRecovery(':memory:'),sent:string[]=[];let pending:any;
  const person={value:null as RemoteHumanInput|null,calls:0,fails:false};
  const channel={available:true,dispose(){},retire(_body:any){},async request(body:any):Promise<any>{sent.push(body.operation);
    if(body.operation==='scope-status')return {success:true,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],accessibility:true,screenRecording:true,secureInput:false,owner};
    if(body.operation==='scope-request-approval'){pending={...body,owner};return {success:true,state:'pending'};}
    if(body.operation==='scope-approval-status'){const payload={version:2 as const,approvalId:pending.approvalId,scope:pending.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS],caller:pending.caller,owner:pending.owner,issuedAt:Date.now(),expiresAt:pending.expiresAt};
      return {success:true,state:'approved',approval:{...payload,signature:sign('sha256',computerScopeApprovalBytes(payload),k.privateKey).toString('base64')},helperPublicKey:k.point.toString('base64')};}
    if(body.operation==='scope-open-grant')return {success:true,bound:true,grant:'b'.repeat(32),expiresAt:Date.now()+590000,scopeProtocolVersion:2,operations:[...COMPUTER_USE_SCOPE_OPERATIONS],scope:body.scope,permissions:[...COMPUTER_USE_SCOPE_PERMISSIONS]};
    if(body.operation==='scope-observe')return {success:true,snapshotId:'snap_1',scope:desktop,displays:[{id:'display_1',originX:0,originY:0,width:100,height:100,scale:2,rotation:0}],
      applications:[calculator],foreground:{applicationId:calculator.id,bundleId:calculator.bundleId,pid:500,processStart:'500001'}};
    if(body.operation==='scope-capture')return {success:true,displayId:body.displayId,mediaType:'image/jpeg',data:'AAAA',width:200,height:200,displayWidth:100,displayHeight:100,originX:0,originY:0};
    if(INPUT.includes(body.operation))return {success:true,receipt:{requestId:body.requestId,state:'confirmed'}};
    return {success:true};
  }};
  const registry=new ComputerCallerRegistry(),identity=registry.authenticate(registry.issue({sessionId:'mcp_test_session',lane:'connection'}))!;
  const scope=new ComputerUseScopeHost(channel as any,recovery,options.now??Date.now,async()=>options.host??{state:'known',bundleIds:['com.openai.codex']},undefined,
    async()=>{person.calls++;if(person.fails)throw Error('unreadable');return options.reader?options.reader():person.value;});
  await scope.requestApproval(identity,'conn_test',desktop,'test');
  const {grant,epoch}=(await scope.agentStatus(identity)).grants[0]!;
  const look=async()=>{const obs=await scope.agent(identity,{operation:'scope-observe',grant,epoch,capture:true});return {grant,epoch,observationId:obs.observationId};};
  return {scope,identity,recovery,sent,person,grant,epoch,look,sentInput:()=>sent.filter(op=>INPUT.includes(op)),close(){scope.dispose();recovery.close();}};
}

describe('computer use while a person controls this Mac from another device',()=>{
  test('a coalesced late input still refuses the AI, then releases it at the conservative boundary',async()=>{
    // The marker was written at NOW. Input at NOW+1.999s was coalesced, so it left the same file.
    let clock=NOW+11_998;
    const reader=createRemoteHumanInputReader({platform:'darwin',now:()=>clock,
      readText:async()=>file({format:1,lastInputAt:NOW,session:'controller'}),screenRunning:async()=>true});
    const f=await fixture({reader});try{
      const denied=await f.scope.agent(f.identity,{operation:'scope-key',...(await f.look()),requestId:'request_coalesced_denied',key:'Enter',modifiers:[]});
      expect(denied.receipt).toEqual({requestId:'request_coalesced_denied',state:'refused',reason:'person-has-control'});
      expect(f.sentInput()).toHaveLength(0);expect(f.recovery.pendingScope()).toHaveLength(0);
      clock=NOW+12_000;
      const sent=await f.scope.agent(f.identity,{operation:'scope-key',...(await f.look()),requestId:'request_coalesced_after',key:'Enter',modifiers:[]});
      expect(sent.receipt.state).toBe('confirmed');expect(f.sentInput()).toEqual(['scope-key']);
    }finally{f.close();}
  });
  test('input is refused before it reaches Control: a settled person-has-control receipt, no halt, no recovery row',async()=>{
    const f=await fixture();try{
      f.person.value={session:'phone',lastInputAt:Date.now()-1_000};
      const from=await f.look();
      const refused=await f.scope.agent(f.identity,{operation:'scope-click',...from,displayId:'display_1',requestId:'request_person_click',x:10,y:10,button:'left',clickCount:1});
      expect(refused).toEqual({success:true,receipt:{requestId:'request_person_click',state:'refused',reason:'person-has-control'},owner:'person',guidance:REMOTE_HUMAN_INPUT_GUIDANCE});
      expect(f.sentInput()).toHaveLength(0);
      expect(f.recovery.pendingScope()).toHaveLength(0);
      const grant=(await f.scope.agentStatus(f.identity)).grants[0]!;
      expect(grant.halted).toBe(false);expect(grant.owner).toBe('agent');expect(grant.epoch).toBe(f.epoch);
      // The observation was used up, and the same request ID keeps its settled answer even after the person stops.
      await expect(f.scope.agent(f.identity,{operation:'scope-key',...from,requestId:'request_person_key',key:'Enter',modifiers:[]})).rejects.toThrow('새로 관찰하세요');
      f.person.value=null;
      expect((await f.scope.agent(f.identity,{operation:'scope-click',...from,displayId:'display_1',requestId:'request_person_click',x:10,y:10,button:'left',clickCount:1})).receipt)
        .toEqual({requestId:'request_person_click',state:'refused',reason:'person-has-control'});
      expect(f.sentInput()).toHaveLength(0);
      // Every kind of input is held the same way.
      f.person.value={session:'controller',lastInputAt:Date.now()};
      const bodies=[
        {operation:'scope-type-text',text:'hello'},{operation:'scope-key',key:'Enter',modifiers:[]},{operation:'scope-focus-app',applicationId:calculator.id},
        {operation:'scope-scroll',displayId:'display_1',x:1,y:1,deltaX:0,deltaY:120},{operation:'scope-drag',displayId:'display_1',x:1,y:1,endX:5,endY:5},
      ];
      for(const [i,body] of bodies.entries())expect((await f.scope.agent(f.identity,{...body,...(await f.look()),requestId:`request_person_${i}`})).receipt.reason).toBe('person-has-control');
      expect(f.sentInput()).toHaveLength(0);expect(f.recovery.pendingScope()).toHaveLength(0);
    }finally{f.close();}
  });
  test('observe and capture go on, and the file is not even read for them',async()=>{
    const f=await fixture();try{
      f.person.value={session:'phone',lastInputAt:Date.now()};
      const from=await f.look();
      const image=await f.scope.agent(f.identity,{operation:'scope-capture',...from,displayId:'display_1'});
      expect(image.image.mediaType).toBe('image/jpeg');
      expect(f.person.calls).toBe(0);
      expect(f.sent.filter(op=>op==='scope-observe'||op==='scope-capture')).toEqual(['scope-observe','scope-capture','scope-capture']);
    }finally{f.close();}
  });
  test('no recent input, or a reader that fails, changes nothing: the action goes to Control as today',async()=>{
    const f=await fixture();try{
      expect((await f.scope.agent(f.identity,{operation:'scope-type-text',...(await f.look()),requestId:'request_free_text',text:'1+2'})).receipt.state).toBe('confirmed');
      f.person.fails=true;
      expect((await f.scope.agent(f.identity,{operation:'scope-key',...(await f.look()),requestId:'request_free_key',key:'Enter',modifiers:[]})).receipt.state).toBe('confirmed');
      expect(f.sentInput()).toEqual(['scope-type-text','scope-key']);expect(f.person.calls).toBe(2);
    }finally{f.close();}
  });
  test('the guidance says when to try again (status never shows the hold) and names the Mac from the reader\'s side',async()=>{
    // An AI on another Mac reads 「그 Mac」; this Mac's AI reads 「이 Mac」; neither is told to poll status for it.
    const f=await fixture({host:remoteCallerHost('3a9d0c1e-5b7f-4e2a-9c3d-1f2e3d4c5b6a','1호')});try{
      f.person.value={session:'phone',lastInputAt:Date.now()};
      const held=await f.scope.agent(f.identity,{operation:'scope-type-text',...(await f.look()),requestId:'request_remote_person',text:'hi'});
      expect(held.receipt).toEqual({requestId:'request_remote_person',state:'refused',reason:'person-has-control'});
      expect(held.guidance).toBe(remoteHumanInputGuidance({remoteCaller:true}));expect(held.guidance).toContain('그 Mac을 조작');
      expect(f.sentInput()).toHaveLength(0);
    }finally{f.close();}
    for(const text of [REMOTE_HUMAN_INPUT_GUIDANCE,remoteHumanInputGuidance({remoteCaller:true}),remoteHumanInputGuidance({window:true})]){
      expect(text).toContain('12초 뒤');expect(text).toContain('observe');expect(text).toContain('status에는 이 상태가 나오지 않');
      expect(text).not.toContain('30초마다');
    }
    expect(REMOTE_HUMAN_INPUT_GUIDANCE).toContain('이 Mac을 조작');
    expect(remoteHumanInputGuidance({window:true})).not.toContain('request-access');
  });
  test('a held input does not count as use: an idle grant stays idle for the hand-over',async()=>{
    let clock=Date.now();
    const f=await fixture({now:()=>clock});try{
      const from=await f.look();const used=f.scope.grantHolders()[0]!.usedAt;expect(used).toBe(clock);
      clock+=5_000;f.person.value={session:'controller',lastInputAt:clock-1_000};
      expect((await f.scope.agent(f.identity,{operation:'scope-key',...from,requestId:'request_idle_key',key:'Enter',modifiers:[]})).receipt.reason).toBe('person-has-control');
      expect(f.scope.grantHolders()[0]!.usedAt).toBe(used);
      // What the AI does do (an observation) is use.
      clock+=1_000;await f.look();expect(f.scope.grantHolders()[0]!.usedAt).toBe(clock);
    }finally{f.close();}
  });
  test('the runtime hands one reader to the scope and one-window hosts; without one nothing is read, and the sidecar passes Screen\'s',()=>{
    const recovery=new ComputerUseRecovery(':memory:'),channel={available:false,dispose(){},async request(){return {success:false,notDispatched:true};}};
    const reader=async()=>null;
    const given=new ComputerUseRuntime(channel,recovery,{remoteHumanInput:reader}),plain=new ComputerUseRuntime(channel,recovery);
    try{
      expect((given as any).scope.remoteHumanInput).toBe(reader);expect((given as any).host.deps.remoteHumanInput).toBe(reader);
      // A runtime built without a reader (every test) never reads this Mac's Screen file or asks pgrep.
      expect((plain as any).scope.remoteHumanInput).toBe(noRemoteHumanInput);expect((plain as any).host.deps.remoteHumanInput).toBe(noRemoteHumanInput);
    }finally{given.dispose();plain.dispose();recovery.close();}
    // The production runtime is the sidecar's, which passes the real reader.
    const server=readFileSync(join(import.meta.dir,'..','api-server.ts'),'utf8');
    expect(server).toContain("import {createRemoteHumanInputReader} from './src/computerUseRemoteHumanInput';");
    expect(server).toMatch(/new ComputerUseRuntime\([\s\S]{0,600}remoteHumanInput:createRemoteHumanInputReader\(\)/);
  });
});

/** The one-window tool (agentstoz_use_computer, src/computerUseHost.ts) with a fake worker and a person reader the test sets. */
async function windowFixture(){
  const person={value:null as RemoteHumanInput|null,calls:0},calls:string[]=[];
  const target={bundleId:'com.example.editor',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'9007199254740995',windowId:321};
  const helper=testApprovalHelper(),recovery=new ComputerUseRecovery(':memory:');
  const host=new ComputerUseHost({approvals:new ComputerApprovalVerifier({helperPublicKey:helper.publicKey}),recovery,remoteHumanInput:async()=>{person.calls++;return person.value;},
    createWorker:async()=>({close(){},supports:()=>true,async request(body){calls.push(String(body.operation));
      if(body.operation==='bind')return {success:true,bound:true,protocolVersion:2};
      if(body.operation==='observe')return {success:true,snapshotId:'ps1_exact',elements:[{id:'elem_1',role:'button',label:'Send',value:'',enabled:true,settable:true}],truncated:false};
      if(body.operation==='capture')return {success:true,mediaType:'image/jpeg',data:'AAAA',width:10,height:10,windowWidth:100,windowHeight:100};
      return {success:true,halted:false,humanStatePreserved:true,outcome:{state:'confirmed_change'}};
    }})});
  const callers=new ComputerCallerRegistry(),leader=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
  const raw=await host.grant(helper.approve(host.requestApproval(leader,target,'Send the draft'))),g={grant:raw.grant,epoch:raw.epoch};
  const look=async()=>(await host.agent(leader,{...g,operation:'observe'})).observationId as string;
  return {host,leader,g,person,recovery,look,sentInput:()=>calls.filter(op=>['press','set-value','click'].includes(op)),close(){host.dispose();recovery.close();}};
}
describe('the one-window tool while a person controls this Mac from another device',()=>{
  test('press, set-value and click are held before the worker: a settled refused receipt, no ledger row, no halt',async()=>{
    const f=await windowFixture();try{
      f.person.value={session:'phone',lastInputAt:Date.now()};
      const observationId=await f.look();
      const held=await f.host.agent(f.leader,{...f.g,operation:'press',requestId:'press_person_01',observationId,element:'elem_1'});
      expect(held).toEqual({success:true,receipt:{requestId:'press_person_01',state:'refused',reason:'person-has-control'},guidance:remoteHumanInputGuidance({window:true})});
      expect(f.sentInput()).toHaveLength(0);expect(f.recovery.unresolved('com.example.editor')).toHaveLength(0);
      expect(f.host.list()[0]).toMatchObject({halted:false,epoch:f.g.epoch});
      // The observation was used up; the same ID keeps its answer after the person stops; a receipt reads it too.
      await expect(f.host.agent(f.leader,{...f.g,operation:'press',requestId:'press_person_02',observationId,element:'elem_1'})).rejects.toThrow('새로 관찰');
      f.person.value=null;
      expect((await f.host.agent(f.leader,{...f.g,operation:'press',requestId:'press_person_01',observationId,element:'elem_1'})).receipt).toEqual({requestId:'press_person_01',state:'refused',reason:'person-has-control'});
      expect((await f.host.agent(f.leader,{...f.g,operation:'receipt',requestId:'press_person_01'})).receipt.reason).toBe('person-has-control');
      f.person.value={session:'controller',lastInputAt:Date.now()};
      expect((await f.host.agent(f.leader,{...f.g,operation:'set-value',requestId:'set_person_01',observationId:await f.look(),element:'elem_1',value:'hello'})).receipt.reason).toBe('person-has-control');
      const shot=await f.look();await f.host.agent(f.leader,{...f.g,operation:'capture',observationId:shot});
      expect((await f.host.agent(f.leader,{...f.g,operation:'click',requestId:'click_person_01',observationId:shot,x:5,y:5})).receipt.reason).toBe('person-has-control');
      expect(f.sentInput()).toHaveLength(0);
      // Nobody at the other device any more: the next action goes to the worker as today.
      f.person.value=null;
      expect((await f.host.agent(f.leader,{...f.g,operation:'press',requestId:'press_free_01',observationId:await f.look(),element:'elem_1'})).receipt.state).toBe('confirmed');
      expect(f.sentInput()).toEqual(['press']);
    }finally{f.close();}
  });
  test('observe and capture never read the file',async()=>{
    const f=await windowFixture();try{
      f.person.value={session:'phone',lastInputAt:Date.now()};
      const observationId=await f.look();
      expect((await f.host.agent(f.leader,{...f.g,operation:'capture',observationId})).image.mediaType).toBe('image/jpeg');
      expect(f.person.calls).toBe(0);
    }finally{f.close();}
  });
});
