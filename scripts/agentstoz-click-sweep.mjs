#!/usr/bin/env node
// agentstoz-click-sweep 1.0.0
/**
 * AgentsToZ 전수 클릭 세트 — 공통 엔진. 화면의 버튼·탭·링크를 하나씩 다 눌러 보고, 그 목록을 이력으로 남긴다.
 *
 * 테스터 공통 계층의 세 번째 세트다(일반 · 페르소나 · 전수 클릭). 러너(scripts/agentstoz-maintainer.py)가 이 파일을
 * 품고 다니다가 `sweep install`/`sweep run` 때 프로젝트의 scripts/agentstoz-click-sweep.mjs로 깐다 — 직접 고치지 말 것
 * (원본은 AgentsToZ 저장소의 같은 경로이고, 고친 사본은 다시 깔지 않는다).
 *
 * 판정은 결정적이다 — AI를 부르지 않는다. 프로젝트 설정 .agentstoz/click-sweep.json의 화면(surface)마다:
 *   - 주소는 이 Mac의 loopback(127.0.0.1·localhost·[::1])만 받는다. 운영 사이트를 눌러 보지 않는다.
 *   - 쓰기 요청(GET·HEAD가 아닌 것)과 다른 출처로 가는 요청은 전부 가로채 503으로 답하고 기록만 한다.
 *     그래서 삭제·결제·전송 같은 버튼도 실제로는 아무 일도 하지 않는다. 같은 출처의 읽기만 실제 개발 서버로 간다.
 *   - 처음 화면(깊이 0)에서 보이는 대상을 모두 누르고, 누른 뒤 새로 나타난 대상이 있으면 그 경로로 내려간다(maxDepth).
 *   - 기준선(커밋 대상 JSON)과 비교해 새 오류 · 강한 반응의 상실 · 사라진 대상 · 예산 초과면 실패다.
 *     새 대상·약한 반응(network·dom)만 사라짐은 보고만 한다. 의도한 변경이면 --update로 기준선을 다시 쓰고 커밋한다.
 *
 * CLI: node scripts/agentstoz-click-sweep.mjs --root . --surface <id> [--update] [--config .agentstoz/click-sweep.json]
 *   종료 코드: 0 통과 · 1 실패 · 2 설정 오류 · 3 실행 불가(playwright 없음·개발 서버가 뜨지 않음 — 통과가 아니다).
 * 라이브러리: runClickSweep(options) — 합성 API(mock)·준비 조건(ready)을 프로젝트가 직접 넘길 때.
 */
import {execFileSync, spawn} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, isAbsolute, join, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const ENGINE_VERSION = '1.0.0';
export const CONFIG_PATH = '.agentstoz/click-sweep.json';
export const EVIDENCE_ROOT = '.agentstoz/maintainer/click-sweep';

// ── 기준선 비교 ─────────────────────────────────────────────────────────────
/**
 * 실패: 새 오류 · 강한 반응의 상실 · 기준선 대상의 사라짐 · 탐색 예산 초과(전수가 아님) · 깊이·화면 크기 불일치 · 기준선 없음.
 * 보고만: 새 대상 · 새로 반응하게 된 대상 · 약한 반응만 사라짐 · 고쳐진 오류.
 * 약한 반응(network·dom)은 클릭과 무관한 주기 조회·타이머가 같은 순간에 겹쳐도 생긴다(실측: 441번 중 1번 흔들림).
 * 그래서 화면·대화상자·복사·이동처럼 클릭의 결과로만 생기는 강한 반응이 사라졌을 때만 실패로 본다.
 * 새 대상을 실패로 두지 않는 이유: 화면에 기능이 더해질 때마다 이 검사가 깨지면 기준선 갱신이 습관이 되고,
 * 그러면 정말 사라진 기능도 같은 손놀림으로 묻힌다. 사라짐·반응 상실만은 사람이 --update로 받아들여야 한다.
 */
export const NON_REACTIONS = ['none', 'disabled', 'not-clickable'];
export const WEAK_REACTIONS = ['network', 'dom'];

export function isReacting(reactions) {
  return !!reactions?.length && !NON_REACTIONS.includes(reactions[0]);
}

/** 클릭의 결과로만 생기는 반응. */
export function strongReactions(reactions) {
  return (reactions ?? []).filter(r => !NON_REACTIONS.includes(r) && !WEAK_REACTIONS.includes(r));
}

