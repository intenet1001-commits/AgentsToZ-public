// Actual Mac/phone Workroom component, isolated transport. No installed app, CLI or external API.
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium,webkit} from 'playwright';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
const shots=process.env.WORKROOM_KEYS_SCREENSHOTS;if(shots)await mkdir(shots,{recursive:true});
const vite=await createServer({server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[process.cwd(),realpathSync(resolve('node_modules'))]}},clearScreen:false});
const session={id:'number-keys-session',targetId:'number-keys-project',agent:'codex',state:'running',createdAt:new Date().toISOString(),exitCode:null,cols:100,rows:28};
const projects=[{targetId:session.targetId,label:'숫자 선택 테스트'}];
try{
 await vite.listen();const origin=`http://127.0.0.1:${vite.httpServer.address().port}`;
 const source=await fetch(origin+'/src/AiTerminalPanel.tsx').then(r=>r.text()),main=await fetch(origin+'/src/main.tsx').then(r=>r.text());
 const react=source.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react\.js[^"\n]*)"/)[1],dom=main.match(/"([^"\n]*\/node_modules\/\.vite\/deps\/react-dom_client\.js[^"\n]*)"/)[1];
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();
  try{for(const remote of [false,true]){
   const context=await browser.newContext({viewport:{width:remote?390:1100,height:844},hasTouch:remote,serviceWorkers:'block'});
   try{
    const page=await context.newPage(),inputs=[],errors=[];let fail=false,hook=false,seq=1;page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',async route=>{
     const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();
     if(url.pathname==='/__keys')return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(dom)};import '/src/index.css';import '/src/workspaceDesign.css';
RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
const {AiTerminalPanel}=await import('/src/AiTerminalPanel.tsx');document.documentElement.dataset.appTheme='gray';
const transport=async body=>{const r=await fetch('/api/agent-runtime/terminals',{method:'POST',body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AiTerminalPanel,{visible:true,remote:${remote},projects:${JSON.stringify(projects)},entry:{nonce:1,targetId:${JSON.stringify(session.targetId)},sessionId:${JSON.stringify(session.id)}},transport,workspaceTransport:transport,sessionScope:'number-keys-${name}-${remote}'}));</script>`});
     if(!url.pathname.startsWith('/api/'))return route.continue();
     if(url.pathname.endsWith('/targets'))return route.fulfill({json:{targets:projects,complete:true,protocolVersion:'agentstoz-tasks-v2'}});
     if(url.pathname.endsWith('/access'))return route.fulfill({json:{connections:[]}});
     if(url.pathname.endsWith('/memory'))return route.fulfill({json:{jobs:[]}});
     if(!url.pathname.endsWith('/terminals'))return route.fulfill({json:{supported:false}});
     const body=req.postDataJSON();
     if(body.operation==='list')return route.fulfill({json:{sessions:[session]}});
     if(body.operation==='accounts')return route.fulfill({json:{accounts:{agent:'codex',selectedAccountId:'host-default',items:[{id:'host-default',agent:'codex',label:'현재 CLI 계정',authState:'unknown',checkedAt:null,loginState:'idle'}]}}});
     if(body.operation==='workspace')return route.fulfill({status:400,json:{error:'지원하지 않는 모바일 작업'}});
     if(body.operation==='read')return route.fulfill({json:{session,chunks:body.after>=seq?[]:[{seq,text:'\x1b[2J\x1b[H'+(hook?'Hooks\r\nLifecycle hooks from config and enabled plugins.\r\nUserPromptSubmit 2/3 !\r\nt trust all · enter review · esc close':'번호를 선택하세요.\r\n1. 첫 선택\r\n4. 네번째 선택')+'\r\n'}],nextCursor:seq,hasMore:false,truncated:false}});
     if(body.operation==='input'){inputs.push(body.data);if(fail)return route.fulfill({status:409,json:{error:'이전 전송 결과를 확인하세요. 자동으로 다시 보내지 않습니다.'}});}
     return route.fulfill({json:{session}});
    });
    await page.goto(origin+'/__keys');const keys=page.getByRole('group',{name:'터미널 키'});await keys.getByRole('button',{name:'1',exact:true}).waitFor();
    const moreBounds=await keys.getByRole('button',{name:'더보기',exact:true}).boundingBox();assert.ok(moreBounds.x>=0&&moreBounds.x+moreBounds.width<=page.viewportSize().width,'More is reachable without horizontal scrolling');
    const delivered=async(number,count)=>{await page.waitForFunction(()=>true);for(let i=0;i<80&&inputs.filter(x=>x===number).length<count;i++)await page.waitForTimeout(25);assert.equal(inputs.filter(x=>x===number).length,count);};
    await keys.getByRole('button',{name:'1',exact:true}).click();await delivered('1',1);
    assert.equal(await keys.getByRole('button',{name:'터미널 직접 입력',exact:true}).getAttribute('aria-pressed'),'false','quick keys do not turn on raw keyboard');
    for(const number of ['4','9','0']){
     await keys.getByRole('button',{name:'더보기',exact:true}).click();const dialog=page.getByRole('dialog',{name:'숫자 선택'});await dialog.waitFor();
     const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=page.viewportSize().width&&box.y+box.height<=page.viewportSize().height);
     if(shots&&number==='4')await page.screenshot({path:resolve(shots,`${name}-${remote?'phone':'mac'}-number-popup.png`)});
     assert.equal(await dialog.getByRole('button',{name:number,exact:true}).evaluate(e=>e.getBoundingClientRect().height>=44),true);
     await dialog.getByRole('button',{name:number,exact:true}).click();await delivered(number,1);assert.equal(await dialog.count(),0);
    }
    await keys.getByRole('button',{name:'더보기',exact:true}).click();const before=inputs.length;await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog',{name:'숫자 선택'}).count(),0);assert.equal(inputs.length,before,'popup Escape never interrupts the CLI');
    assert.equal(await keys.getByRole('button',{name:'더보기',exact:true}).evaluate(e=>e===document.activeElement),true);
    hook=true;seq=2;await page.waitForFunction(()=>document.querySelector('.xterm-rows')?.textContent.includes('Hooks'));
    const count=inputs.length;await keys.getByRole('button',{name:'3',exact:true}).click();await page.getByRole('alert').filter({hasText:'숫자 선택을 받지 않습니다'}).waitFor();assert.equal(inputs.length,count,'Hooks digits never turn into trust approval');
    await keys.getByRole('button',{name:'더보기',exact:true}).click();await page.getByRole('dialog',{name:'숫자 선택'}).getByRole('button',{name:'5',exact:true}).click();assert.equal(await page.getByRole('dialog',{name:'숫자 선택'}).count(),0);assert.equal(inputs.length,count);
    hook=false;seq=3;await page.waitForFunction(()=>!document.querySelector('.xterm-rows')?.textContent.includes('Hooks'));
    fail=true;await keys.getByRole('button',{name:'2',exact:true}).click();await page.getByRole('alert').filter({hasText:'이전 전송 결과'}).waitFor();await page.waitForTimeout(300);assert.equal(inputs.filter(x=>x==='2').length,1,'failed input is never automatically retried');
    assert.deepEqual(errors,[]);console.log(`${name} ${remote?'phone':'Mac'}: numbered choices, More popup, no keyboard activation, Escape and failed-delivery fencing passed`);
   }finally{await context.close();}
  }}finally{await browser.close();}
 }
}finally{await vite.close();}
