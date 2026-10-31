/** Rendered UI + real local support host. Browser SDK, official OAuth and provider CLI are synthetic boundaries;
 * these results are not native computer-use, real Google sign-in or installed-CEF evidence. */
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {createAssistScreenFixture} from './fixtures/helpdesk-assist-server.ts';

const output = join(import.meta.dir, '../output/playwright/helpdesk-assist');
mkdirSync(output, {recursive: true});
const results = [];
const resultFile = join(output, 'results.json');
const source = 'real-support-host-real-components-synthetic-browser-OAuth-CLI';
writeFileSync(resultFile, JSON.stringify({source, state: 'running', passed: false, results}, null, 2));
process.on('exit', code => writeFileSync(resultFile, JSON.stringify({source, state: code === 0 ? 'completed' : 'failed', passed: code === 0, results}, null, 2)));
const state = async fixture => (await fetch(fixture.url + 'fixture/state')).json();
async function waitState(fixture, predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const current = await state(fixture);
    if (predicate(current)) return current;
    await new Promise(r => setTimeout(r, 80));
  }
  throw Error('Fixture state did not reach the expected observable result');
}
async function begin(page, fixture, service = 'github', project = 'existing') {
  await page.goto(fixture.url + '?service=' + service);
  const start = page.getByRole('button', {name: '이 범위로 함께 진행', exact: true});
  await start.waitFor();
  assert.equal(await start.isDisabled(), true, 'scope confirmation is required');
  assert.equal((await state(fixture)).actions.length, 0, 'opening never moves a browser');
  assert.equal((await state(fixture)).operations.some(o => o.startsWith('platform:login-')), false, 'opening never signs in');
  if (service === 'google-workspace') {
    if (project === 'new') await page.getByRole('radio', {name: '새 프로젝트', exact: true}).check();
    else {
      await page.getByLabel('프로젝트 ID', {exact: true}).fill('invalid project');
      assert.equal(await start.isDisabled(), true);
      await page.getByLabel('프로젝트 ID', {exact: true}).fill('fixture-project-123');
    }
  }
  await page.getByRole('checkbox', {name: /이 범위에서 허용된 화면 이동/}).check();
  assert.equal(await start.isEnabled(), true);
  await start.click();
}
async function currentStep(page, title) {
  await page.locator('.assist-steps li[aria-current="step"]').filter({hasText: title}).waitFor();
}
async function confirmHuman(page) {
  await page.getByRole('button', {name: '직접 마쳤어요 · 이어서 진행', exact: true}).click();
}
async function finishLogin(page, fixture) {
  await page.getByRole('button', {name: '브라우저로 계정 연결', exact: true}).click();
  await waitState(fixture, s => s.operations.some(o => ['platform:login-start', 'platform:login-add-start', 'platform:login-onboarding-start'].includes(o)));
  await page.getByRole('button', {name: '공식 로그인 완료 (시험 응답)', exact: true}).click();
  const finished = await waitState(fixture, s => s.run?.state === 'completed');
  assert.equal(finished.run.checks.find(c => c.id === 'connection')?.state, 'ok');
  await page.getByText('실제 연결 확인됨', {exact: true}).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'successful linking must not send an invalid human-done');
  assert.equal(finished.operations.filter(o => ['platform:login-start', 'platform:login-add-start', 'platform:login-onboarding-start'].includes(o)).length, 1);
}