export function compareSweep(baseline, current, run) {
  const failures = [];
  const notes = [];
  if (run.budgetHit) failures.push(`탐색 예산(${run.budgetHit})에 걸려 전수가 아닙니다 — --max-clicks/--time-budget을 늘리거나 깊이를 줄이세요`);
  if (!baseline) {
    failures.push('기준선이 없습니다 — 처음 한 번 --update로 만들고 그 파일을 커밋하세요');
    return {failures, notes};
  }
  if (baseline.maxDepth !== current.maxDepth) failures.push(`기준선 깊이(${baseline.maxDepth})와 실행 깊이(${current.maxDepth})가 다릅니다`);
  if (baseline.viewport !== current.viewport) failures.push(`기준선 화면 크기(${baseline.viewport})와 실행 화면 크기(${current.viewport})가 다릅니다`);
  for (const [key, now] of Object.entries(current.elements)) {
    const was = baseline.elements[key];
    const known = new Set(was?.errors ?? []);
    for (const error of now.errors ?? []) if (!known.has(error)) failures.push(`새 오류 — ${key}: ${error}`);
    if (!was) { notes.push(`새 대상 — ${key} (${now.reactions.join(',')})`); continue; }
    for (const error of was.errors ?? []) if (!(now.errors ?? []).includes(error)) notes.push(`오류 사라짐 — ${key}: ${error}`);
    const strongBefore = strongReactions(was.reactions).length > 0, strongNow = strongReactions(now.reactions).length > 0;
    if (strongBefore && !strongNow) failures.push(`반응 상실 — ${key}: 기준선 ${was.reactions.join(',')} → 지금 ${now.reactions.join(',')}`);
    else if (!strongBefore && strongNow) notes.push(`반응 생김 — ${key}: ${now.reactions.join(',')}`);
    else if (isReacting(was.reactions) && !isReacting(now.reactions)) notes.push(`약한 반응만 사라짐 — ${key}: 기준선 ${was.reactions.join(',')} → 지금 ${now.reactions.join(',')}`);
  }
  if (run.budgetHit) notes.push('예산에 걸린 실행이라 사라짐 판정은 건너뛰었습니다');
  else for (const key of Object.keys(baseline.elements)) if (!current.elements[key]) failures.push(`사라짐 — ${key}`);
  return {failures, notes};
}

// ── 설정 ────────────────────────────────────────────────────────────────────
const SURFACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** .agentstoz/click-sweep.json을 읽어 검사한다. 모르는 키도 받되(앞으로의 확장) 쓰는 키의 형식은 엄격히 본다. */
export function parseSweepConfig(text) {
  const config = JSON.parse(text);
  if (!config || typeof config !== 'object' || config.schemaVersion !== 1 || !Array.isArray(config.surfaces) || !config.surfaces.length || config.surfaces.length > 8)
    throw new Error('전수 클릭 설정은 schemaVersion 1과 화면(surfaces) 1~8개가 필요합니다');
  const ids = new Set();
  for (const s of config.surfaces) {
    if (!s || typeof s.id !== 'string' || !SURFACE_ID.test(s.id) || ids.has(s.id)) throw new Error('화면 id 형식 또는 중복을 확인하세요');
    ids.add(s.id);
    const argv = v => Array.isArray(v) && v.length > 0 && v.length <= 64 && v.every(a => typeof a === 'string' && a.length <= 4096);
    if (s.command !== undefined) {
      if (!argv(s.command) || s.url !== undefined) throw new Error(`화면 ${s.id}: command는 인자 배열이고 url과 함께 쓸 수 없습니다`);
      if (s.updateArgs !== undefined && !(Array.isArray(s.updateArgs) && s.updateArgs.every(a => typeof a === 'string'))) throw new Error(`화면 ${s.id}: updateArgs 형식을 확인하세요`);
    } else {
      let url;
      try { url = new URL(s.url); } catch { throw new Error(`화면 ${s.id}: url 또는 command가 필요합니다`); }
      if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) throw new Error(`화면 ${s.id}: 주소는 이 Mac의 loopback(127.0.0.1·localhost)만 됩니다`);
      if (s.serve !== undefined && (!s.serve || !argv(s.serve.command))) throw new Error(`화면 ${s.id}: serve.command는 인자 배열이어야 합니다`);
    }
    for (const key of ['baseline', 'ready']) if (s[key] !== undefined && (typeof s[key] !== 'string' || !s[key] || s[key].length > 400)) throw new Error(`화면 ${s.id}: ${key} 형식을 확인하세요`);
    if (s.baseline !== undefined && (isAbsolute(s.baseline) || s.baseline.split(/[\\/]/).includes('..'))) throw new Error(`화면 ${s.id}: baseline은 프로젝트 안의 상대 경로여야 합니다`);
    if (s.viewport !== undefined && !/^\d{3,4}x\d{3,4}$/.test(s.viewport)) throw new Error(`화면 ${s.id}: viewport는 1440x900 형식입니다`);
    if (s.crashText !== undefined && !(Array.isArray(s.crashText) && s.crashText.every(t => typeof t === 'string' && t.length <= 200))) throw new Error(`화면 ${s.id}: crashText 형식을 확인하세요`);
    for (const key of ['maxDepth', 'workers', 'maxClicks', 'timeBudgetSeconds', 'timeoutSeconds'])
      if (s[key] !== undefined && !(Number.isInteger(s[key]) && s[key] >= 0 && s[key] <= 100000)) throw new Error(`화면 ${s.id}: ${key} 형식을 확인하세요`);
  }
  return config;
}

export const surfaceBaseline = surface => surface.baseline ?? `.agentstoz/click-sweep/${surface.id}.json`;
export const surfaceEvidence = surface => `${EVIDENCE_ROOT}/${surface.id}`;

// ── 페이지 안에서 도는 코드 ─────────────────────────────────────────────────
function installProbes(preset) {
  try { localStorage.clear(); sessionStorage.clear(); for (const [k, v] of Object.entries(preset)) localStorage.setItem(k, v); } catch {}
  const probe = window.__sweep = {mutations: 0, clipboard: 0};
  new MutationObserver(list => {
    for (const m of list) if (!(m.type === 'attributes' && m.attributeName === 'data-sweep-id')) probe.mutations++;
  }).observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  try {
    const clip = navigator.clipboard;
    if (clip) { clip.writeText = async () => { probe.clipboard++; }; clip.write = async () => { probe.clipboard++; }; }
  } catch {}
}

