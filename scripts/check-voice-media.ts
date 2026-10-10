/** Isolated browser UI/event lifecycle; fake microphone and provider, no credentials. */
import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
const built=await Bun.build({entrypoints:['tests/fixtures/voice/panel.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error('UI fixture build failed');
const js=built.outputs.find(o=>o.path.endsWith('.js')),css=built.outputs.find(o=>o.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{const path=new URL(r.url).pathname;return path==='/panel.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):path==='/panel.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/panel.css"><div id="root"></div><script type="module" src="/panel.js"></script>',{headers:{'Content-Type':'text/html'}});}});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url.toString());
 await page.getByTestId('ops-voice-button').click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'마이크 켜고 시작'}).click();
 await page.getByText('입력량 측정 불가',{exact:false}).waitFor();await page.getByRole('meter',{name:'마이크 입력 크기'}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).targetChanges),0);await page.evaluate(()=>(window as any).setSecondaryOps(true));await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.action==='stop').length),0);await page.getByRole('meter',{name:'마이크 입력 크기'}).waitFor();
 const emit=async(e:object)=>page.evaluate(e=>(window as any).emit(e),e);
 await emit({type:'input_audio_buffer.speech_started'});await page.getByText('발화 감지 · 듣고 있어요',{exact:true}).waitFor();
 await emit({type:'input_audio_buffer.speech_stopped'});await page.getByText('발화 종료 · 인식 중',{exact:true}).waitFor();
 await emit({type:'conversation.item.input_audio_transcription.completed',transcript:'현재 프로젝트 알려줘'});await page.getByText('발화 인식 완료',{exact:true}).waitFor();await page.getByTestId('voice-panel').getByText('현재 프로젝트 알려줘',{exact:false}).waitFor();
 await emit({type:'conversation.item.input_audio_transcription.failed'});await page.getByTestId('voice-dock-error').filter({hasText:'전사하지 못했습니다'}).waitFor();assert.equal(await page.getByTestId('voice-panel').getByRole('alert').count(),0,'the dock says it once, the panel does not repeat it');
 await page.getByRole('button',{name:'음성 창 내리기',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.evaluate(()=>(window as any).trackStops),0);await page.getByTestId('voice-dock-status').filter({hasText:'총괄 응답중'}).waitFor(); // the always-on dock replaced the OPS mini bar (VOC 2026-09-29)
 await emit({type:'conversation.item.input_audio_transcription.completed',transcript:'패널을 닫아도 대화가 계속됩니다'});
 await page.getByTestId('voice-dock-call').click();await page.getByTestId('voice-panel').getByText('패널을 닫아도 대화가 계속됩니다',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.action==='prepare').length),1);
 // VOC 2026-09-24: after the microphone turns off, the same conversation can continue.
 await page.getByTestId('voice-panel').getByRole('button',{name:'마이크 끄기',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).trackStops),1);
 await page.getByRole('button',{name:'마이크 다시 켜고 이어하기',exact:true}).click();await page.getByRole('meter',{name:'마이크 입력 크기'}).waitFor();
 assert.equal(await page.evaluate(()=>(window as any).replaced),1,'the new microphone track must replace the old one on the same connection');
 assert.equal(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.action==='prepare').length),1,'resuming must not start a new conversation');
 await page.getByTestId('voice-panel').getByRole('button',{name:'음성 종료',exact:true}).click();assert.equal(await page.getByRole('meter').count(),0);assert.equal(await page.evaluate(()=>(window as any).trackStops),2);
 // VOC 2026-09-25: consent is remembered after the first start and can be withdrawn.
 if(await page.getByTestId('voice-panel').count()===0)await page.getByTestId('ops-voice-button').click();
 await page.getByTestId('voice-consent-remembered').waitFor();assert.equal(await page.getByRole('checkbox').count(),0);
 await page.getByRole('button',{name:'동의 철회',exact:true}).click();await page.getByRole('checkbox').waitFor();assert.equal(await page.getByRole('checkbox').isChecked(),false);
 assert.deepEqual(errors,[]);console.log(name+': microphone, VAD, transcript, failure, stop states passed');
 const native=await browser.newPage();await native.addInitScript(()=>Object.defineProperty(window,'agentstozNativeWorkroom',{value:true,writable:false}));await native.goto(server.url.toString());
 await native.getByTestId('ops-voice-button').click();await native.getByRole('checkbox').check();await native.getByRole('button',{name:'마이크 켜고 시작'}).click();await native.getByRole('meter',{name:'마이크 입력 크기'}).waitFor();
 await native.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});await native.waitForTimeout(50);
 assert.equal(await native.evaluate(()=>(window as any).trackStops),0,'native permission visibility change must preserve microphone');
 await native.evaluate(()=>window.dispatchEvent(new Event('agentstoz:native-background')));await native.waitForTimeout(50);
 assert.equal(await native.evaluate(()=>(window as any).trackStops),1,'real native background must stop microphone');await native.close();
 console.log(name+': native permission and background lifecycle passed');
 }finally{await browser.close();}
}}finally{await server.stop(true);}
