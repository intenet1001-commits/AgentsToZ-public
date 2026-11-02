import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService,type AiTerminalAdmittedEffortFallback} from '../src/aiTerminalService';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';

const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const task='검증된 독립 OPS 작업의 권한 격리와 동시성 설계를 검토해 주세요';
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'admitted-ops-effort-')),setting=createWorkroomEffortSetting(root),account='acct_11111111-1111-4111-8111-111111111111';
  const state={settings:true,job:true,reads:0,fallbacks:0,spawns:0,spawnThrows:false,moveOnFallback:false,fenceRevokedByGate:false};
  const launches:{args:string[];env:Record<string,unknown>}[]=[];let entered!:()=>void,release!:()=>void;
  const refreshing=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
  const service=new AiTerminalService({effortAuto:setting,activitySampler:false,headlessScreen:false,
    resolveTarget:async()=>{if(state.moveOnFallback&&state.fallbacks)state.job=false;return{cwd:root};},executable:()=>'/fixture/codex',codexEffortModel:()=>({ok:true,model:'gpt-6.1-sol',allowed:['low','medium','high']}),
    accounts:{launch:async(_t:string,_a:string,id:string)=>({accountId:id,label:'fixture account',args:['--fixture-account'],env:{HOME:root,FIXTURE_ACCOUNT:'selected-account'}}),validateLaunch:(id:string)=>{expect(id).toBe(account);}} as never,
    spawn:(args,options:any)=>{state.spawns++;launches.push({args:[...args],env:{...options.env}});if(state.spawnThrows)throw Error('spawn outcome unknown');let end!:(v:number)=>void;const exited=new Promise<number>(r=>{end=r;});return{pid:700001,exited,kill:()=>end(143),terminal:{write:()=>0,resize(){},close(){end(0);}}} as never;},
  });
  const effortPolicy=async()=>({mode:setting.getMode!(),isAuthorized:()=>state.settings,beforeEffect:async()=>{state.reads++;entered();await gate;if(!state.settings)throw Error('original mobile episode closed');return true;}});
  const fallback:AiTerminalAdmittedEffortFallback=async()=>{state.fallbacks++;if(!state.job)throw Error('job authority revoked');return()=>state.job;};
  const request=(id=crypto.randomUUID())=>({operation:'start',requestId:id,targetId:'actual-ops-project',agent:'codex',cols:100,rows:28,prompt:task,accountId:account,bypassPermissions:false});
  const options={opsWorker:true,effortPolicy,admittedEffortFallback:fallback,launchModel:{model:'gpt-6.1-sol'}};
  cleanup.push(async()=>{release();await service.shutdown();rmSync(root,{recursive:true,force:true});});
  return{service,setting,state,launches,request,options,refreshing,release,account};
}

test('closing the original mobile episode after auto planning replans once before spawn and preserves the independently admitted OPS job',async()=>{
  const f=fixture(),id=crypto.randomUUID(),launch=f.service.perform(f.request(id),undefined,f.options);
  await f.refreshing;expect(f.state.spawns).toBe(0);f.state.settings=false;f.release();const result=await launch;
  expect(result.session?.state).toBe('running');expect(f.state.fallbacks).toBe(1);expect(f.state.spawns).toBe(1);
  const {args,env}=f.launches[0]!;expect(args.join(' ')).not.toContain('model_reasoning_effort');expect(args).toContain(task);expect(args).toContain('--fixture-account');expect(args).toContain('gpt-6.1-sol');expect(args).toContain('workspace-write');expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');expect(env.FIXTURE_ACCOUNT).toBe('selected-account');
  expect(result.session?.accountId).toBe(f.account);expect(f.setting.getMode!()).toBe('auto');
  expect(f.service.workspaceEffort({targetId:'actual-ops-project',sessionId:result.session!.id,effortModes:true,effortExtended:true}).session?.skipped).toBe('off');
  expect((await f.service.perform(f.request(id),undefined,f.options)).session?.id).toBe(result.session?.id);expect(f.state.spawns).toBe(1);expect(f.state.fallbacks).toBe(1);
});

test.each([false,true])('lost job authority (%s) never becomes a settings fallback privilege',async revokeDuringTarget=>{
  const f=fixture(),launch=f.service.perform(f.request(),undefined,f.options);await f.refreshing;f.state.settings=false;
  if(revokeDuringTarget)f.state.moveOnFallback=true;else f.state.job=false;f.release();await expect(launch).rejects.toThrow();expect(f.state.spawns).toBe(0);expect(f.state.fallbacks).toBe(1);
});

test('the independent job fence is checked inside the final spawn gate; its failure is not retried',async()=>{
  const f=fixture(),launch=f.service.perform(f.request(),undefined,{...f.options,startEffectGate:<T>(effect:()=>T)=>{f.state.job=false;return effect();}});
  await f.refreshing;f.state.settings=false;f.release();await expect(launch).rejects.toThrow('OPS 작업');expect(f.state.spawns).toBe(0);expect(f.state.fallbacks).toBe(1);
});

test.each([false,true])('ordinary Teams/control launches keep their settings refusal even if an unrelated host passes a fallback (%s)',async optionPresent=>{
  const f=fixture(),{admittedEffortFallback,...normal}=f.options,launch=f.service.perform(f.request(),undefined,{...normal,opsWorker:false,...(optionPresent?{admittedEffortFallback}:{})});
  await f.refreshing;f.state.settings=false;f.release();await expect(launch).rejects.toThrow('episode closed');expect(f.state.spawns).toBe(0);expect(f.state.fallbacks).toBe(0);
});

test.each(['recommend','off'] as const)('the existing %s policy starts once without consulting the OPS fallback',async mode=>{
  const f=fixture();f.setting.setMode!(mode);f.release();await f.service.perform(f.request(),undefined,f.options);expect(f.state.spawns).toBe(1);expect(f.state.reads).toBe(0);expect(f.state.fallbacks).toBe(0);expect(f.launches[0]!.args.join(' ')).not.toContain('model_reasoning_effort');expect(f.setting.getMode!()).toBe(mode);
});

test('an explicit pinned effort is never removed by the admitted-job fallback',async()=>{
  const f=fixture();f.release();await f.service.perform(f.request(),undefined,{...f.options,launchEffort:{pinned:'medium'}});expect(f.launches[0]!.args).toContain('model_reasoning_effort="medium"');expect(f.state.fallbacks).toBe(0);expect(f.state.reads).toBe(0);
});

test('a spawn that may have exposed the prompt is never retried after its result becomes unknown',async()=>{
  const f=fixture(),id=crypto.randomUUID();f.state.spawnThrows=true;const launch=f.service.perform(f.request(id),undefined,f.options);await f.refreshing;f.state.settings=false;f.release();await expect(launch).rejects.toThrow('spawn outcome unknown');
  await expect(f.service.perform(f.request(id),undefined,f.options)).rejects.toThrow('spawn outcome unknown');expect(f.state.spawns).toBe(1);expect(f.state.fallbacks).toBe(1);
});
