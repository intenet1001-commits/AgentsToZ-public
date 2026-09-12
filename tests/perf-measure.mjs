import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

const testsDir = dirname(fileURLToPath(import.meta.url));
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const rawTarget = argument('--url') ?? process.env.PERF_TARGET_URL;
if (!rawTarget) throw new Error('PERF_TARGET_URL or --url is required; performance evidence must name the tested deployment.');
const target = new URL(rawTarget);
if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) {
  throw new Error('Performance target must be a plain HTTP(S) URL without credentials or a fragment.');
}
const runs = Number(argument('--runs') ?? process.env.PERF_RUNS ?? '5');
if (!Number.isInteger(runs) || runs < 3 || runs > 20) throw new Error('Run count must be an integer from 3 through 20.');
const output = resolve(argument('--output') ?? process.env.PERF_OUTPUT ?? join(testsDir, 'results', 'performance-report.json'));
const screenshot = resolve(argument('--screenshot') ?? join(testsDir, 'screenshots', 'perf-snapshot.png'));
const enforce = process.argv.includes('--enforce') || process.env.PERF_ENFORCE === '1';
const timeout = Number(process.env.PERF_TIMEOUT_MS ?? '30000');
if (!Number.isFinite(timeout) || timeout < 5_000 || timeout > 120_000) throw new Error('PERF_TIMEOUT_MS must be between 5000 and 120000.');

const budgets = Object.freeze({ fcp_ms: 1800, lcp_ms: 2500, cls: 0.1, tbt_ms: 200 });
const percentile = (values, ratio) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
};
const summarize = values => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  min: percentile(values, 0),
  max: percentile(values, 1),
});

const bootstrapMetrics = () => {
  window.__agentstozPerf = { lcp: null, cls: 0, longTasks: [] };
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__agentstozPerf.lcp = Math.round(entry.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__agentstozPerf.cls += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__agentstozPerf.longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
};

async function sample(context, mode, index, capture = false) {
  const page = await context.newPage();
  await page.addInitScript(bootstrapMetrics);
  const started = performance.now();
  await page.goto(target.href, { waitUntil: 'networkidle', timeout });
  await page.waitForTimeout(1_000);
  const wall_ms = Math.round(performance.now() - started);
  if (capture) {
    mkdirSync(dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: false });
  }
  const result = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const paints = performance.getEntriesByType('paint');
    const state = window.__agentstozPerf ?? { lcp: null, cls: 0, longTasks: [] };
    const bytes = entry => entry.transferSize || entry.encodedBodySize || 0;
    const classify = matcher => resources.filter(matcher).reduce((sum, entry) => sum + bytes(entry), 0);
    return {
      ttfb_ms: nav ? Math.round(nav.responseStart - nav.requestStart) : null,
      fcp_ms: Math.round(paints.find(entry => entry.name === 'first-contentful-paint')?.startTime ?? NaN),
      lcp_ms: state.lcp,
      cls: Math.round(state.cls * 1000) / 1000,
      tbt_ms: state.longTasks.reduce((sum, duration) => sum + Math.max(0, duration - 50), 0),
      dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      load_event_ms: nav ? Math.round(nav.loadEventEnd) : null,
      dom_elements: document.querySelectorAll('*').length,
      resources: {
        requests: resources.length,
        transfer_bytes: resources.reduce((sum, entry) => sum + bytes(entry), 0),
        script_bytes: classify(entry => entry.initiatorType === 'script'),
        style_bytes: classify(entry => entry.initiatorType === 'css' || entry.initiatorType === 'link'),
        image_bytes: classify(entry => entry.initiatorType === 'img'),
        font_bytes: classify(entry => entry.initiatorType === 'font' || /\.(woff2?|ttf|otf)(\?|$)/i.test(entry.name)),
      },
    };
  });
  await page.close();
  return { mode, run: index + 1, wall_ms, ...result };
}

const metricSummary = samples => Object.fromEntries(
  ['ttfb_ms', 'fcp_ms', 'lcp_ms', 'cls', 'tbt_ms', 'wall_ms'].map(metric => [metric, summarize(samples.map(row => row[metric]))]),
);

const browser = await chromium.launch({ headless: true });
try {
  const cold = [];
  for (let index = 0; index < runs; index += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    cold.push(await sample(context, 'cold', index, index === runs - 1));
    await context.close();
  }
  const warmContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await sample(warmContext, 'warmup', 0);
  const warm = [];
  for (let index = 0; index < runs; index += 1) warm.push(await sample(warmContext, 'warm', index));
  await warmContext.close();

  const summary = { cold: metricSummary(cold), warm: metricSummary(warm) };
  const violations = [];
  for (const mode of ['cold', 'warm']) {
    for (const [metric, limit] of Object.entries(budgets)) {
      const value = summary[mode][metric].p95;
      if (value === null) violations.push({ mode, metric, reason: 'unavailable', limit });
      else if (value > limit) violations.push({ mode, metric, value, limit });
    }
  }
  const report = {
    schemaVersion: 2,
    target: target.href,
    measuredAt: new Date().toISOString(),
    viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
    runsPerMode: runs,
    budgets,
    passed: violations.length === 0,
    violations,
    summary,
    samples: [...cold, ...warm],
    screenshot,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, target: target.href, runsPerMode: runs, passed: report.passed, violations, summary }, null, 2));
  if (enforce && !report.passed) process.exitCode = 2;
} finally {
  await browser.close();
}
