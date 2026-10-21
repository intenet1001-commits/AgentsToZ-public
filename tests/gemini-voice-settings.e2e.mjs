import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'gemini-ui-fixture-'));mkdirSync(join(temp,'env'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
const vite=await createServer({root,configFile:join(root,'vite.config.ts'),envDir:join(temp,'env'),mode:'test',cacheDir:join(temp,'node_modules/.vite'),logLevel:'error',server:{host:'127.0.0.1',port:0,strictPort:false,open:false}});
let assertions=0;
const fixtureKey='AQ.fixture_not_a_real_key.'.padEnd(2048,'x');
try{
 await vite.listen();const address=vite.httpServer.address();const origin=`http://127.0.0.1:${address.port}`;
 const source=await fetch(origin+'/src/GeminiVoiceSettingsPanel.tsx').then(r=>r.text());
 const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
 const dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
 assert.ok(react&&dom);
 for(const [engineName,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:390,height:850},serviceWorkers:'block'});const page=await context.newPage();const browserRequests=[];
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/api/open-browser'){browserRequests.push(JSON.parse(route.request().postData()??'{}'));return route.fulfill({contentType:'application/json',body:'{"success":true}'});}
    if(url.pathname.startsWith('/api/'))return route.abort();
    if(url.pathname!=='/__gemini-fixture')return route.continue();
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import '/src/index.css';import '/src/AiTerminalPanel.css';
const {GeminiVoiceSettings}=await import('/src/GeminiVoiceSettingsPanel.tsx');
const {parseGeminiVoiceSettingsRequest}=await import('/src/geminiVoiceSettings.ts');
window.fixture={configured:false,failSave:false,falseReceipt:false,loseRead:false,calls:[]};
const transport=async request=>{parseGeminiVoiceSettingsRequest(request);const f=window.fixture;f.calls.push(request.operation);await new Promise(resolve=>setTimeout(resolve,15));if(request.operation==='save'){if(f.failSave)throw Error('테스트 저장 실패');if(!f.falseReceipt)f.configured=true;}if(request.operation==='delete')f.configured=false;return {supported:true,configured:request.operation==='status'&&f.loseRead?false:f.configured,model:'gemini-3.8-live',checkedAt:null,checkedModel:null};};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement('div',{className:'ai-terminal-panel'},React.createElement(GeminiVoiceSettings,{transport}))));</script>`});
   });
   await page.goto(origin+'/__gemini-fixture');
   const toggle=()=>page.getByRole('button',{name:/Gemini 음성 설정/});
   await page.getByRole('button',{name:/Gemini 음성 설정 키 미등록/}).waitFor();assertions++;
   await toggle().click();const input=page.getByLabel('Gemini API 키',{exact:true});
   await input.fill(fixtureKey);await page.getByText(/입력한 키는 아직 저장 전/).waitFor();assert.equal(await input.inputValue(),fixtureKey);assertions++;
   await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/open-browser')),page.getByRole('button',{name:'Gemini 공식 API 키 발급 페이지 열기 ↗'}).click()]);assert.equal(browserRequests.at(-1).url,'https://aistudio.google.com/apikey');assert.equal(await input.inputValue(),fixtureKey);assert.equal(await page.evaluate(()=>window.fixture.calls.filter(call=>call==='save').length),0);assertions++;
   await toggle().click();await toggle().click();assert.equal(await input.inputValue(),fixtureKey);assertions++;
   await page.evaluate(()=>window.fixture.failSave=true);await input.press('Enter');await page.getByRole('alert').filter({hasText:'테스트 저장 실패'}).waitFor();assert.equal(await input.inputValue(),fixtureKey);assertions++;
   await page.getByRole('button',{name:'상태 새로고침'}).click();await page.waitForFunction(()=>!document.querySelector('button[disabled]')?.textContent?.includes('상태 새로고침'));assert.equal(await page.getByRole('alert').textContent(),'테스트 저장 실패');assertions++;
   await page.evaluate(()=>{window.fixture.failSave=false;window.fixture.falseReceipt=true;});await page.getByRole('button',{name:'키 저장',exact:true}).click();await page.getByRole('alert').filter({hasText:'키 저장 완료를 확인하지 못했습니다.'}).waitFor();assert.equal(await input.inputValue(),fixtureKey);assertions++;
   await page.evaluate(()=>{window.fixture.falseReceipt=false;window.fixture.loseRead=true;});await input.press('Enter');await page.getByRole('alert').filter({hasText:'저장 후 다시 읽기'}).waitFor();assertions++;
   await page.evaluate(()=>window.fixture.loseRead=false);await input.press('Enter');await page.getByText(/API 키 저장 완료 · 저장된 설정을 다시 읽어/).waitFor();assert.equal(await input.inputValue(),'');assert.equal(await page.getByRole('button',{name:'Live 연결 검사',exact:true}).isEnabled(),true);assertions++;
   await toggle().click();await page.getByRole('button',{name:/Gemini 음성 설정 키 저장됨/}).waitFor();await toggle().click();assert.equal(await input.getAttribute('placeholder'),'저장된 키 사용 중 · 교체할 때만 새 키 입력');assertions++;
   const box=await input.boundingBox();assert.ok(box.height>=44);assert.ok(box.width>250);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assertions++;
   assert.deepEqual(errors,[]);assertions++;
   await context.close();console.log(engineName+': passed');
  }finally{await browser.close();}
 }
 console.log(`${assertions} UI checks passed`);
}finally{await vite.close();rmSync(temp,{recursive:true,force:true});}
