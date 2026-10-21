/** Rendered real VOC + report controls; fake browser opener/clipboard, no external submission. */
import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'atz-error-report-'));
const output = join(import.meta.dir, '../output/playwright/developer-error-report'); mkdirSync(output, { recursive: true });
try {
  const build = await Bun.build({ entrypoints: ['tests/fixtures/developer-error-report/panel.tsx'], target: 'browser', format: 'esm' });
  assert.equal(build.success, true, build.logs.join('\n')); const js = await build.outputs[0].text();
  const cssPath = join(root, 'app.css');
  const cssBuild = Bun.spawn(['./node_modules/.bin/tailwindcss', '-i', 'src/index.css', '-o', cssPath], { stdout: 'ignore', stderr: 'pipe' });
  assert.equal(await cssBuild.exited, 0, await new Response(cssBuild.stderr).text()); const css = readFileSync(cssPath, 'utf8');
  const results = [];
  for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) for (const width of [390, 1120]) {
    const opens = [], errors = []; let external = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/open-browser') {
        opens.push(await request.json());
        return Response.json(opens.length === 1 ? { success: false, error: 'synthetic open failure' } : { success: true }, { status: opens.length === 1 ? 503 : 200 });
      }
      if (path === '/app.js') return new Response(js, { headers: { 'Content-Type': 'text/javascript' } });
      return new Response(`<html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    } });
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('**/*', route => { if (new URL(route.request().url()).origin !== server.url.origin) { external++; return route.abort(); } return route.continue(); });
      page.on('pageerror', error => errors.push(error.message)); await page.goto(server.url.href);
      const target = await page.getByTestId('report-target').boundingBox(); await page.mouse.click(target.x + 20, target.y + 20);
      const form = page.getByTestId('voc-form'); await form.waitFor();
      await page.getByTestId('voc-comment').fill('버튼 실패 /Users/alice/private.txt sk-abcdefghijklmnopqrstuvwxyz1234567890');
      assert.equal(await page.getByTestId('voc-send-remote').isDisabled(), true);
      await form.getByText('로컬 저장은 개발자에게 전달되지 않습니다.', { exact: false }).waitFor();
      const report = page.getByTestId('developer-error-report'); await report.locator('summary').click();
      const preview = page.getByTestId('developer-error-report-preview'); const original = await preview.inputValue();
      assert.match(original, /fixture1149/); assert.match(original, /\[path\]/); assert.doesNotMatch(original, /alice|sk-abcdef/);
      await preview.fill('사용자가 검토하고 수정한 신고 내용');
      await preview.press('Control+Enter');
      assert.equal(await page.evaluate(() => window.__reports.length), 0, 'editing a public draft does not trigger local save');
      assert.equal(await preview.inputValue(), '사용자가 검토하고 수정한 신고 내용');
      await page.getByTestId('developer-error-report-copy').click();
      assert.deepEqual(await page.evaluate(() => window.__clipboard), ['사용자가 검토하고 수정한 신고 내용']);
      assert.equal(await page.evaluate(() => window.__reports.length), 0);
      const open = page.getByTestId('developer-error-report-open'); await open.click();
      await report.getByRole('status').filter({ hasText: '신고창을 열지 못했습니다' }).waitFor();
      assert.equal(await preview.inputValue(), '사용자가 검토하고 수정한 신고 내용');
      await open.evaluate(element => { element.click(); element.click(); });
      await report.getByRole('status').filter({ hasText: '이 앱에서는 접수 여부를 확인하지 않습니다' }).waitFor();
      assert.equal(opens.length, 2, 'retry once, duplicate immediate click suppressed');
      for (const request of opens) assert.equal(request.url, 'https://github.com/intenet1001-commits/AgentsToZ-public/issues/new');
      assert.equal(await page.evaluate(() => window.__reports.length), 0);
      // A configuration change clears an already-selected remote send and preserves the local request.
      await page.evaluate(() => window.__configured(true)); await page.getByTestId('voc-send-remote').check();
      await page.evaluate(() => window.__configured(false)); await page.waitForFunction(() => !document.querySelector('[data-testid=voc-send-remote]').checked);
      await report.locator('summary').click();
      await page.getByTestId('voc-save').click(); await page.waitForFunction(() => window.__reports.length === 1);
      assert.equal((await page.evaluate(() => window.__reports[0])).sendRemote, false);
      assert.equal(external, 0); assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      results.push({ engine: engineName, width, passed: true, fakeBrowserOpens: opens.length, externalRequests: external, realSubmission: false });
      console.log(`${engineName}/${width}: preview, edit/copy, failed open, retry, no auto-submit, configuration loss and local save passed`);
    } finally { await browser.close(); server.stop(true); }
  }
  writeFileSync(join(output, 'result.json'), JSON.stringify({ scope: 'isolated rendered controls; no live GitHub/Supabase/auth', results }, null, 2) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
