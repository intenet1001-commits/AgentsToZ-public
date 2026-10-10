import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');
const panel = app.slice(
  app.indexOf('data-testid="local-preview-panel"'),
  app.indexOf('data-testid="terminal-agent-panel"'),
);

// 미리보기 버튼 셋은 모두 `sel.port &&` 로 묶여 있다. 이 앱은 폴더 전용 프로젝트를
// 정식으로 지원하므로(실측 13개 중 12개가 포트 없음) 그 상태가 예외가 아니라 다수다.
// 그때 제목만 남은 빈 상자가 뜨면 "기능이 사라졌다"로 읽힌다 — 실제로 그렇게 접수됐다.
describe('local preview panel without a port', () => {
  test('explains the absence instead of rendering an empty box', () => {
    expect(panel).toContain('local-preview-no-port');
    expect(panel).toContain('!sel.port &&');
  });

  test('offers working ways to get the buttons back', () => {
    const hint = panel.slice(panel.indexOf('local-preview-no-port'));
    expect(hint).toContain('포트');
    expect(hint).toContain('local-preview-auto-port');
    expect(hint).toContain('local-preview-edit-port');
  });

  // 버튼을 **숨기지 않는다**. 주소가 없는 상태는 자동 설정/수정 CTA로 복구할 수 있고,
  // 등록 주소가 생기면 일시적인 실행 상태 폴링과 무관하게 즉시 열 수 있어야 한다.
  test('keeps the buttons visible and only blocks them while the address is unknown', () => {
    expect(panel).toContain('disabled={!canOpenRegisteredPort(sel)}');
    expect(panel).not.toContain('disabled={!sel.port || !sel.isRunning}');
    expect(panel).not.toContain('{sel.port && <button');
  });

  // 정지 상태는 주소를 없애지 않는다. 폴링 지연·외부 실행 중에도 사용자가 직접 열어
  // 브라우저의 실제 결과를 확인할 수 있어야 한다.
  test('does not turn a stopped-state observation into a localhost blocker', () => {
    expect(panel).toContain('프로젝트 수정에서 포트를 먼저 설정하세요');
    expect(panel).toContain('현재 실행 상태 미감지');
    expect(panel).not.toContain('포트가 실행되면 사용할 수 있습니다');
  });
});
