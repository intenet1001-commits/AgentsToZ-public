/** Actual React panel + synthetic local persistence. Never calls the real profile API, Keychain, AI or installed app. */
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium, webkit} from 'playwright';

const origin = process.argv[2], target = origin && new URL(origin);
if (!target || target.origin !== origin || target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
  || !target.port || target.port === '3001' || target.username || target.password) throw Error('Exact owned non-3001 HTTP fixture origin required');
const [source, main] = await Promise.all([
  fetch(origin + '/src/UserProfilePanel.tsx').then(response => response.text()),
  fetch(origin + '/src/main.tsx').then(response => response.text()),
]);
const react = source.match(/"([^"\n]*\/deps\/react\.js[^"\n]*)"/)?.[1];
const reactDom = main.match(/"([^"\n]*\/deps\/react-dom_client\.js[^"\n]*)"/)?.[1];
assert.ok(react && reactDom, 'the owned Vite transforms expose the real React dependencies');
const projectId = '11111111-1111-4111-8111-111111111111';
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;
import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};import '/src/index.css';
const {UserProfilePanel}=await import('/src/UserProfilePanel.tsx');
const key='isolated-user-profile-ui-v1',clone=value=>JSON.parse(JSON.stringify(value));
let profile=JSON.parse(localStorage.getItem(key)||'null')||{revision:'0',entries:[]};
const f=window.profileFixture={calls:[],nextSave:'normal',holdRead:false,releaseRead:null,originalOpens:0,get profile(){return clone(profile);},setRemoteEntries(entries){profile={revision:crypto.randomUUID(),entries:clone(entries)};localStorage.setItem(key,JSON.stringify(profile));}};
const conflict=()=>Object.assign(Error('fixture revision conflict'),{code:'USER_PROFILE_CONFLICT',status:409});
const request=async body=>{
 f.calls.push(clone(body));
 if(body.operation==='projects')return {projects:localStorage.getItem('isolated-user-profile-project-retired')?[]:[{memoryId:${JSON.stringify(projectId)},name:'프로필 시험 프로젝트'}]};
 if(body.operation==='read'){
  const answer={profile:clone(profile)};
  if(f.holdRead){f.holdRead=false;return new Promise(resolve=>{f.releaseRead=()=>{f.releaseRead=null;resolve(answer);};});}
  return answer;
 }
 if(body.operation!=='save'||body.confirmed!==true)throw Error('unexpected fixture write');
 const mode=f.nextSave;f.nextSave='normal';
 if(mode==='conflict'){profile={...profile,revision:crypto.randomUUID()};localStorage.setItem(key,JSON.stringify(profile));throw conflict();}
 if(mode==='unknown-before-commit')throw Object.assign(Error('fixture lost request'),{code:'USER_PROFILE_RESULT_UNCERTAIN'});
 if(body.expectedRevision!==profile.revision)throw conflict();
 profile={revision:crypto.randomUUID(),entries:clone(body.entries)};localStorage.setItem(key,JSON.stringify(profile));
 if(mode==='unknown-after-commit')throw Object.assign(Error('fixture lost reply'),{code:'USER_PROFILE_RESULT_UNCERTAIN'});
 return {profile:clone(profile)};
};
const initialLanguage=new URLSearchParams(location.search).get('lang')==='en'?'en':'ko';
function Fixture(){const [language,setLanguage]=React.useState(initialLanguage);f.setLanguage=setLanguage;return React.createElement('main',{style:{padding:16,maxWidth:980,margin:'0 auto',boxSizing:'border-box'}},React.createElement(UserProfilePanel,{request,language,onOpenUserMemory:()=>f.originalOpens++}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Fixture)));
</script>`;
const labels = {
  ko: {heading: '내 프로필', empty: '아직 직접 저장한 프로필이 없습니다.', confirm: '프로필 직접 확인', title: '프로필 항목 제목', body: '프로필 항목 내용', scope: '프로필 적용 범위', project: '프로필 적용 프로젝트', add: '새 항목 추가', deactivate: '사용 중지', restore: '다시 사용', reread: '저장본 다시 읽기', review: '이 초안을 최신 기준으로 검토', chooseDraft: '이 초안 사용', chooseSaved: '최신 저장값 사용', checkSave: '저장 상태 확인', originals: '내가 한 말 원문 보기', cancelAddition: '추가 취소', saved: '이 Mac에 저장했습니다', draftKept: '작성 중인 내용은 그대로 보존했습니다', conflictError: '저장본이 바뀌어', uncertain: '저장 여부를 확인하지 못했습니다', confirmed: '저장한 내용이 확인되었습니다', invalid: '4,000바이트', projectRequired: '등록 프로젝트를 다시 선택', projectOnly: '선택한 프로젝트만', allProjects: '이 Mac의 모든 프로젝트', active: '사용 중', inactive: '사용 중지', clean: '저장본과 같음'},
  en: {heading: 'My profile', empty: 'No personally reviewed profile entries yet.', confirm: 'Personally confirm profile', title: 'Profile entry title', body: 'Profile entry content', scope: 'Profile scope', project: 'Profile project', add: 'Add entry', deactivate: 'Stop using', restore: 'Use again', reread: 'Read saved profile again', review: 'Review draft against latest profile', chooseDraft: 'Use this draft', chooseSaved: 'Use latest saved values', checkSave: 'Check save status', originals: 'View What I Said originals', cancelAddition: 'Cancel addition', saved: 'was saved on this Mac', draftKept: 'Your draft has been preserved', conflictError: 'the saved profile changed', uncertain: 'Could not confirm whether the save completed', confirmed: 'Your saved content has been confirmed', invalid: '4,000 bytes', projectRequired: 'select a registered project', projectOnly: 'Selected project only', allProjects: 'All projects on this Mac', active: 'In use', inactive: 'Inactive', clean: 'Matches saved profile'},
};
mkdirSync('.agentstoz/maintainer/user-profile', {recursive: true});
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) for (const language of ['ko', 'en']) {
  const t = labels[language];
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
    const unexpected = [], errors = [];
    try {
      await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.startsWith('/api/')) {unexpected.push(url.origin + url.pathname); return route.abort();}
        if (url.pathname === '/__user-profile-panel') return route.fulfill({contentType: 'text/html', body: html});
        return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin + '/__user-profile-panel?lang=' + language);
      const panel = page.getByTestId('user-profile-panel'), save = panel.getByTestId('user-profile-save');
      const confirm = panel.getByRole('checkbox', {name: t.confirm, exact: true});
      const writes = () => page.evaluate(() => window.profileFixture.calls.filter(call => call.operation === 'save'));
      const current = () => panel.getByTestId('user-profile-entry').first();
      const title = () => current().getByRole('textbox', {name: t.title, exact: true});
      const body = () => current().getByRole('textbox', {name: t.body, exact: true});
      const submit = async () => {await confirm.check(); await save.click(); await panel.getByRole('status').filter({hasText: t.saved}).waitFor();};
      await panel.getByText(t.empty, {exact: true}).waitFor({timeout: 10_000}).catch(async failure => {
        throw new Error(failure.message + '\n' + JSON.stringify({errors, unexpected, body: await page.locator('body').innerText(), fixture: await page.evaluate(() => ({calls: window.profileFixture?.calls, profile: window.profileFixture?.profile}))}));
      });
      assert.match(await panel.innerText(), language === 'ko' ? /현재 OS 사용자 전용[\s\S]*다른 기기와 동기화하지 않습니다/ : /current OS user on this Mac only[\s\S]*no sync to other devices/);
      assert.match(await panel.innerText(), language === 'ko' ? /AI의 추측을 자동으로 확정하지 않으며[\s\S]*계정·권한·모델 설정을 자동으로 바꾸지 않습니다/ : /AI guesses are never automatically confirmed[\s\S]*current explicit instructions take priority[\s\S]*does not automatically change accounts, permissions or model settings/);
      if (language === 'en') assert.doesNotMatch(await panel.innerText(), /[가-힣]/, 'empty English panel has no untranslated Korean product copy');
      assert.deepEqual(await writes(), []);
      await panel.getByRole('button', {name: t.add, exact: true}).click();
      await title().fill('답변 언어'); await body().fill('한국어로 설명해 주세요.');
      await current().getByRole('combobox', {name: t.scope, exact: true}).selectOption('project');
      const project = current().getByRole('combobox', {name: t.project, exact: true});
      await project.selectOption(projectId);
      assert.equal(await confirm.isChecked(), false); assert.equal(await save.isEnabled(), false);
      await confirm.check(); await body().fill('한국어로 간결하게 설명해 주세요.');
      assert.equal(await confirm.isChecked(), false, 'editing resets direct confirmation');
      assert.equal(await save.isEnabled(), false); assert.equal((await writes()).length, 0);
      await submit();
      let saved = await page.evaluate(() => window.profileFixture.profile);
      const id = saved.entries[0].id;
      assert.match(id, /^[0-9a-f-]{36}$/);
      assert.equal(saved.entries[0].body, '한국어로 간결하게 설명해 주세요.');
      assert.deepEqual([saved.entries[0].scope, saved.entries[0].projectMemoryId, saved.entries[0].origin], ['project', projectId, 'user-confirmed']);
      assert.equal((await writes()).length, 1); assert.equal((await writes())[0].confirmed, true);
      await page.reload(); await title().waitFor();
      assert.equal(await title().inputValue(), '답변 언어'); assert.equal(await project.inputValue(), projectId);
      assert.equal(await confirm.isChecked(), false); assert.deepEqual(await writes(), [], 'reload reads persisted fixture data without saving');

      await current().getByRole('button', {name: t.deactivate, exact: true}).click();
      assert.equal(await current().getAttribute('data-state'), 'inactive'); assert.deepEqual(await writes(), []);
      await submit(); assert.equal((await page.evaluate(() => window.profileFixture.profile)).entries[0].state, 'inactive');
      await current().getByRole('button', {name: t.restore, exact: true}).click(); await submit();
      assert.deepEqual((await page.evaluate(() => window.profileFixture.profile)).entries.map(entry => [entry.id, entry.state]), [[id, 'active']]);

      await page.evaluate(() => {window.profileFixture.holdRead = true;});
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await page.waitForFunction(() => typeof window.profileFixture.releaseRead === 'function');
      await body().fill('늦은 조회가 이 초안을 지우면 안 됩니다.');
      await page.evaluate(() => window.profileFixture.releaseRead());
      await panel.getByRole('status').filter({hasText: t.draftKept}).waitFor();
      assert.equal(await body().inputValue(), '늦은 조회가 이 초안을 지우면 안 됩니다.');
      assert.equal(await confirm.isChecked(), false);
      const callsBeforeLanguage = await page.evaluate(() => window.profileFixture.calls.length);
      const otherLanguage = language === 'ko' ? 'en' : 'ko';
      await page.evaluate(value => window.profileFixture.setLanguage(value), otherLanguage);
      await panel.getByRole('heading', {name: labels[otherLanguage].heading, exact: true}).waitFor();
      await panel.getByRole('status').filter({hasText: labels[otherLanguage].draftKept}).waitFor();
      assert.equal(await panel.getByRole('textbox', {name: labels[otherLanguage].body, exact: true}).first().inputValue(), '늦은 조회가 이 초안을 지우면 안 됩니다.');
      assert.equal(await page.evaluate(() => window.profileFixture.calls.length), callsBeforeLanguage, 'changing app language preserves draft and performs no API calls');
      await page.evaluate(value => window.profileFixture.setLanguage(value), language);
      await panel.getByRole('heading', {name: t.heading, exact: true}).waitFor();
      assert.equal(await confirm.isEnabled(), false, 'an observed saved snapshot must be reviewed before saving');
      await panel.getByRole('button', {name: t.review, exact: true}).click();

      const remoteId = '22222222-2222-4222-8222-222222222222';
      await page.evaluate(remoteId => {
        const f = window.profileFixture;
        f.setRemoteEntries([...f.profile.entries, {id: remoteId, title: '다른 창에서 추가', body: '새 항목도 보존해 주세요.', scope: 'all-projects', projectMemoryId: null, state: 'active', updatedAt: new Date().toISOString(), origin: 'user-confirmed'}]);
      }, remoteId);
      await confirm.check(); await save.click();
      await panel.getByRole('alert').filter({hasText: t.conflictError}).waitFor();
      assert.equal(await body().inputValue(), '늦은 조회가 이 초안을 지우면 안 됩니다.');
      const afterConflict = (await writes()).length;
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await panel.getByRole('button', {name: t.review, exact: true}).click();
      assert.equal(await body().inputValue(), '늦은 조회가 이 초안을 지우면 안 됩니다.');
      assert.equal(await panel.getByTestId('user-profile-conflict').count(), 0, 'different-entry changes merge without inventing a conflict');
      assert.equal(await panel.locator(`[data-entry-id="${remoteId}"]`).getByRole('textbox', {name: t.body, exact: true}).inputValue(), '새 항목도 보존해 주세요.');
      assert.equal(await confirm.isChecked(), false); assert.equal((await writes()).length, afterConflict, 'a conflict refresh and review never write');
      await submit();
      assert.deepEqual((await page.evaluate(() => window.profileFixture.profile)).entries.map(entry => [entry.id, entry.body]), [[id, '늦은 조회가 이 초안을 지우면 안 됩니다.'], [remoteId, '새 항목도 보존해 주세요.']], 'whole-snapshot save preserves a concurrent addition beside the local edit');

      // A remote edit to an untouched entry follows the latest value while our separate edit survives.
      await body().fill('로컬에서 바꾼 첫 번째 항목');
      await page.evaluate(remoteId => {
        const f = window.profileFixture;
        f.setRemoteEntries(f.profile.entries.map(entry => entry.id === remoteId ? {...entry, body: '다른 창에서 바꾼 두 번째 항목', updatedAt: new Date().toISOString()} : entry));
      }, remoteId);
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await panel.getByRole('button', {name: t.review, exact: true}).click();
      assert.equal(await body().inputValue(), '로컬에서 바꾼 첫 번째 항목');
      assert.equal(await panel.locator(`[data-entry-id="${remoteId}"]`).getByRole('textbox', {name: t.body, exact: true}).inputValue(), '다른 창에서 바꾼 두 번째 항목');
      await submit();

      // Same-entry changes must show the actual values and require an explicit selection.
      await title().fill('로컬 제목'); await body().fill('로컬 초안 내용');
      await page.evaluate(id => {
        const f = window.profileFixture;
        f.setRemoteEntries(f.profile.entries.map(entry => entry.id === id ? {...entry, title: '최신 제목', body: '최신 저장 내용', scope: 'all-projects', projectMemoryId: null, state: 'inactive', updatedAt: new Date().toISOString()} : entry));
      }, id);
      const beforeChoice = (await writes()).length;
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await panel.getByRole('button', {name: t.review, exact: true}).click();
      const collision = panel.getByTestId('user-profile-conflict');
      await collision.waitFor();
      const draftComparison = await collision.getByTestId('user-profile-conflict-draft').innerText();
      const savedComparison = await collision.getByTestId('user-profile-conflict-saved').innerText();
      for (const value of ['로컬 제목', '로컬 초안 내용', t.projectOnly + ' · 프로필 시험 프로젝트', t.active]) assert.ok(draftComparison.includes(value), 'draft comparison shows ' + value);
      for (const value of ['최신 제목', '최신 저장 내용', t.allProjects, t.inactive]) assert.ok(savedComparison.includes(value), 'saved comparison shows ' + value);
      assert.equal(await confirm.isEnabled(), false); assert.equal(await save.isEnabled(), false); assert.equal(await body().isEnabled(), false);
      assert.equal((await writes()).length, beforeChoice, 'comparison alone never writes or grants confirmation');
      await page.screenshot({path: `.agentstoz/maintainer/user-profile/${name}-${language}-conflict-390.png`, fullPage: true});
      await collision.getByRole('button', {name: t.chooseDraft, exact: true}).click();
      assert.equal(await collision.count(), 0); assert.equal(await body().inputValue(), '로컬 초안 내용');
      assert.equal(await confirm.isChecked(), false); await submit();
      assert.equal((await page.evaluate(() => window.profileFixture.profile)).entries.find(entry => entry.id === id).body, '로컬 초안 내용');

      // Selecting the latest value removes the only local change and returns to a clean state.
      await body().fill('사용하지 않을 로컬 수정');
      await page.evaluate(id => {const f = window.profileFixture; f.setRemoteEntries(f.profile.entries.map(entry => entry.id === id ? {...entry, body: '선택할 최신 내용', updatedAt: new Date().toISOString()} : entry));}, id);
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await panel.getByRole('button', {name: t.review, exact: true}).click();
      await collision.getByRole('button', {name: t.chooseSaved, exact: true}).click();
      assert.equal(await body().inputValue(), '선택할 최신 내용');
      assert.equal(await confirm.isEnabled(), false); assert.equal(await save.isEnabled(), false);
      assert.ok((await panel.innerText()).includes(t.clean));

      await body().fill('응답이 사라져도 한 번만 저장한 내용');
      await page.evaluate(() => {window.profileFixture.nextSave = 'unknown-after-commit';});
      await confirm.check(); await save.click();
      await panel.getByRole('alert').filter({hasText: t.uncertain}).waitFor();
      const unknownWrites = (await writes()).length;
      assert.equal(await body().isEnabled(), false); assert.equal(await save.isEnabled(), false);
      await panel.getByRole('button', {name: t.checkSave, exact: true}).click();
      await panel.getByRole('status').filter({hasText: t.confirmed}).waitFor();
      assert.equal((await writes()).length, unknownWrites, 'an uncertain reply is resolved only by reading, never replayed');
      assert.equal(await body().inputValue(), '응답이 사라져도 한 번만 저장한 내용');

      // A lost request that did not commit is distinct from a lost reply; rereading a different
      // remote result must preserve both sides and must not send the unknown payload again.
      await body().fill('미확정 요청의 보존할 초안');
      await page.evaluate(() => {window.profileFixture.nextSave = 'unknown-before-commit';});
      await confirm.check(); await save.click();
      await panel.getByRole('alert').filter({hasText: t.uncertain}).waitFor();
      const lostRequestWrites = (await writes()).length;
      await page.evaluate(remoteId => {const f = window.profileFixture; f.setRemoteEntries(f.profile.entries.map(entry => entry.id === remoteId ? {...entry, body: '미확정 중 다른 창의 변경', updatedAt: new Date().toISOString()} : entry));}, remoteId);
      await panel.getByRole('button', {name: t.checkSave, exact: true}).click();
      await panel.getByRole('button', {name: t.review, exact: true}).click();
      assert.equal(await body().inputValue(), '미확정 요청의 보존할 초안');
      assert.equal(await panel.locator(`[data-entry-id="${remoteId}"]`).getByRole('textbox', {name: t.body, exact: true}).inputValue(), '미확정 중 다른 창의 변경');
      assert.equal((await writes()).length, lostRequestWrites, 'unknown + nonmatching read never resends automatically');
      await submit();

      // An earlier read may finish after a successful save; it must not restore the old snapshot.
      await page.evaluate(() => {window.profileFixture.holdRead = true;});
      await panel.getByRole('button', {name: t.reread, exact: true}).click();
      await page.waitForFunction(() => typeof window.profileFixture.releaseRead === 'function');
      await body().fill('저장 뒤에 도착한 이전 조회도 무시합니다.'); await submit();
      await page.evaluate(() => window.profileFixture.releaseRead());
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await body().inputValue(), '저장 뒤에 도착한 이전 조회도 무시합니다.');

      const beforeInvalid = (await writes()).length;
      await body().fill('가'.repeat(1334)); await confirm.check(); await save.click();
      await panel.getByRole('alert').filter({hasText: t.invalid}).waitFor();
      assert.equal((await writes()).length, beforeInvalid, 'UTF-8 overflow never reaches the requester');
      await body().fill('로컬 선호를 직접 확인합니다.'); await submit();
      await panel.getByRole('button', {name: t.originals, exact: true}).click();
      assert.equal(await page.evaluate(() => window.profileFixture.originalOpens), 1);
      await panel.getByRole('button', {name: t.add, exact: true}).click();
      await panel.getByRole('button', {name: t.cancelAddition, exact: true}).click();
      assert.equal(await panel.getByTestId('user-profile-entry').count(), 2, 'an unpersisted empty addition can be cancelled without deleting saved entries');
      assert.equal(await confirm.isEnabled(), false, 'cancelling an empty addition restores the clean saved state');

      // An unregistered project's old preference can be disabled, but cannot be reactivated
      // without choosing a current project. This does not delete either saved entry.
      await page.evaluate(() => localStorage.setItem('isolated-user-profile-project-retired', 'yes'));
      await page.reload(); await title().waitFor();
      await current().getByRole('button', {name: t.deactivate, exact: true}).click(); await submit();
      assert.equal((await page.evaluate(() => window.profileFixture.profile)).entries.find(entry => entry.id === id).state, 'inactive');
      await current().getByRole('button', {name: t.restore, exact: true}).click();
      const inactiveWrites = (await writes()).length;
      await confirm.check(); await save.click();
      await panel.getByRole('alert').filter({hasText: t.projectRequired}).waitFor();
      assert.equal((await writes()).length, inactiveWrites, 'an unregistered active project never reaches the save request');
      await page.evaluate(() => localStorage.removeItem('isolated-user-profile-project-retired'));
      await page.reload(); await title().waitFor();
      await current().getByRole('button', {name: t.restore, exact: true}).click(); await submit();
      for (const width of [390, 744, 1100]) {
        await page.setViewportSize({width, height: 950});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}/${language} ${width}: no horizontal overflow`);
        const metrics = await panel.evaluate(node => ({buttons: [...node.querySelectorAll('button')].map(button => button.getBoundingClientRect().height), fields: [...node.querySelectorAll('input:not([type="checkbox"]),textarea,select')].map(field => ({fontSize: parseFloat(getComputedStyle(field).fontSize), height: field.getBoundingClientRect().height}))}));
        assert.ok(metrics.buttons.every(height => height >= 44), `${name}/${language} ${width}: touch controls at least44px`);
        assert.ok(metrics.fields.every(field => field.fontSize >= 16 && field.height >= 44), `${name}/${language} ${width}: inputs at least16px with44px targets: ${JSON.stringify(metrics.fields)}`);
        await page.screenshot({path: `.agentstoz/maintainer/user-profile/${name}-${language}-${width}.png`, fullPage: true});
      }
      assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      assert.ok((await page.evaluate(() => window.profileFixture.calls)).every(call => ['read', 'projects', 'save'].includes(call.operation)));
      console.log(`${name}/${language}: direct confirmation, project scope and retired-project inactive/restore, persisted fixture reload, three-way concurrent additions/edits, explicit same-entry conflict choices, late-read preservation, both uncertain-result read comparisons, UTF-8 bound and390/744/1100px passed (synthetic storage; no real API/installed-app/account proof)`);
    } finally {await context.close();}
  } finally {await browser.close();}
}
