/** Chromium at an intercepted, insecure HTTP origin. No LAN, API or AI request escapes. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const source=JSON.parse(execFileSync('bun',['-e',"import {REMOTE_CONTROL_MOBILE_JS} from './src/remoteControlMobilePage';process.stdout.write(JSON.stringify(REMOTE_CONTROL_MOBILE_JS));"],{cwd:new URL('..',import.meta.url),encoding:'utf8'}));
const helpers=source.slice(source.indexOf('const projectIntentFingerprint ='),source.indexOf('let lastActionName ='));
const handlers=source.slice(source.indexOf('function projectCreateDraftChanged()'),source.indexOf('function sendAction(action, controlId'));
const html=`<!doctype html><meta charset="utf-8"><input id="create-name" value="비공개 프로젝트"><select id="create-root"><option value="${'R'.repeat(43)}">Root</option></select><button id="create-project">프로젝트 만들기</button><script>
const sessionToken='fixture-pairing-bearer',workspaceRoots=[{controlId:'${'R'.repeat(43)}'}],PROTOCOL_VERSION=7;
let inFlight=false,lastActionCode='',lastActionName='';window.sent=[];window.errors=[];
const socket={readyState:1,send:raw=>sent.push(JSON.parse(raw))};
function setBusy(value){inFlight=value;}function recordError(context,error){errors.push(error.message);}function notify(){}
${helpers}
${handlers}
window.retry=()=>{inFlight=false;};
</script>`;
const browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:'block'});const unexpected=[];
try{
await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.href==='http://192.0.2.2/__lan-create')return route.fulfill({contentType:'text/html',body:html});unexpected.push(url.href);return route.abort();});
const page=await context.newPage();await page.goto('http://192.0.2.2/__lan-create');
assert.deepEqual(await page.evaluate(()=>({secure:isSecureContext,subtle:typeof crypto.subtle,random:typeof crypto.getRandomValues})),{secure:false,subtle:'undefined',random:'function'});
await page.getByRole('button',{name:'프로젝트 만들기'}).click();const id=await page.evaluate(()=>sent[0].actionId);
await page.evaluate(()=>retry());await page.getByRole('button',{name:'프로젝트 만들기'}).click();assert.equal(await page.evaluate(()=>sent[1].actionId),id);
await page.reload();await page.getByRole('button',{name:'프로젝트 만들기'}).click();assert.equal(await page.evaluate(()=>sent[0].actionId),id);
const saved=await page.evaluate(()=>localStorage.getItem('agentstoz-project-create-intents-v1'));assert.ok(!saved.includes('비공개 프로젝트')&&!saved.includes('fixture-pairing-bearer'));
assert.deepEqual(await page.evaluate(()=>errors),[]);assert.deepEqual(unexpected,[]);
const result={passed:true,secureContext:false,subtleAvailable:false,actualGetRandomValues:true,sameIdAcrossTimeoutAndReload:true,noSecretsStored:true};
const output=new URL('../output/playwright/',import.meta.url);await mkdir(output,{recursive:true});await writeFile(new URL('remote-project-create-lan-results.json',output),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await context.close();await browser.close();}
