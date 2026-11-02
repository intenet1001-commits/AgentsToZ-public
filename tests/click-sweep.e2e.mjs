/**
 * 전수 클릭 검사 — AgentsToZ 데스크톱 앱 화면(테스터 공통 계층의 세 번째 세트, 이 프로젝트의 설정).
 *
 * 엔진은 공통 계층의 scripts/agentstoz-click-sweep.mjs다(러너가 품고 다니며 모든 등록 프로젝트에 깐다).
 * 이 파일은 이 앱에만 필요한 것 — 격리 Vite 빌드를 서빙하고 /api/*를 합성 API로 답하는 것 — 만 넘긴다.
 * 실사용 사이드카(3001)·Supabase·외부 사이트에는 닿지 않는다. 합성 API에 없는 /api 요청과 모든 쓰기·외부 요청은
 * 503으로 막고 기록한다(보고서의 unmockedGet·interceptedWrites).
 *
 * 사용(테스터: bun scripts/check-maintainer-web.ts click-sweep [--update] 이 빌드부터 해 준다):
 *   ./node_modules/.bin/vite build --outDir <dir> && bun tests/click-sweep.e2e.mjs <dir> [--update] [--max-depth 2] [--workers 4]
 * 기준선 tests/click-sweep/desktop.json(커밋 대상) · 증거 .agentstoz/maintainer/click-sweep/desktop/ · 이력 .agentstoz/maintainer/click-sweep/history.jsonl
 */
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {portalLocalMetadataFingerprint} from '../src/portalLocalMetadata.ts';
import {runClickSweep} from '../scripts/agentstoz-click-sweep.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const VALUE_OPTIONS = new Set(['--max-depth', '--max-clicks', '--time-budget', '--baseline', '--evidence', '--workers']);
const dist = args.find((a, i) => !a.startsWith('--') && !VALUE_OPTIONS.has(args[i - 1]));
if (!dist) throw new Error('Pass an isolated Vite build directory');
const option = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

