/**
 * 전수 클릭 공통 엔진을 AgentsToZ가 아닌 프로젝트(작은 정적 페이지)에 CLI로 돌린다 — 다른 등록 프로젝트가 쓰는 길 그대로.
 * 기준선 작성 → 같은 결과로 통과 → 버튼이 사라지면 실패, 쓰기 요청은 서버에 닿지 않음, loopback이 아닌 주소는 설정 오류.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {parseSweepConfig} from '../scripts/agentstoz-click-sweep.mjs';

const ENGINE = resolve(import.meta.dir, '../scripts/agentstoz-click-sweep.mjs');
const PAGE = (withDialogButton: boolean) => `<!doctype html><html lang="ko"><body><main>
<h1>작은 앱</h1>
${withDialogButton ? '<button id="open" onclick="document.getElementById(\'dlg\').hidden=false">설정 열기</button>' : ''}
<div id="dlg" role="dialog" aria-label="설정" hidden><button onclick="document.getElementById('dlg').hidden=true">닫기</button></div>
<button onclick="fetch('/api/save',{method:'POST',body:'x'})">저장</button>
<button disabled>준비 중</button>
<button onclick="navigator.clipboard.writeText('복사')">복사</button>
</main></body></html>`;

let project = '';
let writesReachedServer = 0;
let html = PAGE(true);
let server: ReturnType<typeof Bun.serve>;

// 비동기로 띄운다 — 이 테스트 프로세스가 곧 개발 서버라서, spawnSync로 막으면 페이지가 영영 뜨지 않는다.
const sweep = async (...extra: string[]) => {
  const child = Bun.spawn(['bun', ENGINE, '--root', project, '--surface', 'web', ...extra], {stdout: 'pipe', stderr: 'pipe'});
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return {code, out: out + err};
};
const writeConfig = (url: string) => writeFileSync(join(project, '.agentstoz/click-sweep.json'),
  JSON.stringify({schemaVersion: 1, surfaces: [{id: 'web', label: '웹', url, ready: 'main', maxDepth: 1, workers: 1}]}));

beforeAll(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-click-sweep-engine-')));
  mkdirSync(join(project, '.agentstoz'));
  server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: request => {
    if (request.method !== 'GET' && request.method !== 'HEAD') writesReachedServer++;
    return new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}});
  }});
  writeConfig(`http://127.0.0.1:${server.port}/`);
});
afterAll(() => { server?.stop(true); rmSync(project, {recursive: true, force: true}); });

describe('click sweep engine on a project that is not AgentsToZ', () => {
  test('first run without a baseline fails; --update writes it; the same page then passes', async () => {
    const first = await sweep();
    expect(first.code).toBe(1);
    expect(first.out).toContain('기준선이 없습니다');
    const accepted = await sweep('--update');
    expect(accepted.code).toBe(0);
    const baseline = JSON.parse(readFileSync(join(project, '.agentstoz/click-sweep/web.json'), 'utf8'));
    const keys = Object.keys(baseline.elements);
    expect(keys.some(k => k.endsWith('button:설정 열기'))).toBe(true);
    expect(keys.some(k => k.includes('dialog(설정)>button:닫기'))).toBe(true);
    expect(baseline.elements[keys.find(k => k.endsWith('button:준비 중'))!].reactions).toEqual(['disabled']);
    expect(baseline.elements[keys.find(k => k.endsWith('button:복사'))!].reactions).toContain('clipboard');
    const again = await sweep();
    expect(again.code).toBe(0);
    expect(again.out).toContain('✓ 기준선과 비교해');
    const summary = JSON.parse(readFileSync(join(project, '.agentstoz/maintainer/click-sweep/web/summary.json'), 'utf8'));
    expect(summary).toMatchObject({schemaVersion: 1, surface: 'web', passed: true, baselinePresent: true});
    expect(readFileSync(join(project, '.agentstoz/maintainer/click-sweep/history.jsonl'), 'utf8').trim().split('\n').length).toBe(3);
  }, 120_000);

  test('a write request is intercepted and never reaches the dev server', () => {
    const latest = JSON.parse(readFileSync(join(project, '.agentstoz/maintainer/click-sweep/web/latest.json'), 'utf8'));
    expect(latest.interceptedWrites['POST /api/save']).toBeGreaterThan(0);
    expect(writesReachedServer).toBe(0);
  });

  test('a button that disappeared fails the set and names the lost targets', async () => {
    html = PAGE(false);
    const result = await sweep();
    expect(result.code).toBe(1);
    expect(result.out).toContain('사라짐 —');
    expect(result.out).toContain('설정 열기');
    html = PAGE(true);
  }, 120_000);

  test('only loopback pages can be swept, and a missing config is not a pass', () => {
    expect(() => parseSweepConfig(JSON.stringify({schemaVersion: 1, surfaces: [{id: 'prod', url: 'https://example.com/'}]}))).toThrow('loopback');
    expect(() => parseSweepConfig(JSON.stringify({schemaVersion: 1, surfaces: [{id: 'x', command: ['a'], url: 'http://127.0.0.1/'}]}))).toThrow();
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'agentstoz-click-sweep-bare-')));
    try {
      const child = Bun.spawnSync(['bun', ENGINE, '--root', bare], {stdout: 'pipe', stderr: 'pipe'});
      expect(child.exitCode).toBe(2);
      expect(child.stderr.toString()).toContain('통과가 아닙니다');
      expect(existsSync(join(bare, '.agentstoz'))).toBe(false);
    } finally { rmSync(bare, {recursive: true, force: true}); }
  });
});