/** 지금 보이고 누를 수 있는 대상을 모아 키를 붙인다. 같은 키는 첫 번째에만 data-sweep-id를 단다. */
function enumerateTargets(crashTexts) {
  const SELECTOR = 'button, a[href], [role=button], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=switch], [role=checkbox], [role=radio], [role=option], summary, input[type=checkbox], input[type=radio], input[type=button], input[type=submit]';
  // 기기 ID·해시처럼 실행마다 바뀌는 값은 먼저 접고, 남은 숫자는 #로 접는다(키가 실행마다 흔들리지 않게).
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/\b[0-9a-f]*\d[0-9a-f]*(?:-[0-9a-f]+)+…?/gi, 'ID').replace(/\b[0-9a-f]{7,}\b/gi, m => /\d/.test(m) ? 'HEX' : m)
    .replace(/\d+/g, '#').slice(0, 60);
  const labelOf = el => {
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '); if (clean(t)) return clean(t); }
    return clean(el.getAttribute('aria-label')) || clean(el.innerText || el.textContent) || clean(el.getAttribute('title')) || clean(el.value) || clean(el.getAttribute('name'));
  };
  const scopeOf = el => {
    const parts = [];
    for (let p = el.parentElement; p && parts.length < 2; p = p.parentElement) {
      if (p.getAttribute('role') === 'dialog' || p.tagName === 'DIALOG') {
        const name = clean(p.getAttribute('aria-label')) || (p.getAttribute('aria-labelledby') ? clean(document.getElementById(p.getAttribute('aria-labelledby'))?.textContent) : '') || clean(p.querySelector('h1,h2,h3')?.textContent);
        parts.unshift(`dialog(${p.getAttribute('data-testid') || name || '?'})`);
      } else if (p.getAttribute('data-testid')) parts.unshift(p.getAttribute('data-testid'));
      else if (p.id && !/^(:|radix-|headlessui-)/.test(p.id) && !/\d{3,}/.test(p.id)) parts.unshift('#' + p.id);
    }
    return parts.join('/') || 'page';
  };
  const visible = el => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    if (el.checkVisibility && !el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    // 화면 안에 있으면 실제로 맨 위에 있는지(모달 뒤에 가려지지 않았는지) 본다.
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return false;
    }
    return true;
  };
  // 시맨틱 요소가 아니어도 React가 onClick을 단 요소(예: 프로젝트 목록의 div 행)는 사람이 누르는 대상이다.
  // 이벤트 전파만 막는 처리기(모달 본문 등)는 누를 기능이 아니므로 뺀다.
  const STOP_ONLY = /^(function\s*\w*)?\(?\s*(\w+)\s*\)?\s*(=>)?\s*\{?\s*(return\s+)?\2\.stopPropagation\(\)\s*;?\s*\}?$/;
  const handlerOf = el => {
    const key = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    const handler = key && el[key]?.onClick;
    return typeof handler === 'function' ? String(handler).trim() : null;
  };
  const reactClickable = el => { const h = handlerOf(el); return h !== null && !STOP_ONLY.test(h); };
  // 「바깥을 누르면 닫힘」 배경: 처리기가 target과 currentTarget을 비교한다. 가운데를 누르면 안쪽 내용이 눌리므로
  // 배경만 드러난 모서리를 찾아 그 점을 누른다. 그런 점이 없으면 사람도 바깥을 누를 수 없으니 대상이 아니다.
  const BACKDROP = /\.target\s*[!=]==?\s*\w+\.currentTarget|\.currentTarget\s*[!=]==?\s*\w+\.target/;
  const backdropPoint = el => {
    const r = el.getBoundingClientRect();
    for (const [dx, dy] of [[3, 3], [r.width - 4, 3], [3, r.height - 4], [r.width - 4, r.height - 4], [3, r.height / 2], [r.width / 2, 3]]) {
      const x = r.left + dx, y = r.top + dy;
      if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y) === el) return {x: Math.round(dx), y: Math.round(dy)};
    }
    return null;
  };
  const dialogName = el => {
    const d = el.querySelector('[role=dialog], dialog, [aria-modal=true]');
    const label = d && (clean(d.getAttribute('aria-label')) || (d.getAttribute('aria-labelledby') ? clean(document.getElementById(d.getAttribute('aria-labelledby'))?.textContent) : '') || d.getAttribute('data-testid'));
    return label || clean(el.querySelector('h1,h2,h3,[data-testid]')?.getAttribute('data-testid') || el.querySelector('h1,h2,h3')?.textContent);
  };
  const candidates = new Set(document.querySelectorAll(SELECTOR));
  for (const el of document.body.querySelectorAll('div, span, li, tr, td, img, svg, p, label, section, article, header')) if (!candidates.has(el) && reactClickable(el)) candidates.add(el);
  // 같은 testid가 반복되는 목록(프로젝트 행 등)은 첫 항목 안쪽만 본다 — 행마다 같은 기능이고,
  // 행마다 다른 글자(이름·로딩 상태)가 키를 흔들면 이력 비교가 무의미해진다.
  const repeated = new Set();
  for (const el of document.querySelectorAll('[data-testid]')) {
    const id = el.getAttribute('data-testid');
    for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) if (prev.getAttribute('data-testid') === id) { repeated.add(el); break; }
  }
  const inRepeatedCopy = el => { for (let p = el; p; p = p.parentElement) if (repeated.has(p)) return true; return false; };
  for (const old of document.querySelectorAll('[data-sweep-id]')) old.removeAttribute('data-sweep-id');
  const items = new Map();
  let unnamed = 0, sid = 0;
  for (const el of document.querySelectorAll('*')) {
    if (!candidates.has(el) || inRepeatedCopy(el) || !visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const semantic = el.matches(SELECTOR);
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'summary' ? 'summary' : tag === 'input' ? el.type : semantic ? 'button' : 'clickable');
    const testid = el.getAttribute('data-testid');
    const backdrop = !semantic && BACKDROP.test(handlerOf(el) || '');
    const clickPoint = backdrop ? backdropPoint(el) : null;
    if (backdrop && !clickPoint) continue;
    // 시맨틱이 아닌 클릭 대상은 안의 글 전체가 이름이 되면 길고 흔들리므로 첫 줄만 쓴다.
    const name = backdrop ? 'backdrop(' + (dialogName(el) || '?') + ')' : semantic ? labelOf(el) : clean(el.getAttribute('aria-label')) || clean((el.innerText || '').split('\n')[0]);
    const scope = scopeOf(el);
    let key = testid ? `${scope}>#${testid}${backdrop ? ':backdrop' : ''}` : `${scope}>${backdrop ? 'backdrop' : role}:${name}`;
    if (!testid && !name) key = `${scope}>${role}:(unnamed ${++unnamed})`;
    const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
    const state = [el.getAttribute('aria-selected'), el.getAttribute('aria-pressed'), el.getAttribute('aria-expanded'), el.getAttribute('aria-checked'), el.checked, tag === 'summary' ? el.parentElement?.open : null].join(',');
    const existing = items.get(key);
    if (existing) { existing.count++; existing.state += '|' + state; continue; }
    el.setAttribute('data-sweep-id', String(++sid));
    items.set(key, {sid: String(sid), key, role: backdrop ? 'backdrop' : role, name: name || testid || '', disabled, count: 1, state, unnamed: !testid && !name, ...(clickPoint ? {clickPoint} : {})});
  }
  const live = [...document.querySelectorAll('[role=alert], [role=status], [aria-live]')].map(n => clean(n.textContent)).filter(Boolean).join('|');
  const dialogs = document.querySelectorAll('[role=dialog], dialog[open], [aria-modal=true]').length;
  const bodyText = document.body.innerText;
  const crashed = (crashTexts || []).some(text => bodyText.includes(text));
  const active = document.activeElement;
  const focus = active && active !== document.body ? active.tagName + ':' + (active.getAttribute('data-testid') || active.id || active.getAttribute('name') || clean(active.getAttribute('aria-label'))) : '';
  const list = [...items.values()];
  const signature = [location.pathname + location.hash, dialogs, live, focus, ...list.map(i => i.key + '=' + i.state)].join('\n');
  return {list, signature, crashed, dialogs};
}


