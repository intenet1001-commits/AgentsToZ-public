import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexLoginHost} from '../src/onboardingCodexLoginHost.ts';
import {CodexLoginStore} from '../src/onboardingCodexLoginStore.ts';
const root=mkdtempSync(join(tmpdir(),'codex-login-ui-')),store=new CodexLoginStore(root);
let state='signed-out',starts=0,opens=0,cancels=0,finish,emit;
const host=new CodexLoginHost(store,{supported:true,probe:async()=>state,open:async()=>{opens++;},login:(_r,onUrl)=>{starts++;emit=onUrl;return {done:new Promise(r=>finish=r),cancel:()=>{cancels++;}};}});
const url=new URL('https://auth.openai.com/oauth/authorize');
for(const [k,v] of Object.entries({response_type:'code',client_id:'app_EMoamEEZ73f0CkXaXp7hrann',redirect_uri:'http://localhost:1455/auth/callback',scope:'openid profile email offline_access api.connectors.read api.connectors.invoke',code_challenge:'a'.repeat(43),code_challenge_method:'S256',state:'s'.repeat(43)}))url.searchParams.set(k,v);
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-codex-login/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
assert.equal(build.success,true);const js=await build.outputs[0].text();
const css=process.env.ONBOARDING_UI_CSS?await Bun.file(process.env.ONBOARDING_UI_CSS).text():'';
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 if(new URL(req.url).pathname==='/fixture/action'){
  const b=await req.json();try{const value=b.operation==='status'?host.status():await host.act(b.operation,b.expectedRevision);assert.equal(JSON.stringify(value).includes('https:'),false);return Response.json({success:true,...value});}catch{return Response.json({error:'fixture rejected'},{status:409});}
 }
 if(new URL(req.url).pathname==='/panel.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});
 return new Response(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script type="module" src="/panel.js"></script>`,{headers:{'Content-Type':'text/html'}});
}});
let browser;
try{
 browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.port}`);await page.getByRole('button',{name:'로그인 상태 확인',exact:true}).click();
 await page.getByRole('button',{name:'ChatGPT 계정으로 로그인',exact:true}).click();assert.equal(starts,1);emit(url.href);
 await page.getByRole('button',{name:'로그인 화면 열기',exact:true}).click();assert.equal(opens,1);
 await page.reload();await page.getByRole('button',{name:'로그인 화면 열기',exact:true}).waitFor();assert.equal(starts,1);assert.equal(opens,1);
 for(const theme of ['gray','dark']){await page.evaluate(t=>document.documentElement.dataset.appTheme=t,theme);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/onboarding-codex-auth-${theme}.png`,fullPage:true});}
 await page.getByRole('button',{name:'로그인 취소 · 나중에',exact:true}).click();assert.equal(cancels,1);state='configured';finish();await Bun.sleep(20);
 await page.reload();await page.getByText('로그인은 나중에 이어갈 수 있습니다',{exact:true}).waitFor();assert.equal(starts,1);
 await page.getByRole('button',{name:'로그인 상태 확인',exact:true}).click();await page.getByRole('button',{name:'첫 AI 작업으로 이어가기',exact:true}).click();assert.equal(await page.getByLabel('next-step').innerText(),'1');
 assert.deepEqual(errors,[]);console.log('PASS: explicit login/open, reload without replay, cancel and late response, readback/first-task, 390px light/dark, no URL in DTO');
}finally{finish?.();await browser?.close();await host.close();store.close();server.stop(true);rmSync(root,{recursive:true,force:true});}
