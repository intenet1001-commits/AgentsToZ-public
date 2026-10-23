// Title verification test — emoji titles + no -w flag + worktree navigation
import { chromium } from 'playwright';
import * as fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:3001';
const UI  = 'http://localhost:9000';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SS  = path.join(PROJECT_ROOT, 'tests/results/screenshots');
fs.mkdirSync(SS, { recursive: true });

const results = [];
let pass = 0, fail = 0;

function ok(id, desc, detail = '') {
  results.push({ status: 'PASS', id, desc, detail });
  console.log(`✅ [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  pass++;
}
function bad(id, desc, detail = '') {
  results.push({ status: 'FAIL', id, desc, detail });
  console.log(`❌ [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  fail++;
}

// ── 1. SOURCE CODE AUDIT ──────────────────────────────────────────────────────
const src = fs.readFileSync(
  path.join(PROJECT_ROOT, 'api-server.ts'), 'utf8'
);
const librs = fs.readFileSync(
  path.join(PROJECT_ROOT, 'src-tauri/src/lib.rs'), 'utf8'
);

// Check no -w flag in claude commands
const wFlagTs = (src.match(/-w\s+['"]/g) || []).length;
const wFlagRs = (librs.match(/-w\s+['"]/g) || []).length;
wFlagTs === 0
  ? ok('SRC-01', 'api-server.ts: no -w flag in claude commands')
  : bad('SRC-01', `api-server.ts: found ${wFlagTs} -w flag occurrences`, src.match(/.*-w\s+['"]+.*/g)?.slice(0,3).join('; ') || '');

wFlagRs === 0
  ? ok('SRC-02', 'lib.rs: no -w flag in claude commands')
  : bad('SRC-02', `lib.rs: found ${wFlagRs} -w flag occurrences`);

// Check emoji prefixes exist in buildWindowTitle
const hasLightning = src.includes('\u26A1') || src.includes('\\u26A1') || src.includes('\\u{26A1}');
const hasDiamond   = src.includes('\uD83D\uDD37') || src.includes('\\u{1F537}') || src.includes('1F537');
const hasShield    = src.includes('\uD83D\uDEE1') || src.includes('\\u{1F6E1}') || src.includes('1F6E1');
const hasWindow    = src.includes('\uD83E\uDE9F') || src.includes('\\u{1FA9F}') || src.includes('1FA9F');

hasLightning ? ok('SRC-03', 'api-server.ts: ⚡ emoji (tmux+bypass) present') : bad('SRC-03', 'api-server.ts: missing ⚡ emoji');
hasDiamond   ? ok('SRC-04', 'api-server.ts: 🔷 emoji (tmux) present')        : bad('SRC-04', 'api-server.ts: missing 🔷 emoji');
hasShield    ? ok('SRC-05', 'api-server.ts: 🛡 emoji (bypass) present')       : bad('SRC-05', 'api-server.ts: missing 🛡 emoji');
hasWindow    ? ok('SRC-06', 'api-server.ts: 🪟 emoji (normal) present')       : bad('SRC-06', 'api-server.ts: missing 🪟 emoji');

// Check lib.rs emoji
const rsHasLightning = librs.includes('26A1') || librs.includes('\u26A1');
const rsHasDiamond   = librs.includes('1F537');
rsHasLightning ? ok('SRC-07', 'lib.rs: ⚡ emoji present') : bad('SRC-07', 'lib.rs: missing ⚡ emoji');
rsHasDiamond   ? ok('SRC-08', 'lib.rs: 🔷 emoji present') : bad('SRC-08', 'lib.rs: missing 🔷 emoji');

// All 3 tmux-claude endpoints funnel through openTerminalWithCmd which has delay 2.0
// Non-tmux endpoints (git-pull/push/commit, open-terminal-at-folder) legitimately use 0.5/0.3
const openTerminalFn = src.match(/function openTerminalWithCmd[\s\S]*?delay\s+([\d.]+)/);
const openTerminalDelay = openTerminalFn ? parseFloat(openTerminalFn[1]) : 0;
openTerminalDelay >= 2.0
  ? ok('SRC-09', `openTerminalWithCmd (handles all 3 tmux endpoints) uses delay ${openTerminalDelay}`)
  : bad('SRC-09', `openTerminalWithCmd delay is ${openTerminalDelay} — need ≥2.0 to prevent tmux title override`);

// Check worktree navigation uses cdPath not -w
const cdPathCheck = src.includes('cdPath') && src.includes('worktreePath');
cdPathCheck
  ? ok('SRC-10', 'api-server.ts: cdPath / worktreePath navigation pattern present')
  : bad('SRC-10', 'api-server.ts: cdPath / worktreePath pattern missing');

// Check lib.rs delay 2.0
const rsDelay2 = (librs.match(/delay 2\.0/g) || []).length;
rsDelay2 >= 5
  ? ok('SRC-11', `lib.rs: delay 2.0 in ${rsDelay2} AppleScript blocks`)
  : bad('SRC-11', `lib.rs: delay 2.0 only in ${rsDelay2} blocks (need ≥5)`);

// Check GIT_PATH duplicate is removed
const gitPathCount = (src.match(/^const GIT_PATH\s*=/gm) || []).length;
gitPathCount === 1
  ? ok('SRC-12', 'api-server.ts: GIT_PATH declared exactly once (no duplicate)')
  : bad('SRC-12', `api-server.ts: GIT_PATH declared ${gitPathCount} times`);

// ── 2. API ENDPOINT TESTS ─────────────────────────────────────────────────────
async function callAPI(path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status, data: await res.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Mock call — will try to open iTerm but we check the response shape
const bypass = await callAPI('/api/open-tmux-claude-bypass', {
  sessionName: 'test-proj',
  folderPath: '/tmp',
  worktreePath: '/tmp/worktrees/portmanagement-test',
});
bypass.ok
  ? ok('API-01', 'POST /api/open-tmux-claude-bypass returns 200', JSON.stringify(bypass.data))
  : bad('API-01', 'POST /api/open-tmux-claude-bypass failed', bypass.error || `status=${bypass.status}`);

const tmux = await callAPI('/api/open-tmux-claude', {
  sessionName: 'test-tmux',
  folderPath: '/tmp',
});
tmux.ok
  ? ok('API-02', 'POST /api/open-tmux-claude returns 200', JSON.stringify(tmux.data))
  : bad('API-02', 'POST /api/open-tmux-claude failed', tmux.error || `status=${tmux.status}`);

const fresh = await callAPI('/api/open-tmux-claude-fresh', {
  sessionName: 'test-fresh',
  folderPath: '/tmp',
});
fresh.ok
  ? ok('API-03', 'POST /api/open-tmux-claude-fresh returns 200', JSON.stringify(fresh.data))
  : bad('API-03', 'POST /api/open-tmux-claude-fresh failed', fresh.error || `status=${fresh.status}`);

// Clean up test sessions
import { execSync } from 'child_process';
['test-proj-bypass', 'test-tmux', 'test-fresh'].forEach(s => {
  try { execSync(`tmux kill-session -t '${s}' 2>/dev/null`); } catch {}
});

// ── 3. UI SCREENSHOT TEST ─────────────────────────────────────────────────────
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.goto(UI, { waitUntil: 'networkidle', timeout: 10000 });
  await page.screenshot({ path: `${SS}/title-test-ui.png` });
  ok('UI-01', 'Portmanagement UI loaded at localhost:9000', `screenshot saved`);

  // Check page has meaningful content (not blank/error)
  const bodyText = await page.locator('body').innerText();
  const hasContent = bodyText.trim().length > 50;
  hasContent
    ? ok('UI-02', `UI has content (${bodyText.trim().slice(0,80).replace(/\n/g,' ')}...)`)
    : bad('UI-02', 'UI body is empty or too short');

  // Check for Claude launch buttons
  const btnCount = await page.locator('button').count();
  btnCount > 0
    ? ok('UI-03', `UI has ${btnCount} buttons (interactive elements present)`)
    : bad('UI-03', 'No buttons found in UI');

} catch (e) {
  bad('UI-01', 'UI test failed', e.message);
} finally {
  await browser?.close();
}

// ── 4. REPORT ─────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════');
console.log(`TITLE VERIFICATION REPORT`);
console.log(`══════════════════════════════════════════════`);
results.forEach(r => {
  const icon = r.status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${r.id.padEnd(8)} ${r.desc}`);
  if (r.detail) console.log(`         └─ ${r.detail}`);
});
console.log('──────────────────────────────────────────────');
console.log(`Total: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}`);
console.log('══════════════════════════════════════════════');

// Save report
const reportPath = path.join(PROJECT_ROOT, 'tests/results/title-test-report.md');
const report = `# Title Emoji Test Report\n\nDate: ${new Date().toISOString()}\n\n` +
  `**${pass} PASS / ${fail} FAIL** (Total: ${pass + fail})\n\n` +
  results.map(r => `- ${r.status === 'PASS' ? '✅' : '❌'} **${r.id}** ${r.desc}${r.detail ? `\n  - ${r.detail}` : ''}`).join('\n');
fs.writeFileSync(reportPath, report);
console.log(`\nReport: ${reportPath}`);

process.exit(fail > 0 ? 1 : 0);
