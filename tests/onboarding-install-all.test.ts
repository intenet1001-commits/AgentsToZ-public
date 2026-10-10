import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexInstallHost,CodexInstallStore,type CodexInstallEffects} from '../src/onboardingCodexInstallHost';
import {OnboardingGithubStore} from '../src/onboardingGithubStore';
import {OnboardingGithubHost,type GithubHostEffects} from '../src/onboardingGithubHost';
import {
  INSTALL_ALL_STEP_TIMEOUT_MS, installAllMissing, installAllRunnable, installAllSummary, runInstallAll, runInstallAllStep,
  type InstallAllStep, type InstallAllTransport,
} from '../src/onboardingInstallAllPlan';

// Real installer hosts with fake effects: the button must go through the same review → install →
// read-back rules the per-tool panels use, so no step here is re-implemented by the test.
const roots:string[]=[],closers:Array<()=>unknown>=[];
afterEach(async()=>{for(const c of closers.splice(0).reverse())await c();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const tmp=(name:string)=>{const r=mkdtempSync(join(tmpdir(),name));roots.push(r);return r;};
const noSleep=async()=>{await Bun.sleep(2);};

/** The same body shape `handleGithubSetup` returns over the native boundary. */
function transportFor(host:{status():object;act(op:string,expected:string):Promise<object>}):InstallAllTransport{
  return async body=>{
    try{
      const value=body.operation==='status'?host.status():await host.act(String(body.operation),String(body.expectedRevision));
      return {status:200,body:{success:true,...value}};
    }catch{return {status:409,body:{error:'작업 상태를 확인하지 못했습니다.'}};}
  };
}
function codex(overrides:Partial<CodexInstallEffects>={}){
  const store=new CodexInstallStore(tmp('install-all-codex-'));let present=false;const calls:string[]=[];
  const host=new CodexInstallHost(store,{supported:true,probe:async()=>present?'installed':'missing',
    prepare:async()=>{calls.push('prepare');},install:async()=>{calls.push('install');present=true;},...overrides});
  closers.push(()=>store.close(),()=>host.close());
  return {host,calls,transport:transportFor(host),setPresent:(v:boolean)=>{present=v;}};
}
function github(overrides:Partial<GithubHostEffects>={}){
  const store=new OnboardingGithubStore(tmp('install-all-gh-'));let present=false;const calls:string[]=[];
  const host=new OnboardingGithubHost(store,{platform:'darwin',probe:async()=>present?'installed':'missing',
    prepare:async()=>{calls.push('prepare');},installFile:async()=>{calls.push('install');present=true;},
    openLoginPage:async()=>{},login:()=>{throw new Error('not in this test');},...overrides});
  closers.push(()=>store.close(),()=>host.close());
  return {host,calls,transport:transportFor(host)};
}
const steps=(c:InstallAllTransport,g:InstallAllTransport):InstallAllStep[]=>[
  {id:'codex',label:'Codex',transport:c},{id:'github',label:'GitHub CLI',transport:g}];

test('one press installs both missing tools in order and reports each',async()=>{
  const c=codex(),g=github();const progress:string[]=[];
  const reports=await runInstallAll(steps(c.transport,g.transport),(i,n,s)=>progress.push(`${i+1}/${n}:${s.id}`),{sleep:noSleep});
  expect(progress).toEqual(['1/2:codex','2/2:github']);
  expect(reports.map(r=>r.result)).toEqual(['installed','installed']);
  expect(c.calls).toEqual(['prepare','install']);expect(g.calls).toEqual(['prepare','install']);
  expect(c.host.status().receipt?.state).toBe('installed');expect(g.host.status().receipt?.state).toBe('installed');
  expect(installAllSummary(reports)).toMatchObject({tone:'ok',title:'모두 설치했습니다.'});
});

test('pressing again installs nothing twice',async()=>{
  const c=codex(),g=github();
  await runInstallAll(steps(c.transport,g.transport),()=>{},{sleep:noSleep});
  const again=await runInstallAll(steps(c.transport,g.transport),()=>{},{sleep:noSleep});
  expect(again.map(r=>r.result)).toEqual(['installed','installed']);
  expect(c.calls).toEqual(['prepare','install']);expect(g.calls).toEqual(['prepare','install']);
});

test('a tool already on the device is reused by the host, not downloaded again',async()=>{
  const c=codex();c.setPresent(true);const g=github();
  const reports=await runInstallAll(steps(c.transport,g.transport),()=>{},{sleep:noSleep});
  expect(reports[0]!.result).toBe('installed');expect(c.calls).toEqual([]);
});

test('a stored "installed" receipt does not hide a tool that was removed since',async()=>{
  const c=codex();
  await runInstallAll(steps(c.transport,github().transport),()=>{},{sleep:noSleep});
  c.setPresent(false);
  const again=await runInstallAllStep(c.transport,{sleep:noSleep});
  expect(again).toBe('installed');expect(c.calls).toEqual(['prepare','install','prepare','install']);
});

test('a device where nothing can be installed is never told "모두 설치했습니다"',()=>{
  const none=installAllSummary([{id:'codex',label:'Codex',result:'unsupported'},{id:'github',label:'GitHub CLI',result:'unsupported'}]);
  expect(none.title).toBe('이 기기에서는 자동 설치를 쓸 수 없습니다.');expect(none.detail).not.toContain('로그인뿐');
  const some=installAllSummary([{id:'codex',label:'Codex',result:'unsupported'},{id:'github',label:'GitHub CLI',result:'installed'}]);
  expect(some.title).toBe('설치할 수 있는 것은 모두 설치했습니다.');expect(some.detail).toContain('Codex는 이 기기에서');
});

test('one failing installer does not keep the other off this device',async()=>{
  const c=codex({install:async()=>{throw new Error('network');}}),g=github();
  const reports=await runInstallAll(steps(c.transport,g.transport),()=>{},{sleep:noSleep});
  expect(reports.map(r=>r.result)).toEqual(['failed','installed']);
  const summary=installAllSummary(reports);
  expect(summary.tone).toBe('warn');expect(summary.title).toContain('Codex');expect(summary.title).not.toContain('GitHub');
  expect(summary.detail).toContain('남은 것만');
});

test('an unsupported device skips the installer without reviewing it',async()=>{
  const c=codex({supported:false} as Partial<CodexInstallEffects>),g=github();
  const sent:string[]=[];const spy:InstallAllTransport=async b=>{sent.push(String(b.operation));return c.transport(b);};
  const reports=await runInstallAll(steps(spy,g.transport),()=>{},{sleep:noSleep});
  expect(reports[0]!.result).toBe('unsupported');expect(sent).toEqual(['status']);
  expect(installAllSummary(reports).detail).toContain('자동 설치를 지원하지 않아');
});

test('an old app without the helper fails that step and still runs the next',async()=>{
  const g=github();const broken:InstallAllTransport=async()=>{throw new Error('지원하지 않는 설치 도우미입니다.');};
  const reports=await runInstallAll(steps(broken,g.transport),()=>{},{sleep:noSleep});
  expect(reports.map(r=>r.result)).toEqual(['failed','installed']);
});

test('an install already running in another window is awaited, not started twice',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const c=codex({prepare:async()=>{await gate;}});
  const reviewed=(await c.host.act('review','0') as any).receipt;await c.host.act('install',reviewed.revision);
  const sent:string[]=[];const spy:InstallAllTransport=async b=>{sent.push(String(b.operation));return c.transport(b);};
  const pending=runInstallAllStep(spy,{sleep:async()=>{release();await Bun.sleep(5);}});
  expect(await pending).toBe('installed');
  expect(sent.every(op=>op==='status')).toBe(true);
});

test('a run that never finishes is reported as failed, not waited on forever',async()=>{
  let now=0;const stuck:InstallAllTransport=async b=>({status:200,body:{success:true,supported:true,interrupted:false,
    receipt:{revision:'r',state:b.operation==='status'&&now===0?null:'installing'}}});
  const result=await runInstallAllStep(stuck,{now:()=>now,sleep:async()=>{now+=INSTALL_ALL_STEP_TIMEOUT_MS/4;}});
  expect(result).toBe('failed');
});

test('only a tool the check proved missing counts as missing',()=>{
  expect(installAllMissing([{id:'codex',state:'missing',installed:false},{id:'github',state:'unknown'}])).toEqual(['codex']);
  expect(installAllMissing([{id:'codex',state:'needs-login',installed:true},{id:'github',state:'ready',installed:true}])).toEqual([]);
  expect(installAllMissing([])).toEqual([]);
});

test('a present tool is never re-run, and a refused tool is not offered again',()=>{
  // Codex installed with an inconclusive login check, GitHub CLI missing → only GitHub runs.
  const diagnostics=[{id:'codex',state:'unknown',installed:true},{id:'github',state:'missing',installed:false}];
  expect(installAllRunnable(diagnostics,[])).toEqual(['github']);
  expect(installAllRunnable(diagnostics,['github'])).toEqual([]);
});

test('the device screen leads with the one button and folds the step-by-step detail',()=>{
  const center=readFileSync(new URL('../src/OnboardingInfrastructureCenter.tsx',import.meta.url),'utf8');
  const install=center.indexOf('<OnboardingInstallAll'),details=center.indexOf('data-testid="onboarding-step-by-step"');
  expect(install).toBeGreaterThan(0);expect(details).toBeGreaterThan(install);
  expect(center.indexOf('<OnboardingPreparation')).toBeGreaterThan(details);
  expect(center.indexOf('aria-label="설치 상태"')).toBeGreaterThan(details);
  // A failed check must not hide inside the folded detail.
  expect(center.indexOf('{loadError && (')).toBeLessThan(details);
  const card=readFileSync(new URL('../src/OnboardingInstallAll.tsx',import.meta.url),'utf8');
  expect(card).toContain('필요한 것 모두 설치');expect(card).toContain('Codex·GitHub CLI 설치 완료');
  // Only missing tools run, and a login panel only appears for a proven signed-out tool.
  expect(card).toContain('INSTALL_ALL_STEPS.filter(step => installable.includes(step.id))');
  expect(card).toContain('installAllRunnable(diagnostics, unsupported)');
  expect(card).toContain("d.state !== 'needs-login'");
  expect(card).not.toContain('관리자 권한 창');
});