for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await engine.launch();
  try {
    for (const width of [390, 1120]) {
      const context = await browser.newContext({viewport: {width, height: 1000}});
      const page = await context.newPage();
      const errors = [];
      page.setDefaultTimeout(20_000); page.on('pageerror', e => errors.push(e.message));
      let fixture;
      try {
        fixture = await createAssistScreenFixture({holdCheck: true});
        await begin(page, fixture);
        await waitState(fixture, s => s.waitingCheck);
        const stop = page.getByRole('button', {name: '도움 끝내기', exact: true});
        assert.equal(await stop.isEnabled(), true, 'cancel stays available while a provider check is pending');
        await stop.click();
        await waitState(fixture, s => s.run?.state === 'cancelled');
        await page.getByRole('button', {name: '대기 중인 검사 응답 보내기', exact: true}).click();
        await page.getByRole('button', {name: '원래 화면으로', exact: true}).waitFor();
        assert.equal((await state(fixture)).run.state, 'cancelled');
        assert.equal(await page.getByRole('alert').count(), 0, 'a late progress reply must not replace cancellation');
        await page.screenshot({path: join(output, `${engineName}-${width}-cancel.png`), fullPage: true});
        await fixture.close(); fixture = null;

        fixture = await createAssistScreenFixture();
        await begin(page, fixture);
        await confirmHuman(page); // Official signup is a separate human step.
        await currentStep(page, '공식 CLI 로그인');
        await finishLogin(page, fixture);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow');
        await page.screenshot({path: join(output, `${engineName}-${width}-connected.png`), fullPage: true});
        await page.getByRole('button', {name: '원래 화면으로', exact: true}).click();
        await page.getByText('원래 화면으로 돌아왔습니다.', {exact: true}).waitFor();
        assert.deepEqual(errors, []);
        results.push({engine: engineName, width, passed: true, journeys: ['explicit-scope', 'cancel-during-pending-check', 'late-reply-after-cancel', 'signup-human-handoff', 'official-login-single-request', 'link-to-verify', 'return-to-origin', 'no-overflow']});
        console.log(`${engineName}-${width}: support control and login journeys passed`);
      } catch (error) {
        await page.screenshot({path: join(output, `${engineName}-${width}-failure.png`), fullPage: true}).catch(() => {});
        throw error;
      } finally { await fixture?.close(); await context.close(); }
    }

    // GWS's longer preparation route is rendered once per engine; both narrow and wide layouts above use the same UI.
    const context = await browser.newContext({viewport: {width: 1120, height: 1000}});
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    const fixture = await createAssistScreenFixture();
    try {
      await begin(page, fixture, 'google-workspace');
      await currentStep(page, '동의 화면 · 앱 이름과 이메일');
      await confirmHuman(page);
      await currentStep(page, '동의 화면 · 테스트 사용자');
      await confirmHuman(page);
      await currentStep(page, '데스크톱 앱 클라이언트 입력 준비');
      await confirmHuman(page);
      await currentStep(page, 'JSON을 앱에 직접 첨부');
      const client = JSON.stringify({installed: {project_id: 'fixture-project-123', client_id: 'fixture.apps.googleusercontent.com', client_secret: 'GOCSPX_fixture_test_only',
        auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost']}});
      await page.locator('input[type=file]').setInputFiles({name: 'fixture-desktop.json', mimeType: 'application/json', buffer: Buffer.from(client)});
      await currentStep(page, '공식 Google 인증');
      assert.equal((await page.content()).includes('GOCSPX_fixture_test_only'), false, 'client secret never becomes rendered content');
      await finishLogin(page, fixture);
      const complete = await state(fixture);
      assert.equal(complete.actions.some(a => a.label === '만들기' || a.label === '저장'), false, 'create/save confirmations stay human');
      for (const id of ['console', 'client', 'login', 'connection']) assert.equal(complete.run.checks.find(c => c.id === id)?.state, 'ok', id);
      await page.screenshot({path: join(output, `${engineName}-gws-connected.png`), fullPage: true});
      results.push({engine: engineName, width: 1120, passed: true, journeys: ['gws-reviewed-preparation', 'create-save-human-only', 'client-json-direct-attachment', 'no-secret-in-rendered-page', 'official-login', 'separate-connection-proof']});
      console.log(`${engineName}: GWS preparation/attachment/login journey passed`);
    } catch (error) {
      await page.screenshot({path: join(output, `${engineName}-gws-failure.png`), fullPage: true}).catch(() => {});
      throw error;
    } finally { await fixture.close(); await context.close(); }

    const projectContext = await browser.newContext({viewport: {width: 390, height: 1000}});
    const projectPage = await projectContext.newPage(); projectPage.setDefaultTimeout(15_000);
    const projectFixture = await createAssistScreenFixture();
    try {
      await begin(projectPage, projectFixture, 'google-workspace', 'new');
      await waitState(projectFixture, s => s.run?.step === 'project' && s.run.state === 'waiting-human');
      await projectPage.getByRole('button', {name: '새 프로젝트 생성 완료 (시험 응답)', exact: true}).click();
      await confirmHuman(projectPage);
      const resumed = await waitState(projectFixture, s => s.run?.links.projectId === 'fixture-project-123' && s.run.step !== 'project', 8_000);
      assert.equal(resumed.run.links.projectId, 'fixture-project-123', 'read the new project URL only after explicit takeback');
      assert.equal(resumed.actions.some(a => a.label === '만들기'), false);
      await projectPage.screenshot({path: join(output, `${engineName}-390-new-project.png`), fullPage: true});
      results.push({engine: engineName, width: 390, passed: true, journeys: ['new-project-human-confirmation', 'takeback-before-SDK-URL-read', 'validated-project-before-api-preparation']});
      console.log(`${engineName}: new-project handoff and continuation passed`);
    } catch (error) {
      await projectPage.screenshot({path: join(output, `${engineName}-new-project-failure.png`), fullPage: true}).catch(() => {});
      throw error;
    } finally { await projectFixture.close(); await projectContext.close(); }
  } finally { await browser.close(); }
}
writeFileSync(resultFile, JSON.stringify({source, state: 'completed', passed: true, results}, null, 2));
