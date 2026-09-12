/** Real React lifecycle, isolated transport; never connects to KakaoTalk or an AI. */
import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TARGET ?? 'http://127.0.0.1:9421';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Local fixture URL required');
const browserType = process.env.DUTY_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
const failures = [];
const button = (page, name) => page.getByRole('button', { name, exact: true });
const profile = page => page.getByLabel('대직용 카카오톡 프로필 이름');
const open = async page => {
  await button(page, 'CS 대직 · 질문 응답 설정').click();
  await page.getByTestId('cs-duty-state').filter({ hasText: 'OFF' }).waitFor();
};
const fill = async page => {
  await profile(page).fill('보존할 프로필');
  await button(page, '카카오톡 채팅방 목록 확인').click();
  await page.getByLabel('응대할 채팅방').selectOption('chat_fixture');
  await page.getByLabel('공유 안내 자료').fill('저장하고 다시 열어도 남아야 하는 안내 자료');
  await button(page, 'FAQ 추가').click();
  await page.getByLabel('FAQ 질문 1', { exact: true }).fill('운영 시간?');
  await page.getByLabel('FAQ 답변 1', { exact: true }).fill('오전 9시');
  await page.getByLabel('답변 담당 AI', { exact: true }).selectOption('codex');
  await page.getByLabel('AI 호출 상한').fill('7');
};
const save = async page => {
  const before = await page.evaluate(() => window.fixtureRequests.filter(x => x === 'save').length);
  await button(page, '설정 저장').click();
  await page.waitForFunction(n => window.fixtureRequests.filter(x => x === 'save').length > n, before);
  await profile(page).waitFor();
  await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
};
const savedValues = async page => {
  assert.equal(await profile(page).inputValue(), '보존할 프로필');
  assert.equal(await page.getByLabel('응대할 채팅방').inputValue(), 'chat_fixture');
  assert.equal(await page.getByLabel('공유 안내 자료').inputValue(), '저장하고 다시 열어도 남아야 하는 안내 자료');
  assert.equal(await page.getByLabel('FAQ 답변 1', { exact: true }).inputValue(), '오전 9시');
  assert.equal(await page.getByLabel('답변 담당 AI', { exact: true }).inputValue(), 'codex');
  assert.equal(await page.getByLabel('AI 호출 상한').inputValue(), '7');
};
async function scenario(name, run) {
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  try {
    await page.goto(base + '/tests/fixtures/cs-duty.html');
    await run(page);
    assert.deepEqual(errors, [], 'No uncaught React errors');
    console.log('PASS ' + name);
  } catch (error) {
    failures.push(name);
    console.error('FAIL ' + name + ': ' + error.message + (errors.length ? ' · ' + errors.join('; ') : ''));
  } finally { await page.close(); }
}
try {
  await scenario('one project adds another room without sharing data or stopping the original', async page => {
    await open(page); await fill(page); await save(page);
    await button(page,'다른 채팅방 추가').click();
    await page.getByLabel('추가할 채팅방').selectOption('chat_second');
    await button(page,'선택한 방 연결').click();
    await page.getByLabel('응대할 채팅방').waitFor();
    await page.waitForFunction(()=>document.querySelector('[aria-label="응대할 채팅방"]')?.value==='chat_second');
    assert.equal(await page.getByLabel('공유 안내 자료').inputValue(),'');
    assert.equal(await page.getByRole('checkbox',{name:'FAQ에 없는 질문은 선택한 AI로 답변',exact:true}).isChecked(),false);
    assert.equal(await page.getByTestId('cs-duty-state').getAttribute('data-state'),'off');
    await page.getByLabel('대직 연결 선택').selectOption('fixture-project');
    await page.waitForFunction(()=>document.querySelector('[aria-label="응대할 채팅방"]')?.value==='chat_fixture');
    await savedValues(page);
  });
  await scenario('saved settings survive close, reopen and project remount', async page => {
    await open(page); await fill(page); await save(page);
    await button(page, 'CS 대직 닫기').click(); await open(page); await savedValues(page);
    await button(page, 'CS 대직 닫기').click();
    await page.evaluate(() => window.fixtureSelectProject('fixture-second'));
    await open(page); assert.equal(await profile(page).inputValue(), '');
    await button(page, 'CS 대직 닫기').click();
    await page.evaluate(() => window.fixtureSelectProject('fixture-project'));
    await open(page); await savedValues(page);
  });
  await scenario('project aliases persist and shared room lists both projects', async page => {
    await open(page); await fill(page);
    await page.getByLabel('프로젝트 호출 별칭').fill('포털'); await save(page);
    await button(page, 'CS 대직 닫기').click();
    await page.evaluate(() => window.fixtureSelectProject('fixture-second'));
    await open(page); await fill(page);
    await page.getByLabel('프로젝트 호출 별칭').fill('결제'); await save(page);
    await page.getByTestId('cs-duty-room-projects').filter({hasText:'#포털'}).waitFor();
    await page.getByTestId('cs-duty-room-projects').filter({hasText:'#결제'}).waitFor();
    await button(page, 'CS 대직 닫기').click();
    await page.evaluate(() => window.fixtureSelectProject('fixture-project'));
    await open(page); assert.equal(await page.getByLabel('프로젝트 호출 별칭').inputValue(),'포털');
  });
  await scenario('legacy configuration suggests a project alias and requires saving it', async page => {
    await open(page); await fill(page); await save(page); await button(page,'CS 대직 닫기').click();
    await page.evaluate(()=>window.fixtureUpdateConfig('fixture-project',{projectAlias:''}));
    await open(page); await page.getByText('기존 설정에는 호출 별칭이 없습니다.',{exact:false}).waitFor();
    assert.equal(await page.getByLabel('프로젝트 호출 별칭').inputValue(),'테스트-프로젝트');
    await save(page); await button(page,'채팅창 다시 열기').click();
    await page.getByText('채팅창을 앞으로 열었습니다.',{exact:false}).waitFor();
    assert.equal(await page.evaluate(()=>window.fixtureRequests.includes('enable')),false);
  });
  await scenario('unsaved close offers save and close without losing inputs', async page => {
    await open(page); await fill(page);
    await button(page, 'CS 대직 닫기').click();
    await page.getByTestId('cs-duty-unsaved').waitFor();
    await savedValues(page);
    await button(page, '저장하고 닫기').click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await open(page); await savedValues(page);
  });
  await scenario('Escape protects edits; explicit discard restores saved values', async page => {
    await open(page); await fill(page); await save(page);
    await profile(page).fill('미저장 수정');
    await page.keyboard.press('Escape');
    await button(page, '계속 편집').click();
    assert.equal(await profile(page).inputValue(), '미저장 수정');
    await page.keyboard.press('Escape');
    await button(page, '저장하지 않고 닫기').click();
    await open(page); await savedValues(page);
  });
  await scenario('refreshing an unconfigured project does not crash', async page => {
    await open(page);
    await button(page, '저장된 설정·자동 FAQ 다시 불러오기').click();
    await page.waitForFunction(() => window.fixtureRequests.filter(x => x === 'status').length >= 2);
    assert.equal(await profile(page).inputValue(), '');
    await profile(page).fill('정상 입력');
  });
  await scenario('delayed initial read cannot overwrite user input', async page => {
    await page.evaluate(() => window.fixtureHoldNext('status'));
    await button(page, 'CS 대직 · 질문 응답 설정').click();
    await page.waitForFunction(() => !!window.fixtureRelease);
    assert(await profile(page).count() === 0 || await profile(page).isDisabled(), 'Editor must wait for authoritative read');
    await page.evaluate(() => window.fixtureRelease());
    await page.getByTestId('cs-duty-state').filter({ hasText: 'OFF' }).waitFor();
    await profile(page).fill('입력 유지');
  });
  await scenario('failed initial read is not an empty editable configuration', async page => {
    await page.evaluate(() => window.fixtureFailNext('status'));
    await button(page, 'CS 대직 · 질문 응답 설정').click();
    await page.getByTestId('cs-duty-error').waitFor();
    assert(await profile(page).count() === 0 || await profile(page).isDisabled(), 'Read failure must not expose empty form');
    await button(page, '설정 다시 확인').click();
    await page.getByTestId('cs-duty-state').filter({ hasText: 'OFF' }).waitFor();
    await profile(page).fill('다시 연결됨');
  });
  await scenario('old delayed read cannot block or overwrite reopened dialog', async page => {
    await page.evaluate(() => window.fixtureHoldNext('status'));
    await button(page, 'CS 대직 · 질문 응답 설정').click();
    await page.waitForFunction(() => !!window.fixtureRelease);
    await button(page, 'CS 대직 닫기').click();
    await button(page, 'CS 대직 · 질문 응답 설정').click();
    await page.waitForFunction(() => window.fixtureRequests.filter(x => x === 'status').length >= 2, null, { timeout: 2000 });
    await profile(page).fill('새 화면 입력');
    await page.evaluate(() => window.fixtureRelease());
    assert.equal(await profile(page).inputValue(), '새 화면 입력');
  });
  await scenario('failed save keeps edits and does not claim success or close', async page => {
    await open(page); await fill(page);
    await page.evaluate(() => window.fixtureFailNext('save'));
    await button(page, 'CS 대직 닫기').click();
    await button(page, '저장하고 닫기').click();
    await page.getByTestId('cs-duty-error').filter({ hasText: '테스트 저장소 연결 실패' }).waitFor();
    await savedValues(page);
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await button(page, '저장하고 닫기').click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await open(page); await savedValues(page);
  });
  await scenario('polling refreshes untouched automatic FAQ but preserves local edits and revision conflict', async page => {
    await page.clock.install();
    await open(page); await fill(page); await save(page);
    await page.evaluate(() => window.fixtureUpdateConfig('fixture-project', { faqs: [{ question: '자동 질문', answer: '자동 응답' }] }));
    await page.clock.runFor(5100);
    await page.waitForFunction(() => document.querySelector('[aria-label="FAQ 질문 1"]')?.value === '자동 질문');
    await profile(page).fill('편집 중 프로필');
    await page.evaluate(() => window.fixtureUpdateConfig('fixture-project', { knowledge: '다른 화면이 변경한 자료' }));
    await page.clock.runFor(5100);
    await page.getByTestId('cs-duty-conflict').waitFor();
    assert.equal(await profile(page).inputValue(), '편집 중 프로필');
    await button(page, '설정 저장').click();
    await page.getByTestId('cs-duty-error').filter({ hasText: '다른 화면에서 설정이 바뀌었습니다' }).waitFor();
    assert.equal(await profile(page).inputValue(), '편집 중 프로필');
  });
  await scenario('explicit reload protects edits and restores the saved snapshot', async page => {
    await open(page); await fill(page); await save(page);
    await profile(page).fill('지우면 안 되는 입력');
    await button(page, '저장된 설정·자동 FAQ 다시 불러오기').click();
    await button(page, '계속 편집').click();
    assert.equal(await profile(page).inputValue(), '지우면 안 되는 입력');
    await button(page, '저장된 설정·자동 FAQ 다시 불러오기').click();
    await button(page, '변경사항 버리고 불러오기').click();
    await savedValues(page);
  });
  await scenario('save waits for its receipt before close and cannot be submitted twice', async page => {
    await open(page); await fill(page);
    await page.evaluate(() => window.fixtureHoldNext('save'));
    await button(page, 'CS 대직 닫기').click();
    await button(page, '저장하고 닫기').click();
    await page.waitForFunction(() => !!window.fixtureRelease);
    assert.equal(await button(page, 'CS 대직 닫기').isDisabled(), true);
    assert.equal(await button(page, '저장하고 닫기').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await page.evaluate(() => window.fixtureRelease());
    await page.locator('dialog').waitFor({ state: 'detached' });
    await open(page); await savedValues(page);
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'save').length), 1);
  });
  await scenario('late polling response cannot roll back a successful save', async page => {
    await page.clock.install();
    await open(page); await fill(page); await save(page);
    await page.evaluate(() => window.fixtureHoldNext('status'));
    await page.clock.runFor(5100);
    await page.waitForFunction(() => !!window.fixtureRelease);
    await profile(page).fill('두 번째 저장'); await save(page);
    await page.evaluate(() => window.fixtureRelease());
    assert.equal(await profile(page).inputValue(), '두 번째 저장');
    await button(page, 'CS 대직 닫기').click(); await open(page);
    assert.equal(await profile(page).inputValue(), '두 번째 저장');
  });
  await scenario('StrictMode remount and unknown saved model keep the actual configuration', async page => {
    await page.goto(base + '/tests/fixtures/cs-duty.html?strict=1');
    await open(page); await fill(page); await save(page);
    await button(page, 'CS 대직 닫기').click();
    await page.evaluate(() => window.fixtureUpdateConfig('fixture-project', { modelId: 'saved-custom-model' }));
    await open(page); await savedValues(page);
    assert.equal(await page.getByLabel('세부 모델', { exact: true }).inputValue(), 'saved-custom-model');
  });
  await scenario('OFF overtakes pending ON and its late result cannot rearm the screen', async page => {
    await open(page); await fill(page); await save(page);
    await page.getByRole('checkbox', { name: /이 Mac의 프로필과 채팅방을 확인했고/ }).check();
    await page.evaluate(() => window.fixtureHoldNext('enable'));
    await button(page, '대직 ON · 자동 답변 허용').click();
    await page.waitForFunction(() => !!window.fixtureRelease);
    await button(page, '대직 OFF').click();
    await page.evaluate(() => window.fixtureRelease());
    await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
    await page.getByTestId('cs-duty-state').filter({ hasText: 'OFF' }).waitFor();
    await button(page, 'CS 대직 닫기').click(); await open(page); await savedValues(page);
  });
  await scenario('pending OFF blocks duplicate stops and status polling until acknowledged', async page => {
    await page.clock.install();
    await open(page); await fill(page); await save(page);
    await page.evaluate(() => window.fixtureHoldNext('disable'));
    await button(page, '대직 OFF').click();
    await page.waitForFunction(() => !!window.fixtureRelease);
    assert.equal(await button(page, '대직 OFF').isDisabled(), true);
    const reads = await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length);
    await page.clock.runFor(5100);
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length), reads);
    await page.evaluate(() => window.fixtureRelease());
    await page.waitForFunction(() => !document.querySelector('fieldset')?.disabled);
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'disable').length), 1);
  });
  await scenario('closed and replaced dialogs release their polling timers', async page => {
    await page.clock.install();
    for (let cycle = 0; cycle < 3; cycle++) {
      await open(page);
      await button(page, 'CS 대직 닫기').click();
      await page.locator('dialog').waitFor({ state: 'detached' });
      const reads = await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length);
      await page.clock.runFor(15000);
      assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length), reads);
    }
    await open(page);
    await page.evaluate(() => window.fixtureSelectProject('fixture-second'));
    await page.locator('dialog').waitFor({ state: 'detached' });
    const reads = await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length);
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'status').length), reads);
    await open(page);
    assert.equal(await profile(page).inputValue(), '');
  });
  await scenario('closing ON dialog preserves runtime and reopens saved configuration without consent', async page => {
    await open(page); await fill(page); await save(page);
    await page.getByRole('checkbox', { name: /이 Mac의 프로필과 채팅방을 확인했고/ }).check();
    await button(page, '대직 ON · 자동 답변 허용').click();
    await page.getByTestId('cs-duty-state').filter({ hasText: 'ON ·' }).waitFor();
    await button(page, 'CS 대직 닫기').click();
    await button(page, 'CS 대직 · 질문 응답 설정').click();
    await page.getByTestId('cs-duty-state').filter({ hasText: 'ON ·' }).waitFor();
    await savedValues(page);
    assert.equal(await page.getByRole('checkbox', { name: /이 Mac의 프로필과 채팅방을 확인했고/ }).isChecked(), false);
    assert.equal(await page.evaluate(() => window.fixtureRequests.filter(x => x === 'disable').length), 0);
  });
} finally { await browser.close(); }
if (failures.length) throw Error(`${failures.length} lifecycle scenarios failed: ${failures.join(', ')}`);
console.log('All CS duty lifecycle scenarios passed; no real transport.');
