/**
 * ChatGPT Desktop exposes Voice through its own UI, not a public `codex://`
 * deep link. Keep the UI driver small, explicit, and testable: it may start a
 * Voice chat, but it never claims that the resulting chat inherited a local
 * project workspace.
 */

export type ChatGptVoiceAutomationMethod = 'accessibility-button' | 'accessibility-global-button';

/** A project composer and the floating/global Voice surface have different
 * scope guarantees. The latter is only invoked after an explicit user action. */
export type ChatGptVoiceStartSurface = 'project-composer' | 'global';

export type ChatGptVoiceAutomationErrorCode =
  | 'VOICE_AUTOMATION_PERMISSION_DENIED'
  | 'VOICE_CHATGPT_PROCESS_NOT_FOUND'
  | 'VOICE_AX_UNRESPONSIVE'
  | 'VOICE_START_CONTROL_UNAVAILABLE';

/**
 * Marker emitted by the AppleScript only when it could not press an exact
 * Voice-start label.  It is intentionally suitable for server logs rather
 * than UI: the values are a small, sanitised list of visible button/menu-style
 * Voice controls; it never reads AX element values or arbitrary page text.
 */
export const CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX = 'VOICE_AX_CANDIDATES=';

/** Labels shipped by the current English and Korean ChatGPT desktop UI. */
export const CHATGPT_NEW_VOICE_START_LABELS = [
  'Start new voice chat',
  '새 음성 채팅 시작',
] as const;

/** Existing Voice threads use a different, resume-specific control. */
export const CHATGPT_RESUME_VOICE_START_LABELS = [
  'Start voice chat',
  '음성 채팅 시작',
] as const;

/** The separately-confirmed global Voice action may start a fresh chat or
 * reopen the most recent global Voice. It is intentionally never used as an
 * implicit fallback for a project-scoped request. */
export const CHATGPT_GLOBAL_VOICE_START_LABELS = [
  ...CHATGPT_NEW_VOICE_START_LABELS,
  'Resume voice chat',
  '음성 채팅 재개',
] as const;

const appleScriptString = (value: string): string => JSON.stringify(value);

/**
 * Pulls the compact AX candidate list out of an `osascript` error without
 * making the UI display raw accessibility data.  The final `(-2700)` (or
 * equivalent) AppleScript error suffix is deliberately excluded.
 */
export function extractChatGptVoiceCandidateDiagnostic(detail: string): string | null {
  const markerIndex = detail.indexOf(CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX);
  if (markerIndex < 0) return null;

  const suffix = detail.slice(markerIndex + CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX.length);
  const candidates = suffix.replace(/\s*\(-?\d+\)\s*$/, '').trim();
  return candidates && candidates !== 'none' ? candidates : null;
}

/** Keep the end-user error actionable without exposing AX tree diagnostics. */
export function describeChatGptVoiceAutomationFailure(
  code: ChatGptVoiceAutomationErrorCode,
  detail: string,
): string {
  if (code === 'VOICE_AUTOMATION_PERMISSION_DENIED') {
    return 'ChatGPT Voice 자동화 권한을 확인하지 못했습니다.';
  }
  if (code === 'VOICE_CHATGPT_PROCESS_NOT_FOUND' || detail.includes('VOICE_CHATGPT_PROCESS_NOT_FOUND')) {
    return 'ChatGPT 앱을 찾지 못했습니다. ChatGPT를 연 뒤 다시 시도하세요.';
  }
  if (code === 'VOICE_AX_UNRESPONSIVE' || detail.includes('VOICE_AX_ENUMERATION_FAILED')) {
    return 'ChatGPT Voice 컨트롤을 확인하는 중 접근성 오류가 발생했습니다.';
  }
  return '현재 ChatGPT 화면에서 Voice 시작 컨트롤을 사용할 수 없습니다. Voice가 준비된 화면인지 확인하세요.';
}

/**
 * Attempts to find an exact visible Voice-start button. A project request only
 * scans the standard project composer; the separate global action may scan the
 * floating avatar too, but it is never reported as project-bound.
 *
 * Callers still verify a new rollout afterwards; this script returning
 * successfully is not treated as evidence that audio is connected.
 */
