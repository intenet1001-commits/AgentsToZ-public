import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TesterAgentHost} from '../src/testerAgentHost';
import {parseTesterRequest,testerRequestId,type TesterRequest} from '../src/testerAgentContract';
import {testerMcpAction,TESTER_MCP_TOOLS} from '../src/testerAgentMcp';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';

const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const host of hosts.splice(0)){await host.shutdown();host.store.close();}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'agentstoz-tester-'));roots.push(dir);const root=join(dir,'project');mkdirSync(root);
  Bun.spawnSync(['git','init','-q',root]);Bun.spawnSync(['git','-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial']);
  mkdirSync(join(root,'tests'));writeFileSync(join(root,'tests/test_core.py'),"import unittest\nclass Core(unittest.TestCase):\n def test_sum(self): self.assertEqual(2+2,4)\n");
  const host=new TesterAgentHost({directory:join(dir,'data'),runner:resolve(import.meta.dir,'../scripts/agentstoz-maintainer.py'),python:()=>Bun.which('python3'),resolve:async r=>{if(r.portId!=='project-id')throw Error('Unknown project');return {root,label:'Fixture',targets:[{id:'project-id',label:'Fixture'}]};},lease:async()=>({release(){}})});hosts.push(host);
  return {host,root};
}
const req=(operation:TesterRequest['operation'],extra:Partial<TesterRequest>={}):TesterRequest=>({operation,portId:'project-id',...extra});
async function setup(host:TesterAgentHost){const {plan}=await host.perform(req('plan'));expect(plan!.files).toContain('scripts/agentstoz-maintainer.py');await host.perform(req('apply',{revision:plan!.revision}));return (await host.perform(req('status'))).status!;}
async function finish(host:TesterAgentHost,id:string){for(let i=0;i<200;i++){const r=(await host.perform(req('read',{runId:id}))).run!;if(!['queued','starting','running','canceling'].includes(r.state))return r;await Bun.sleep(50);}throw Error('Test run did not finish');}

test('setup adopts real project tests and preserves custom instructions across repeat setup',async()=>{
  const {host,root}=await fixture();writeFileSync(join(root,'AGENTS.md'),'# My instructions\nKeep this exactly.\n');
  const before=(await host.perform(req('status'))).status!;expect(before.installation).toBe('absent');
  const status=await setup(host);expect(status.installation).toBe('ready');expect(status.profiles[0]!.configured).toBe(true);
  expect(readFileSync(join(root,'AGENTS.md'),'utf8').startsWith('# My instructions\nKeep this exactly.\n')).toBe(true);
  expect(readFileSync(join(root,'.agents/skills/agentstoz-test/SKILL.md'),'utf8')).toContain('remember-session');
  expect((await host.perform(req('plan'))).plan!.files).toEqual([]);
},20000);

test('same request is one Python run and real result is readable without leaking local paths',async()=>{
  const {host,root}=await fixture();const status=await setup(host);
  const start=req('start',{requestId:testerRequestId(),profileId:'quick',revision:status.configurationRevision});
  const [a,b]=await Promise.all([host.perform(start),host.perform(start)]);expect(a.run!.id).toBe(b.run!.id);
  const done=await finish(host,a.run!.id);expect(done.state).toBe('passed');expect(done.report!.checks[0]!.state).toBe('passed');
  expect(JSON.stringify(done)).not.toContain(root);
  expect((await host.perform(start)).run!.id).toBe(done.id);
  const refreshed=(await host.perform(req('status'))).status!;
  expect(refreshed.latestRun!.origin).toBe('app');expect(refreshed.latestRun!.report!.checks[0]!.output).toContain('OK');
  const handoff=(await host.perform(req('handoff',{mode:'repair',runId:done.id}))).handoff!;expect(handoff).toContain(done.id);expect(handoff).not.toContain(root);expect(Buffer.byteLength(handoff)).toBeLessThanOrEqual(16000);
},20000);

test('missing Python and broken config still provide an actionable AI handoff',async()=>{
  const {host,root}=await fixture();host.deps.python=()=>null;
  expect((await host.perform(req('status'))).status!.environmentReady).toBe(false);
  expect((await host.perform(req('handoff',{mode:'configure'}))).handoff).toContain('Python 3.9');
  host.deps.python=()=>Bun.which('python3');await setup(host);writeFileSync(join(root,'.agentstoz/maintainer.json'),'bad JSON');
  expect((await host.perform(req('status'))).status!.environmentReady).toBe(false);
  expect((await host.perform(req('handoff',{mode:'configure'}))).handoff).toContain('확인 필요');
},20000);

