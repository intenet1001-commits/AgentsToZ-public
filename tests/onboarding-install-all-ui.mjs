// 「필요한 것 모두 설치」 in a real browser over the real installer hosts (fake effects only).
// Isolated stores in a temp folder; never touches this device's tools or settings.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexInstallHost,CodexInstallStore} from '../src/onboardingCodexInstallHost.ts';
import {OnboardingGithubStore} from '../src/onboardingGithubStore.ts';
import {OnboardingGithubHost} from '../src/onboardingGithubHost.ts';
const root=mkdtempSync(join(tmpdir(),'install-all-ui-'));
const codexStore=new CodexInstallStore(join(root,'c')),ghStore=new OnboardingGithubStore(join(root,'g'));
let codexPresent=false,ghPresent=false,installs=0,release;const gate=new Promise(r=>{release=r;});
const codex=new CodexInstallHost(codexStore,{supported:true,probe:async()=>codexPresent?'installed':'missing',
 prepare:async()=>{await gate;},install:async()=>{installs++;codexPresent=true;}});
const gh=new OnboardingGithubHost(ghStore,{platform:'darwin',probe:async()=>ghPresent?'installed':'missing',
 prepare:async()=>{},installFile:async()=>{installs++;ghPresent=true;},openLoginPage:async()=>{},login:()=>{throw new Error('no');}});
const hosts={codex,github:gh};
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-install-all/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
assert.equal(build.success,true,build.logs.join('\n'));const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const path=new URL(req.url).pathname;
 if(path==='/fixture/diagnostics')return Response.json([
  codexPresent?{id:'codex',state:'needs-login',installed:true,authenticated:false}:{id:'codex',state:'missing',installed:false},
  ghPresent?{id:'github',state:'needs-login',installed:true,authenticated:false}:{id:'github',state:'missing',installed:false}]);
 const host=hosts[path.replace('/fixture/','')];
 if(host){const body=await req.json();try{return Response.json({success:true,...(body.operation==='status'?host.status():await host.act(body.operation,body.expectedRevision))});}catch{return Response.json({error:'fixture rejected'},{status:409});}}
 if(path==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
 return new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/panel.js"></script>`,{headers:{'Content-Type':'text/html'}});
}});
let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);
 const button=page.getByRole('button',{name:'필요한 것 모두 설치',exact:true});
 await button.waitFor();assert.equal(installs,0,'nothing installs before the press');
 if(css)await page.screenshot({path:'/tmp/onboarding-install-all-before.png',fullPage:true});
 await button.click();
 await page.waitForFunction(()=>document.querySelector('[data-testid=onboarding-install-all-progress]')?.textContent==='진행 중 1/2: Codex');
 assert.equal(await button.count(),0,'the button is gone while running');
 release();
 await page.getByTestId('onboarding-install-all-complete').waitFor();
 assert.equal(installs,2);assert.equal(await page.getByLabel('finished').innerText(),'1');
 assert.equal(await page.getByTestId('onboarding-install-all-summary').count(),0,'a clean finish does not repeat the complete line');
 await page.getByText('남은 일은 로그인뿐입니다. 아래에서 계정을 연결하세요.').waitFor();
 await page.getByRole('heading',{name:'ChatGPT 계정 연결'}).waitFor();
 await page.getByRole('heading',{name:'GitHub 설치·연결'}).waitFor();
 for(const theme of ['gray','dark']){
  await page.evaluate(t=>document.documentElement.dataset.appTheme=t,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal scroll at 390px');
  if(css)await page.screenshot({path:`/tmp/onboarding-install-all-${theme}.png`,fullPage:true});
 }
 await page.reload();await page.getByTestId('onboarding-install-all-complete').waitFor();assert.equal(installs,2,'reload installs nothing');
 // Login panels use the native bridge, which this browser fixture does not have: only those may fail.
 assert.deepEqual(errors,[]);
 console.log('PASS: one press installs both in order with progress, summary, complete state with login panels, no horizontal scroll, reload is idempotent');
}finally{release?.();await browser?.close();await codex.close();await gh.close();codexStore.close();ghStore.close();server.stop(true);rmSync(root,{recursive:true,force:true});}
