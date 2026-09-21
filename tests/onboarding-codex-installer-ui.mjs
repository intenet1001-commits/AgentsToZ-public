import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexInstallHost,CodexInstallStore} from '../src/onboardingCodexInstallHost.ts';
const root=mkdtempSync(join(tmpdir(),'codex-installer-ui-')),store=new CodexInstallStore(root);
let state='missing',installs=0,checks=0,finish;
const host=new CodexInstallHost(store,{supported:true,probe:async()=>{checks++;return state;},
 prepare:()=>new Promise(resolve=>finish=resolve),install:async()=>{installs++;state='installed';}});
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-codex-installer/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
assert.equal(build.success,true);const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 if(new URL(req.url).pathname==='/fixture/action'){
  const body=await req.json();try{return Response.json({success:true,...(body.operation==='status'?host.status():await host.act(body.operation,body.expectedRevision))});}catch{return Response.json({error:'fixture rejected'},{status:409});}
 }
 if(new URL(req.url).pathname==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
 return new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/panel.js"></script>`,{headers:{'Content-Type':'text/html'}});
}});
let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);
 await page.getByRole('button',{name:'자동 설치 준비',exact:true}).click();assert.equal(installs,0);assert.equal(checks,0);
 await page.getByRole('button',{name:'확인하고 설치',exact:true}).waitFor();
 for(const theme of ['gray','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
  if(css){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/onboarding-codex-installer-${theme}.png`,fullPage:true});}
 }
 await page.getByRole('button',{name:'확인하고 설치',exact:true}).click();
 await page.getByRole('button',{name:'설치 중단',exact:true}).waitFor();
 await page.reload();await page.getByRole('button',{name:'설치 중단',exact:true}).waitFor();assert.equal(checks,1);
 finish();await page.getByRole('button',{name:'다음 단계 확인',exact:true}).waitFor();assert.equal(installs,1);
 const priorChecks=checks;await page.reload();await page.getByRole('button',{name:'다음 단계 확인',exact:true}).waitFor();assert.equal(checks,priorChecks);
 assert.equal(await page.getByLabel('next-step').innerText(),'0');
 await page.getByRole('button',{name:'다음 단계 확인',exact:true}).click();assert.equal(await page.getByLabel('next-step').innerText(),'1');
 state='unknown';await page.getByRole('button',{name:'설치 결과 확인',exact:true}).click();
 await page.getByText('이전 결과를 확인한 뒤 이어가세요',{exact:true}).waitFor();assert.equal(installs,1);
 assert.deepEqual(errors,[]);console.log('PASS: explicit review/install, pending reload without replay, completion/reload, explicit next step, unknown preserves installation, mobile themes');
}finally{finish?.();await browser?.close();await host.close();store.close();server.stop(true);rmSync(root,{recursive:true,force:true});}
