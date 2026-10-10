/** Isolated real React UI; fixture keys only, no Keychain or provider traffic. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const temp=mkdtempSync(join(tmpdir(),'voice-settings-ui-'));mkdirSync(join(temp,'env'));
for(const key of Object.keys(process.env))if(key.startsWith('VITE_'))delete process.env[key];
const baseline=process.env.VOICE_UI_BASELINE==='1';
const overrides=baseline?new Map(['VoiceSessionPanel.tsx','VoiceSessionPanel.css'].map(name=>[join(root,'src',name),execFileSync('git',['show','HEAD:src/'+name],{cwd:root,encoding:'utf8'})])):new Map();
const vite=await createServer({root,configFile:join(root,'vite.config.ts'),envDir:join(temp,'env'),mode:'test',cacheDir:join(temp,'node_modules/.vite'),logLevel:'error',plugins:[{name:'voice-settings-baseline',enforce:'pre',load:id=>overrides.get(id)}],server:{host:'127.0.0.1',port:0,strictPort:false,open:false}});
const fixtureKey='fixture-key-'+ 'a'.repeat(40);let checks=0;
try{
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const source=await fetch(origin+'/src/VoiceSessionPanel.tsx').then(r=>r.text());
 const main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)?.[1];
 const dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];assert.ok(react&&dom);
 for(const [engineName,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:768,height:807},serviceWorkers:'block'});const page=await context.newPage();const errors=[],browserRequests=[];
   page.on('pageerror',e=>errors.push(e.message));
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();
    if(url.pathname==='/api/open-browser'){browserRequests.push(JSON.parse(route.request().postData()??'{}'));return route.fulfill({contentType:'application/json',body:'{"success":true}'});}
    if(url.pathname.startsWith('/api/'))return route.abort();
    if(url.pathname!=='/__voice-settings')return route.continue();
    return route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="white-space:nowrap"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import '/src/index.css';import '/src/appearanceTokens.css';
const {VoiceButton}=await import('/src/VoiceSessionPanel.tsx');const {normalizeVoiceRequest}=await import('/src/voiceSessionProtocol.ts');
document.documentElement.dataset.appTheme='gray';
window.fixture={configured:false,failSave:false,falseReceipt:false,loseRead:false,holdCapabilities:false,releaseCapabilities:null,capabilityResponses:0,calls:[]};
const transport=async request=>{normalizeVoiceRequest(request);const f=window.fixture;f.calls.push({action:request.action,provider:request.provider,model:request.model,keyTrimmed:request.apiKey===undefined||request.apiKey===request.apiKey.trim()});await new Promise(resolve=>setTimeout(resolve,150));if(request.action==='capabilities'&&f.holdCapabilities){f.holdCapabilities=false;await new Promise(resolve=>f.releaseCapabilities=resolve);}if(request.action==='configure'){if(f.failSave)throw Error('테스트 저장 실패');if(!f.falseReceipt)f.configured=!request.removeKey;}const configured=request.action==='capabilities'&&f.loseRead?false:f.configured;if(request.action==='capabilities')f.capabilityResponses++;return {configured,keySource:configured?'keychain':'none',model:'gpt-realtime-2.1',voice:'marin',providers:{openai:{configured,model:'gpt-realtime-2.1',keySource:configured?'keychain':'none'},gemini:{configured:false,model:'gemini-live-fixture',keySource:'none'}}};};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(VoiceButton,{target:location.search.includes('workroom')?{kind:'workroom',targetId:'target_fixture',sessionId:'session_fixture'}:{kind:'ops'},label:'AgentsToZ OPS',transport})));</script>`});
   });
   await page.goto(origin+'/__voice-settings');await page.getByTestId('ops-voice-button').waitFor();
   await page.evaluate(()=>{window.fixture.holdCapabilities=true;});
   await page.getByTestId('ops-voice-button').click();
   const panel=page.getByTestId('voice-panel');
   await page.waitForFunction(()=>typeof window.fixture.releaseCapabilities==='function');
   const initialProvider=panel.getByRole('combobox',{name:'음성 제공자'});
   await initialProvider.selectOption('gemini');
   await panel.locator('details > summary').click();
   await panel.getByRole('textbox',{name:'Gemini 음성 모델'}).fill('gemini-user-draft');
   await panel.getByLabel('Gemini API 키').fill('gemini-key-draft');
   await page.evaluate(()=>window.fixture.releaseCapabilities());
   await page.waitForFunction(()=>window.fixture.capabilityResponses>0);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.equal(await initialProvider.inputValue(),'gemini','a late capabilities response must keep the person-selected provider');checks++;
   assert.equal(await panel.getByRole('textbox',{name:'Gemini 음성 모델'}).inputValue(),'gemini-user-draft','a late capabilities response must keep the edited model');checks++;
   assert.equal(await panel.getByLabel('Gemini API 키').inputValue(),'gemini-key-draft','a late capabilities response must keep the unsaved key');checks++;
   await initialProvider.selectOption('openai');await panel.locator('input[type=password]').waitFor();
   const input=panel.locator('input[type=password]');await input.fill('  '+fixtureKey+'  ');
   await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/open-browser')),panel.getByRole('button',{name:'OpenAI 공식 API 키 발급 페이지 열기 ↗'}).click()]);
   assert.equal(browserRequests.at(-1).url,'https://platform.openai.com/api-keys');assert.equal(await input.inputValue(),'  '+fixtureKey+'  ');assert.equal(await page.evaluate(()=>window.fixture.calls.filter(r=>r.action==='configure').length),0);checks++;
   await input.press('Enter');
   await page.waitForFunction(()=>window.fixture.calls.some(r=>r.action==='configure'),null,{timeout:2000});checks++;
   await page.getByText(/OpenAI 설정 저장 완료/).waitFor();assert.equal(await input.count(),0);await panel.getByText('✓ 키 저장됨',{exact:true}).waitFor();checks++;
   assert.equal(await page.evaluate(()=>window.fixture.calls.filter(r=>r.action==='configure').length),1);checks++;
   assert.equal(await page.evaluate(()=>window.fixture.calls.find(r=>r.action==='configure').keyTrimmed),true);checks++;
   const consent=panel.locator('input[type=checkbox]').first(),start=page.getByRole('button',{name:'마이크 켜고 시작'});
   assert.equal(await panel.getByRole('combobox',{name:'음성 제공자'}).inputValue(),'openai');checks++;assert.equal(await panel.getByRole('button',{name:'저장됨',exact:true}).isEnabled(),false);checks++;
   assert.equal(await start.isEnabled(),false);await consent.check();assert.equal(await start.isEnabled(),true);checks++;
   await panel.getByRole('button',{name:'키 변경',exact:true}).click();await input.fill(fixtureKey);await page.getByText(/입력한 키는 아직 저장 전/).waitFor();assert.equal(await start.isEnabled(),false);checks++;
   await page.evaluate(()=>window.fixture.failSave=true);await input.press('Enter');await page.getByRole('alert').filter({hasText:'테스트 저장 실패'}).waitFor();assert.equal(await input.inputValue(),fixtureKey);checks++;
   await page.evaluate(()=>{window.fixture.failSave=false;window.fixture.falseReceipt=true;window.fixture.configured=false;});await input.press('Enter');await page.getByRole('alert').filter({hasText:'키 저장 완료를 확인하지 못했습니다.'}).waitFor();assert.equal(await input.inputValue(),fixtureKey);checks++;
   await page.evaluate(()=>{window.fixture.falseReceipt=false;window.fixture.loseRead=true;});await input.press('Enter');await page.getByRole('alert').filter({hasText:'저장된 설정을 다시 확인하지 못했습니다.'}).waitFor();assert.equal(await input.inputValue(),fixtureKey);checks++;
   await page.evaluate(()=>window.fixture.loseRead=false);await input.press('Enter');await page.getByText(/OpenAI 설정 저장 완료/).waitFor();assert.equal(await start.isEnabled(),true);checks++;
   assert.equal(await panel.locator('.voice-fixed-mode').textContent(),'입력 방식실시간 대화 · 지시 전 확인');checks++;
   await panel.getByRole('button',{name:'키 변경',exact:true}).click();await input.fill(fixtureKey);await panel.getByRole('button',{name:'변경 취소',exact:true}).click();assert.equal(await input.count(),0);assert.equal(await start.isEnabled(),true);checks++;
   const beforeNoop=await page.evaluate(()=>window.fixture.calls.filter(r=>r.action==='configure').length);await panel.getByRole('textbox',{name:'OpenAI 음성 모델'}).press('Enter');await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>window.fixture.calls.filter(r=>r.action==='configure').length),beforeNoop);checks++;
   await panel.getByRole('button',{name:'음성 패널 닫기'}).click();await page.getByTestId('ops-voice-button').click();await panel.getByText('✓ 키 저장됨',{exact:true}).waitFor();assert.equal(await input.count(),0);checks++;
   const providerSelect=panel.getByRole('combobox',{name:'음성 제공자'});await providerSelect.selectOption('gemini');await panel.getByText(/Gemini 키 미등록/).waitFor();assert.equal(await start.isEnabled(),false);assert.ok((await panel.textContent()).includes('필요한 OPS 기억·워크룸 출력을 Gemini로 전송'));checks++;
   await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/open-browser')),panel.getByRole('button',{name:'Gemini 공식 API 키 발급 페이지 열기 ↗'}).click()]);assert.equal(browserRequests.at(-1).url,'https://aistudio.google.com/apikey');checks++;
   await providerSelect.selectOption('openai');await panel.getByText('✓ 키 저장됨',{exact:true}).waitFor();assert.equal(await start.isEnabled(),true);checks++;
   for(const theme of ['gray','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.appTheme=theme,theme);
    const contrast=await panel.getByRole('button',{name:'음성 패널 닫기'}).evaluate(el=>{
     const s=getComputedStyle(el),lum=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]};const a=lum(s.color),b=lum(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    });assert.ok(contrast>=4.5,`${theme} button contrast ${contrast}`);checks++;
   }
   await page.setViewportSize({width:390,height:850});assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));checks++;
   assert.deepEqual(errors,[]);checks++;
   await page.goto(origin+'/__voice-settings?workroom');await page.getByTestId('workroom-voice-button').click();
   const mode=page.getByRole('combobox',{name:'입력 방식'});assert.equal(await mode.inputValue(),'dictation');assert.equal(await mode.locator('option').count(),2);await mode.selectOption('conversation');assert.equal(await mode.inputValue(),'conversation');checks++;
   await page.getByRole('combobox',{name:'음성 제공자'}).selectOption('gemini');assert.equal(await page.getByRole('combobox',{name:'입력 방식'}).count(),0);assert.ok((await page.locator('.voice-fixed-mode').textContent()).includes('실시간 대화'));checks++;
   await context.close();console.log(engineName+': passed');
  }finally{await browser.close();}
 }
 console.log(`${checks} dual-provider voice settings UI checks passed`);
}finally{await vite.close();rmSync(temp,{recursive:true,force:true});}