test('handoff reads the selected run and refuses an unknown run',async()=>{
  const {host,root}=await fixture();await setup(host);
  const path=join(root,'.agentstoz/maintainer.json');const config=JSON.parse(readFileSync(path,'utf8'));config.profiles.full=config.profiles.quick;writeFileSync(path,JSON.stringify(config));
  const s=(await host.perform(req('status'))).status!;
  const a=(await host.perform(req('start',{requestId:testerRequestId(),profileId:'quick',revision:s.configurationRevision}))).run!;await finish(host,a.id);
  const b=(await host.perform(req('start',{requestId:testerRequestId(),profileId:'full',revision:s.configurationRevision}))).run!;await finish(host,b.id);
  const handoff=(await host.perform(req('handoff',{mode:'repair',runId:a.id}))).handoff!;expect(handoff).toContain(a.id);expect(handoff).not.toContain(b.id);
  expect((await host.perform(req('handoff',{mode:'repair',runId:b.id}))).handoff).toContain('--profile full');
  await expect(host.perform(req('handoff',{mode:'repair',runId:'20260914T000000Z-00000000'}))).rejects.toThrow('기록을 찾지');
},20000);

test('restart preserves completed receipts and never replays an uncertain run',async()=>{
  const {host}=await fixture();const s=await setup(host);
  const request=req('start',{requestId:testerRequestId(),profileId:'quick',revision:s.configurationRevision});
  const a=(await host.perform(request)).run!;await finish(host,a.id);await host.shutdown();host.store.close();hosts.splice(hosts.indexOf(host),1);
  const next=new TesterAgentHost(host.deps);hosts.push(next);
  expect((await next.perform(request)).run!.id).toBe(a.id);expect((await next.perform(req('status'))).status!.latestRun!.state).toBe('passed');
  const receipt=next.store.get(a.id)!;receipt.state='running';next.store.save(receipt);rmSync(join(receipt.root,`.agentstoz/maintainer/runs/${a.id}`),{recursive:true});
  await next.shutdown();next.store.close();hosts.splice(hosts.indexOf(next),1);const restored=new TesterAgentHost(host.deps);hosts.push(restored);
  expect((await restored.perform(request)).run!.state).toBe('recovery-required');
  await expect(restored.perform(req('start',{...request,requestId:testerRequestId()}))).rejects.toThrow('복구 결과');
},20000);

test('stale setup and test revisions do not write files or run changed commands',async()=>{
  const {host,root}=await fixture();const plan=(await host.perform(req('plan'))).plan!;writeFileSync(join(root,'AGENTS.md'),'new user instruction');
  await expect(host.perform(req('apply',{revision:plan.revision}))).rejects.toThrow('Setup changed');
  const s=await setup(host);const config=JSON.parse(readFileSync(join(root,'.agentstoz/maintainer.json'),'utf8'));config.checks[0].timeoutSeconds=80;writeFileSync(join(root,'.agentstoz/maintainer.json'),JSON.stringify(config));
  await expect(host.perform(req('start',{requestId:testerRequestId(),revision:s.configurationRevision,profileId:'quick'}))).rejects.toThrow('설정이 변경');
},20000);

test('missing tests stay blocked; modified runner is preserved',async()=>{
  const {host,root}=await fixture();rmSync(join(root,'tests'),{recursive:true});const s=await setup(host);expect(s.profiles[0]!.configured).toBe(false);
  const started=(await host.perform(req('start',{requestId:testerRequestId(),revision:s.configurationRevision,profileId:'quick'}))).run!;
  expect((await finish(host,started.id)).state).toBe('blocked');
  writeFileSync(join(root,'scripts/agentstoz-maintainer.py'),'# custom runner\n');
  expect((await host.perform(req('status'))).status!.installation).toBe('conflict');
  await expect(host.perform(req('plan'))).rejects.toThrow('Locally modified');
},20000);

test('cancellation owns its child and terminal result follows process exit',async()=>{
  const {host,root}=await fixture();await setup(host);const p=join(root,'.agentstoz/maintainer.json');const config=JSON.parse(readFileSync(p,'utf8'));config.checks[0].argv=['{python}','-c','import time; time.sleep(30)'];writeFileSync(p,JSON.stringify(config));
  const s=(await host.perform(req('status'))).status!;const r=(await host.perform(req('start',{requestId:testerRequestId(),revision:s.configurationRevision,profileId:'quick'}))).run!;
  for(let i=0;i<50;i++){if((await host.perform(req('read',{runId:r.id}))).run!.state==='running')break;await Bun.sleep(40);}
  await host.perform(req('cancel',{runId:r.id}));expect((await finish(host,r.id)).state).toBe('interrupted');
},20000);

