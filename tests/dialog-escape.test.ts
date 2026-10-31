import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isDialogDismissKey, isModalLayerTarget } from '../src/dialogEscape';

describe('dialog Escape dismissal', () => {
  test('plain Escape dismisses', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: false })).toBe(true);
  });
  test('Escape during IME composition only cancels the composition', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: true })).toBe(false);
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 229 })).toBe(false);
  });
  test('an Escape another handler consumed, or any other key, does not dismiss', () => {
    expect(isDialogDismissKey({ key: 'Escape', defaultPrevented: true, isComposing: false })).toBe(false);
    expect(isDialogDismissKey({ key: 'Enter', defaultPrevented: false, isComposing: false })).toBe(false);
  });
  test('the new-project dialog uses this rule', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const start = app.indexOf('if (!showNewProjectModal) return;');
    expect(start).toBeGreaterThan(-1);
    expect(app.slice(start, start + 400)).toContain('if (!isDialogDismissKey(event)) return;');
  });
  // 2026-10-31 실측: 도구 및 설정에서 연 넷이 Esc로 닫히지 않았다 — 여는 버튼에 포커스가 남아
  // 대화상자 자신의 onKeyDown이 키를 받지 못했다. 앱 공통 Esc 처리가 맨 위에서 먼저 닫는다.
  test('the settings dialogs close on Escape wherever focus is', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const start = app.indexOf('escapeHandlerRef.current = () => {');
    expect(start).toBeGreaterThan(-1);
    const chain = app.slice(start, app.indexOf('};', start));
    const first = chain.indexOf('if (deleteConfirmId)');
    for (const close of ['setShowShortcutModal(false)', 'setShowChannelHealth(false)', 'setShowWorkspaceLeaseRecovery(false)', 'setShowAiUsage(false)']) {
      const at = chain.indexOf(close);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(first);
    }
  });
  test('the shortcut recorder lets a bare Escape through to close its dialog', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const start = app.indexOf('data-testid="global-shortcut-dialog"');
    expect(start).toBeGreaterThan(-1);
    const recorder = app.slice(start, app.indexOf('e.preventDefault();', start));
    expect(recorder).toContain("if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return;");
  });
  // 2026-10-31 v1603 실측: 기록 칸을 누른 뒤 Esc 로 닫고 다시 열면 기존 단축키 대신 「키를 누르세요...」가 보였다.
  // 포커스된 칸이 통째로 지워지면 WebKit 은 blur 를 보내지 않아 기록 상태가 남는다 — 닫힘에서 푼다.
  test('closing the shortcut dialog by any path ends recording', () => {
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('useEffect(() => { if (!showShortcutModal) setIsRecordingShortcut(false); }, [showShortcutModal]);');
    const start = app.indexOf('data-testid="global-shortcut-dialog"');
    const input = app.slice(start, app.indexOf('onKeyDown', start));
    expect(input).toContain("value={isRecordingShortcut ? '키를 누르세요...' : shortcutInput}");
  });
  test('dialogs that handle Escape themselves consume it so the app does not close a second layer', () => {
    for (const file of ['ChannelHealthDialog', 'WorkspaceLeaseRecoveryDialog']) {
      const source = readFileSync(new URL(`../src/components/${file}.tsx`, import.meta.url), 'utf8');
      expect(source).toContain('if (isDialogDismissKey(event.nativeEvent)) { event.preventDefault(); onClose(); }');
      expect(source).not.toContain("event.key === 'Escape') onClose()");
    }
  });
  // 2026-10-31 v1601 실측: 도구 및 설정 → 앱 열기 단축키의 입력칸을 누르자 뒤의 도구 및 설정 패널이 접혔다.
  // 대화상자는 패널 바깥에 그려지므로 패널의 바깥 클릭 처리가 그것을 바깥으로 셌다.
  const fakeElement = ({ insideModal = false, modalChild = false }) => ({
    closest: (selector: string) => (selector === '[aria-modal="true"]' && insideModal ? {} : null),
    querySelector: (selector: string) => (selector === ':scope > [aria-modal="true"]' && modalChild ? {} : null),
  }) as unknown as Pick<Element, 'closest' | 'querySelector'>;
  test('a press inside a modal dialog or on its scrim belongs to that dialog', () => {
    expect(isModalLayerTarget(fakeElement({ insideModal: true }))).toBe(true);
    expect(isModalLayerTarget(fakeElement({ modalChild: true }))).toBe(true);
    expect(isModalLayerTarget(fakeElement({}))).toBe(false);
  });
  test('the tools disclosure ignores presses on a modal layer before collapsing', () => {
    const source = readFileSync(new URL('../src/components/WorkspaceTools.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const close = (event: PointerEvent) => {');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('};', start));
    const guard = handler.indexOf('isModalLayerTarget(event.target)) return;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(handler.indexOf('root.current.open = false'));
  });
});
