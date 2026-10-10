import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TesterAgentHost} from '../src/testerAgentHost';
import {parseTesterRequest,testerRequestId,type TesterRequest} from '../src/testerAgentContract';
import {testerMcpAction,TESTER_MCP_TOOLS} from '../src/testerAgentMcp';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
// The same resolver the host uses in production. Repeating `Bun.which('python3')`
// here reproduced the bug the resolver exists to fix: on Windows that lookup
// finds nothing even with Python 3.13 installed behind the `py` launcher.
import {resolveSystemPython} from '../src/pythonExecutable';

const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const host of hosts.splice(0)){await host.shutdown();host.store.close();}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'agentstoz-tester-'));roots.push(dir);const root=join(dir,'project');mkdirSync(root);
  Bun.spawnSync(['git','init','-q',root]);Bun.spawnSync(['git','-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial']);
  mkdirSync(join(root,'tests'));writeFileSync(join(root,'tests/test_core.py'),"import unittest\nclass Core(unittest.TestCase):\n def test_sum(self): self.assertEqual(2+2,4)\n");
  const host=new TesterAgentHost({directory:join(dir,'data'),runner:resolve(import.meta.dir,'../scripts/agentstoz-maintainer.py'),python:resolveSystemPython,resolve:async r=>{if(r.portId!=='project-id')throw Error('Unknown project');return {root,label:'Fixture',targets:[{id:'project-id',label:'Fixture'}]};},lease:async()=>({release(){}})});hosts.push(host);
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

test('automatic reconciliation versions the common and project-specific layers independently',async()=>{
  const {host,root}=await fixture();
  const installed=await host.perform(req('ensure'));
  expect(installed.ensure?.outcome).toBe('installed');
  expect(installed.status?.installation).toBe('ready');
  expect(installed.status?.installedVersion).toBe(installed.status?.availableVersion);
  expect(installed.status?.projectRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(installed.ensure)).not.toContain(root);

  const path=join(root,'.agentstoz/maintainer.json');
  const projectConfig=JSON.parse(readFileSync(path,'utf8'));
  projectConfig.limits.push('Project-specific rule stays in Git.');
  writeFileSync(path,JSON.stringify(projectConfig,null,2)+'\n');
  const projectRevision=installed.status!.projectRevision;
  const reconciled=await host.perform(req('ensure'));
  expect(reconciled.ensure?.outcome).toBe('ready');
  expect(reconciled.status?.installedVersion).toBe(installed.status?.installedVersion);
  expect(reconciled.status?.projectRevision).not.toBe(projectRevision);
  expect(readFileSync(path,'utf8')).toContain('Project-specific rule stays in Git.');
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
  host.deps.python=resolveSystemPython;await setup(host);writeFileSync(join(root,'.agentstoz/maintainer.json'),'bad JSON');
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
  expect(TESTER_MCP_TOOLS).toHaveLength(9);
  // 제안 읽기는 읽기 전용이고, 받아들이기는 제안 id 하나만 받는다(경로가 될 수 있는 글자는 거절).
  expect(TESTER_MCP_TOOLS.map(tool=>tool.name)).toContain('agentstoz_use_list_tester_proposals');
  expect(parseTesterRequest(req('proposals')).operation).toBe('proposals');
  expect(parseTesterRequest({...req('accept'),scenarioId:'discovered.unit-tests'}).scenarioId).toBe('discovered.unit-tests');
  expect(()=>parseTesterRequest({...req('accept'),scenarioId:'../escape'})).toThrow();
  expect(()=>parseTesterRequest({...req('accept'),scenarioId:'common.json-valid/../x'})).toThrow();
  expect(()=>parseTesterRequest(req('accept'))).toThrow();
  expect(()=>testerMcpAction('agentstoz_use_accept_tester_scenario',{portId:'project-id',scenarioId:'a/b'},'controller')).toThrow();
  expect(parseTesterRequest(req('ensure')).operation).toBe('ensure');
  expect(()=>parseTesterRequest({...req('ensure'),revision:'a'.repeat(64)})).toThrow();
  expect(()=>parseTesterRequest({...req('status'),path:'/tmp'})).toThrow();
  expect(()=>testerMcpAction('agentstoz_use_start_tester',{portId:'project-id',command:'rm -rf /'},'controller')).toThrow();
  const action=testerMcpAction('agentstoz_use_get_tester',{portId:'project-id'},'controller')!;
  expect(parseAgentsToZUseActionRequest(action).tester!.operation).toBe('status');
  expect(()=>parseAgentsToZUseActionRequest({...action,portId:'another-project'})).toThrow();
});

