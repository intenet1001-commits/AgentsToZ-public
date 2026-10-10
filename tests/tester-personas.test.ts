import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {TesterAgentHost} from '../src/testerAgentHost';
import {parseTesterRequest,testerRequestId,TESTER_PERSONA_PROFILE,TESTER_EXPLORATION_CLASS,type TesterRequest} from '../src/testerAgentContract';
import {testerMcpAction,TESTER_MCP_TOOLS} from '../src/testerAgentMcp';

/*
 * 페르소나 검사는 공통 러너(1.5.0 `personas`)로 옮겨졌다 — 어느 프로젝트든 자기 카탈로그로 쓴다.
 * 여기서는 앱 호스트가 그것을 **정직하게** 보여 주는지 본다: 카탈로그 없음은 통과가 아니고, 판정은 결정적
 * 테스트뿐이며, AI 탐색은 초안(판정 없음·크기 제한·경로 제거)이고 아무 것도 실행·기록하지 않는다.
 */
const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const host of hosts.splice(0)){await host.shutdown();host.store.close();}for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'agentstoz-personas-'));roots.push(dir);const root=join(dir,'project');mkdirSync(root);
  Bun.spawnSync(['git','init','-q',root]);Bun.spawnSync(['git','-C',root,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-qm','initial']);
  mkdirSync(join(root,'tests'));writeFileSync(join(root,'tests/test_core.py'),"import unittest\nclass Core(unittest.TestCase):\n def test_sum(self): self.assertEqual(2+2,4)\n");
  const host=new TesterAgentHost({directory:join(dir,'data'),runner:resolve(import.meta.dir,'../scripts/agentstoz-maintainer.py'),python:()=>Bun.which('python3'),resolve:async r=>{if(r.portId!=='project-id')throw Error('Unknown project');return {root,label:'Fixture',targets:[{id:'project-id',label:'Fixture'}]};},lease:async()=>({release(){}})});hosts.push(host);
  return {host,root};
}
const req=(operation:TesterRequest['operation'],extra:Partial<TesterRequest>={}):TesterRequest=>({operation,portId:'project-id',...extra});
async function setup(host:TesterAgentHost){const {plan}=await host.perform(req('plan'));await host.perform(req('apply',{revision:plan!.revision}));return (await host.perform(req('status'))).status!;}
async function finish(host:TesterAgentHost,id:string){for(let i=0;i<200;i++){const r=(await host.perform(req('read',{runId:id}))).run!;if(!['queued','starting','running','canceling'].includes(r.state))return r;await Bun.sleep(50);}throw Error('Test run did not finish');}
function catalog(root:string,personas:unknown[]){mkdirSync(join(root,'.agentstoz'),{recursive:true});writeFileSync(join(root,'.agentstoz/personas.json'),JSON.stringify({schemaVersion:1,personas}));}
const ok=['{python}','-c','pass'],fail=['{python}','-c','raise SystemExit(3)'];

test('a project without a catalog says so — neither a pass nor something to run',async()=>{
  const {host}=await fixture();const s=await setup(host);
  expect(s.personas).toEqual({state:'none',catalog:null});
  await expect(host.perform(req('start',{requestId:testerRequestId(),profileId:TESTER_PERSONA_PROFILE,revision:s.configurationRevision}))).rejects.toThrow('통과도 실패도 아닙니다');
},20000);

test('personas run through the same run machinery and only deterministic tests decide',async()=>{
  const {host,root}=await fixture();const s0=await setup(host);
  catalog(root,[{id:'reader',goal:'목록을 읽는다',tests:[{argv:ok,kind:'contract',name:'unit'},{argv:['{python}','-c','print(1)'],kind:'screen',name:'drawn'}]},
    {id:'breaker',goal:'실패를 본다',tests:[{argv:fail,kind:'contract',name:'broken'}]}]);
  const s=(await host.perform(req('status'))).status!;
  expect(s.configurationRevision).toBe(s0.configurationRevision);
  expect(s.personas?.state).toBe('ready');
  expect(s.personas?.personas?.map(p=>[p.id,p.contract,p.screen])).toEqual([['reader',1,1],['breaker',1,0]]);
  const run=(await host.perform(req('start',{requestId:testerRequestId(),profileId:TESTER_PERSONA_PROFILE,revision:s.configurationRevision}))).run!;
  const done=await finish(host,run.id);
  expect(done.profileId).toBe(TESTER_PERSONA_PROFILE);expect(done.state).toBe('failed');
  expect(done.report?.profile).toBe(TESTER_PERSONA_PROFILE);
  expect(done.report?.checks.map(c=>[c.id,c.state,c.evidence])).toEqual([['unit','passed','persona:contract'],['drawn','passed','persona:screen'],['broken','failed','persona:contract']]);
  expect(JSON.stringify(done)).not.toContain(root);
  const after=(await host.perform(req('status'))).status!;
  expect(after.personas?.latest?.verdicts.map(v=>[v.id,v.verdict])).toEqual([['reader','PASS'],['breaker','FAIL']]);
  // The profile view is untouched: a persona run never stands in for a manifest profile result.
  expect(after.latest).toBeNull();
},30000);

test('a real manifest profile named personas wins over the reserved one',async()=>{
  const {host,root}=await fixture();await setup(host);
  const path=join(root,'.agentstoz/maintainer.json');const config=JSON.parse(await Bun.file(path).text());config.profiles.personas=config.profiles.quick;writeFileSync(path,JSON.stringify(config));
  const s=(await host.perform(req('status'))).status!;
  const run=(await host.perform(req('start',{requestId:testerRequestId(),profileId:'personas',revision:s.configurationRevision}))).run!;
  const done=await finish(host,run.id);expect(done.state).toBe('passed');
  expect(done.report?.checks.map(c=>c.id)).toEqual(['project-tests']);
},20000);

test('the exploration brief is a bounded draft with a forbidden list and no verdict, and it runs or records nothing',async()=>{
  const {host,root}=await fixture();await setup(host);
  catalog(root,[{id:'newcomer',goal:'처음 연결할 때 실패 원인을 이해한다',tests:[{argv:ok,kind:'screen',name:'first-run'}],
    explore:{successCriteria:['실패 원인이 한 화면 안에 보인다'],forbidden:['실제 계정으로 로그인하지 않는다'],surfaces:['온보딩 첫 화면']}}]);
  const files=()=>existsSync(join(root,'.agentstoz/maintainer'))?readdirSync(join(root,'.agentstoz/maintainer'),{recursive:true}).map(String).sort():[];
  const before=files(),runsBefore=host.store.active().length;
  const result=await host.perform(req('handoff',{mode:'explore',personaId:'newcomer'}));
  expect(result.exploration).toEqual({personaId:'newcomer',class:TESTER_EXPLORATION_CLASS,draftOnly:true,verdict:null});
  const brief=result.handoff!;
  expect(Buffer.byteLength(brief)).toBeLessThanOrEqual(16000);
  for(const text of ['실제 계정으로 로그인하지 않는다','Do not report this exploration as PASS or FAIL','실제 화면','스크린샷','회귀 테스트','exploratory/observed','screen · first-run'])expect(brief).toContain(text);
  expect(brief).not.toContain(root);
  expect(files()).toEqual(before);expect(host.store.active().length).toBe(runsBefore);
  await expect(host.perform(req('handoff',{mode:'explore',personaId:'nobody'}))).rejects.toThrow('Unknown persona');
},20000);

test('the wire contract keeps exploration separate from runs',()=>{
  expect(parseTesterRequest(req('handoff',{mode:'explore',personaId:'newcomer'})).personaId).toBe('newcomer');
  for(const bad of [req('handoff',{mode:'explore'}),req('handoff',{mode:'repair',personaId:'newcomer'}),
    req('handoff',{mode:'explore',personaId:'../x'}),req('handoff',{mode:'explore',personaId:'newcomer',runId:'20260914T000000Z-00000000'}),
    req('status',{personaId:'newcomer'} as Partial<TesterRequest>)])expect(()=>parseTesterRequest(bad)).toThrow();
  const tool=TESTER_MCP_TOOLS.find(t=>t.name==='agentstoz_use_prepare_tester_handoff')!;
  expect((tool.inputSchema as any).properties.mode.enum).toEqual(['configure','repair','explore']);
  expect((tool.inputSchema as any).properties.personaId.pattern).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
  expect(tool.description).toContain('draft only');expect(tool.description).toContain('never reported as PASS/FAIL');
  expect(testerMcpAction('agentstoz_use_prepare_tester_handoff',{portId:'p',mode:'explore',personaId:'newcomer'},'c')).toEqual({action:'tester',controllerPortId:'c',portId:'p',tester:{operation:'handoff',portId:'p',mode:'explore',personaId:'newcomer'}});
  expect(TESTER_MCP_TOOLS.find(t=>t.name==='agentstoz_use_start_tester')!.description).toContain('"personas"');
  // No new tool: personas ride on get_tester, start_tester and prepare_tester_handoff.
  expect(TESTER_MCP_TOOLS).toHaveLength(9);
});
