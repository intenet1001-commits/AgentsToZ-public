import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 이 저장소는 오랫동안 typecheck·bun test·cargo test 를 자동 실행하는 지점이
 * 하나도 없었다 — git hook 0개, 워크플로는 수동 실행(workflow_dispatch) 하나뿐,
 * package.json 에 test 스크립트 없음. 다른 모든 회귀 가드는 이것이 없으면 무력하다.
 *
 * 그래서 "검증이 자동으로 돈다"는 계약 자체를 테스트로 못박는다.
 */

const REPO_ROOT = join(import.meta.dir, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

function readPackageScripts(): Record<string, string> {
  const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/** `on:` 블록만 잘라낸다. 인라인(`on: [push]`)과 블록(`on:\n  push:`) 둘 다 지원. */
function extractOnSection(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start === -1) return '';

  const collected = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // 들여쓰기가 없는 다음 최상위 키를 만나면 블록 종료 (빈 줄·주석은 통과)
    if (/^\S/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n');
}

type Workflow = { file: string; body: string };

function readWorkflows(): Workflow[] {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({ file: name, body: readFileSync(join(WORKFLOW_DIR, name), 'utf8') }));
}

function autoTriggeredWorkflows(): Workflow[] {
  return readWorkflows().filter((wf) => {
    const on = extractOnSection(wf.body);
    return /\bpush\b/.test(on) || /\bpull_request\b/.test(on);
  });
}

test('package.json 에 test / test:rust / verify 스크립트가 있다', () => {
  const scripts = readPackageScripts();
  const missing = ['test', 'test:rust', 'verify'].filter((name) => !scripts[name]);
  expect(
    missing,
    `package.json scripts 에 다음이 없다: ${missing.join(', ')}. ` +
      `이것들이 없으면 검증을 한 줄로 돌릴 방법이 없다.`,
  ).toEqual([]);
});

test('test 스크립트가 bun test 를, test:rust 가 cargo test 를 부른다', () => {
  const scripts = readPackageScripts();
  expect(
    scripts['test'] ?? '',
    `scripts.test 가 "bun test" 를 부르지 않는다 (현재: ${scripts['test'] ?? '없음'})`,
  ).toContain('bun test');
  expect(
    scripts['test:rust'] ?? '',
    `scripts["test:rust"] 가 "cargo test" 를 부르지 않는다 (현재: ${scripts['test:rust'] ?? '없음'})`,
  ).toContain('cargo test');
});

test('Rust 검증은 Tauri가 요구하는 sidecar 리소스를 먼저 만든다', () => {
  const scripts = readPackageScripts();
  const rustTest = scripts['test:rust'] ?? '';
  expect(rustTest).toContain('build:sidecar');
  expect(rustTest.indexOf('build:sidecar')).toBeLessThan(rustTest.indexOf('cargo test'));
});

test('verify 스크립트가 typecheck·test·test:rust 를 모두 엮는다', () => {
  const verify = readPackageScripts()['verify'] ?? '';
  for (const part of ['typecheck', 'test', 'test:rust']) {
    expect(
      verify,
      `scripts.verify 에 "${part}" 가 빠졌다 (현재: ${verify || '없음'}). ` +
        `verify 는 세 검증을 한 번에 돌리는 단일 진입점이어야 한다.`,
    ).toContain(part);
  }
});

test('push 또는 pull_request 로 자동 실행되는 워크플로가 최소 1개 있다', () => {
  const all = readWorkflows();
  const auto = autoTriggeredWorkflows();
  expect(
    auto.length,
    `.github/workflows 에 push/pull_request 트리거 워크플로가 없다. ` +
      `발견된 워크플로: ${all.length ? all.map((w) => w.file).join(', ') : '없음'}. ` +
      `수동(workflow_dispatch) 전용 워크플로는 아무도 안 돌리므로 검증 지점이 아니다.`,
  ).toBeGreaterThan(0);
});

test('자동 실행 워크플로들이 typecheck·bun test·cargo test 를 모두 부른다', () => {
  const auto = autoTriggeredWorkflows();
  const union = auto.map((wf) => wf.body).join('\n');
  const required = ['bun run typecheck', 'bun test', 'cargo test'];
  const missing = required.filter((cmd) => !union.includes(cmd));
  expect(
    missing,
    `자동 실행 워크플로(${auto.map((w) => w.file).join(', ') || '없음'}) 어디에서도 ` +
      `다음 명령을 부르지 않는다: ${missing.join(', ')}. ` +
      `CI 가 초록이어도 이 검증들은 실제로 돈 적이 없다는 뜻이다.`,
  ).toEqual([]);
});

test('CI Rust job도 cargo test 전에 sidecar를 준비한다', () => {
  const rustWorkflow = readWorkflows().find((workflow) => workflow.file === 'verify.yml')?.body ?? '';
  expect(rustWorkflow).toContain('bun run build:sidecar');
  expect(rustWorkflow.indexOf('bun run build:sidecar')).toBeLessThan(rustWorkflow.lastIndexOf('cargo test'));
});
