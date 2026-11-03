import {afterEach,expect,test} from 'bun:test';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {TesterAgentHost} from '../src/testerAgentHost';
import {parseTesterRequest,type TesterTarget} from '../src/testerAgentContract';
import {TESTER_MCP_TOOLS} from '../src/testerAgentMcp';
import {resolveSystemPython} from '../src/pythonExecutable';

// 전수 클릭 「켜기」·「기준선 만들기」(2026-11-01). 다른 프로젝트에서는 사람이 JSON을 직접 써야 켜졌다 — 카드는 「구성 전」만
// 보여 줬다. 등록된 포트가 있으면 앱이 설정과 엔진을 깔고, 포트가 없더라도 데스크톱 프로젝트 하네스를 별도로 구성할 수 있다.
const roots:string[]=[],hosts:TesterAgentHost[]=[];
afterEach(async()=>{for(const h of hosts.splice(0)){await h.shutdown();h.store.close();}for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function host(urls:Record<string,string|null>){
  const root=mkdtempSync(join(tmpdir(),'tester-sweep-enable-'));roots.push(root);mkdirSync(join(root,'.agentstoz'),{recursive:true});
  let leases=0;
  const h=new TesterAgentHost({directory:join(root,'.data'),runner:resolve(import.meta.dir,'../scripts/agentstoz-maintainer.py'),python:resolveSystemPython,
    resolve:async r=>{if(!(r.portId in urls))throw Error('unregistered');return {root,label:'Fixture',targets:[]};},
    lease:async()=>{leases++;return {release(){}};},localUrl:async(r:TesterTarget)=>urls[r.portId]??null});
  hosts.push(h);return {h,root,leases:()=>leases};
}
test('sets offer 켜기 only with a registered port, and explain desktop configuration without one',async()=>{
  const withPort=host({web:'http://127.0.0.1:9/'});
  expect((await withPort.h.perform({portId:'web',operation:'sets'})).sets!.clickSweep).toMatchObject({state:'none',enableUrl:'http://127.0.0.1:9/'});
  const without=host({docs:null});
  expect((await without.h.perform({portId:'docs',operation:'sets'})).sets!.clickSweep).toMatchObject({state:'none',enableUrl:null});
  await expect(without.h.perform({portId:'docs',operation:'sweep-enable'})).rejects.toThrow('데스크톱 앱은 포트 없이');
  expect(existsSync(join(without.root,'.agentstoz/click-sweep.json'))).toBe(false);
});
test('켜기 writes the loopback config once, installs the shared engine under the lease and never overwrites',async()=>{
  const {h,root,leases}=host({web:'http://127.0.0.1:9/'});
  const sweep=(await h.perform({portId:'web',operation:'sweep-enable'})).sets!.clickSweep!;
  expect(sweep).toMatchObject({state:'configured',engine:'present'});expect(sweep.surfaces).toEqual([{id:'web',label:'로컬 웹 화면',kind:'url',target:'web',environment:'browser',baselinePresent:false,last:null}]);
  expect(JSON.parse(readFileSync(join(root,'.agentstoz/click-sweep.json'),'utf8'))).toEqual({schemaVersion:2,surfaces:[{id:'web',label:'로컬 웹 화면',target:'web',environment:'browser',url:'http://127.0.0.1:9/'}]});
  expect(readFileSync(join(root,'scripts/agentstoz-click-sweep.mjs'),'utf8')).toStartWith('#!/usr/bin/env node\n// agentstoz-click-sweep ');
  expect(leases()).toBe(1);
  writeFileSync(join(root,'.agentstoz/click-sweep.json'),'{"hand":"edited"}');
  await expect(h.perform({portId:'web',operation:'sweep-enable'})).rejects.toThrow('덮어쓰지 않습니다');
  expect(readFileSync(join(root,'.agentstoz/click-sweep.json'),'utf8')).toBe('{"hand":"edited"}');
});
test('기준선 만들기 needs a config, runs once at a time and reports an unrunnable sweep as not a pass',async()=>{
  const {h,root}=host({web:'http://127.0.0.1:9/'});
  await expect(h.perform({portId:'web',operation:'sweep-baseline'})).rejects.toThrow('먼저 켜세요');
  await h.perform({portId:'web',operation:'sweep-enable'});
  const started=(await h.perform({portId:'web',operation:'sweep-baseline'})).sets!.clickSweep!;
  expect(started.job?.state).toBe('running');
  await expect(h.perform({portId:'web',operation:'sweep-baseline'})).rejects.toThrow('기준선을 만드는 중');
  // 픽스처에는 Playwright가 없고 9번 포트에는 서버가 없다 — 엔진은 3(실행 불가)으로 끝나야 하고, 그것은 통과가 아니다.
  let job=started.job!;for(let i=0;i<120&&job.state==='running';i++){await Bun.sleep(500);job=(await h.perform({portId:'web',operation:'sets'})).sets!.clickSweep!.job!;}
  expect(job.state).toBe('unavailable');expect(job.message).toContain('통과 아님');expect(job.message).not.toContain(root);
  expect(existsSync(join(root,'.agentstoz/click-sweep/web.json'))).toBe(false);
},70_000);
test('sweep operations stay desktop-only: not MCP tools and refused from the phone',async()=>{
  for(const operation of ['sweep-enable','sweep-baseline'] as const){
    expect(parseTesterRequest({portId:'web',operation}).operation).toBe(operation);
    expect(()=>parseTesterRequest({portId:'web',operation,url:'http://example.com/'})).toThrow();
  }
  expect(TESTER_MCP_TOOLS.some(t=>/sweep/.test(t.name))).toBe(false);
  const {h}=host({web:'http://127.0.0.1:9/'});
  await expect(h.perform({portId:'web',operation:'sweep-enable'},{owner:'phone',async authorize(){},executionAllowed:()=>true})).rejects.toThrow('모바일에서는');
});

test('native preparation alone cannot regenerate the already-present web baseline',async()=>{
  const {h,root}=host({web:null});
  writeFileSync(join(root,'.agentstoz/click-sweep.json'),JSON.stringify({schemaVersion:2,surfaces:[
    {id:'web',target:'web',environment:'browser',command:['python3','-c','raise Exception("must not launch")'],baseline:'web-baseline.json'},
    {id:'native-app',target:'desktop',environment:'native',platform:'darwin',command:['python3','-c','raise Exception("must not launch")']},
  ]}));
  writeFileSync(join(root,'web-baseline.json'),'original web bytes');
  writeFileSync(join(root,'.agentstoz/desktop-operative.json'),JSON.stringify({schemaVersion:1,surfaceId:'native-app',bundleId:'com.example.Product',platform:'darwin',maxTargets:64}));
  await expect(h.perform({portId:'web',operation:'sweep-baseline'})).rejects.toMatchObject({code:'TESTER_DESKTOP_ADAPTER_UNAVAILABLE'});
  expect(readFileSync(join(root,'web-baseline.json'),'utf8')).toBe('original web bytes');
  expect((await h.perform({portId:'web',operation:'sets'})).sets!.clickSweep?.job).toBeUndefined();
});
