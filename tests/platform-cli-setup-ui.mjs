/** First-device journeys use real UI/hosts with synthetic providers; no installed app or credentials. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
const output=new URL('../output/playwright/platform-cli-setup/',import.meta.url);await mkdir(output,{recursive:true});const results=[];
for(const [engineName,engine]of [['chromium',chromium],['webkit',webkit]])for(const width of [390,1120]){
 const id=engineName+'-'+width,child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/platform-cli-ui-server.ts')],{stdout:'pipe',stderr:'pipe'});let browser,page;
 try{
  const reader=child.stdout.getReader();let line='';while(!line.includes('\n')){const chunk=await reader.read();if(chunk.done)throw Error('Fixture failed: '+await new Response(child.stderr).text());line+=new TextDecoder().decode(chunk.value);}reader.releaseLock();const {url}=JSON.parse(line.split('\n')[0]);
  browser=await engine.launch();page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(15000);const errors=[],external=[],adminRequests=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{
   const request=route.request(),u=new URL(request.url());
   if(u.origin===new URL(url).origin)return route.continue();
   if(u.hostname==='a'.repeat(20)+'.supabase.co'&&u.pathname.startsWith('/rest/v1/'))return route.fulfill({status:403,json:{code:'42501',message:'permission denied: synthetic anon denied'}});
   if(u.origin==='http://127.0.0.1:3001'&&u.pathname==='/api/supabase-service-key/from-cli'){adminRequests.push(request.postDataJSON());return route.fulfill({json:{saved:true,present:true}});}
   external.push(request.url());return route.abort();
  });
  await page.request.post(url+'test/installation',{data:{missing:['github','vercel','supabase','google-workspace']}});
  await page.goto(url);const panel=page.getByTestId('platform-cli-settings');await panel.locator(':scope > summary').click();
  const preparation=panel.getByRole('region',{name:'CLI 설치·계정 연결',exact:true});await preparation.getByText('GitHub · 설치 필요 · 연결 계정 0',{exact:true}).waitFor();
  await panel.getByLabel('연결할 이메일',{exact:true}).fill('intenet1001@gmail.com');assert.equal(await panel.getByRole('button',{name:'브라우저로 계정 연결',exact:true}).isDisabled(),true);
  await preparation.getByRole('button',{name:'AI에게 설치·연결 도움받기',exact:true}).click();const prompt=await preparation.getByLabel('CLI 설정 AI 인계문').inputValue();assert.ok(prompt.includes('찾지 못함'));assert.ok(prompt.includes('이미 설치된 CLI는 재설치하지 마세요'));assert.ok(!prompt.includes('synthetic-client-secret'));
  await page.request.post(url+'test/installation',{data:{missing:['vercel','google-workspace']}});await preparation.getByRole('button',{name:'설치 상태 다시 확인',exact:true}).click();await preparation.getByText('GitHub · 설치됨 · 연결 계정 0',{exact:true}).waitFor();
  await page.request.post(url+'test/block-keychain');await panel.getByRole('button',{name:'기존 로그인 확인·연결',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'macOS 키체인 확인창이 보이면 직접 허용'}).waitFor();assert.match(await panel.getByRole('status').locator('strong').innerText(),/^GitHub · /);
  await page.reload();await panel.locator(':scope > summary').click();await panel.getByRole('button',{name:'같은 계정 확인 결과 보기',exact:true}).click();
  assert.equal((await page.request.get(url+'test/state').then(r=>r.json())).nativeReads,1,'Reload reads the same pending request without repeating Keychain access');
  await page.request.post(url+'test/release-keychain');await panel.getByRole('status').filter({hasText:'이 요청의 실제 연결 확인이 완료됐습니다.'}).waitFor();
  const state=await page.request.get(url+'test/state').then(r=>r.json());assert.equal(state.accounts.length,1);assert.equal(state.accounts[0].verifiedEmail,'intenet1001@gmail.com');
  const card=panel.getByText(state.accounts[0].label,{exact:true}).locator('..');await card.getByRole('button',{name:'기본 계정으로 사용',exact:true}).click();await card.getByRole('button',{name:'현재 기본 계정',exact:true}).waitFor();
  await panel.getByLabel('CLI',{exact:true}).selectOption('vercel');await preparation.getByText('Vercel · 설치 필요 · 연결 계정 0',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'기존 로그인 확인·연결',exact:true}).isDisabled(),true);assert.match(await panel.getByRole('status').filter({hasText:'이 요청의 실제 연결 확인이 완료됐습니다.'}).locator('strong').innerText(),/^GitHub · /,'Switching to Vercel must retain the actual GitHub receipt provider');
  await panel.getByText(/이 영역 전체는 개발 프로젝트 작업용 CLI 설정입니다/).waitFor();assert.equal(await preparation.locator('summary').count(),0,'App storage is outside project CLI preparation');
  const seeded=await page.request.post(url+'test/seed-supabase').then(r=>r.json()),account=seeded.accounts.find(a=>a.verifiedEmail==='app-owner@example.test');
  await page.goto(url+'?first-wizard&native-drop');const picker=page.getByRole('region',{name:'아젠투지 동기화용 Supabase 계정',exact:true});await picker.locator(':scope > details > summary').click();const management=picker.getByTestId('platform-cli-settings');await management.locator(':scope > summary').click();
  await management.getByText('Supabase 관리 로그인 추가',{exact:true}).waitFor();
  assert.equal(await management.getByLabel('CLI',{exact:true}).count(),0);assert.equal(await management.getByRole('button',{name:'기기 기본값 저장',exact:true}).count(),0);assert.equal(await management.getByRole('button',{name:'기본 계정으로 사용',exact:true}).count(),0);assert.equal(await management.getByRole('button',{name:'프로젝트에 연결',exact:true}).count(),0);assert.equal(await management.getByRole('button',{name:'목록에서 제외',exact:true}).count(),0);
  assert.equal(await management.getByLabel('연결할 이메일',{exact:true}).inputValue(),'');
  await management.getByRole('button',{name:'AI에게 설치·연결 도움받기',exact:true}).click();const managementPrompt=await management.getByLabel('CLI 설정 AI 인계문').inputValue();assert.ok(managementPrompt.includes('프로젝트 작업용 CLI 기본 계정은 바꾸지 마세요'));
  await management.locator(':scope > summary').click();await picker.locator(':scope > details > summary').click();
  await picker.getByLabel('Supabase 관리 계정',{exact:true}).selectOption(account.id);
  await page.getByLabel('로그인 허용 이메일',{exact:true}).fill('phone-user@example.test');await page.getByRole('button',{name:/^다음/}).click();await page.getByRole('checkbox',{name:/SQL 실행을 완료했습니다/}).check();await page.getByRole('button',{name:/^다음/}).click();
  await page.getByText('아젠투지 전용 데이터 ('+'a'.repeat(20)+')',{exact:true}).waitFor({state:'attached'});await page.getByRole('button',{name:'자동 입력',exact:true}).click();
  await page.getByRole('button',{name:'연결과 보안 테스트',exact:true}).click();await page.getByRole('button',{name:'URL/Key 정상 · 익명 접근 차단 정상',exact:true}).waitFor();
  await page.getByRole('button',{name:'Supabase CLI에서 자동 연결',exact:true}).click();await page.getByRole('button',{name:'✓ 로컬 관리자 연결 완료',exact:true}).waitFor();
  assert.equal(adminRequests.length,1);assert.deepEqual(adminRequests[0],{supabaseUrl:'https://'+'a'.repeat(20)+'.supabase.co',accountId:account.id});
  assert.ok(!await page.content().then(v=>v.includes('sb_secret_NEVER_SEND_TO_BROWSER')));assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.screenshot({path:new URL(id+'-sync-account.png',output).pathname,fullPage:true});results.push({id,passed:true,journeys:['no-cli-ai-handoff','partial-cli-recheck','existing-email-verified-login','keychain-wait-reload-same-request','explicit-default','missing-cli-blocks-login','dedicated-app-sync-account','different-phone-login-email','explicit-project-key','same-account-local-admin']});console.log(id+': first-device CLI and app-sync account journeys passed');
 }catch(error){await page?.screenshot({path:new URL(id+'-failure.png',output).pathname,fullPage:true}).catch(()=>{});results.push({id,passed:false,error:String(error)});throw error;}
 finally{await browser?.close();child.kill();await child.exited;await writeFile(new URL('results.json',output),JSON.stringify({source:'isolated-real-components-fake-providers',results},null,2));}
}
