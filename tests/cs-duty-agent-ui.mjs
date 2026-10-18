/** AI 대직 화면 — isolated fixture (tests/fixtures/cs-duty.html), never touches KakaoTalk, Slack or an AI. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TARGET ?? 'http://127.0.0.1:9421';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw Error('Local fixture URL required');
const browser = await chromium.launch({headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1000, height: 1050}}), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base + '/tests/fixtures/cs-duty.html?strict');
  await page.getByRole('button', {name: 'CS 대직 · 질문 응답 설정', exact: true}).click();
  const section = page.getByTestId('duty-agent');
  await section.waitFor();
  // The new duty is the first thing in the dialog; the old 3-step flow is folded away.
  assert.equal(await page.getByTestId('cs-duty-legacy').evaluate(d => d.open), false, 'legacy flow starts folded');
  await page.getByTestId('duty-agent-state').filter({hasText: '꺼짐'}).waitFor();
  const on = page.getByTestId('duty-agent-on');
  assert.equal(await on.isDisabled(), true, 'nothing to guard yet → cannot turn on');

  // KakaoTalk room from the MCP list, Slack channel typed by hand.
  await section.getByTestId('duty-agent-kakao').getByRole('button', {name: '목록 불러오기'}).click();
  await section.getByLabel('카카오톡 방 고르기').selectOption('고객 문의방');
  await section.getByTestId('duty-agent-kakao-chip').filter({hasText: '고객 문의방'}).waitFor();
  const slackInput = section.getByLabel('슬랙 채널 · DM 직접 입력');
  await slackInput.fill('#support');
  await slackInput.press('Enter');
  await section.getByTestId('duty-agent-slack-chip').filter({hasText: '#support'}).waitFor();
  await section.getByTestId('duty-agent-note').fill('존댓말로 답하기');

  // One click saves and starts.
  await on.click();
  await page.getByTestId('duty-agent-state').filter({hasText: '켜짐 · 질문을 기다리는 중'}).waitFor();
  const ops = await page.evaluate(() => window.fixtureRequests.filter(op => op.startsWith('agent')));
  assert.deepEqual(ops.filter(op => op !== 'agentStatus'), ['agentChoices', 'agentSave', 'agentStart']);
  const stored = await page.evaluate(() => window.fixtureAgent.get('fixture-project').settings);
  assert.deepEqual(stored, {kakaoRooms: ['고객 문의방'], slackChannels: ['#support'], note: '존댓말로 답하기', enabled: true});
  await page.getByTestId('duty-agent-session').waitFor();

  // Removing a room while on offers "save and restart", not a silent change.
  await section.getByRole('button', {name: '#support 빼기'}).click();
  await page.getByTestId('duty-agent-save').filter({hasText: '저장하고 세션 다시 시작'}).click();
  await page.waitForFunction(() => window.fixtureAgent.get('fixture-project').settings.slackChannels.length === 0);

  await page.getByTestId('duty-agent-off').click();
  await page.getByTestId('duty-agent-state').filter({hasText: '꺼짐'}).waitFor();
  for (const width of [800, 390]) {
    await page.setViewportSize({width, height: 844});
    assert.equal(await page.locator('dialog').evaluate(d => d.scrollWidth <= d.clientWidth + 1), true, 'no horizontal overflow at ' + width);
  }
  await page.screenshot({path: process.env.DUTY_SCREENSHOT_PATH ?? '/tmp/cs-duty-agent-ui.png', fullPage: true});
  assert.deepEqual(errors, []);
  console.log('AI duty UI passed: folded legacy, MCP room list, typed Slack channel, save+start in one click, restart on edit, OFF, 800/390px');
} finally { await browser.close(); }