test('제안 → 받아들이기 사슬이 실제 러너로 끝까지 돈다 (2026-10-06)',async()=>{
  // 이 사슬이 끊겨 있었다: `discover` 가 제안을 만들어도 **읽거나 받아들일 길이 와이어에 없었다**.
  // 실측(2026-10-06): 12개 프로젝트에 제안이 쌓였는데 시나리오가 된 프로젝트는 하나뿐이었다.
  // ⚠️ 제안은 **직접 심는다** — 최소 픽스처에서는 `discover` 가 아무 것도 제안하지 않아(실측 0건)
  // 그대로 두면 이 테스트가 조용히 통과한다. 심는 모양은 러너가 쓰는 것과 같다.
  const {host,root}=await fixture();await setup(host);
  mkdirSync(join(root,'.agentstoz/maintainer/proposals'),{recursive:true});
  writeFileSync(join(root,'.agentstoz/maintainer/proposals/seeded-unit.json'),JSON.stringify({
    schemaVersion:1,id:'project.seeded-unit',title:'심은 제안',intent:'테스트용',
    origin:'discovered:changed-test-file',tags:['changed'],paths:['tests/**'],safety:'read-only',risk:1,
    cost:{estimateSeconds:5},
    steps:[{type:'command',argv:['{python}','-c','print(1)'],timeoutSeconds:60}],
  }));
  const listed=await host.perform(req('proposals'));
  const seeded=listed.proposals!.find(proposal=>proposal.id==='project.seeded-unit');
  expect(seeded).toBeTruthy();
  expect(seeded!.title).toBe('심은 제안');
  expect(seeded!.origin).toBe('discovered:changed-test-file');
  expect(seeded!.argv).toEqual(['{python}','-c','print(1)']);
  const accepted=await host.perform({...req('accept'),scenarioId:'project.seeded-unit'});
  expect(accepted.accepted!.id).toBe('project.seeded-unit');
  expect(accepted.accepted!.path).toBe('.agentstoz/scenarios/project/seeded-unit.json');
  expect(readFileSync(join(root,'.agentstoz/scenarios/project/seeded-unit.json'),'utf8')).toContain('project.seeded-unit');
  // 받아들인 뒤에는 그 제안이 목록에서 빠진다.
  expect((await host.perform(req('proposals'))).proposals!.some(proposal=>proposal.id==='project.seeded-unit')).toBe(false);
  // ⚠️ 공통 계층은 이 길로 바뀌지 않는다 — 러너가 `project.` 아닌 id 를 거절한다.
  await expect(host.perform({...req('accept'),scenarioId:'common.json-valid'})).rejects.toThrow();
},60000);

test('제안 읽기·받아들이기는 휴대폰에서 막힌다 (2026-10-06)',async()=>{
  // ⚠️ `accept` 는 프로젝트 파일을 쓰는 동작이다. 원격 차단 목록(status·start·read·cancel)에 없으므로
  // 휴대폰에서는 쓸 수 없어야 하고, 읽기인 `proposals` 도 같은 규칙을 따른다(목록만 늘리지 않는다).
  const {host}=await fixture();
  const invocation={owner:'device:host:phone-a',authorize:async()=>{},executionAllowed:()=>true};
  for(const operation of ['proposals','accept'] as const){
    const request=operation==='accept'?{...req('accept'),scenarioId:'discovered.unit-tests'}:req('proposals');
    await expect(host.perform(request,invocation)).rejects.toThrow('모바일에서는');
  }
},20000);

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

// Natural-language testing path (/api/project-tester/ensure): one call installs, a repeat is a no-op,
// a locally edited runner is never overwritten, and nothing runs or commits.
test('ensure installs once, is idempotent, and skips a locally edited runner',async()=>{
  const {host,root}=await fixture();writeFileSync(join(root,'CLAUDE.md'),'# Mine\nKeep.\n');
  const headBefore=Bun.spawnSync(['git','-C',root,'rev-parse','HEAD']).stdout.toString();
  const first=await host.ensure({portId:'project-id'});
  expect(first.outcome).toBe('installed');expect(first.installation).toBe('ready');
  expect(first.files).toContain('scripts/agentstoz-maintainer.py');
  expect(readFileSync(join(root,'CLAUDE.md'),'utf8').startsWith('# Mine\nKeep.\n')).toBe(true);
  expect(host.store.latest(root)).toBeFalsy();
  expect(Bun.spawnSync(['git','-C',root,'rev-parse','HEAD']).stdout.toString()).toBe(headBefore);
  expect((await host.ensure({portId:'project-id'})).outcome).toBe('ready');
  writeFileSync(join(root,'scripts/agentstoz-maintainer.py'),readFileSync(join(root,'scripts/agentstoz-maintainer.py'),'utf8')+'\n# local edit\n');
  const edited=await host.ensure({portId:'project-id'});
  expect(edited.outcome).toBe('skipped');expect(edited.reason).toBeTruthy();
  expect(readFileSync(join(root,'scripts/agentstoz-maintainer.py'),'utf8')).toContain('# local edit');
},30000);
