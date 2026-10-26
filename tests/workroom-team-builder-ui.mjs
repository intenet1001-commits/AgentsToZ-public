import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {parseTeamSelectionBlock,teamSelectionBlock} from '../src/teamLaunchOptions.ts';
// 팀 작전 builder (src/WorkroomTeamBuilder.tsx): members, model lists, effort (자동 by default, pinned on request),
// validation and the composed leader instruction, in
// Chromium and WebKit at dock, phone and panel widths. It never sends anything — the composer does.
const built=await Bun.build({entrypoints:['tests/fixtures/workroom-team-builder.tsx'],target:'browser',format:'esm',define:{'process.env.NODE_ENV':'"production"'}});
if(!built.success)throw Error(built.logs.join('\n'));
const js=built.outputs.find(f=>f.path.endsWith('.js')),css=built.outputs.find(f=>f.path.endsWith('.css'));
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:r=>{
 const p=new URL(r.url).pathname;
 return p==='/app.js'?new Response(js,{headers:{'Content-Type':'text/javascript'}}):p==='/app.css'?new Response(css,{headers:{'Content-Type':'text/css'}}):new Response('<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;--bg:#131211;--surface:#1d1c19;--ink:#f4efe3;--ink-2:#a8a29e;--ink-3:#78716c;--accent:#ef995e;--line:#383630;--line-2:#45423b;font-family:system-ui}</style><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script>',{headers:{'Content-Type':'text/html'}});
}});
mkdirSync('.agentstoz/maintainer/workroom-team',{recursive:true});
try{for(const [name,engine] of Object.entries({chromium,webkit})){
 const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:420,height:700}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'?leader=claude');
  await page.getByTestId('workroom-team-builder').waitFor();
  assert.match(await page.getByTestId('workroom-team-leader').innerText(),/Claude Code/);
  const rows=page.getByTestId('workroom-team-member');
  assert.equal(await rows.count(),2);
  const agents=()=>page.locator('select[aria-label$=" · AI"]').evaluateAll(s=>s.map(x=>x.value));
  const model=n=>page.getByRole('combobox',{name:`팀원 ${n} · 모델`}),effort=n=>page.getByRole('combobox',{name:`팀원 ${n} · 에포트`});
  const options=n=>model(n).locator('option').evaluateAll(o=>o.map(x=>x.textContent));
  assert.deepEqual(await agents(),['codex','hermes'],'default members are the other AIs, not the leader');
  // Each AI lists its own models, with the CLI default first and a way to type a newer one last.
  assert.deepEqual((await options(1)).slice(0,3),['기본 모델','GPT-6.1-Sol','GPT-6-Astra']);assert.equal((await options(1)).at(-1),'직접 입력…');
  assert.ok((await options(2)).includes('Anthropic · Opus 5.5'),'Hermes lists its providers');
  // Effort is 자동 for every member until the person pins one.
  assert.deepEqual([await effort(1).inputValue(),await effort(2).inputValue()],['','']);
  assert.equal(await effort(1).locator('option:checked').textContent(),'에포트 자동');
  assert.equal(await page.getByRole('textbox',{name:'팀원 2 · provider'}).count(),0,'a preset needs no typing');
  await page.getByRole('textbox',{name:'팀원 1 · 맡길 작업'}).fill('API와 테스트');
  await effort(1).selectOption('high');
  await model(2).selectOption({label:'Anthropic · Opus 5.5'});
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'팀원 추가'}).click();
  assert.equal(await rows.count(),6);assert.equal(await page.getByRole('button',{name:'팀원 추가'}).isDisabled(),true,'six members at most');
  assert.deepEqual((await agents()).slice(2,3),['agy'],'an added member takes an AI not yet on the team');
  assert.equal(await effort(3).isDisabled(),true,'Antigravity picks effort with its model');
  assert.equal(await effort(3).locator('option:checked').textContent(),'모델에 포함');
  assert.ok((await options(3)).includes('Gemini 4 Argon (High)'));
  // Changing a member's AI starts it from that AI's defaults.
  assert.deepEqual((await agents()).slice(3,4),['codex'],'with every other AI taken, Codex again');
  await model(4).selectOption({label:'GPT-6-Astra'});await effort(4).selectOption('low');
  await page.getByRole('combobox',{name:'팀원 4 · AI'}).selectOption('claude');
  assert.deepEqual([await model(4).inputValue(),await effort(4).inputValue()],['','']);
  for(let n=6;n>2;n--)await page.getByRole('button',{name:`팀원 ${n} 빼기`}).click();
  for(const width of [280,320,420]){
   await page.setViewportSize({width,height:700});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow at ${width}px`);
  }
  for(const field of [model(1),page.getByRole('textbox',{name:'팀원 1 · 맡길 작업'})])assert.equal(await field.evaluate(n=>getComputedStyle(n).fontSize),'16px','phone width fields are 16px (iOS zoom)');
  await page.setViewportSize({width:420,height:700});
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-builder.png`});
  // 직접 입력 reveals a model field (and a provider for Hermes); a bad name composes nothing.
  await model(1).selectOption('custom');
  assert.equal(await page.getByRole('textbox',{name:'팀원 1 · provider'}).count(),0,'Codex has no provider');
  await page.getByRole('textbox',{name:'팀원 1 · 모델 이름'}).fill('gpt 5; rm');await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'팀원 1의 모델 이름'}).waitFor();
  assert.equal(await page.evaluate(()=>window.composed.length),0,'an invalid model composes nothing');
  await page.getByRole('textbox',{name:'팀원 1 · 모델 이름'}).fill('gpt-7-nova');
  await model(2).selectOption('custom');
  assert.equal(await page.getByRole('textbox',{name:'팀원 2 · provider'}).inputValue(),'anthropic','typing starts from the picked preset');
  await model(2).selectOption({label:'Anthropic · Opus 5.5'});
  await page.getByRole('textbox',{name:'목표'}).fill('');await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'목표를 적어 주세요'}).waitFor();
  await page.getByRole('textbox',{name:'목표'}).fill('결제 오류를 고친다');await page.getByTestId('workroom-team-compose').click();
  const text=await page.evaluate(()=>window.composed.at(-1));
  for(const part of ['[AgentsToZ 팀 작전 · 리더]','결제 오류를 고친다','팀원 1: Codex (gpt-7-nova) · 에포트 고정 high — API와 테스트','팀원 2: Hermes (anthropic/claude-opus-5-5) · 에포트 자동 — 작업은 리더가 배분','agentstoz_use_create_team','push는 하지 않습니다'])assert.ok(text.includes(part),part);
  // 빠른 구성: one tap fills the members from the AIs other than the leader; a reviewer reads and reports, and the leader is told.
  await page.getByRole('button',{name:'다시 열기'}).click();
  const role=n=>page.getByRole('combobox',{name:`팀원 ${n} · 역할`}),roles=async()=>[await role(1).inputValue(),await role(2).inputValue()];
  const hint=page.getByText('검토 담당은 파일을 고치지 않고',{exact:false});
  assert.deepEqual(await roles(),['worker','worker'],'members work unless chosen otherwise');assert.equal(await hint.count(),0);
  await page.getByTestId('workroom-team-preset-cross-review').click();
  assert.deepEqual(await roles(),['reviewer','reviewer']);assert.deepEqual(await agents(),['codex','hermes'],'presets use the AIs other than the leader');
  await page.getByTestId('workroom-team-preset-split').click();assert.deepEqual(await roles(),['worker','worker']);
  await page.getByTestId('workroom-team-preset-build-review').click();
  assert.deepEqual(await roles(),['worker','reviewer']);assert.equal(await rows.count(),2);
  assert.equal(await page.getByRole('textbox',{name:'팀원 2 · 맡길 작업'}).getAttribute('placeholder'),'비우면 리더가 검토 범위를 정합니다');
  await hint.waitFor();
  for(const width of [280,320]){
   await page.setViewportSize({width,height:700});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow with roles at ${width}px`);
   assert.equal(await role(2).evaluate(n=>getComputedStyle(n).fontSize),'16px','the role select is 16px at phone width');
  }
  await page.setViewportSize({width:420,height:700});
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-builder-review.png`});
  await page.getByTestId('workroom-team-compose').click();
  const reviewed=await page.evaluate(()=>window.composed.at(-1));
  for(const part of ['팀원 1: Codex · 에포트 자동 — 작업은 리더가 배분','팀원 2: Hermes · 에포트 자동 · 검토 담당 — 검토 범위는 리더가 정함','role "reviewer"','검토 담당의 보고를 받은 뒤 병합'])assert.ok(reviewed.includes(part),part);
  // 열린 세션: an open session joins as it is — no model or effort lists; one in the main checkout may only review.
  await page.getByRole('button',{name:'다시 열기'}).click();
  const agentOf=n=>page.getByRole('combobox',{name:`팀원 ${n} · AI`});
  await agentOf(1).selectOption('session:s-main00');
  assert.equal(await role(1).inputValue(),'reviewer','a main-checkout session joins as a reviewer');
  assert.equal(await role(1).locator('option[value="worker"]').isDisabled(),true,'and cannot take work');
  assert.equal(await model(1).count(),0,'an open session keeps its own model');
  assert.equal(await rows.nth(0).getByTestId('workroom-team-attached').innerText(),'그 세션의 모델·에포트 그대로');
  await page.getByText('열린 세션은 새 워크룸 없이',{exact:false}).waitFor();
  await agentOf(2).selectOption('session:s-wt0000');
  assert.equal(await role(2).inputValue(),'worker','a worktree session may take work');
  assert.equal(await agentOf(2).locator('option[value="session:s-main00"]').isDisabled(),true,'one session joins once');
  for(const width of [280,320]){
   await page.setViewportSize({width,height:700});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow with open sessions at ${width}px`);
  }
  await page.setViewportSize({width:420,height:700});
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-builder-open-sessions.png`});
  await page.getByRole('textbox',{name:'팀원 2 · 맡길 작업'}).fill('결제 API');
  await page.getByTestId('workroom-team-compose').click();
  const joined=await page.evaluate(()=>window.composed.at(-1));
  for(const part of ['팀원 1: 열린 세션 「Demo · hermes」 · Hermes · sessionId s-main00 · 검토 담당 — 검토 범위는 리더가 정함','팀원 2: 열린 세션 「Demo · codex #2」 · Codex · sessionId s-wt0000 — 결제 API','agent와 sessionId만 넣고'])assert.ok(joined.includes(part),part);
  // Picking an AI again makes it a new Workroom with that AI's defaults.
  await page.getByRole('button',{name:'다시 열기'}).click();
  await agentOf(1).selectOption('session:s-wt0000');
  // A second session in the same worktree joins as a reviewer: one worker per checkout (the host refuses a second).
  await agentOf(2).selectOption('session:s-wt0002');
  assert.equal(await role(2).inputValue(),'reviewer','a second session in a worktree that already has a worker reviews');
  assert.equal(await role(2).locator('option[value="worker"]').isDisabled(),true,'and cannot take work there');
  assert.equal(await role(2).locator('option[value="worker"]').getAttribute('title'),'같은 작업 트리에서는 한 세션만 작업을 맡습니다');
  await agentOf(1).selectOption('claude');
  assert.equal(await model(1).count(),1,'a new Workroom has its model list again');
  await page.getByRole('textbox',{name:'목표'}).press('Escape');
  assert.equal(await page.evaluate(()=>window.teamClosed),1,'Escape closes the builder');
  // 실행 위치·옵션 (src/teamLaunchOptions.ts): the same places and options as 「프로젝트 열기」, and who carries each member.
  await page.getByRole('button',{name:'다시 열기'}).click();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'팀원 추가'}).click();
  const surface=n=>page.getByRole('combobox',{name:`팀원 ${n} · 실행 위치`}),check=(n,name)=>page.getByRole('checkbox',{name:`팀원 ${n} · ${name}`});
  const chip=n=>rows.nth(n-1).getByTestId('workroom-team-management');
  assert.deepEqual(await surface(1).locator('option').evaluateAll(o=>o.map(x=>x.value)),['internal','orca-floating','orca-worktree','cmux','iterm','terminal','app'],'every surface of this Mac');
  assert.equal(await chip(1).innerText(),'자동 관리','a Workroom member is managed');
  assert.equal(await check(1,'권한 우회').isChecked(),false,'bypass is off until the person turns it on');
  // 「Hermes · Claude/Codex」 sit next to Hermes; a provider this Mac's Hermes cannot use is offered but disabled.
  assert.deepEqual(await agentOf(2).locator('option').evaluateAll(o=>o.filter(x=>!x.parentElement.matches('optgroup')).map(x=>x.value)),['codex','claude','hermes','hermes:claude','hermes:codex','agy']);
  assert.equal(await agentOf(2).locator('option[value="hermes:codex"]').isDisabled(),true);
  assert.match(await agentOf(2).locator('option[value="hermes:codex"]').textContent(),/Hermes · Codex · openai-codex 자격 없음/);
  // Choosing a Hermes provider never silently moves an external member into a Workroom.
  await surface(2).selectOption('iterm');
  await agentOf(2).selectOption('hermes:claude');
  assert.equal(await surface(2).inputValue(),'iterm','the chosen external surface stays selected');
  assert.equal(await surface(2).locator('option:checked').textContent(),'iTerm','the selected location stays visible even while incompatible');
  assert.equal(await surface(2).getAttribute('aria-invalid'),'true');
  const variantSurfaceError=rows.nth(1).getByTestId('workroom-team-variant-surface-error');
  assert.equal(await variantSurfaceError.innerText(),'모델을 정한 Hermes는 워크룸에서만 실행합니다','the row explains the conflict immediately, before composing');
  const beforeVariant=await page.evaluate(()=>window.composed.length);
  await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'모델을 정한 Hermes는 워크룸에서만 실행합니다'}).waitFor();
  assert.equal(await page.evaluate(()=>window.composed.length),beforeVariant,'an unsupported variant/surface composes nothing');
  await agentOf(2).selectOption('hermes');
  assert.equal(await surface(2).inputValue(),'iterm','choosing plain Hermes also keeps the exact surface');
  assert.equal(await variantSurfaceError.count(),0,'choosing plain Hermes resolves the conflict');
  await page.getByTestId('workroom-team-compose').click();
  const plainHermes=await page.evaluate(()=>window.composed.at(-1));
  assert.deepEqual(parseTeamSelectionBlock(plainHermes).members[1],{agent:'hermes',surface:'iterm',launchOptions:{reuse:'new'}},'plain Hermes composes on the same external surface');
  await page.getByRole('button',{name:'다시 열기'}).click();
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'팀원 추가'}).click();
  await surface(2).selectOption('iterm');
  await agentOf(2).selectOption('hermes:claude');
  await surface(2).selectOption('internal');
  assert.equal(await variantSurfaceError.count(),0,'only the person explicitly changes the variant to a Workroom');
  assert.equal(await surface(2).getAttribute('aria-invalid'),null);
  await agentOf(2).selectOption('hermes:claude');
  assert.deepEqual(await options(2),['Anthropic · Opus 5.5','Anthropic · Sonnet 5.5','Anthropic · Haiku 5.5','직접 입력…'],'a variant lists its provider only');
  assert.equal(await surface(2).locator('option[value="iterm"]').isDisabled(),true,'a variant chooses a model, so a Workroom');
  // An account is a Workroom choice for Codex and Claude.
  const account1=page.getByRole('combobox',{name:'팀원 1 · 계정'});
  assert.deepEqual(await account1.locator('option').evaluateAll(o=>o.map(x=>x.textContent)),['이 Mac 기본 CLI 계정','회사 계정'],'no account is this Mac’s default login, not listed twice');
  await account1.selectOption({label:'회사 계정'});
  // A chosen account is never dropped to the default login: where it does not apply, it stays shown and compose refuses it.
  await surface(1).selectOption('iterm');
  assert.equal(await account1.inputValue(),'acct_12345678-1234-4123-8123-123456789abc');assert.equal(await account1.getAttribute('aria-invalid'),'true');
  const before=await page.evaluate(()=>window.composed.length);
  await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'팀원 1: 이 AI나 실행 위치는 CLI 계정을 받지 않습니다'}).waitFor();
  assert.equal(await page.evaluate(()=>window.composed.length),before,'a refused account composes nothing');
  await surface(1).selectOption('internal');
  assert.equal(await account1.inputValue(),'acct_12345678-1234-4123-8123-123456789abc','back in the Workroom the same account applies');
  assert.equal(await page.getByRole('combobox',{name:'팀원 2 · 계정'}).count(),0,'Hermes takes no CLI account');
  // A terminal takes no model or effort; it starts from project open's own options.
  await model(3).selectOption({label:'Gemini 4 Argon (High)'});
  await surface(3).selectOption('iterm');
  assert.equal(await model(3).isDisabled(),true);assert.equal(await model(3).locator('option:checked').textContent(),'워크룸에서만');
  assert.equal(await check(3,'tmux').isChecked(),true,'iTerm starts with tmux, like project open');
  await check(3,'권한 우회').check();await check(3,'기존 창 재사용').check();
  assert.equal(await chip(3).innerText(),'수동 합류');
  assert.equal(await rows.nth(2).getByTestId('workroom-team-reason').innerText(),'터미널 창에는 지시·결과 연결이 없습니다');
  // Said in the row, not only in a tooltip; the Gemini pick is gone instead of going where nothing takes it.
  assert.equal(await rows.nth(2).getByTestId('workroom-team-model-elsewhere').innerText(),'이 실행 위치는 모델·에포트를 고르지 않습니다. 그 앱이나 터미널의 설정을 그대로 씁니다.');
  assert.equal(await rows.nth(0).getByTestId('workroom-team-model-elsewhere').count(),0,'a Workroom row picks its own model');
  // Claude --bg wins over tmux; without it cmux waits for its control connection.
  await agentOf(4).selectOption('claude');await surface(4).selectOption('cmux');
  assert.equal(await check(4,'Claude --bg').isChecked(),true);assert.equal(await check(4,'tmux').isDisabled(),true);
  assert.equal(await chip(4).innerText(),'수동 합류');
  await check(4,'Claude --bg').uncheck();await check(4,'tmux').check();
  assert.equal(await chip(4).innerText(),'연결 대기');
  assert.equal(await check(4,'기존 창 재사용').isDisabled(),true,'cmux cannot find a window again');
  // The Codex app fills its composer without sending: a person joins it.
  await surface(5).selectOption('app');
  assert.deepEqual(await page.getByRole('combobox',{name:'팀원 5 · 앱 대화'}).locator('option').evaluateAll(o=>o.map(x=>x.textContent)),['새 대화','최근 대화 다시 열기']);
  await page.getByRole('combobox',{name:'팀원 5 · 앱 대화'}).selectOption('reopen');
  assert.equal(await check(5,'권한 우회').count(),0,'the Codex app takes no bypass');
  assert.equal(await rows.nth(4).getByTestId('workroom-team-reason').innerText(),'Codex 앱 입력칸에 채우기만 하고 보내지 않습니다');
  await page.getByText('워크룸 밖의 팀원은 고른 위치 그대로 엽니다',{exact:false}).waitFor();
  for(const width of [280,320,420]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`no horizontal overflow with launch options at ${width}px`);
   if(width<420)assert.equal(await surface(3).evaluate(n=>getComputedStyle(n).fontSize),'16px','the surface select is 16px at phone width');
  }
  await page.screenshot({path:`.agentstoz/maintainer/workroom-team/${name}-builder-launch.png`,fullPage:true});
  await page.getByTestId('workroom-team-compose').click();
  const launched=await page.evaluate(()=>window.composed.at(-1));
  for(const part of ['팀원 1: Codex · 에포트 자동 · 계정 「회사 계정」(accountId acct_12345678-1234-4123-8123-123456789abc)','팀원 2: Hermes (anthropic/claude-opus-5-5) · 에포트 자동',
   '팀원 3: Antigravity · 실행 위치 iTerm(iterm) · 권한 우회 · tmux · 기존 창 재사용 · 수동 합류: 터미널 창에는 지시·결과 연결이 없습니다',
   '팀원 4: Claude Code · 실행 위치 cmux(cmux) · Claude --bg 끔 · tmux · 새 창 · 연결 대기: cmux 제어 연결이 확인된 뒤에 지시합니다',
   '팀원 5: Codex · 실행 위치 Codex 앱(app) · 최근 대화 다시 열기 · 수동 합류: Codex 앱 입력칸에 채우기만 하고 보내지 않습니다','실행 위치·옵션:'])assert.ok(launched.includes(part),part);
  assert.deepEqual(parseTeamSelectionBlock(launched).members,[
   {agent:'codex',accountId:'acct_12345678-1234-4123-8123-123456789abc'},{agent:'hermes',model:'claude-opus-5-5',provider:'anthropic'},
   {agent:'agy',bypassPermissions:true,surface:'iterm',launchOptions:{tmuxMode:true,reuse:'reuse-or-new'}},
   {agent:'claude',surface:'cmux',launchOptions:{bgMode:false,tmuxMode:true,reuse:'new'}},
   {agent:'codex',surface:'app',launchOptions:{appMode:'reopen'}},
  ],'the selection block carries exactly what was chosen');
  // Production reopens with the current composed draft: restore choices and the original goal, never nest old authority.
  await page.evaluate(()=>{window.initialGoal=window.composed.at(-1);});
  await page.getByRole('button',{name:'다시 열기'}).click();
  assert.equal(await page.getByRole('textbox',{name:'목표'}).inputValue(),'결제 오류를 고친다');
  assert.equal(await rows.count(),5);assert.equal(await surface(3).inputValue(),'iterm');
  assert.equal(await check(3,'권한 우회').isChecked(),true,'the old choice is visible for review');
  await check(3,'권한 우회').uncheck();
  await page.getByTestId('workroom-team-compose').click();
  const replaced=await page.evaluate(()=>window.composed.at(-1));
  assert.equal((replaced.match(/```agentstoz-team-selection/g)??[]).length,1,'reopen/compose replaces the previous block');
  assert.equal(parseTeamSelectionBlock(replaced).members[2].bypassPermissions,undefined,'a cancelled bypass cannot survive in an old goal');
  assert.ok(!replaced.includes('각자의 워크트리 워크룸'));assert.ok(replaced.includes('agentstoz_use_team_member의 read/send/reveal'));
  // A malformed source draft is refused before its choices can be restored; the old raw text never enters the goal.
  await page.evaluate(block=>{window.initialGoal=window.composed.at(-1)+'\n'+block;},teamSelectionBlock([{agent:'codex',bypassPermissions:true}]));
  await page.getByRole('button',{name:'다시 열기'}).click();
  await page.getByRole('alert').filter({hasText:'팀 선택 블록이 둘'}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'목표'}).inputValue(),'');
  const rejected=await page.evaluate(()=>window.composed.length);
  await page.getByRole('textbox',{name:'목표'}).fill(replaced);
  await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'팀 선택 블록이 둘'}).waitFor();
  assert.equal(await page.evaluate(()=>window.composed.length),rejected,'full-text validation refuses a block pasted into the new goal');
  await page.getByRole('textbox',{name:'목표'}).fill('새 목표');
  assert.equal(await page.getByRole('alert').count(),0,'editing the rejected choice clears a stale warning');
  const codexPreset=model(2).locator('option').filter({hasText:'OpenAI Codex · GPT-6.1-Sol'});
  assert.equal(await codexPreset.isDisabled(),true,'plain Hermes presets respect the same missing provider credential');
  await model(2).selectOption('custom');
  await page.getByRole('textbox',{name:'팀원 2 · 모델 이름'}).fill('gpt-6.1-sol');
  await page.getByRole('textbox',{name:'팀원 2 · provider'}).fill('openai-codex');
  await page.getByTestId('workroom-team-compose').click();
  await page.getByRole('alert').filter({hasText:'openai-codex'}).waitFor();
  assert.equal(await page.evaluate(()=>window.composed.length),rejected,'typing the disabled preset cannot bypass availability');
  await model(2).selectOption('');
  assert.equal(await page.getByRole('alert').count(),0);
  await page.getByTestId('workroom-team-compose').click();
  assert.equal(parseTeamSelectionBlock(await page.evaluate(()=>window.composed.at(-1))).members[1].agent,'hermes');
  assert.deepEqual(errors,[]);
  console.log(`${name}: leader exclusion, model lists, 자동/pinned effort, agy model-bound effort, AI change reset, typed model and Hermes provider, six-member bound, model and goal validation, composed instruction, presets and reviewer role, open sessions joining, Escape, Hermes variants, launch surfaces and options, management states, selection block and narrow widths passed`);
 }finally{await browser.close();}
}}finally{server.stop(true);}
// 팀 현황 shares this check (the tester manifest is at its 96-check cap): the strip above a team session's terminal.
if(process.env.AGENTSTOZ_TEAM_BUILDER_ONLY!=='1')await import('./workroom-team-status-ui.mjs');