function classify(before, after, delta, clickError) {
  if (clickError) return ['not-clickable'];
  const reactions = [];
  if (after.crashed && !before.crashed) reactions.push('crash');
  if (delta.navigated) reactions.push('navigation');
  if (delta.popups) reactions.push('popup');
  if (delta.nativeDialogs) reactions.push('native-dialog');
  if (delta.fileChoosers) reactions.push('file-chooser');
  if (delta.downloads) reactions.push('download');
  if (after.dialogs > before.dialogs) reactions.push('dialog');
  if (after.signature !== before.signature || delta.nearChanged) reactions.push('ui');
  if (delta.requests.length) reactions.push('network');
  if (delta.clipboard) reactions.push('clipboard');
  if (!reactions.length && delta.mutations > delta.idleMutations) reactions.push('dom');
  return reactions.length ? reactions : ['none'];
}

// ── 브라우저 쪽 ─────────────────────────────────────────────────────────────
const oneLine = s => String(s).replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/g, '').replace(/\d{4,}/g, '#').slice(0, 200);
const RECORDED_TYPES = new Set(['fetch', 'xhr', 'eventsource', 'websocket']);

/** 실제로 설치된 node_modules/<name>을 위로 올라가며 찾는다. 찾은 폴더의 부모(그 node_modules를 가진 폴더)를 돌려준다. */
function installedPackageHome(start, name) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * 이 프로젝트에 설치된 playwright를 먼저, 없으면 엔진 옆에 설치된 것을 쓴다. 둘 다 없으면 실행 불가(통과가 아니다).
 * ⚠️ 설치 여부를 먼저 확인한다 — node_modules가 없는 곳에서 그냥 require하면 Bun이 최신 playwright를 자동 설치하고,
 * 그 버전의 브라우저가 없어 엉뚱한 오류로 끝난다(실측 2026-11-01).
 */
export async function loadChromium(root) {
  const engineDir = dirname(fileURLToPath(import.meta.url));
  for (const start of [root, engineDir]) {
    const home = installedPackageHome(start, 'playwright');
    if (!home) continue;
    try {
      const mod = createRequire(join(home, 'package.json'))('playwright');
      const chromium = mod?.chromium ?? mod?.default?.chromium;
      if (chromium) return chromium;
    } catch {}
  }
  const error = new Error('playwright를 찾지 못했습니다 — 이 프로젝트에 설치하세요(예: bun add -d playwright && bunx playwright install chromium)');
  error.code = 'PLAYWRIGHT_MISSING';
  throw error;
}

