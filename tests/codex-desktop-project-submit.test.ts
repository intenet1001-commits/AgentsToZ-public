import { describe, expect, test } from 'bun:test';
import {
  buildCodexDesktopDeepLinkCommand,
  buildCodexDesktopComposerSubmitAppleScript,
  buildCodexDesktopComposerSubmitPowerShell,
  classifyCodexDesktopComposerAutomationError,
  describeCodexDesktopComposerAutomationFailure,
} from '../src/codexDesktopProjectSubmit';

describe('Codex Desktop project composer submission', () => {
  test('targets the installed ChatGPT bundle instead of a stale default URL handler', () => {
    expect(buildCodexDesktopDeepLinkCommand('codex://threads/thread-1', 'darwin')).toEqual([
      '/usr/bin/open',
      '-b',
      'com.openai.codex',
      'codex://threads/thread-1',
    ]);
    expect(() => buildCodexDesktopDeepLinkCommand('https://example.test', 'darwin'))
      .toThrow('CODEX_DESKTOP_DEEP_LINK_INVALID');
  });

  test('presses Return only for the focused multiline composer in a standard window', () => {
    const script = buildCodexDesktopComposerSubmitAppleScript({
      attempts: 3,
      initialDelaySeconds: 0.25,
      expectedPrompt: 'fixed remote prompt',
    });
    expect(script).toContain('tell application id "com.openai.codex" to activate');
    expect(script).toContain('application processes whose bundle identifier is "com.openai.codex"');
    expect(script).not.toContain('application process "ChatGPT"');
    expect(script).toContain('subrole of front window as text) is "AXStandardWindow"');
    expect(script).toContain('value of attribute "AXFocusedUIElement"');
    expect(script).toContain('if focusedRole is "AXTextArea" then');
    expect(script).toContain('if focusedValue is "fixed remote prompt" then');
    expect(script).toContain('key code 36');
    expect(script).not.toContain('AXTextField" then');
    expect(script).not.toContain('entire contents');
  });

  test('checks the focused Windows UI Automation control before Enter', () => {
    const script = buildCodexDesktopComposerSubmitPowerShell();
    expect(script).toContain('SetForegroundWindow');
    expect(script).toContain('AutomationElement]::FocusedElement');
    expect(script).toContain('ControlType.Edit');
    expect(script).toContain('ControlType.Document');
    expect(script).toContain('SendWait("{ENTER}")');
  });

  test('classifies permission, missing-process, and unfocused-composer failures', () => {
    expect(classifyCodexDesktopComposerAutomationError('Not authorized to send Apple events. (-1743)'))
      .toBe('CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED');
    expect(classifyCodexDesktopComposerAutomationError('CODEX_DESKTOP_PROCESS_NOT_FOUND'))
      .toBe('CODEX_DESKTOP_PROCESS_NOT_FOUND');
    expect(classifyCodexDesktopComposerAutomationError('CODEX_DESKTOP_COMPOSER_NOT_READY'))
      .toBe('CODEX_DESKTOP_COMPOSER_NOT_READY');
    expect(classifyCodexDesktopComposerAutomationError('automation timed out'))
      .toBe('CODEX_DESKTOP_SUBMISSION_UNCERTAIN');
    expect(describeCodexDesktopComposerAutomationFailure('CODEX_DESKTOP_SUBMISSION_UNCERTAIN'))
      .not.toContain('보내지 않았습니다');
    expect(describeCodexDesktopComposerAutomationFailure('CODEX_DESKTOP_COMPOSER_NOT_READY'))
      .toContain('첫 메시지를 보내지 않았습니다');
  });
});