// ── 합성 API ────────────────────────────────────────────────────────────────
const DAY = 86400e3;
const FIXED_NOW = Date.parse('2026-10-15T09:00:00Z');
const PORTS = [
  {id: '11111111-aaaa-4aaa-8aaa-000000000001', name: 'AgentsToZ_byCS', aiName: 'Port Manager App', category: 'tool', port: 9000, folderPath: '/fixture/product/AgentsToZ_byCS', favorite: true, isRunning: true, terminalCommand: 'bun run dev'},
  {id: '22222222-aaaa-4aaa-8aaa-000000000002', name: 'song-app', aiName: 'Music Player', category: 'music', port: 5173, folderPath: '/fixture/product/song-app', role: 'dev'},
  {id: '44444444-aaaa-4aaa-8aaa-000000000004', name: 'vault', aiName: 'AI Knowledge Vault', category: 'notes', folderPath: '/fixture/vault'},
  {id: '55555555-aaaa-4aaa-8aaa-000000000005', name: 'ShadowLoop', category: 'game', port: 8080, folderPath: '/fixture/product/ShadowLoop', favorite: true},
];
// 컴퓨터 유즈 패널(도구 및 설정 → 컴퓨터 유즈)의 관리 상태. 경로로만 고르므로 켜기·끊기·막기에도 같은 상태가 돌아온다.
// 다른 Mac의 AI(받기 스위치·원격 행·막은 기기·첫 안내)와 이 Mac의 AI가 다른 Mac을 쓰는 줄까지 보이게 한다.
const CU_DEVICES = ['3a9d0c1e-5b7f-4e2a-9c3d-1f2e3d4c5b6a', '7c1f2e3d-4b5a-4968-8776-5a4b3c2d1e0f', '5e6f7a8b-1c2d-4e3f-8a9b-0c1d2e3f4a5b'];
const COMPUTER_USE_STATUS = {
  success: true, available: true, restartRequired: false,
  native: {success: true, protocolVersion: 1, accessibility: true, secureInput: false, operations: ['capture', 'click']},
  access: {enabled: false},
  connections: [
    {id: 'mcp_fixture', code: '00000000-0000-4000-8000-000000000001', label: 'codex', scope: 'mcp-connection', expiresAt: FIXED_NOW + 75e3},
    {id: 'rcu_fixture', code: '11111111-0000-4000-8000-000000000001', label: '원격 1호 (3a9d)', scope: 'remote-connection', expiresAt: FIXED_NOW + 75e3,
      remote: {deviceId: CU_DEVICES[0], deviceName: '1호', deviceCode: '3a9d', connection: 'a'.repeat(32)}},
  ],
  grants: [], pending: [], recovery: [],
  scoped: {native: {success: true, scopeProtocolVersion: 2, accessibility: true, screenRecording: true, secureInput: false,
    operations: ['scope-observe', 'scope-capture', 'scope-click', 'scope-type-text', 'scope-key']}, grants: [], pending: [], recovery: []},
  remote: {accepting: true, allowRemote: true, noticeShown: false, profileReady: true,
    blockedDevices: [{deviceId: CU_DEVICES[1], name: '2호', since: FIXED_NOW - DAY}],
    blockedConnections: [{deviceId: CU_DEVICES[0], instance: 'b'.repeat(32), until: FIXED_NOW + 1800e3}]},
  outgoing: [{deviceId: CU_DEVICES[2], deviceName: '3호', connection: 'cccccccc', client: 'codex-mcp-client', since: FIXED_NOW - 60e3, lastCallAt: FIXED_NOW - 5e3, active: true}],
};
// 경로로만 고른다(projects-tab-ui와 같은 규칙) — 이 앱은 읽기에도 POST를 쓰는 곳이 많다.
// 여기 없는 요청은 모두 503으로 답하고 기록한다(보고서의 unmockedGet·interceptedWrites).
const FIXTURE = {
  '/api/agent-runtime/computer-use': COMPUTER_USE_STATUS,
  '/api/ports': PORTS,
  '/api/portal': {},
  '/api/workspace-roots': [{id: 'root1', name: 'product', path: '/fixture/product'}],
  '/api/portal/safety-lease/acquire': {success: true, token: 'a'.repeat(64), metadata: {}, fingerprint: portalLocalMetadataFingerprint({}), expiresInMs: 30000},
  '/api/portal/safety-lease/release': {released: true},
  '/api/ports/merge': {success: true},
  '/api/health': {status: 'ok'},
  '/api/onboarding/status': {stage: 'complete'},
  '/api/last-visits': Object.fromEntries(PORTS.map((p, i) => [p.id, FIXED_NOW - i * DAY])),
  '/api/last-git-activity': {},
  '/api/check-ports-batch': {success: true, results: [{port: 9000, isRunning: true}]},
  '/api/voc/access': {blocked: false},
  '/api/browser-profiles': {profiles: []},
  '/api/orca-worktrees': {success: true, worktrees: []},
  '/api/discover-registered-git-worktrees': {success: true, worktrees: [], nextCursor: null},
  '/api/list-git-worktrees': {success: true, worktrees: [{path: '/fixture/product/AgentsToZ_byCS', branch: 'main', is_main: true, head: 'a'.repeat(40), locked: false}]},
  '/api/client-errors': {ok: true, items: []},
};
const PRESET_STORAGE = {'portmanager-setup-wizard-seen-v1': '1'};

// ── 실행 ────────────────────────────────────────────────────────────────────
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch: req => {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(dist, path === '/' ? 'index.html' : path));
    return file.size ? new Response(file) : new Response(Bun.file(join(dist, 'index.html')));
  },
});
try {
  const result = await runClickSweep({
    root, surface: 'desktop', url: `http://127.0.0.1:${server.port}/`, viewport: '1440x900',
    ready: page => page.getByRole('tablist').first().waitFor({timeout: 20000}),
    // 경로로만 고른다(projects-tab-ui와 같은 규칙) — 이 앱은 읽기에도 POST를 쓰는 곳이 많다.
    mock: (url, method) => {
      if (url.origin !== `http://127.0.0.1:${server.port}`) return null; // 다른 출처: 엔진 기본 규칙(막음)
      if (!url.pathname.startsWith('/api/')) return 'continue';
      if (url.pathname === '/api/ports' && method === 'POST') return {status: 200, json: {success: true}};
      if (Object.hasOwn(FIXTURE, url.pathname)) return {status: 200, json: FIXTURE[url.pathname]};
      return 'block';
    },
    presetStorage: PRESET_STORAGE, crashTexts: ['앱에서 오류가 발생했습니다'],
    maxDepth: Number(option('--max-depth', '2')), workers: Number(option('--workers', '4')),
    maxClicks: Number(option('--max-clicks', '1500')), timeBudgetSeconds: Number(option('--time-budget', '1200')),
    baseline: option('--baseline', 'tests/click-sweep/desktop.json'), evidence: option('--evidence', '.agentstoz/maintainer/click-sweep/desktop'),
    update: args.includes('--update'), updateHint: 'bun scripts/check-maintainer-web.ts click-sweep --update',
  });
  process.exitCode = result.exitCode;
} finally {
  server.stop(true);
}