export function buildChatGptVoiceStartAppleScript(input: {
  labels: readonly string[];
  attempts?: number;
  initialDelaySeconds?: number;
  /** The global surface is used only by the separate, explicitly requested
   * "전역 Voice 시작" action. It is deliberately never inferred from a
   * project-scoped start request. */
  surface?: ChatGptVoiceStartSurface;
}): string {
  const attempts = Math.max(1, Math.min(60, input.attempts ?? 36));
  const initialDelaySeconds = Math.max(0.25, Math.min(5, input.initialDelaySeconds ?? 1));
  const surface = input.surface ?? 'project-composer';
  const successMarker = surface === 'global'
    ? 'accessibility-global-button'
    : 'accessibility-button';
  const candidatePrefix = appleScriptString(CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX);
  const comparisons = input.labels
    .map((label) => `labelText is ${appleScriptString(label)}`)
    .join(' or ') || 'false';
  const voiceWindowSelection = surface === 'global'
    ? [
      // The floating avatar is a separate Electron window. Exact-label
      // matching below remains mandatory, so the explicit global action cannot
      // press an arbitrary window control.
      '      set voiceWindows to every window',
    ]
    : [
      // The floating Voice avatar also exposes a same-named start button. A
      // project request must only inspect the standard ChatGPT task window;
      // the avatar has no project binding guarantee.
      '      set allVoiceWindows to every window',
      '      set voiceWindows to {}',
      '      repeat with availableVoiceWindow in allVoiceWindows',
      '        set isStandardChatWindow to false',
      '        try',
      '          set isStandardChatWindow to ((subrole of availableVoiceWindow as text) is "AXStandardWindow")',
      '        end try',
      '        if isStandardChatWindow then set end of voiceWindows to availableVoiceWindow',
      '      end repeat',
    ];

  return [
    'on matchesVoiceStartLabel(labelText)',
    `  return ${comparisons}`,
    'end matchesVoiceStartLabel',
    '',
    // Keep diagnostic matching intentionally narrow. It helps distinguish a
    // hidden/renamed Voice control from a missing control without harvesting
    // arbitrary labels from the ChatGPT accessibility tree.
    'on isVoiceDiagnosticText(textValue)',
    '  ignoring case',
    '    if textValue contains "voice" or textValue contains "realtime" or textValue contains "microphone" then return true',
    '  end ignoring',
    '  if textValue contains "음성" or textValue contains "마이크" then return true',
    '  return false',
    'end isVoiceDiagnosticText',
    '',
    'on isInteractiveVoiceRole(roleText)',
    '  return roleText is "AXButton" or roleText is "AXMenuItem" or roleText is "AXPopUpButton" or roleText is "AXCheckBox" or roleText is "AXRadioButton" or roleText is "AXSwitch"',
    'end isInteractiveVoiceRole',
    '',
    // AX labels occasionally contain line breaks or separators. Normalise
    // those and cap the output so the diagnostic remains safe for logs.
    'on compactVoiceDiagnosticText(textValue)',
    '  set compactText to textValue as text',
    '  set savedDelimiters to AppleScript\'s text item delimiters',
    '  try',
    '    set AppleScript\'s text item delimiters to {";", "|", return, linefeed, tab}',
    '    set compactText to text items of compactText',
    '    set AppleScript\'s text item delimiters to " "',
    '    set compactText to compactText as text',
    '    set AppleScript\'s text item delimiters to savedDelimiters',
    '  on error',
    '    set AppleScript\'s text item delimiters to savedDelimiters',
    '    return ""',
    '  end try',
    '  if (count characters of compactText) > 96 then',
    '    set compactText to (characters 1 thru 96 of compactText) as text',
    '    set compactText to compactText & "…"',
    '  end if',
    '  return compactText',
    'end compactVoiceDiagnosticText',
    '',
    'on joinVoiceCandidateDetails(candidateDetails)',
    '  if (count of candidateDetails) is 0 then return "none"',
    '  set savedDelimiters to AppleScript\'s text item delimiters',
    '  try',
    '    set AppleScript\'s text item delimiters to "|"',
    '    set resultText to candidateDetails as text',
    '    set AppleScript\'s text item delimiters to savedDelimiters',
    '    return resultText',
    '  on error',
    '    set AppleScript\'s text item delimiters to savedDelimiters',
    '    return "none"',
    '  end try',
    'end joinVoiceCandidateDetails',
    '',
    'tell application id "com.openai.codex" to activate',
    `delay ${initialDelaySeconds}`,
    'tell application "System Events"',
    '  if UI elements enabled is false then error "VOICE_AUTOMATION_PERMISSION_DENIED"',
    '  set lastAxError to ""',
    '  set voiceCandidateDetails to {}',
    '  set voiceAppProcess to missing value',
    '  if exists application process "ChatGPT" then',
    '    set voiceAppProcess to application process "ChatGPT"',
    '  else if exists application process "Codex" then',
    // `whose bundle identifier is` unexpectedly returns -1728 for the current
    // Electron accessibility process even though the direct property reads as
    // com.openai.codex. The visible process name is stable and queryable.
    '    set voiceAppProcess to application process "Codex"',
    '  end if',
    '  if voiceAppProcess is missing value then error "VOICE_CHATGPT_PROCESS_NOT_FOUND"',
    '  if voiceAppProcess is not missing value then',
    `  repeat with attempt from 1 to ${attempts}`,
    '    tell voiceAppProcess',
    '      set frontmost to true',
    ...voiceWindowSelection,
    '      repeat with voiceWindow in voiceWindows',
    '        try',
    '          tell voiceWindow',
    // `entire contents` is the System Events-recursive AX collection. Do not
    // use `every button of entire contents`: that looks natural but macOS
    // rejects it as a type specifier. Iterate the returned AX elements and
    // press only an exact accessible-label match.
    '          set voiceElements to entire contents',
    '          repeat with voiceElement in voiceElements',
    '            set isVisibleVoiceElement to true',
    '            try',
    '              set isVisibleVoiceElement to visible of voiceElement',
    '            end try',
    '            if isVisibleVoiceElement then',
    '            set nameText to ""',
    '            try',
    '              set nameText to name of voiceElement as text',
    '            end try',
    '            set descriptionText to ""',
    '            try',
    '              set descriptionText to description of voiceElement as text',
    '            end try',
    '            set titleText to ""',
    '            try',
    '              set titleText to title of voiceElement as text',
    '            end try',
    '            set helpText to ""',
    '            try',
    '              set helpText to help of voiceElement as text',
    '            end try',
    '            set roleText to ""',
    '            try',
    '              set roleText to role of voiceElement as text',
    '            end try',
    '            set subroleText to ""',
    '            try',
    '              set subroleText to subrole of voiceElement as text',
    '            end try',
    '            set identifierText to ""',
    '            try',
    '              set identifierText to value of attribute "AXIdentifier" of voiceElement as text',
    '            end try',
    '            set voiceLabels to {{"name", nameText}, {"description", descriptionText}, {"title", titleText}, {"help", helpText}}',
    '            set exactStartLabelFound to false',
    '            set candidateFieldName to ""',
    '            set candidateFieldText to ""',
    '            repeat with voiceLabel in voiceLabels',
    '              set labelFieldName to item 1 of voiceLabel as text',
    '              set labelText to item 2 of voiceLabel as text',
    '              if my matchesVoiceStartLabel(labelText) then set exactStartLabelFound to true',
    '              if candidateFieldName is "" then',
    '                if my matchesVoiceStartLabel(labelText) or my isVoiceDiagnosticText(labelText) then',
    '                  set candidateFieldName to labelFieldName',
    '                  set candidateFieldText to labelText',
    '                end if',
    '              end if',
    '            end repeat',
    '            if candidateFieldName is "" then',
    '              if my isVoiceDiagnosticText(identifierText) then',
    '                set candidateFieldName to "identifier"',
    '                set candidateFieldText to identifierText',
    '              else if my isVoiceDiagnosticText(roleText) or my isVoiceDiagnosticText(subroleText) then',
    '                set candidateFieldName to "role"',
    '                set candidateFieldText to roleText & "/" & subroleText',
    '              end if',
    '            end if',
    '            set isInteractiveControl to my isInteractiveVoiceRole(roleText)',
    '            if candidateFieldName is not "" and isInteractiveControl then',
    '              set candidateDetail to "role=" & my compactVoiceDiagnosticText(roleText) & ",subrole=" & my compactVoiceDiagnosticText(subroleText) & ",field=" & candidateFieldName & ",label=" & my compactVoiceDiagnosticText(candidateFieldText)',
    '              if candidateDetail is not in voiceCandidateDetails then',
    '                if (count of voiceCandidateDetails) < 8 then set end of voiceCandidateDetails to candidateDetail',
    '              end if',
    '            end if',
    // An exact label is necessary but not sufficient. Do not press a partial
    // candidate, a hidden node, or an unrelated static-text child.
    '            if exactStartLabelFound and isInteractiveControl then',
    '              set didPress to false',
    '              try',
    '                perform action "AXPress" of voiceElement',
    '                set didPress to true',
    '              end try',
    '              if didPress is false then',
    '                try',
    '                  click voiceElement',
    '                  set didPress to true',
    '                end try',
    '              end if',
    `              if didPress then return ${appleScriptString(successMarker)}`,
    '            end if',
    '            end if',
    '          end repeat',
    '          end tell',
    '        on error errMsg number errNum',
    '          set lastAxError to errMsg & " (" & errNum & ")"',
    '        end try',
    '      end repeat',
    '    end tell',
    '    delay 0.25',
    '  end repeat',
    '  end if',
    'end tell',
    `if lastAxError is not "" then error "VOICE_AX_ENUMERATION_FAILED: " & lastAxError & ";" & ${candidatePrefix} & my joinVoiceCandidateDetails(voiceCandidateDetails)`,
    `error "VOICE_START_CONTROL_UNAVAILABLE;" & ${candidatePrefix} & my joinVoiceCandidateDetails(voiceCandidateDetails)`,
  ].join('\n');
}

export function classifyChatGptVoiceAutomationError(detail: string): ChatGptVoiceAutomationErrorCode {
  if (/(?:VOICE_AUTOMATION_PERMISSION_DENIED|not authorized|not allowed|not permitted|assistive access|\b-1743\b)/i.test(detail)) {
    return 'VOICE_AUTOMATION_PERMISSION_DENIED';
  }
  if (/(?:VOICE_CHATGPT_PROCESS_NOT_FOUND|\b-1728\b)/i.test(detail)) {
    return 'VOICE_CHATGPT_PROCESS_NOT_FOUND';
  }
  if (/(?:VOICE_AX_ENUMERATION_FAILED|\b-25204\b)/i.test(detail)) {
    return 'VOICE_AX_UNRESPONSIVE';
  }
  return 'VOICE_START_CONTROL_UNAVAILABLE';
}