/** 페이지 하나를 맡아 상태 하나씩 탐색한다. 여러 개가 같은 깊이의 상태를 나눠 처리한다. */
class Explorer {
  constructor(browser, run) { this.browser = browser; this.run = run; this.resetEvents(); }
  resetEvents() { this.events = {requests: [], inflight: 0, errors: [], nativeDialogs: 0, popups: 0, downloads: 0, fileChoosers: 0}; }

  async open() {
    const {run} = this;
    this.context = await this.browser.newContext({viewport: run.viewport, timezoneId: run.timezoneId, locale: run.locale, acceptDownloads: true});
    await this.context.addInitScript(installProbes, run.presetStorage);
    await this.context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const sameOrigin = url.origin === run.origin;
      const label = `${method} ${sameOrigin ? url.pathname : url.hostname}`;
      const mocked = run.mock ? await run.mock(url, method, request) : null;
      // 쓰기와 다른 출처는 막는다. 같은 출처의 읽기만 실제 서버로 보낸다(합성 API가 답하지 않은 것).
      const decision = mocked ?? (sameOrigin && (method === 'GET' || method === 'HEAD') ? 'continue' : 'block');
      if (decision === 'continue') {
        if (sameOrigin && RECORDED_TYPES.has(request.resourceType())) this.events.requests.push(label);
        return route.continue();
      }
      if (sameOrigin) this.events.requests.push(label);
      if (decision === 'block') {
        const counter = method === 'GET' || method === 'HEAD' ? run.unmocked : run.intercepted;
        counter.set(label, (counter.get(label) || 0) + 1);
        return route.fulfill({status: 503, json: {error: 'fixture blocked'}});
      }
      return route.fulfill(decision);
    });
    const page = this.page = await this.context.newPage();
    this.context.on('page', p => { if (p !== page) { this.events.popups++; p.close().catch(() => {}); } });
    page.on('request', () => { this.events.inflight++; });
    const done = () => { this.events.inflight = Math.max(0, this.events.inflight - 1); };
    page.on('requestfinished', done); page.on('requestfailed', done);
    page.on('pageerror', e => this.events.errors.push('pageerror: ' + oneLine(e.message)));
    page.on('console', m => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (/Failed to load resource|status of 503|fixture blocked/i.test(text)) return; // 막은 요청의 503은 의도한 것
      this.events.errors.push('console: ' + oneLine(text));
    });
    page.on('dialog', d => { this.events.nativeDialogs++; d.dismiss().catch(() => {}); });
    page.on('download', d => { this.events.downloads++; d.cancel().catch(() => {}); });
    page.on('filechooser', () => { this.events.fileChoosers++; });
    return this;
  }

  async settle(minMs = 350, maxMs = 2500) {
    const start = Date.now();
    await this.page.waitForTimeout(minMs);
    while (this.events.inflight > 0 && Date.now() - start < maxMs) await this.page.waitForTimeout(50);
    await this.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  }

  snapshot() { return this.page.evaluate(enumerateTargets, this.run.crashTexts); }

  /** 처음 화면에서 경로대로 눌러 그 상태로 간다. 매번 저장소를 비운 새 문서에서 시작한다. */
  async reach(path) {
    const {run} = this;
    run.shared.reloads++;
    this.resetEvents();
    await this.page.goto(run.url, {waitUntil: 'domcontentloaded'});
    if (typeof run.ready === 'function') await run.ready(this.page);
    else await this.page.locator(run.ready).first().waitFor({timeout: 20000});
    await this.settle(900, 4000);
    let snap = await this.snapshot();
    for (const key of path) {
      const target = snap.list.find(i => i.key === key);
      if (!target) return {ok: false, missing: key};
      try { await this.page.locator(`[data-sweep-id="${target.sid}"]`).click({timeout: 2500, ...(target.clickPoint ? {position: target.clickPoint} : {})}); }
      catch (e) { return {ok: false, missing: key, reason: oneLine(e.message.split('\n')[0])}; }
      await this.settle();
      snap = await this.snapshot();
    }
    return {ok: true, snap};
  }

  /**
   * 상태 하나를 탐색한다. known(이전 깊이까지 누른 키)과 부모 상태에서 이미 보이던 키는 누르지 않는다.
   * 결과는 합치지 않고 돌려준다 — 같은 깊이의 상태들은 동시에 돌고, 큐 순서대로 합쳐야 매번 같은 기준선이 나온다.
   */
  async explore(state, known) {
    const out = {records: [], children: [], unreachable: []};
    const reached = await this.reach(state.path);
    if (!reached.ok) { out.unreachable.push({path: state.path, missing: reached.missing, reason: reached.reason}); return out; }
    let snap = reached.snap;
    const parentKeys = new Set(state.parentKeys || []);
    const local = new Set();
    for (const item of snap.list.filter(i => !known.has(i.key) && !parentKeys.has(i.key))) {
      if (local.has(item.key)) continue;
      const shared = this.run.shared;
      if (shared.clicks >= this.run.maxClicks) shared.budgetHit = 'max-clicks';
      if (Date.now() - shared.started > this.run.timeBudgetMs) shared.budgetHit = 'time';
      if (shared.budgetHit) break;
      local.add(item.key);
      const record = {key: item.key, role: item.role, name: item.name, depth: state.path.length, via: state.path, count: item.count, unnamed: item.unnamed};
      if (item.disabled) { out.records.push({...record, reactions: ['disabled'], requests: [], errors: []}); continue; }
      // 앞의 클릭으로 화면이 바뀌었으면 그 대상이 다시 보이는 상태로 돌아간다.
      if (!snap.list.some(i => i.key === item.key)) {
        const again = await this.reach(state.path);
        if (!again.ok) { out.unreachable.push({path: state.path, missing: again.missing, reason: 'state not reproducible'}); break; }
        snap = again.snap;
        if (!snap.list.some(i => i.key === item.key)) { local.delete(item.key); continue; }
      }
      // 잠깐 가만히 두고 저절로 일어나는 DOM 변화(타이머·폴링)를 잰다.
      const idleStart = await this.page.evaluate(() => window.__sweep.mutations);
      await this.page.waitForTimeout(150);
      const before = await this.snapshot();
      const target = before.list.find(i => i.key === item.key);
      if (!target) { local.delete(item.key); continue; }
      const idleMutations = (await this.page.evaluate(() => window.__sweep.mutations)) - idleStart;
      this.resetEvents();
      const probeBefore = await this.page.evaluate(() => ({...window.__sweep}));
      const urlBefore = this.page.url();
      const locator = this.page.locator(`[data-sweep-id="${target.sid}"]`);
      // 서명은 숫자를 접으므로 배율 「100%→110%」 같은 변화는 누른 대상 주변의 실제 글자로 본다.
      const near = await locator.evaluateHandle(el => el.parentElement?.parentElement || el.parentElement || el).catch(() => null);
      const nearText = h => h ? h.evaluate(c => c.isConnected ? c.innerText.slice(0, 2000) : null).catch(() => null) : null;
      const nearBefore = await nearText(near);
      let clickError = null;
      try { await locator.click({timeout: 2500, ...(target.clickPoint ? {position: target.clickPoint} : {})}); }
      catch (e) {
        // Playwright의 호출 로그에서 원인 줄(가로막는 요소·안 보임·움직임)을 함께 남긴다 — 첫 줄은 「Timeout」뿐이다.
        const lines = e.message.split('\n').map(line => line.trim());
        const cause = [...lines].reverse().find(line => /intercepts pointer events|not visible|not stable|outside of the viewport|detached|disabled/.test(line));
        clickError = oneLine(lines[0] + (cause ? ' — ' + cause : ''));
      }
      this.run.shared.clicks++;
      await this.settle();
      let after, probeAfter;
      try { after = await this.snapshot(); probeAfter = await this.page.evaluate(() => ({...window.__sweep})); }
      catch { after = {list: [], signature: 'navigated', crashed: false, dialogs: 0}; probeAfter = probeBefore; }
      const delta = {
        requests: [...new Set(this.events.requests)].sort(),
        popups: this.events.popups, nativeDialogs: this.events.nativeDialogs, fileChoosers: this.events.fileChoosers, downloads: this.events.downloads,
        clipboard: (probeAfter.clipboard || 0) - (probeBefore.clipboard || 0),
        mutations: (probeAfter.mutations || 0) - (probeBefore.mutations || 0),
        idleMutations: idleMutations * 3, // 클릭 뒤 대기는 idle 측정보다 길다 — 그만큼 여유를 둔다
        navigated: this.page.url() !== urlBefore,
        nearChanged: false,
      };
      const nearAfter = await nearText(near);
      delta.nearChanged = nearBefore !== null && nearAfter !== null && nearBefore !== nearAfter;
      await near?.dispose().catch(() => {});
      const errors = [...new Set(this.events.errors)];
      if (after.crashed) errors.push('crash: 앱에서 오류가 발생했습니다');
      out.records.push({...record, reactions: classify(before, after, delta, clickError), requests: delta.requests, errors, ...(clickError ? {clickError} : {})});
      // 누른 뒤 새로 나타난 대상이 있으면 그 상태가 다음 깊이의 후보다.
      const beforeKeys = new Set(before.list.map(i => i.key));
      const fresh = after.list.filter(i => !beforeKeys.has(i.key) && !known.has(i.key)).map(i => i.key);
      if (fresh.length && state.path.length < this.run.maxDepth && !after.crashed && !delta.navigated)
        out.children.push({path: [...state.path, item.key], parentKeys: [...beforeKeys], freshKeys: fresh});
      // 화면이 바뀌었으면 Escape로 한 번 되돌려 보고, 안 되면 처음부터 다시 간다.
      if (after.signature === before.signature && !delta.navigated) { snap = after; continue; }
      if (!delta.navigated && !after.crashed) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.settle(200);
        const back = await this.snapshot().catch(() => null);
        if (back && back.signature === before.signature) { snap = back; continue; }
      }
      const again = await this.reach(state.path);
      if (!again.ok) { out.unreachable.push({path: state.path, missing: again.missing, reason: 'state not reproducible after click'}); break; }
      snap = again.snap;
    }
    return out;
  }
}


