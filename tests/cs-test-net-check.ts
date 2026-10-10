/**
 * CS-test: 404 네트워크 에러 식별
 */
import { chromium } from 'playwright';

(async () => {
  const b = await chromium.launch({ headless: true });
  const p = await b.newPage();
  const errors404: string[] = [];
  p.on('response', r => { if (r.status() >= 400) errors404.push(`${r.status()} ${r.url()}`); });
  await p.goto('http://localhost:9000', { waitUntil: 'networkidle', timeout: 15000 });
  await p.waitForTimeout(1500);
  // click portal tab
  const tabs = await p.locator('button').all();
  for (const t of tabs) {
    const txt = await t.textContent().catch(() => '');
    if (txt?.includes('포털')) { await t.click(); break; }
  }
  await p.waitForTimeout(1500);
  await b.close();
  console.log('4xx responses:');
  errors404.forEach(e => console.log(' ', e));
  if (errors404.length === 0) console.log('  (없음)');
})().catch(console.error);
