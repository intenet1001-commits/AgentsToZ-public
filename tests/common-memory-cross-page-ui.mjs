import assert from 'node:assert/strict';
import {chromium, webkit} from 'playwright';
import {commonMemoryUiFixture} from './fixtures/common-memory/server.ts';

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  const fixture = await commonMemoryUiFixture('127.0.0.1', {crossPageLessons: true}), browser = await engine.launch();
  try {
    const page = await browser.newPage({viewport: {width: 390, height: 844}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
    // This isolated Bun fixture does not serve package CSS imports; use its system-font fallback.
    await page.route('**/@fontsource-variable/*/index.css', route => route.fulfill({contentType: 'text/css', body: ''}));
    await page.goto(fixture.url);
    const panel = page.getByTestId('common-memory-panel');
    await panel.getByRole('button', {name: '공통기억 관리', exact: true}).click();
    const topics = panel.getByTestId('common-memory-cloud-topics');
    await topics.getByText('다음 원본을 이어 확인하면 이전 페이지의 관련 교훈도 함께 비교합니다. 발견한 근거는 현재 원본에서 다시 확인합니다.', {exact: true}).waitFor();
    const before = await (await fetch(fixture.url + '/fixture/stats')).json();
    await topics.getByRole('button', {name: '교집합·카테고리 후보 확인', exact: true}).click();
    for (let n = 0; n < 2; n++) {
      const next = topics.getByRole('button', {name: '다음 클라우드 원본 확인', exact: true});
      await next.waitFor();
      await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('topic-candidates')), next.click()]);
    }
    const candidate = topics.locator('article').filter({hasText: 'Bun'});
    await candidate.getByText('추천 분류: 공통 교훈 · 원본 장기기억 2개', {exact: true}).waitFor();
    assert.match(await candidate.innerText(), /원본 A/);
    assert.match(await candidate.innerText(), /원본 B/);
    await topics.getByText('이번 조회에서 원본 3개 확인 · 선택한 범위 조회 완료', {exact: true}).waitFor();
    assert.match(await candidate.innerText(), /같은 규칙인지, 조건과 충돌이 있는지는 원본을 읽고 검토합니다/);
    const after = await (await fetch(fixture.url + '/fixture/stats')).json();
    assert.deepEqual(after.sources, before.sources);
    assert.deepEqual(after.groups, []);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({path: `/tmp/common-memory-cross-page-${name}.png`, fullPage: true});
    console.log(JSON.stringify({engine: name, pages: 3, crossPageLesson: true, writes: 0}));
  } finally { await browser.close(); fixture.stop(); }
}