// ── 탐색과 기록 ─────────────────────────────────────────────────────────────
/**
 * 화면 하나를 전수로 눌러 보고 기준선과 비교한다. 돌려주는 exitCode: 0 통과 · 1 실패.
 * mock(url, method, request): {status, json|body, contentType} → 합성 응답, 'block' → 503, 'continue' → 통과, null → 기본 규칙.
 */
export async function runClickSweep(options) {
  const root = resolve(options.root ?? process.cwd());
  const surface = options.surface ?? 'web';
  const [width, height] = String(options.viewport ?? '1440x900').split('x').map(Number);
  const run = {
    url: options.url, origin: new URL(options.url).origin, ready: options.ready ?? 'body', mock: options.mock ?? null,
    viewport: {width, height}, timezoneId: options.timezoneId ?? 'Asia/Seoul', locale: options.locale ?? 'ko-KR',
    presetStorage: options.presetStorage ?? {}, crashTexts: options.crashTexts ?? [],
    maxDepth: options.maxDepth ?? 2, maxClicks: options.maxClicks ?? 1500, timeBudgetMs: (options.timeBudgetSeconds ?? 1200) * 1000,
    unmocked: new Map(), intercepted: new Map(), shared: {clicks: 0, reloads: 0, budgetHit: null, started: Date.now()},
  };
  const workers = Math.max(1, options.workers ?? 4);
  const baselinePath = resolve(root, options.baseline ?? `.agentstoz/click-sweep/${surface}.json`);
  const evidence = resolve(root, options.evidence ?? `${EVIDENCE_ROOT}/${surface}`);
  const log = options.log ?? (line => console.log(line));
  const chromium = options.chromium ?? await loadChromium(root);

  const results = new Map();
  const unreachable = [];
  let browser;
  try {
    browser = await chromium.launch();
    const explorers = await Promise.all(Array.from({length: workers}, () => new Explorer(browser, run).open()));
    let level = [{path: []}];
    while (level.length && !run.shared.budgetHit) {
      const known = new Set(results.keys());
      const outputs = new Array(level.length);
      let next = 0;
      await Promise.all(explorers.map(async explorer => {
        for (let i = next++; i < level.length && !run.shared.budgetHit; i = next++) outputs[i] = await explorer.explore(level[i], known);
      }));
      // 큐 순서대로 합친다 — 같은 깊이의 두 상태가 같은 대상을 눌렀으면 앞의 상태의 기록을 쓴다(병렬이어도 같은 기준선).
      for (const out of outputs) if (out) {
        for (const record of out.records) if (!results.has(record.key)) results.set(record.key, record);
        unreachable.push(...out.unreachable);
      }
      const nextLevel = [], queued = new Set();
      for (const out of outputs) if (out) for (const child of out.children) {
        const fresh = child.freshKeys.filter(k => !results.has(k) && !queued.has(k));
        if (!fresh.length) continue;
        for (const k of fresh) queued.add(k);
        nextLevel.push(child);
      }
      level = nextLevel;
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  const {clicks, reloads, budgetHit, started} = run.shared;

  const elements = Object.fromEntries([...results.values()].sort((a, b) => a.key.localeCompare(b.key)).map(r => [r.key, {
    role: r.role, name: r.name, depth: r.depth, via: r.via, count: r.count,
    reactions: r.reactions, requests: r.requests.slice(0, 12),
    ...(r.errors.length ? {errors: r.errors.slice(0, 5)} : {}),
    ...(r.unnamed ? {unnamed: true} : {}),
  }]));
  const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); } catch { return 'unknown'; } })();
  const all = [...results.values()];
  const summary = {
    clicked: clicks, elements: results.size, reloads, seconds: Math.round((Date.now() - started) / 1000),
    reacting: all.filter(r => isReacting(r.reactions)).length,
    none: all.filter(r => r.reactions[0] === 'none').map(r => r.key),
    notClickable: all.filter(r => r.reactions[0] === 'not-clickable').map(r => ({key: r.key, reason: r.clickError})),
    unnamed: all.filter(r => r.unnamed).map(r => r.key),
    withErrors: all.filter(r => r.errors.length).map(r => r.key),
    unreachable, budgetHit,
  };
  const inventory = {schemaVersion: 1, surface, viewport: `${width}x${height}`, maxDepth: run.maxDepth, elements};
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const {failures, notes} = compareSweep(baseline, inventory, {budgetHit});
  // --update는 비교 결과를 보여 준 뒤 기준선을 다시 쓴다. 예산에 걸린(전수가 아닌) 목록은 기준선이 될 수 없다.
  const accepted = !!options.update && !budgetHit;
  if (options.update && budgetHit) failures.unshift('예산에 걸린 실행이라 기준선을 갱신하지 않았습니다');
  const shown = accepted ? [] : failures;
  const passed = shown.length === 0;

  mkdirSync(evidence, {recursive: true, mode: 0o700});
  const at = new Date().toISOString();
  const report = {at, engineVersion: ENGINE_VERSION, surface, commit, baseline: baseline ? 'present' : 'absent', updated: accepted, passed, summary, failures, notes,
    unmockedGet: Object.fromEntries([...run.unmocked].sort()), interceptedWrites: Object.fromEntries([...run.intercepted].sort())};
  writeFileSync(join(evidence, 'latest.json'), JSON.stringify({...report, inventory}, null, 2) + '\n');
  // 앱의 테스트 세트 카드는 이 작은 요약만 읽는다(latest.json은 수백 KB다).
  const brief = {schemaVersion: 1, at, engineVersion: ENGINE_VERSION, surface, commit, passed, updated: accepted, elements: summary.elements, clicked: clicks,
    reacting: summary.reacting, none: summary.none.length, notClickable: summary.notClickable.length, errors: summary.withErrors.length,
    failures: shown.length, notes: notes.length, budgetHit, baselinePresent: !!baseline || accepted};
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify(brief) + '\n');
  const historyDir = resolve(root, EVIDENCE_ROOT);
  mkdirSync(historyDir, {recursive: true, mode: 0o700});
  appendFileSync(join(historyDir, 'history.jsonl'), JSON.stringify(brief) + '\n');
  if (accepted) {
    mkdirSync(dirname(baselinePath), {recursive: true});
    writeFileSync(baselinePath, JSON.stringify(inventory, null, 2) + '\n');
  }

  log(`전수 클릭(${surface}): 대상 ${summary.elements}개 · 클릭 ${clicks}회 · 반응 ${summary.reacting} · 무반응 ${summary.none.length} · 못 누름 ${summary.notClickable.length} · 오류 ${summary.withErrors.length} · ${summary.seconds}초 (다시 열기 ${reloads}회)`);
  if (unreachable.length) log(`도달 못 한 상태 ${unreachable.length}개`);
  for (const n of notes.slice(0, 40)) log('· ' + n);
  if (notes.length > 40) log(`· …그 외 ${notes.length - 40}건 (latest.json)`);
  if (accepted) log(`기준선을 ${baseline ? '갱신' : '새로 작성'}했습니다 — 이 diff를 커밋하면 버튼 목록의 이력이 됩니다: ${baselinePath}`);
  for (const f of shown.slice(0, 60)) log('✗ ' + f);
  if (shown.length > 60) log(`✗ …그 외 ${shown.length - 60}건 (${join(evidence, 'latest.json')})`);
  if (shown.length) log(`의도한 변경이면: ${options.updateHint ?? 'python3 scripts/agentstoz-maintainer.py sweep run --root . --surface ' + surface + ' --update'}`);
  else if (!accepted) log('✓ 기준선과 비교해 새 오류·반응 상실·사라진 대상 없음');
  return {exitCode: passed ? 0 : 1, summary, failures: shown, notes, inventory};
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function waitForServer(url, child, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw Object.assign(new Error(`개발 서버가 먼저 끝났습니다(종료 코드 ${child.exitCode})`), {code: 'SERVE_FAILED'});
    try { const response = await fetch(url, {redirect: 'manual'}); if (response.status < 500) return; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw Object.assign(new Error(`개발 서버가 ${Math.round(timeoutMs / 1000)}초 안에 응답하지 않았습니다: ${url}`), {code: 'SERVE_FAILED'});
}

async function cli(argv) {
  const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const root = resolve(option('--root', process.cwd()));
  const configPath = resolve(root, option('--config', CONFIG_PATH));
  let config, surface;
  try {
    if (!(configPath === root || configPath.startsWith(root + sep))) throw new Error('설정 파일은 프로젝트 안에 있어야 합니다');
    if (!existsSync(configPath)) throw new Error(`${CONFIG_PATH}이 없습니다 — 전수 클릭 세트가 구성되지 않았습니다(통과가 아닙니다)`);
    config = parseSweepConfig(readFileSync(configPath, 'utf8'));
    const id = option('--surface', config.surfaces[0].id);
    surface = config.surfaces.find(s => s.id === id);
    if (!surface) throw new Error(`화면 ${id}이(가) 설정에 없습니다`);
    if (surface.command) throw new Error(`화면 ${id}은(는) 프로젝트 명령(command)으로 돕니다 — python3 scripts/agentstoz-maintainer.py sweep run --root . --surface ${id}`);
  } catch (error) { console.error('전수 클릭 설정 오류: ' + error.message); return 2; }
  let child = null;
  try {
    if (surface.serve) {
      child = spawn(surface.serve.command[0], surface.serve.command.slice(1), {cwd: root, stdio: 'ignore', detached: process.platform !== 'win32'});
      child.on('error', () => {});
      await waitForServer(surface.serve.readyUrl ?? surface.url, child, (surface.serve.timeoutSeconds ?? 120) * 1000);
    } else await waitForServer(surface.url, null, 15000);
    const result = await runClickSweep({
      root, surface: surface.id, url: surface.url, ready: surface.ready ?? 'body', viewport: surface.viewport ?? '1440x900',
      maxDepth: surface.maxDepth ?? 2, workers: surface.workers ?? 4, maxClicks: surface.maxClicks ?? 1500, timeBudgetSeconds: surface.timeBudgetSeconds ?? 1200,
      baseline: surfaceBaseline(surface), evidence: surfaceEvidence(surface), crashTexts: surface.crashText ?? [],
      update: argv.includes('--update'),
    });
    return result.exitCode;
  } catch (error) {
    if (error?.code === 'PLAYWRIGHT_MISSING' || error?.code === 'SERVE_FAILED') { console.error('전수 클릭 실행 불가: ' + error.message); return 3; }
    throw error;
  } finally {
    if (child && child.exitCode === null) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {} }
  }
}

const invokedDirectly = (() => { try { return !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; } })();
if (invokedDirectly) process.exitCode = await cli(process.argv.slice(2));
