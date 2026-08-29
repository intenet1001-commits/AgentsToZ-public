import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const capabilities = JSON.parse(
  readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
) as { permissions: string[] };

describe('VOC — 매뉴얼·로그 파일 넣기가 ACL에 막히던 문제', () => {
  // 드롭 검증이 plugin-fs 의 stat 을 부르는데 fs:allow-stat 이 없어
  // `fs|stat not allowed by ACL` 로 매번 실패했다.
  test('stat 권한이 ACL에 있다', () => {
    expect(capabilities.permissions).toContain('fs:allow-stat');
  });

  test('권한이 빠져도 기능이 죽지 않도록 API 서버로 폴백한다', () => {
    expect(appSource).toContain('const fileExistsAtPath = async');
    expect(appSource).toContain("${isTauri() ? 'http://127.0.0.1:3001' : ''}/api/validate-file");
  });

  test('"파일이 아니다"라는 판정은 폴백으로 덮지 않는다', () => {
    // 폴백이 판정 결과까지 되돌리면 폴더를 드롭해도 통과해 버린다.
    expect(appSource).toContain('if (error?.message === notAFileMessage) throw error;');
  });

  test('실행 파일과 문서 파일이 같은 검증을 쓴다', () => {
    expect(appSource.match(/await fileExistsAtPath\(normalizedPath, '드롭한 경로가 파일이 아닙니다\.'\);/g) ?? [])
      .toHaveLength(2);
    // 두 곳에 흩어져 있던 stat 직접 호출이 남아 있으면 한쪽만 고쳐진다.
    expect(appSource).not.toContain("const { stat } = await import('@tauri-apps/plugin-fs');\n      const info = await stat(normalizedPath);");
  });
});

describe('VOC — Orca 「실행」이 다른 프로젝트 탭 뒤에서 아무 일도 안 하던 문제', () => {
  // Orca 1.4.180부터 생성 경로도 --focus 없이는 새 탭을 뒤에 만든다. 재사용 경로는
  // 기존 탭을 명시적으로 switch해야 하므로 두 경로를 각각 고정한다.
  test('새 Floating 탭을 만들 때 명시적으로 포커스한다', () => {
    const apiCreate = apiSource.slice(
      apiSource.indexOf('async function createOrcaFloatingTerminal('),
      apiSource.indexOf('type OrcaListedTerminal'),
    );
    const rustCreate = rustSource.slice(
      rustSource.indexOf('fn orca_create_floating_terminal('),
      rustSource.indexOf('fn normalize_orca_floating_terminal_path('),
    );
    expect(apiCreate).toContain("'--focus'");
    expect(rustCreate).toContain('"--focus"');
  });

  test('재사용할 때 그 탭을 명시적으로 앞으로 가져온다', () => {
    const reuse = apiSource.slice(
      apiSource.indexOf('const reuseExistingFloatingTerminal = async'),
      apiSource.indexOf('// 일반 “실행”은 이미 AgentsToZ가 만든'),
    );
    expect(reuse).toContain("['terminal', 'switch', '--terminal', existing.handle]");
    expect(reuse.indexOf("'terminal', 'switch'")).toBeLessThan(reuse.indexOf('revealOrcaFloatingWorkspace'));
  });

  test('전환 실패가 재사용 자체를 실패로 만들지 않는다', () => {
    expect(apiSource).toContain('const switchWarning = switched.ok');
    expect(apiSource).toContain('switchWarning,');
    expect(rustSource).toContain('.err()\n        .map(|error| format!("재사용할 탭을 앞으로 가져오지 못했습니다');
  });

  // 앱은 Rust 경로(open_orca_agent)로 실행한다. 웹만 고치면 정작 신고된 화면에서는
  // 증상이 그대로 남는다 — 실제로 처음에 그렇게 고쳤다가 앱에서 안 고쳐진 것을 확인했다.
  test('같은 규칙이 Rust 쪽에도 있다 — 앱이 쓰는 경로다', () => {
    expect(rustSource).toContain('fn orca_focus_reused_floating_terminal(');
    const reuse = rustSource.slice(rustSource.indexOf('fn open_orca_agent('));
    const focusCalls = reuse.match(/orca_focus_reused_floating_terminal\(&cli, /g) ?? [];
    // 재사용 경로는 registry hit 과 제목 기반 마이그레이션 두 곳이다.
    expect(focusCalls).toHaveLength(2);
  });
});
