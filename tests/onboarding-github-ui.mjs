import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OnboardingGithubStore} from '../src/onboardingGithubStore.ts';
import {OnboardingGithubHost} from '../src/onboardingGithubHost.ts';
const root=mkdtempSync(join(tmpdir(),'onboarding-github-ui-')),store=new OnboardingGithubStore(root);
let state='missing',installs=0,logins=0,opened=0,finish;
const host=new OnboardingGithubHost(store,{platform:'darwin',probe:async()=>state,prepare:async()=>{},installFile:async()=>{installs++;state='installed';},openLoginPage:async()=>{opened++;},login:code=>{logins++;const done=new Promise(resolve=>finish=resolve);setTimeout(()=>code('ABCD-1234'),10);return {done,cancel:()=>finish()};}});
const build=await Bun.build({entrypoints:['tests/fixtures/onboarding-github/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
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
 await page.getByRole('button',{name:'설치 준비',exact:true}).click();assert.equal(installs,0);
 await page.getByRole('button',{name:'확인하고 설치 시작'}).waitFor();
 if(css){await page.evaluate(()=>document.documentElement.dataset.appTheme='gray');await page.screenshot({path:'/tmp/onboarding-github-review.png',fullPage:true});}
 await page.getByRole('button',{name:'확인하고 설치 시작'}).click();
 await page.getByRole('button',{name:'GitHub 계정 연결',exact:true}).waitFor();assert.equal(installs,1);
 await page.getByRole('button',{name:'GitHub 계정 연결',exact:true}).click();
 await page.getByText('ABCD-1234',{exact:true}).waitFor();assert.equal(logins,1);
 await page.reload();await page.getByText('ABCD-1234',{exact:true}).waitFor();assert.equal(logins,1);
 await Promise.all([page.waitForResponse(r=>r.url().endsWith('/fixture/action')&&r.request().postDataJSON()?.operation==='open-login'),page.getByRole('button',{name:'코드 복사하고 GitHub 열기'}).click()]);assert.equal(opened,1);
 state='ready';finish();await page.getByText('GitHub 연결 확인',{exact:true}).waitFor();
 assert.equal(await page.getByText('ABCD-1234',{exact:true}).count(),0);
 for(const theme of ['gray','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
  if(css){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:`/tmp/onboarding-github-${theme}.png`,fullPage:true});}
 }
 state='storage-review';
 await page.getByRole('button',{name:'설치·연결 결과 확인'}).click();
 await page.getByText('로그인 정보 저장 방식 확인 필요',{exact:true}).waitFor();
 await page.reload();await page.getByText('로그인 정보 저장 방식 확인 필요',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'GitHub 계정 연결',exact:true}).count(),0);
 assert.equal(logins,1);assert.equal(installs,1);
 assert.deepEqual(errors,[]);console.log('PASS: review → one install → login → reload without re-login → code handoff → verified completion; plaintext storage stays unresolved after reload');
}finally{await browser?.close();await host.close();store.close();server.stop(true);rmSync(root,{recursive:true,force:true});}
