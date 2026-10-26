/** Real account picker + owned API + fake login CLIs. Never touch host credentials or live sessions. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {join} from 'node:path';

const output=new URL('../output/playwright/cli-accounts-personas/',import.meta.url);
await mkdir(output,{recursive:true});
const results=[];
try {
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]) {
  for(const viewport of [{width:390,height:844},{width:1120,height:780}]) {
   const id=`${name}-${viewport.width}`,started=Date.now();
   const child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/cli-accounts-ui-server.ts')],{stdin:'ignore',stdout:'pipe',stderr:'pipe'});
   let browser,page;
   try {
    const reader=child.stdout.getReader();let buffer='';const decoder=new TextDecoder();
    while(!buffer.includes('\n')){const chunk=await reader.read();if(chunk.done)throw Error('Account UI fixture stopped');buffer+=decoder.decode(chunk.value);}
    const {url}=JSON.parse(buffer.split('\n')[0]);reader.releaseLock();
    browser=await engine.launch();page=await browser.newPage({viewport});const errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():(external.push(route.request().url()),route.abort('blockedbyclient')));
    await page.goto(url);const picker=page.getByTestId('cli-account-picker'),select=picker.getByLabel('새 작업의 CLI 계정');
    const row=label=>picker.locator('.cli-account-row').filter({has:page.getByText(label,{exact:true})});
    const manage=async()=>{if(await picker.getByRole('button',{name:'계정 관리',exact:true}).getAttribute('aria-expanded')==='false')await picker.getByRole('button',{name:'계정 관리',exact:true}).click();};
    const create=async label=>{
     await manage();await picker.getByLabel('추가할 CLI 계정 이름').fill(label);await picker.getByRole('button',{name:'계정 추가',exact:true}).click();
     await picker.locator('.cli-account-row').getByText(label,{exact:true}).waitFor();
     await row(label).getByRole('button',{name:'공식 로그인',exact:true}).click();
     await row(label).getByText(`${label} · 로그인됨`,{exact:true}).waitFor();
     const account=await select.locator('option').filter({hasText:label}).getAttribute('value');assert.ok(account);
     await select.selectOption(account);await picker.getByText('다음에 시작하는 작업부터 이 계정을 사용합니다.',{exact:true}).waitFor();
     assert.equal(await select.inputValue(),account);return account;
    };
    const codex=await create('시험 Codex 업무 계정');
    await page.getByLabel('검사할 프로젝트').selectOption('account-project-other');
    await page.waitForFunction(()=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value==='host-default');
    await page.getByLabel('검사할 프로젝트').selectOption('account-project');
    await page.waitForFunction(account=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value===account,codex);
    await page.getByLabel('검사할 AI').selectOption('claude');
    await page.waitForFunction(()=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value==='host-default');
    assert.equal(await select.locator('option').filter({hasText:'시험 Codex 업무 계정'}).count(),0,'Claude cannot inherit a Codex account');
    const claude=await create('시험 Claude 업무 계정');
    await page.getByLabel('검사할 AI').selectOption('codex');
    await page.waitForFunction(account=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value===account,codex);
    await manage();
    await picker.getByLabel('추가할 CLI 계정 이름').fill('시험 Codex 업무 계정');
    await picker.getByRole('button',{name:'계정 추가',exact:true}).click();
    await picker.getByRole('status').filter({hasText:'계정 이름'}).waitFor();
    assert.equal(await row('시험 Codex 업무 계정').count(),1,'A duplicate label cannot replace an account identity');
    assert.equal(await select.inputValue(),codex);
    const post=(body)=>page.evaluate(async body=>{
     const response=await fetch('/api/agent-runtime/terminals',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,requestId:crypto.randomUUID()})});
     return {status:response.status,body:await response.json()};
    },body);
    const startedSession=await post({operation:'start',targetId:'account-project',agent:'codex',accountId:codex,cols:80,rows:24});
    assert.equal(startedSession.status,200);const session=startedSession.body.session;
    assert.equal(session.accountId,codex,'The owned fake terminal starts under its selected account');
    await row('시험 Codex 업무 계정').getByRole('button',{name:'목록에서 제외',exact:true}).click();
    await picker.getByRole('status').filter({hasText:'실행 중'}).waitFor();
    assert.equal(await row('시험 Codex 업무 계정').count(),1,'An in-use account remains registered');
    await row('시험 Codex 업무 계정').getByRole('button',{name:'공식 로그인',exact:true}).click();
    await picker.getByRole('status').filter({hasText:'실행 중인 작업'}).waitFor();
    const listed=await post({operation:'list'});assert.ok(listed.body.sessions.some(current=>current.id===session.id&&current.state==='running'),'The refused account changes leave the owned terminal running');
    await page.screenshot({path:new URL(`${id}-in-use-account.png`,output).pathname,fullPage:true});
    // Only the fixture's synthetic terminal is closed; the installed app is never contacted.
    assert.equal((await post({operation:'close',sessionId:session.id})).status,200);
    await row('시험 Codex 업무 계정').getByRole('button',{name:'목록에서 제외',exact:true}).click();
    await picker.getByText('목록에서 제외했습니다. 로그인 파일은 이 기기에 보존됩니다.',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value==='host-default');
    assert.equal(await select.locator('option').filter({hasText:'시험 Codex 업무 계정'}).count(),0);
    await page.getByLabel('검사할 AI').selectOption('claude');
    await page.waitForFunction(account=>document.querySelector('[aria-label="새 작업의 CLI 계정"]')?.value===account,claude);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'The account manager fits the viewport');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await page.screenshot({path:new URL(`${id}-claude-preserved.png`,output).pathname,fullPage:true});
    results.push({id,passed:true,viewport,durationMs:Date.now()-started,checks:['codex-create-fake-login','claude-create-fake-login','project-selection-isolation','provider-selection-isolation','duplicate-label-rejected','in-use-archive-rejected','in-use-login-rejected','existing-session-preserved','archive-after-fixture-close','other-provider-selection-preserved','no-horizontal-overflow','no-external-traffic']});
    console.log(`${id}: 12 account/runtime persona checks passed`);
   } catch(error) {
    results.push({id,passed:false,viewport,error:String(error)});
    await page?.screenshot({path:new URL(`${id}-failure.png`,output).pathname,fullPage:true}).catch(()=>{});
    throw error;
   } finally {if(browser)await browser.close();child.kill();await child.exited;}
  }
 }
} finally {
 await writeFile(new URL('results.json',output),JSON.stringify({generatedAt:new Date().toISOString(),source:'isolated-owned-api-fake-provider-logins',results},null,2)+'\n');
}
