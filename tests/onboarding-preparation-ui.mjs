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
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-preparation/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
if(!build.success)throw new Error(build.logs.join('\n'));
const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
let checks=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:req=>{
 const path=new URL(req.url).pathname;
 if(path==='/api/onboarding/progress')return handleOnboardingProgress(req,{store:()=>store,platform:'mac',diagnose:async()=>{checks++;return[{id:'codex',state:'ready',installed:true}];}});
 if(path==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
 return new Response('<style>'+css+'</style><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
let browser;
try {
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);
 await page.getByRole('button',{name:'준비 목록 저장'}).click();
 await page.getByRole('button',{name:'설치·로그인 상태 확인',exact:true}).click();
 await page.getByText('Codex CLI · 설치 확인 · 로그인은 별도 확인',{exact:true}).waitFor();
 assert.equal(checks,1);
 await page.reload();
 await page.getByText('Codex CLI · 설치 확인 · 로그인은 별도 확인',{exact:true}).waitFor();
 assert.equal(checks,1,'reload must not rerun diagnostics');
 await page.getByRole('button',{name:'이 도구는 나중에'}).click();
 await page.getByRole('button',{name:'이어서 준비',exact:true}).waitFor();
 await page.reload();
 await page.getByRole('button',{name:'이어서 준비',exact:true}).click();
 await page.getByText('Codex CLI · 확인 전',{exact:true}).waitFor();
 assert.equal(checks,1,'resume must not claim completion or auto-run');
 for(const theme of ['gray','dark']) {
  await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  if(process.env.ONBOARDING_UI_CSS)await page.screenshot({path:`/tmp/onboarding-preparation-${theme}.png`,fullPage:true});
 }
 assert.deepEqual(errors,[]);
 console.log('PASS: StrictMode mount, saved selection, evidence distinction, reload, defer/resume, no automatic replay');
}finally{await browser?.close();server.stop(true);store.close();rmSync(dir,{recursive:true,force:true});}
