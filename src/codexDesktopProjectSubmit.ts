export type CodexDesktopComposerAutomationErrorCode =
  | 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED'
  | 'CODEX_DESKTOP_PROCESS_NOT_FOUND'
  | 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN'
  | 'CODEX_DESKTOP_COMPOSER_NOT_READY';

export const CODEX_DESKTOP_BUNDLE_ID = 'com.openai.codex' as const;

/** Route every Codex URL to the installed ChatGPT/Codex bundle explicitly.
 * A bare `open codex://…` trusts a possibly stale LaunchServices default and
 * can report success after handing the URL to the wrong app registration. */
export function buildCodexDesktopDeepLinkCommand(
  deepLink: string,
  platform: NodeJS.Platform,
): string[] {
  let parsed: URL;
  try {
    parsed = new URL(deepLink);
  } catch {
    throw new Error('CODEX_DESKTOP_DEEP_LINK_INVALID');
  }
  if (parsed.protocol !== 'codex:' || deepLink.length > 8_192) {
    throw new Error('CODEX_DESKTOP_DEEP_LINK_INVALID');
  }
  if (platform === 'darwin') {
    return ['/usr/bin/open', '-b', CODEX_DESKTOP_BUNDLE_ID, deepLink];
  }
  if (platform === 'win32') {
    return ['rundll32.exe', 'url.dll,FileProtocolHandler', deepLink];
  }
  return ['xdg-open', deepLink];
}

const appleScriptString = (value: string): string => JSON.stringify(value);

/**
 * The documented Codex project deep link can select/create the local project
 * and prefill a prompt, but deliberately leaves that prompt unsent. Submit
 * only when the focused accessibility element is the standard task window's
 * multiline composer. This avoids sending Return to search, a dialog, or a
 * previously focused conversation if the deep link has not settled yet.
 */
export function buildCodexDesktopComposerSubmitAppleScript(input: {
  attempts?: number;
  initialDelaySeconds?: number;
  expectedPrompt?: string;
} = {}): string {
  const attempts = Math.max(1, Math.min(40, input.attempts ?? 20));
  const initialDelaySeconds = Math.max(0.25, Math.min(5, input.initialDelaySeconds ?? 0.6));
  const expectedPrompt = input.expectedPrompt;
  const submitFocusedComposer = expectedPrompt === undefined
    ? [
        '            key code 36',
        `            return ${appleScriptString('accessibility-project-composer-return')}`,
      ]
    : [
        '            set focusedValue to ""',
        '            try',
        '              set focusedValue to value of focusedElement as text',
        '            end try',
        `            if focusedValue is ${appleScriptString(expectedPrompt)} then`,
        '              key code 36',
        `              return ${appleScriptString('accessibility-project-composer-return')}`,
        '            end if',
      ];
  return [
    'tell application id "com.openai.codex" to activate',
    `delay ${initialDelaySeconds}`,
    'tell application "System Events"',
    '  if UI elements enabled is false then error "CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED"',
    '  set codexAppProcess to missing value',
    '  set matchingProcesses to application processes whose bundle identifier is "com.openai.codex"',
    '  if (count of matchingProcesses) is 1 then',
    '    set codexAppProcess to item 1 of matchingProcesses',
    '  end if',
    '  if codexAppProcess is missing value then error "CODEX_DESKTOP_PROCESS_NOT_FOUND"',
    `  repeat with attempt from 1 to ${attempts}`,
    '    tell codexAppProcess',
    '      set frontmost to true',
    '      set standardWindowReady to false',
    '      try',
    '        set standardWindowReady to ((subrole of front window as text) is "AXStandardWindow")',
    '      end try',
    '      if standardWindowReady then',
    '        set focusedElement to missing value',
    '        try',
    '          set focusedElement to value of attribute "AXFocusedUIElement"',
    '        end try',
    '        if focusedElement is not missing value then',
    '          set focusedRole to ""',
    '          try',
    '            set focusedRole to role of focusedElement as text',
    '          end try',
    // Electron exposes the multiline Codex composer as AXTextArea. Do not
    // accept AXTextField: sidebar search and rename controls use that role.
    '          if focusedRole is "AXTextArea" then',
    ...submitFocusedComposer,
    '          end if',
    '        end if',
    '      end if',
    '    end tell',
    '    delay 0.2',
    '  end repeat',
    'end tell',
    'error "CODEX_DESKTOP_COMPOSER_NOT_READY"',
  ].join('\n');
}

/** Windows equivalent: the deep link owns the prompt and focus transition;
 * UI Automation must still confirm the foreground Codex control is an
 * editable document before Enter is sent. */
export function buildCodexDesktopComposerSubmitPowerShell(): string {
  return [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class CodexForegroundWindow {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '\'@',
    '$codexProcess = Get-Process -ErrorAction SilentlyContinue | Where-Object {',
    '  ($_.ProcessName -eq "Codex" -or $_.ProcessName -eq "ChatGPT") -and $_.MainWindowHandle -ne 0',
    '} | Select-Object -First 1',
    'if ($null -eq $codexProcess) { throw "CODEX_DESKTOP_PROCESS_NOT_FOUND" }',
    '[void][CodexForegroundWindow]::SetForegroundWindow($codexProcess.MainWindowHandle)',
    'Start-Sleep -Milliseconds 700',
    '$focused = [System.Windows.Automation.AutomationElement]::FocusedElement',
    'if ($null -eq $focused) { throw "CODEX_DESKTOP_COMPOSER_NOT_READY" }',
    '$controlType = $focused.Current.ControlType.ProgrammaticName',
    'if ($controlType -ne "ControlType.Edit" -and $controlType -ne "ControlType.Document") {',
    '  throw "CODEX_DESKTOP_COMPOSER_NOT_READY"',
    '}',
    '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
    'Write-Output "accessibility-project-composer-return"',
  ].join('\n');
}

export function classifyCodexDesktopComposerAutomationError(
  detail: string,
): CodexDesktopComposerAutomationErrorCode {
  if (/not authorized|not permitted|assistive access|accessibility|(-1743|-25211)/i.test(detail)
    || detail.includes('CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED')) {
    return 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED';
  }
  if (detail.includes('CODEX_DESKTOP_PROCESS_NOT_FOUND')) {
    return 'CODEX_DESKTOP_PROCESS_NOT_FOUND';
  }
  if (detail.includes('CODEX_DESKTOP_COMPOSER_NOT_READY')) return 'CODEX_DESKTOP_COMPOSER_NOT_READY';
  return 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN';
}

export function describeCodexDesktopComposerAutomationFailure(
  code: CodexDesktopComposerAutomationErrorCode,
): string {
  if (code === 'CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED') {
    return 'Codex 앱에 첫 메시지를 보내려면 macOS 접근성 자동화 권한이 필요합니다.';
  }
  if (code === 'CODEX_DESKTOP_PROCESS_NOT_FOUND') {
    return 'Codex 앱을 찾지 못했습니다. 이 Mac에서 Codex 앱을 연 뒤 다시 시도하세요.';
  }
  if (code === 'CODEX_DESKTOP_SUBMISSION_UNCERTAIN') {
    return 'Codex 첫 메시지 전달 결과를 확인하지 못했습니다. 중복 전송을 차단했으므로 Mac 앱에서 대화를 확인하세요.';
  }
  return 'Codex 프로젝트의 새 대화 입력창을 확인하지 못해 첫 메시지를 보내지 않았습니다. Codex 앱 상태를 확인한 뒤 다시 시도하세요.';
}
