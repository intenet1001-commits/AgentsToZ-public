import {describe,expect,test} from 'bun:test';
import {type ComputerWorker} from '../src/computerUseHost';
import {ComputerCallerRegistry} from '../src/computerUseCaller';
import {parseComputerAgentRequest,parseComputerTarget} from '../src/computerUseProtocol';
import {testComputerUseHost} from './computer-use-test-helper';

const target={bundleId:'com.example.editor',teamId:'ABCDEFGHIJ',codeHash:'ab'.repeat(20),pid:100,processStart:'9007199254740995',windowId:321};
const callers=new ComputerCallerRegistry();
const caller=callers.authenticate(callers.issue({sessionId:'workroom_session_a',lane:'leader'}))!;
function fixture() {
  let now=1000, calls:Record<string,unknown>[]=[], closed=0;
  let action:(body:Record<string,unknown>)=>Promise<Record<string,any>>=async()=>({success:true,humanStatePreserved:true,outcome:{state:'confirmed_change'}});
  const workers:ComputerWorker[]=[];
  const {host,grantFor}=testComputerUseHost({now:()=>now,createWorker:async()=>{
    const w:ComputerWorker={close(){closed++;},async request(body){calls.push(body);
      if(body.operation==='bind')return {success:true,bound:true,protocolVersion:2};
      if(body.operation==='observe')return {success:true,snapshotId:'ps1_exact',elements:[{id:'elem_1',role:'textField',label:'Editor',value:'',enabled:true,settable:true}],truncated:false};
      return action(body);
    }};workers.push(w);return w;
  }});
  return {host,grantFor,agent:(v:unknown)=>host.agent(caller,v),calls,workers,closed:()=>closed,setNow:(v:number)=>{now=v;},setAction:(fn:typeof action)=>{action=fn;}};
}
async function create(f:ReturnType<typeof fixture>,t=target) {
  const raw=await f.grantFor(caller,t,'Hermes UX task');
  const grant={grant:raw.grant,epoch:raw.epoch};
  const obs=await f.agent({...grant,operation:'observe'});
  return {grant,obs,id:raw.id};
}
const mutation=(g:any,o:any,id='mutation_0001')=>({...g,operation:'set-value',requestId:id,observationId:o.observationId,element:'elem_1',value:'한글 OK'});
describe('human-granted background computer use',()=>{
  test('no token, Screen token, extra foreground flags and arbitrary command are refused before dispatch',async()=>{
    const f=fixture();try {
      for(const v of [{operation:'observe',epoch:1},{grant:'screen-pairing-token',epoch:1,operation:'observe'},
        {grant:'ab'.repeat(32),epoch:1,operation:'observe',foreground:true},
        {grant:'ab'.repeat(32),epoch:1,operation:'shell',command:'open'}])await expect(f.agent(v)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }finally{f.host.dispose();}
  });
  test('an approved exact window can be observed and changed once, without exposing its token in inventory',async()=>{
    const f=fixture();try {
      const {grant,obs}=await create(f);const req=mutation(grant,obs);
      expect((await f.agent(req)).receipt.state).toBe('confirmed');
      expect((await f.agent(req)).receipt.state).toBe('confirmed');
      expect(f.calls.filter(c=>c.operation==='set-value')).toHaveLength(1);
      expect(JSON.stringify(f.host.list())).not.toContain(grant.grant);
      expect(JSON.stringify(f.host.list())).not.toContain('한글 OK');
      await expect(f.agent({...req,value:'different'})).rejects.toThrow('내용');
    }finally{f.host.dispose();}
  });
  test('stale observation, stale epoch, unknown element and extra fields cannot mutate',async()=>{
    const f=fixture();try {
      const {grant,obs}=await create(f);const r=mutation(grant,obs);
      for(const req of [{...r,epoch:2},{...r,element:'not_observed'},{...r,observationId:'other_observation'},{...r,foreground:true}])
        await expect(f.agent(req)).rejects.toThrow();
      f.setNow(16001);await expect(f.agent(r)).rejects.toThrow();
      expect(f.calls.filter(c=>c.operation==='set-value')).toHaveLength(0);
    }finally{f.host.dispose();}
  });
  test('two team members sharing an app serialize without a stale queued click',async()=>{
    const f=fixture();try {
      const a=await create(f),b=await create(f,{...target,windowId:322});
      let finish!:(v:any)=>void;f.setAction(()=>new Promise(r=>{finish=r;}));
      const first=f.agent(mutation(a.grant,a.obs));
      await expect(f.agent(mutation(b.grant,b.obs,'mutation_0002'))).rejects.toThrow('진행 중');
      finish({success:true,humanStatePreserved:true,outcome:{state:'confirmed_change'}});await first;
      await expect(f.agent(mutation(b.grant,b.obs,'mutation_0002'))).rejects.toThrow('새로 관찰');
      expect(f.calls.filter(c=>c.operation==='set-value')).toHaveLength(1);
    }finally{f.host.dispose();}
  });
  test('different applications can execute independently',async()=>{
    const f=fixture();try {
      const a=await create(f),b=await create(f,{...target,pid:101});
      let finish!:(v:any)=>void;f.setAction(body=>body.value==='first'?new Promise(r=>{finish=r;}):Promise.resolve({success:true,humanStatePreserved:true,outcome:{state:'confirmed_change'}}));
      const first=f.agent({...mutation(a.grant,a.obs),value:'first'});
      expect((await f.agent(mutation(b.grant,b.obs,'mutation_0002'))).receipt.state).toBe('confirmed');
      finish({success:true,humanStatePreserved:true,outcome:{state:'confirmed_change'}});await first;
    }finally{f.host.dispose();}
  });
  test('lost reply is unknown, halts the grant and can only return its original receipt',async()=>{
    const f=fixture();try {
      const {grant,obs}=await create(f);f.setAction(async()=>{throw Error('raw credential must not escape');});
      const r=mutation(grant,obs);expect((await f.agent(r)).receipt.state).toBe('unknown');
      const receipt=await f.agent({...grant,operation:'receipt',requestId:r.requestId});
      expect(receipt.receipt.state).toBe('unknown');expect(JSON.stringify(receipt)).not.toContain('credential');
      await expect(f.agent({...grant,operation:'observe'})).rejects.toThrow();
      await expect(f.agent({...r,requestId:'new_retry_0001'})).rejects.toThrow();
      expect(f.calls.filter(c=>c.operation==='set-value')).toHaveLength(1);
    }finally{f.host.dispose();}
  });
  test('delivery accepted is not reported as task completion',async()=>{
    const f=fixture();try {
      const {grant,obs}=await create(f);f.setAction(async()=>({success:true,humanStatePreserved:true,outcome:{state:'dispatched_unverified'}}));
      expect((await f.agent(mutation(grant,obs))).receipt.state).toBe('dispatched-unverified');
    }finally{f.host.dispose();}
  });
  test('any observed human-state change halts all later input without restoring a cursor',async()=>{
    const f=fixture();try {
      const {grant,obs}=await create(f);f.setAction(async()=>({success:true,humanStatePreserved:false,outcome:{state:'confirmed_change'}}));
      expect((await f.agent(mutation(grant,obs))).receipt.state).toBe('human-takeover');
      await expect(f.agent({...grant,operation:'observe'})).rejects.toThrow();
      expect(f.calls.some(c=>['restore','focus','activate','move-pointer'].includes(String(c.operation)))).toBe(false);
    }finally{f.host.dispose();}
  });
  test('expiry and revocation close the worker; human request ends input immediately',async()=>{
    const f=fixture();try {
      const a=await create(f);f.setNow(601001);
      await expect(f.agent({...a.grant,operation:'observe'})).rejects.toThrow();
      expect(f.closed()).toBe(1);
      const b=await create(f);await f.agent({...b.grant,operation:'request-human'});
      await expect(f.agent(mutation(b.grant,b.obs))).rejects.toThrow();
      const c=await create(f);f.host.revoke(c.id);
      await expect(f.agent({...c.grant,operation:'observe'})).rejects.toThrow();
    }finally{f.host.dispose();}
  });
  test('the fixed app/process generation/window identity is mandatory',()=>{
    expect(parseComputerTarget(target).processStart).toBe('9007199254740995');
    for(const bad of [{...target,pid:0},{...target,windowId:0},{...target,processStart:9007199254740995},{...target,codeHash:''},{...target,path:'/tmp/app'}])
      expect(()=>parseComputerTarget(bad)).toThrow();
    expect(()=>parseComputerAgentRequest({grant:'ab'.repeat(32),epoch:1,operation:'press',requestId:'mutation_0001',observationId:'observe_0001',element:'elem_1',value:'hidden extra'})).toThrow();
  });
  test('grant capacity also bounds concurrent worker creation and dispose closes all workers',async()=>{
    let release!:()=>void, count=0, closed=0;
    const gate=new Promise<void>(r=>{release=r;});
    const {host,grantFor}=testComputerUseHost({createWorker:async()=>{count++;await gate;return {close(){closed++;},async request(){return {success:true,bound:true,protocolVersion:2};}};}});
    try {
      const grants=Array.from({length:8},(_,i)=>grantFor(caller,{...target,pid:100+i},'member'));
      await expect(grantFor(caller,target,'ninth')).rejects.toThrow();expect(count).toBe(8);
      release();await Promise.all(grants);host.dispose();expect(closed).toBe(8);
    }finally{release();host.dispose();}
  });
});
