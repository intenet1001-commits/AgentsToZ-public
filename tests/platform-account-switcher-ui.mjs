/** The CLI account switcher a person clicks: this Mac, one project, a project being created. Fake CLIs, no live credentials. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,webkit} from 'playwright';
const output=new URL('../output/playwright/platform-account-switcher/',import.meta.url);await mkdir(output,{recursive:true});const results=[];
const engines=[['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.SWITCHER_ENGINE||process.env.SWITCHER_ENGINE===name);

for(const [engineName,engine]of engines)for(const viewport of [{width:390,height:844},{width:1120,height:900}]){
  const id=engineName+'-'+viewport.width,child=Bun.spawn([process.execPath,join(import.meta.dir,'fixtures/platform-account-switcher-server.ts')],{stdout:'pipe',stderr:'pipe'});let browser,page;
  try{
    const reader=child.stdout.getReader();let buffer='';while(!buffer.includes('\n')){const r=await reader.read();if(r.done)throw Error('Switcher fixture stopped: '+await new Response(child.stderr).text());buffer+=new TextDecoder().decode(r.value);}reader.releaseLock();const {url}=JSON.parse(buffer.split('\n')[0]);
    browser=await engine.launch();page=await browser.newPage({viewport});page.setDefaultTimeout(15_000);const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>new URL(r.request().url()).origin===new URL(url).origin?r.continue():(external.push(r.request().url()),r.abort()));
    const state=()=>page.request.get(url+'test/state').then(r=>r.json());
    await page.goto(url);

    // This Mac: one picker per CLI; choosing switches the Mac's own login at once.
    const mac=page.getByTestId('fixture-mac'),macGithub=mac.getByLabel('GitHub 이 Mac 계정',{exact:true});
    await mac.getByTestId('cli-everywhere').getByText('프로젝트에 계정을 고르면 그 폴더에서는 터미널·VS Code·git 어디서든 그 계정을 씁니다.',{exact:true}).waitFor();
    await macGithub.locator('option').filter({hasText:'company'}).waitFor({state:'attached'});
    assert.equal(await macGithub.inputValue(),'pcli_gh_personal');
    assert.match(await macGithub.locator('option:checked').textContent(),/personal \(사용 중\)/);
    await mac.getByRole('button',{name:'git push도 이 전환을 따르게',exact:true}).click();
    await mac.getByText('✓ 이제 git push도 GitHub 전환을 따라갑니다.',{exact:true}).waitFor();
    assert.match((await state()).gitConfig,/auth git-credential/);
    await page.screenshot({path:new URL(id+'-1-mac.png',output).pathname,fullPage:true});
    await macGithub.selectOption('pcli_gh_company');
    await mac.getByText('✓ 이 Mac 전체가 company을(를) 씁니다.',{exact:true}).waitFor();
    assert.deepEqual((await state()).logins.filter(l=>l.active).map(l=>l.login),['company']);
    const macSupabase=mac.getByLabel('Supabase 이 Mac 계정',{exact:true});
    const work=await macSupabase.locator('option').filter({hasText:'work@example.test'}).getAttribute('value');
    await macSupabase.selectOption(work);
    await mac.getByText(/✓ 이 Mac 전체가 .*을\(를\) 씁니다\./).nth(1).waitFor();
    assert.match((await state()).supabaseProfile,/platform-cli-v1\/native\/supabase-[0-9a-f-]+\.json$/,'Supabase CLI now selects the connected profile');
    assert.equal(await mac.getByLabel('Vercel 이 Mac 계정',{exact:true}).locator('option:checked').textContent(),'로그인 없음');

    // One project: an account already signed in on this Mac applies at once — no sign-in, no copied secret.
    const project=page.getByTestId('fixture-project'),projectGithub=project.getByLabel('GitHub 프로젝트 계정',{exact:true});
    await projectGithub.locator('option[value=pcli_gh_personal]').waitFor({state:'attached'});
    assert.equal(await projectGithub.inputValue(),'pcli_default');
    const before=(await state()).accounts.length;
    await projectGithub.selectOption('pcli_gh_personal');
    await project.getByText('✓ 이 프로젝트는 이제 personal을(를) 씁니다.',{exact:true}).waitFor();
    let s=await state();assert.equal(s.bindings.github.accountId,'pcli_gh_personal');
    // The first project account turns on its use in every terminal and in git, not only Workrooms.
    assert.match(s.zshrc,/^# mine\n\n# >>> AgentsToZ CLI accounts >>>/);assert.match(s.gitconfig,/include/);
    assert.equal(await project.getByTestId('project-cli-scope').textContent(),'고르면 바로 적용 · 이 폴더의 터미널·VS Code·git 어디서든');assert.equal(s.accounts.length,before,'Switching to a signed-in account stores nothing new');
    assert.equal(await project.getByTestId('cli-quick-login').count(),0,'No sign-in for an account already signed in');
    assert.deepEqual(s.logins.filter(l=>l.active).map(l=>l.login),['company'],'A project switch leaves this Mac alone');
    const projectSupabase=project.getByLabel('Supabase 프로젝트 계정',{exact:true});
    await projectSupabase.selectOption(work);await project.getByText('✓ 이 프로젝트는 이제 work@example.test을(를) 씁니다.',{exact:true}).waitFor();
    assert.equal((await state()).bindings.supabase.accountId,work);
    await page.screenshot({path:new URL(id+'-2-project.png',output).pathname,fullPage:true});

    // A new account from the same picker: the official sign-in, then it is this project's account.
    await projectGithub.selectOption('__add');
    const quick=project.getByTestId('cli-quick-login');await quick.getByTestId('cli-quick-login-start').click();
    await quick.getByText('ABCD-1234',{exact:true}).waitFor();
    await page.screenshot({path:new URL(id+'-3-add-login.png',output).pathname,fullPage:true});
    await page.request.post(url+'test/approve-login');
    await project.getByText(/✓ 이 프로젝트는 이제 designer/).waitFor({timeout:20_000});
    s=await state();const designer=s.accounts.find(a=>a.identity==='designer');assert.ok(designer,'The signed-in account is connected');assert.equal(s.bindings.github.accountId,designer.id);
    assert.equal(s.defaults.github,undefined,'Adding an account for a project leaves this Mac’s account alone');
    assert.equal(await project.getByTestId('cli-quick-login').count(),0,'The sign-in panel closes once added');
    // Back to following this Mac, in one pick.
    await projectGithub.selectOption('pcli_default');await project.getByText('✓ 이 프로젝트는 이 Mac 계정을 따릅니다.',{exact:true}).waitFor();
    assert.equal((await state()).bindings.github?.accountId??'pcli_default','pcli_default','Following this Mac keeps no account of its own');

    // Workrooms only, and back, from this Mac's section; startup files and git config return to what they were.
    await page.reload();const row=page.getByTestId('fixture-mac').getByTestId('cli-everywhere');
    await row.getByText('✓ 등록된 프로젝트 폴더에서는 터미널·VS Code·git 어디서든 그 프로젝트가 고른 계정을 씁니다.',{exact:true}).waitFor();
    await row.getByText('적용한 곳: ~/.zprofile · ~/.zshrc · git 전역 설정',{exact:true}).waitFor();
    await page.screenshot({path:new URL(id+'-5-everywhere.png',output).pathname,fullPage:true});
    await row.getByRole('button',{name:'워크룸에서만 쓰기',exact:true}).click();await row.getByText('프로젝트 계정은 아젠투지 워크룸에서만 씁니다.',{exact:true}).waitFor();
    s=await state();assert.equal(s.zshrc,'# mine\n');assert.doesNotMatch(s.gitconfig,/include/);
    await row.getByRole('button',{name:'어디서든 쓰기',exact:true}).click();await row.getByText('✓ 켰습니다. git은 바로, 터미널은 새로 여는 창부터 적용됩니다.',{exact:true}).waitFor();
    assert.match((await state()).zshrc,/AgentsToZ CLI accounts/);

    // A project being created: the same accounts, chosen before it exists.
    const fresh=page.getByTestId('fixture-new'),details=fresh.getByTestId('new-project-cli-accounts');
    assert.match(await details.locator('summary').textContent(),/GitHub 이 Mac 계정 · Supabase 이 Mac 계정 · Vercel 이 Mac 계정/);
    await details.locator('summary').click();
    await fresh.getByLabel('새 프로젝트 Supabase 계정',{exact:true}).locator(`option[value="${work}"]`).waitFor({state:'attached'});
    await fresh.getByLabel('새 프로젝트 Supabase 계정',{exact:true}).selectOption(work);
    await fresh.getByLabel('새 프로젝트 GitHub 계정',{exact:true}).selectOption('pcli_gh_company');
    assert.deepEqual(JSON.parse(await fresh.getByTestId('new-choice').textContent()),{supabase:work,github:'pcli_gh_company'});
    assert.match(await details.locator('summary').textContent(),/GitHub company · Supabase work@example\.test · Vercel 이 Mac 계정/);
    await page.screenshot({path:new URL(id+'-4-new-project.png',output).pathname,fullPage:true});

    // Nothing overflows sideways on a phone-width screen.
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'No horizontal overflow');
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    results.push({id,ok:true});
  }catch(error){if(page)await page.screenshot({path:new URL(id+'-failure.png',output).pathname,fullPage:true}).catch(()=>{});throw error;}
  finally{await browser?.close();child.kill();await child.exited;}
}
console.log(JSON.stringify({results}));
