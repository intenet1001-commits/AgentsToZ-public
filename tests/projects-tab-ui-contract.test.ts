import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * 프로젝트·폴더 탭 UI 감사(2026-09)의 회귀 계약. 행위 검증은 브라우저로 실제로 누르는
 * `tests/projects-tab-ui.e2e.mjs`가 맡고, 여기서는 그 스크립트를 돌리지 않는 `bun test`에서도
 * 되돌림이 보이도록 원인이 된 코드 모양만 고정한다.
 */
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const portal = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');

describe('settings gear opens on the first click', () => {
  test('onSettingsClosed fires only on an open→closed transition, never on mount', () => {
    // 마운트 시 showSettings=false 로 닫힘을 통지하면 부모가 openSettings 를 즉시 내려
    // 모달이 숨겨진 탭 패널에 갇혔다.
    expect(portal).not.toMatch(/if \(!showSettings && onSettingsClosed\) onSettingsClosed\(\);/);
    expect(portal).toContain('settingsWasOpenRef');
    expect(portal).toMatch(/if \(wasOpen && !showSettings && onSettingsClosed\) onSettingsClosed\(\);/);
  });
});

describe('settings opened over a failed portal load can be dismissed', () => {
  test('the load-error card offers a close that ends the settings request', () => {
    // 첫 ⚙ 클릭이 이제 패널을 드러내므로, portal.json 을 못 읽은 상태에서는 오류 카드가
    // 프로젝트 화면에 남는다. 닫기가 showSettings 를 내려 부모의 openSettings 도 내린다.
    const errorBranch = portal.match(/if \(loadError\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(errorBranch).toContain('data-testid="portal-load-error-close"');
    expect(errorBranch).toContain('setShowSettings(false)');
  });
});

describe('guide mode is session-only', () => {
  test('guide mode is never restored from or written to localStorage', () => {
    expect(app).not.toMatch(/localStorage\.getItem\('pm-guide-mode'\)/);
    expect(app).not.toMatch(/localStorage\.setItem\('pm-guide-mode'/);
    expect(app).toMatch(/const \[guideMode, setGuideMode\] = useState\(false\);/);
  });
});

describe('sidebar project list keeps room', () => {
  const design = readFileSync(new URL('../src/workspaceDesign.css', import.meta.url), 'utf8');
  const roles = readFileSync(new URL('../src/ProjectRoleLabels.tsx', import.meta.url), 'utf8');

  test('the list has a real floor and the expanded sections scroll inside themselves', () => {
    expect(app).toContain('data-testid="sidebar-project-list" className="workspace-sidebar-list"');
    const list = design.match(/\.workspace-sidebar-list \{[^}]*\}/)?.[0] ?? '';
    expect(list).toMatch(/min-height:\s*min\(/);
    expect(design).toMatch(/\.workspace-sidebar-roots > \.workspace-sidebar-section-body \{[^}]*overflow-y: auto/);
    expect(app).toContain('className="workspace-sidebar-roots"');
    expect(app).toContain('className="workspace-sidebar-tags"');
  });

  test('a click near the bottom cannot scroll the chips and search out of the sidebar', () => {
    expect(design).toMatch(/\.workspace-sidebar-host \{[^}]*overflow: clip;/);
  });

  test('role chips keep the 44px touch height only on narrow screens', () => {
    expect(roles).toContain('min-h-11 sm:min-h-6');
  });
});

describe('dialogs close on Escape and describe themselves', () => {
  test('Escape closes the delete, cleanup and new-project dialogs', () => {
    const escape = app.match(/escapeHandlerRef\.current = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? '';
    expect(escape).toContain('setDeleteConfirmId(null)');
    expect(escape).toContain('setShowCleanupReview(false)');
    expect(escape).toContain('closeNewProjectModal()');
  });

  test('Escape does not close a dialog underneath an overlay or during Korean composition', () => {
    // 새 프로젝트(기존 폴더) → OPS 운영 프로필을 연 상태의 Esc 가 두 겹을 함께 닫아
    // 입력한 기존 폴더 경로를 지웠다(리뷰 재현). 조합 중 Esc 도 같은 손실을 냈다.
    const escape = app.match(/escapeHandlerRef\.current = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? '';
    const guard = escape.indexOf('if (showControlProfile) return;');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(escape.indexOf('closeNewProjectModal()'));
    expect(guard).toBeLessThan(escape.indexOf('setShowCleanupReview(false)'));
    expect(app).toContain("if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;\n        escapeHandlerRef.current?.();");
  });

  test('new-project backdrop does not discard typed existing-folder input', () => {
    expect(app).toMatch(/if \(existingFolderPath\.trim\(\) \|\| existingProjectName\.trim\(\) \|\| existingPort\.trim\(\)\) return;/);
  });

  test('delete dialog is about the project and offers the reversible choice first', () => {
    expect(app).toContain('aria-labelledby="delete-project-title"');
    expect(app).not.toContain('>포트 삭제</h3>');
    const local = app.indexOf('data-testid="delete-confirm-local"');
    const remote = app.indexOf('data-testid="delete-confirm-remote"');
    expect(local).toBeGreaterThan(0);
    expect(local).toBeLessThan(remote);
  });

  test('cleanup review is announced as a dialog', () => {
    expect(app).toContain('aria-labelledby="cleanup-review-title"');
  });
});

describe('copy points at places that exist', () => {
  test('no toast sends the user to the removed 포털 tab', () => {
    expect(app).not.toContain('포털 탭에서');
  });

  test('the overflow menu is labelled in Korean', () => {
    expect(app).not.toContain('title="More options"');
    expect(app).toContain('aria-label="더 보기"');
  });

  test('an empty filtered list explains itself instead of asking to pick from it', () => {
    expect(app).toContain('data-testid="sidebar-empty-state"');
    expect(app).toContain('왼쪽 검색·필터에 맞는 프로젝트가 없습니다');
  });
});

describe('labels say what they mean', () => {
  test('the permission-bypass toggle names the risk instead of a bare 「⚠ ON」', () => {
    expect(app).not.toContain("{bypassPermissions ? '⚠ ON' : 'OFF'}");
    expect(app).toContain("{bypassPermissions ? '승인 없이 실행 켜짐' : '승인 없이 실행 꺼짐'}");
  });

  test('error toasts show the message, not a stringified Error object', () => {
    expect(app).not.toMatch(/showToast\('[^']*' \+ (error|e), 'error'\)/);
    expect(app).toContain('const errorText = (value: unknown): string => value instanceof Error ? value.message : String(value);');
  });

  test('the header count does not repeat 프로젝트 after the title', () => {
    expect(app).not.toContain("{v3Ports.length} {t(lang,'projects')}</span>");
  });

  test('an Orca query failure is not shown as a check that never finishes', () => {
    expect(app).not.toContain("label:'Orca 확인중'");
  });
});
