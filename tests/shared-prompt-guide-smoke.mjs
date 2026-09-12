import {chromium} from 'playwright';
import assert from 'node:assert/strict';

export async function verifySharedPromptGuides(url) {
  if (!['localhost','127.0.0.1'].includes(new URL(url).hostname)) throw Error('Loopback fixture required');
  const browser=await chromium.launch({headless:true});
  let state={success:true,revision:'0',entries:[]}, writes=0;
  const errors=[];
  try {
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    await context.addInitScript(()=>{window.fixtureCopies=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.fixtureCopies.push(text);}},configurable:true});});
    await context.routeWebSocket('**/*',socket=>socket.close());
    await context.route('**/*',async route=>{
      const request=route.request(), target=new URL(request.url());
      if(target.origin!==new URL(url).origin) {errors.push('external request');return route.abort();}
      if(target.pathname.startsWith('/api/')) {errors.push('sidecar request');return route.abort();}
      if(target.pathname.startsWith('/fixture-rpc/')) {
        let error=null;
        if(target.pathname.endsWith('_save')) {
          const body=request.postDataJSON();
          if(body.p_expected_revision!==state.revision) error={message:'PROMPT_GUIDES_CONFLICT'};
          else {state={success:true,revision:crypto.randomUUID(),entries:body.p_entries};writes++;}
        }
        return route.fulfill({json:{data:error?null:state,error}});
      }
      return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url+'/tests/fixtures/shared-prompts.html');
    await page.getByTestId('prompt-guide-open').click();
    await page.getByTestId('prompt-guide-title').fill('모바일 검토');
    await page.getByTestId('prompt-guide-body').fill('변경 사항을 검토하고 테스트해줘.');
    await page.getByTestId('prompt-guide-save').click();
    await page.getByTestId('prompt-guide-list-copy').waitFor();
    await page.getByTestId('prompt-guide-list-copy').click();
    await page.waitForFunction(()=>window.fixtureCopies.length===1);
    assert.deepEqual(await page.evaluate(()=>window.fixtureCopies),['변경 사항을 검토하고 테스트해줘.']);
    assert.equal(writes,1);
    assert.equal(await page.getByTestId('prompt-guide-suggestions-load').count(),0);
    const bounds=await page.getByTestId('prompt-guide-list-copy').boundingBox();assert.ok(bounds.height>=44);
    await page.getByRole('searchbox',{name:'프롬프트 검색'}).fill('없는 항목');
    assert.equal(await page.getByTestId('prompt-guide-list-copy').count(),0);
    await page.getByRole('searchbox',{name:'프롬프트 검색'}).fill('검토');
    assert.equal(await page.getByTestId('prompt-guide-list-copy').count(),1);
    await page.getByTestId('prompt-guide-body').fill('저장 전 내 초안');
    state={...state,revision:crypto.randomUUID(),entries:[{...state.entries[0],body:'다른 기기 수정',updatedAt:'2026-09-11T12:00:00.000Z'}]};
    await page.getByTestId('prompt-guide-save').click();
    await page.getByTestId('prompt-guide-action-error').waitFor();
    assert.equal(writes,1);assert.equal(await page.getByTestId('prompt-guide-body').inputValue(),'저장 전 내 초안');
    await page.mouse.click(2,2);
    await page.getByTestId('prompt-guide-dialog').waitFor({state:'hidden'});
    await page.getByTestId('prompt-guide-open').click();
    await page.getByTestId('prompt-guide-reload').waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="prompt-guide-reload"]').disabled);
    assert.equal(await page.getByTestId('prompt-guide-body').inputValue(),'저장 전 내 초안');
    await page.getByTestId('prompt-guide-list-copy').click();
    await page.waitForFunction(()=>window.fixtureCopies.length===2);
    assert.equal((await page.evaluate(()=>window.fixtureCopies))[1],'다른 기기 수정');
    await page.getByTestId('prompt-guide-clear-draft').click();
    assert.equal(await page.getByTestId('prompt-guide-body').inputValue(),'다른 기기 수정');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:'/tmp/agentstoz-shared-prompts-mobile.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS mobile save, search, 44px copy, cloud refresh, stale-write refusal, draft preservation, outside dismiss and viewport');
  } finally {await browser.close();}
}
if(process.argv[1]?.endsWith('shared-prompt-guide-smoke.mjs')) await verifySharedPromptGuides(process.argv[2]||'http://127.0.0.1:19111');
