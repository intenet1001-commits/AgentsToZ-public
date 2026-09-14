// Isolated host store + real browser; never reads installed user configuration.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OnboardingProgressStore} from '../src/onboardingProgressStore.ts';
import {handleOnboardingProgress} from '../src/onboardingProgressHttp.ts';
const dir=mkdtempSync(join(tmpdir(),'onboarding-ui-'));
const store=new OnboardingProgressStore(dir);
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-codex/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
if(!build.success)throw new Error(build.logs.join('\n'));
const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
let checks=0,diagnostic={id:'codex',state:'missing',installed:false};
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{
 const path=new URL(req.url).pathname;
 if(path==='/api/onboarding/progress')return handleOnboardingProgress(req,{store:()=>store,platform:'mac',diagnose:async()=>{checks++;return[diagnostic];}});
 if(path==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
 return new Response('<style>'+css+'</style><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
let browser;
try {
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);
 await page.getByRole('button',{name:'준비 목록 저장'}).click();
 const check=()=>page.getByRole('button',{name:'설치·로그인 상태 확인',exact:true}).click();
 await check();await page.getByRole('button',{name:'공식 설치 명령 복사'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'첫 AI 작업 열기'}).count(),0);
 diagnostic={id:'codex',state:'needs-login',installed:true,authenticated:false};
 await check();await page.getByRole('button',{name:'로그인 명령 복사'}).waitFor();
 diagnostic={id:'codex',state:'ready',installed:true,authenticationEvidence:'cached'};
 await check();await page.getByText('Codex CLI · 로그인 정보 있음 · 첫 작업 확인 필요',{exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'첫 AI 작업 열기'}).waitFor();
 assert.equal(checks,3);assert.equal(await page.getByLabel('first-task-opens').innerText(),'0');
 await page.getByRole('button',{name:'첫 AI 작업 열기'}).click();
 assert.equal(await page.getByLabel('first-task-opens').innerText(),'1');
 diagnostic={id:'codex',state:'unknown',installed:true};
 await check();await page.getByText('Codex CLI · 현재 상태 확인 필요',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'로그인 명령 복사'}).count(),0);
 assert.equal(await page.getByRole('button',{name:'첫 AI 작업 열기'}).count(),0);
 for(const theme of ['gray','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.ONBOARDING_UI_CSS)await page.screenshot({path:`/tmp/onboarding-codex-${theme}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: missing → login needed → cached credentials → reload without probing or task launch → explicit first-task navigation; unknown state preserves login');
}finally{await browser?.close();server.stop(true);store.close();rmSync(dir,{recursive:true,force:true});}
