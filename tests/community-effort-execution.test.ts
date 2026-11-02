import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {createWorkroomTeamHost} from '../src/workroomTeamHost';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {communityWorkroomEffortPolicy} from '../src/communityWorkroomEffort';
import {CommunityAdapterAuthorization} from '../src/communityAdapterAuthorization';

const owner='community:11111111-1111-4111-8111-111111111111';
const clean:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'common-effort-')),journal=new WorkroomConversationJournal(root),setting=createWorkroomEffortSetting(root),writes:string[]=[],launches:string[][]=[];
  const native={selected:true,active:true,checks:0,revokeBeforeWrite:false};let frame=(s:string)=>{};
  const service=new AiTerminalService({submissions:()=>journal,effortAuto:setting,activitySampler:false,
    resolveTarget:async()=>({cwd:root}),executable:()=>'/fixture/codex',codexEffortModel:()=>({ok:true,model:'gpt-6.1-sol',allowed:['low','medium','high']}),effortRuntimeSupport:()=>({codexDefaultKeys:true,claudeSessionPicker:true}),
    communityEffortPolicy:async()=>{native.checks++;if(!native.selected||!native.active)throw Error('Native consent absent');return{mode:setting.getMode!(),isAuthorized:()=>native.active,beforeEffect:async()=>{native.checks++;if(native.revokeBeforeWrite)native.active=false;return native.active;}};},
    effortRuntime:async c=>{await c.write('native-effort:'+c.level);return'applied';},
    spawn:(args,options:any)=>{launches.push(args);let end!:(code:number)=>void;const exited=new Promise<number>(r=>{end=r;});frame=s=>options.terminal.data(null,new TextEncoder().encode(s));queueMicrotask(()=>frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol medium\r\n› '));return{pid:700001,exited,kill:()=>end(143),terminal:{write:(s:string)=>{writes.push(s);if(s.startsWith('native-effort:'))frame('\x1b[2J\x1b[Hmodel: gpt-6.1-sol '+s.split(':')[1]+'\r\n› ');return Buffer.byteLength(s);},resize(){},close(){end(0);}}} as never;},
  });
  clean.push(async()=>{await service.shutdown();journal.close();rmSync(root,{recursive:true,force:true});});
  const start=async(receiptOwner='local',prompt='일반 작업을 진행해 주세요')=>{const r=await service.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'fixture-project-1',agent:'codex',cols:100,rows:28,prompt},undefined,receiptOwner==='local'?{}:{receiptOwner});await new Promise(r=>setTimeout(r,10));return r.session!;};
  const send=(sessionId:string)=>submitWorkroomDraft({id:crypto.randomUUID(),sessionId,text:'권한 격리 설계를 검토해 주세요\r',prepared:()=>{},request:r=>service.perform({...r,requestId:crypto.randomUUID()},undefined,{receiptOwner:owner})});
  return{service,setting,native,writes,launches,start,send};
}
test('the common settings choice reaches actual CLI launch arguments, while an unselected purpose starts at the ordinary default',async()=>{
  const f=fixture();f.setting.setMode!('auto');await f.start(owner,'권한 격리 설계를 검토해 주세요');expect(f.launches[0]!.join(' ')).toContain('model_reasoning_effort=\"high\"');expect(f.native.checks).toBeGreaterThanOrEqual(2);
  f.native.selected=false;await f.start(owner,'권한 격리 설계를 검토해 주세요');expect(f.launches[1]!.join(' ')).not.toContain('model_reasoning_effort');expect(f.setting.getMode!()).toBe('auto');
});
test.each(['auto','recommend','off'] as const)('a current common witness preserves the real %s governor and Desktop off policy',async mode=>{
  const f=fixture();f.setting.setMode!(mode);f.setting.setDesktopMode!('off');const s=await f.start();await f.send(s.id);
  expect(f.writes.some(v=>v.startsWith('native-effort:'))).toBe(mode==='auto');expect(f.setting.getMode!()).toBe(mode);expect(f.setting.getDesktopMode!()).toBe('off');
});
test('a missing selected purpose suppresses only effort commands, and Native withdrawal before an actual write never changes the CLI',async()=>{
  const f=fixture(),s=await f.start();f.native.selected=false;expect((await f.send(s.id)).state).toBe('written');expect(f.writes.some(v=>v.startsWith('native-effort:'))).toBe(false);
  f.native.selected=true;f.native.revokeBeforeWrite=true;await expect(f.send(s.id)).rejects.toThrow('공통 설정 조정 권한');expect(f.writes.some(v=>v.startsWith('native-effort:'))).toBe(false);expect(f.setting.getMode!()).toBe('auto');
});
test('local CLI execution keeps its existing opt-in and never asks the common broker',async()=>{
  const f=fixture();f.native.selected=false;await f.start('local','권한 격리 설계를 검토해 주세요');expect(f.launches[0]!.join(' ')).toContain('model_reasoning_effort=\"high\"');expect(f.native.checks).toBe(0);
});
test('the production common-effort resolver requires current Native own and exact endpoint peer selection and checks withdrawal again',async()=>{
  const profile='22222222-2222-4222-8222-222222222222',community='33333333-3333-4333-8333-333333333333',device='44444444-4444-4444-8444-444444444444';let allowed=true,peerSelected=true;
  const link={verifiedMain:true,request:async()=>({success:true,halted:false,authorized:allowed,capability:'computer-use.agent-settings',communityId:community,profileId:profile,deviceId:device,revision:1,expiresAt:Date.now()+90000,desktopGrant:false})},adapter=new CommunityAdapterAuthorization(link),setting={get:()=>true,set:()=>true,getMode:()=> 'auto' as const};
  const peer={body:{deviceId:'55555555-5555-4555-8555-555555555555',agentDeviceId:device,communityId:community,profileId:profile,capabilities:['agent.communicate','computer-use.agent-settings']},policyDigest:'fixture-only-policy',permits:()=>allowed};
  const deps={adapter,identity:{directory:async()=>peerSelected?[peer] as never:[]},devices:async()=>({inside:true,devices:[{deviceId:device,endpointId:owner.slice(10)}]})};
  const policy=await communityWorkroomEffortPolicy(deps,owner,setting);expect(policy.mode).toBe('auto');expect(await policy.beforeEffect()).toBe(true);
  allowed=false;expect(await policy.beforeEffect()).toBe(false);allowed=true;peerSelected=false;await expect(communityWorkroomEffortPolicy(deps,owner,setting)).rejects.toThrow('선택');
  await expect(communityWorkroomEffortPolicy(deps,'community:wrong',setting)).rejects.toThrow('발신');
});

test.each(['auto','recommend','off'] as const)('a remote Teams host carries separate current settings consent into the real %s launch without changing receipt ownership',async mode=>{
  const f=fixture();f.setting.setMode!(mode);let selected=false;
  const policy=async()=>{if(!selected)throw Error('settings unselected');return{mode,isAuthorized:()=>selected,beforeEffect:async()=>selected};};
  const host=createWorkroomTeamHost({terminal:f.service,gitPath:'fixture-git',resolveProject:async()=>{throw Error('not used');},targetCwd:async()=>null,ensureExclude:async()=>{},seedConfig(){},withLease:async(_p,_l,fn)=>fn()});
  const launch=(pinned=false)=>host.start({requestId:crypto.randomUUID(),targetId:'fixture-project-1',agent:'codex',prompt:'권한 격리 설계를 검토해 주세요',effort:pinned?{pinned:'medium'}:{requestText:'권한 격리 설계를 검토해 주세요'},guard:{active:()=>true,beforeEffect:async()=>{},effortPolicy:policy}});
  await launch();expect(f.launches[0]!.join(' ')).not.toContain('model_reasoning_effort');
  selected=true;await launch();expect(f.launches[1]!.join(' ').includes('model_reasoning_effort="high"')).toBe(mode==='auto');
  selected=false;await launch(true);expect(f.launches[2]!.join(' ')).toContain('model_reasoning_effort="medium"');expect(f.setting.getMode!()).toBe(mode);
});