test('a held parent workspace lease returns a bounded result and never clears its lock',async()=>{
  const {host}=await fixture();const s=await setup(host);host.deps.lease=async()=>{throw Object.assign(Error('busy'),{code:'WORKSPACE_LEASE_BUSY'});};
  const r=(await host.perform(req('start',{requestId:testerRequestId(),revision:s.configurationRevision,profileId:'quick'}))).run!;
  const done=await finish(host,r.id);expect(done.state).toBe('blocked');expect(done.message).toContain('현재 AI 세션');
},20000);

test('cancel during preparation never starts the test command',async()=>{
  const {host,root}=await fixture();const s=await setup(host);let unblock!:()=>void;
  host.deps.lease=async()=>{await new Promise<void>(r=>{unblock=r;});return {release(){}};};
  const run=(await host.perform(req('start',{requestId:testerRequestId(),profileId:'quick',revision:s.configurationRevision}))).run!;
  for(let i=0;i<50&&!unblock;i++)await Bun.sleep(20);
  expect((await host.perform(req('cancel',{runId:run.id}))).run!.state).toBe('canceling');unblock();
  const done=await finish(host,run.id);expect(done.state).toBe('interrupted');expect(done.report).toBeUndefined();
  expect((await host.perform(req('status'))).status!.latest).toBeNull();
},20000);

test('tester requests and MCP tools reject command/path injection and target mismatches',()=>{
  expect(TESTER_MCP_TOOLS).toHaveLength(7);
  expect(()=>parseTesterRequest({...req('status'),path:'/tmp'})).toThrow();
  expect(()=>testerMcpAction('agentstoz_use_start_tester',{portId:'project-id',command:'rm -rf /'},'controller')).toThrow();
  const action=testerMcpAction('agentstoz_use_get_tester',{portId:'project-id'},'controller')!;
  expect(parseAgentsToZUseActionRequest(action).tester!.operation).toBe('status');
  expect(()=>parseAgentsToZUseActionRequest({...action,portId:'another-project'})).toThrow();
});

test('remote admission and queued execution recheck permission, with durable owner replay',async()=>{
  const {host,root}=await fixture();const s=await setup(host);let allowed=true,connected=true;let unblock!:()=>void;
  const request=req('start',{requestId:testerRequestId(),profileId:'quick',revision:s.configurationRevision});
  const invocation={owner:'device:host:phone-a',authorize:async()=>{if(!connected)throw Error('Disconnected');},executionAllowed:()=>allowed};
  host.deps.lease=async()=>{await new Promise<void>(r=>{unblock=r;});return {release(){}};};
  const run=(await host.perform(request,invocation)).run!;
  for(let i=0;i<50&&!unblock;i++)await Bun.sleep(20);
  allowed=false;unblock();
  const done=await finish(host,run.id);expect(done.state).toBe('blocked');expect(done.report).toBeUndefined();
  allowed=true;expect((await host.perform(request,invocation)).run!.id).toBe(run.id);
  expect(host.store.get(run.id)!.remoteOwner).toBe(invocation.owner);
  expect((await host.perform(req('status'))).status!.latest).toBeNull();
},20000);

test('remote test continues after transport loss, rejects another owner cancel and stops on grant revocation',async()=>{
  const {host,root}=await fixture();await setup(host);const p=join(root,'.agentstoz/maintainer.json');const config=JSON.parse(readFileSync(p,'utf8'));config.checks[0].argv=['{python}','-c','import time; time.sleep(20)'];writeFileSync(p,JSON.stringify(config));
  const s=(await host.perform(req('status'))).status!;let connected=true,allowed=true;
  const invocation={owner:'device:host:phone-a',authorize:async()=>{if(!connected)throw Error('Disconnected');},executionAllowed:()=>allowed};
  const request=req('start',{requestId:testerRequestId(),revision:s.configurationRevision,profileId:'quick'});
  const run=(await host.perform(request,invocation)).run!;
  for(let i=0;i<60;i++){if(host.store.get(run.id)!.state==='running')break;await Bun.sleep(50);}
  connected=false;await Bun.sleep(1200);expect(host.store.get(run.id)!.state).toBe('running');
  connected=true;expect((await host.perform(request,invocation)).run!.id).toBe(run.id);
  await expect(host.perform(req('cancel',{runId:run.id}),{...invocation,owner:'device:host:phone-b'})).rejects.toThrow('이 기기에서 시작');
  allowed=false;expect((await finish(host,run.id)).state).toBe('interrupted');
},20000);
