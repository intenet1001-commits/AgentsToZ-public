import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  HERMES_CLI_NOT_FOUND_CODE,
  HERMES_CLI_NOT_FOUND_MESSAGE,
  hermesCliAvailabilityFromStatus,
  hermesCliPathFromResolved,
} from '../src/hermesCliPresence';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/ProjectMemoryPanel.tsx', import.meta.url), 'utf8');
const memoryServerSource = readFileSync(new URL('../project-memory-server.ts', import.meta.url), 'utf8');

describe('hermesCliPathFromResolved', () => {
  test('이름 그대로 돌아오면 미설치다', () => {
    // resolveAgentBin은 후보 탐색과 로그인 셸 폴백이 모두 실패하면 이름을 그대로 돌려준다.
    expect(hermesCliPathFromResolved('hermes')).toBeNull();
  });

  test('절대경로는 그대로 통과한다', () => {
    expect(hermesCliPathFromResolved('/opt/homebrew/bin/hermes')).toBe('/opt/homebrew/bin/hermes');
  });

  test('빈 값·공백·null은 미설치다', () => {
    expect(hermesCliPathFromResolved('')).toBeNull();
    expect(hermesCliPathFromResolved('   ')).toBeNull();
    expect(hermesCliPathFromResolved(null)).toBeNull();
    expect(hermesCliPathFromResolved(undefined)).toBeNull();
  });

  test('경로 안에 이름이 들어 있을 뿐인 값은 설치로 본다', () => {
    expect(hermesCliPathFromResolved('/Users/x/.local/bin/hermes')).toBe('/Users/x/.local/bin/hermes');
  });
});

describe('Hermes 존재 판정은 실행 파일을 요구한다', () => {
  test('어댑터 상태는 홈 폴더와 CLI를 모두 봐야 present다', () => {
    // 홈 폴더만 보던 시절, 앱이 만든 ~/.hermes 때문에 CLI 없는 기기가 "설치됨"이 됐다.
    expect(memoryServerSource).toContain('const hermesPresent = hermesHomePresent && hermesCliPath !== null;');
    expect(memoryServerSource).toContain('hermesHomePresent,');
    expect(memoryServerSource).toContain('hermesCliPath,');
  });

  test('상태 조회와 설치 경로가 같은 리졸버 결과를 받는다', () => {
    expect(apiSource).toContain('function hermesCliPath(): string | null {');
    expect(apiSource).toContain("return hermesCliPathFromResolved(resolveAgentBin('hermes'));");
    expect(apiSource).toContain('detectHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() })');
    expect(apiSource).toContain('installHermesProjectMemoryAdapter({ hermesCliPath: hermesCliPath() })');
  });
});

describe('실행 실패 대신 미설치를 먼저 말한다', () => {
  test('CLI가 없고 떠 있는 인스턴스도 없으면 spawn 전에 409로 끝낸다', () => {
    expect(apiSource).toContain('if (!running && hermesCliPath() === null) {');
    expect(apiSource).toContain('JSON.stringify({ error: HERMES_CLI_NOT_FOUND_MESSAGE, code: HERMES_CLI_NOT_FOUND_CODE })');
    expect(apiSource).toContain('{ status: 409, headers }');
  });

  test('안내 문구가 다음 행동과 오해의 원인을 함께 말한다', () => {
    expect(HERMES_CLI_NOT_FOUND_CODE).toBe('HERMES_CLI_NOT_FOUND');
    expect(HERMES_CLI_NOT_FOUND_MESSAGE).toContain('~/.hermes');
    expect(HERMES_CLI_NOT_FOUND_MESSAGE).toContain('설치');
    // 원시 spawn 오류를 그대로 노출하지 않는다.
    expect(HERMES_CLI_NOT_FOUND_MESSAGE).not.toContain('$PATH');
  });
});

describe('hermesCliAvailabilityFromStatus — 모름과 없음을 구분한다', () => {
  // 실제로 앱이 물고 있던 sidecar 응답이다. 이 UI보다 오래된 서버라 hermesCliPath 키가
  // 아예 없는데, 그것을 「미설치」로 읽어 Hermes가 깔린 기기의 실행 버튼이 막혔다.
  const staleSidecar = JSON.parse(
    readFileSync(new URL('./fixtures/hermes-adapter-stale-sidecar.json', import.meta.url), 'utf8'),
  );

  test('필드가 없는 옛 sidecar 응답은 판단하지 않는다', () => {
    expect('hermesCliPath' in staleSidecar).toBe(false);
    expect(hermesCliAvailabilityFromStatus(staleSidecar)).toBeNull();
  });

  test('절대경로가 오면 설치로 읽는다', () => {
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: '/Users/x/.local/bin/hermes' })).toBe(true);
  });

  test('서버가 찾아보고 없다고 답한 경우에만 미설치로 읽는다', () => {
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: null })).toBe(false);
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: '' })).toBe(false);
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: '   ' })).toBe(false);
    // 리졸버가 못 찾아 이름 그대로를 실어 보낸 경우도 미설치다.
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: 'hermes' })).toBe(false);
  });

  test('응답 자체가 이상하면 판단하지 않는다', () => {
    expect(hermesCliAvailabilityFromStatus(null)).toBeNull();
    expect(hermesCliAvailabilityFromStatus('nope')).toBeNull();
    expect(hermesCliAvailabilityFromStatus({})).toBeNull();
    expect(hermesCliAvailabilityFromStatus({ hermesCliPath: 42 })).toBeNull();
  });

  test('앱이 이 판정을 쓰고, 판단 불가일 때 상태를 건드리지 않는다', () => {
    expect(appSource).toContain('hermesCliAvailabilityFromStatus(await res.json())');
    expect(appSource).toContain('if (!cancelled && availability !== null) setHermesCliAvailable(availability);');
    // 없는 필드를 미설치로 승격시키던 옛 판정이 돌아오면 안 된다.
    expect(appSource).not.toContain("typeof status?.hermesCliPath === 'string'");
  });
});

describe('버튼은 숨지 않고, 누르면 이유를 말한다', () => {
  test('미설치가 확인된 경우에만 막고, 미확인이면 서버 판정에 맡긴다', () => {
    expect(appSource).toContain('if (hermesCliAvailable !== false) return false;');
    expect(appSource).toContain('Hermes가 이 기기에 설치되어 있지 않습니다.');
  });

  test('앱 버튼과 CLI 버튼이 같은 판정을 거친다', () => {
    // 앱 버튼만 막으면 터미널 버튼이 대신 원시 오류로 죽는다.
    expect(appSource).toContain("if (agent === 'hermes' && blockedByMissingHermes()) return;");
    expect(appSource).toContain('if (blockedByMissingHermes()) return false;');
  });

  test('버튼을 조건부로 숨기지 않는다', () => {
    // 말없이 사라지는 버튼은 "기능이 없는 앱"으로 읽힌다.
    expect(appSource).not.toContain('showHermesLaunch &&');
  });

  test('패널은 「폴더는 있는데 CLI가 없다」를 따로 말한다', () => {
    expect(panelSource).toContain('data-testid="project-memory-hermes-cli-missing"');
    expect(panelSource).toContain('hermesAdapter.hermesHomePresent ?');
  });
});
