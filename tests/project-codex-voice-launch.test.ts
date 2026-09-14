import { describe, expect, test } from 'bun:test';
import {
  buildChatGptVoiceStartAppleScript,
  CHATGPT_GLOBAL_VOICE_START_LABELS,
  CHATGPT_NEW_VOICE_START_LABELS,
  CHATGPT_RESUME_VOICE_START_LABELS,
  CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX,
  classifyChatGptVoiceAutomationError,
  describeChatGptVoiceAutomationFailure,
  extractChatGptVoiceCandidateDiagnostic,
} from '../src/projectCodexVoiceLaunch';

describe('ChatGPT Voice launch automation', () => {
  test('uses the exact new-chat and resume controls shipped by English and Korean ChatGPT', () => {
    expect(CHATGPT_NEW_VOICE_START_LABELS).toEqual([
      'Start new voice chat',
      '새 음성 채팅 시작',
    ]);
    expect(CHATGPT_RESUME_VOICE_START_LABELS).toEqual([
      'Start voice chat',
      '음성 채팅 시작',
    ]);
    expect(CHATGPT_GLOBAL_VOICE_START_LABELS).toEqual([
      'Start new voice chat',
      '새 음성 채팅 시작',
      'Resume voice chat',
      '음성 채팅 재개',
    ]);
  });

  test('presses only an exact, visible and interactive new-chat control without synthesizing a global hotkey', () => {
    const script = buildChatGptVoiceStartAppleScript({
      labels: CHATGPT_NEW_VOICE_START_LABELS,
      attempts: 2,
      initialDelaySeconds: 0.75,
    });

    expect(script).toContain('if UI elements enabled is false then error "VOICE_AUTOMATION_PERMISSION_DENIED"');
    expect(script).toContain('set allVoiceWindows to every window');
    expect(script).toContain('set isStandardChatWindow to ((subrole of availableVoiceWindow as text) is "AXStandardWindow")');
    expect(script).toContain('tell voiceWindow');
    expect(script).toContain('set voiceElements to entire contents');
    expect(script).not.toContain('every button of entire contents');
    expect(script).toContain('application process "ChatGPT"');
    expect(script).toContain('application process "Codex"');
    expect(script).not.toContain('whose bundle identifier');
    expect(script).toContain('"Start new voice chat"');
    expect(script).toContain('"새 음성 채팅 시작"');
    expect(script).toContain('title of voiceElement as text');
    expect(script).toContain('help of voiceElement as text');
    expect(script).toContain('value of attribute "AXIdentifier" of voiceElement as text');
    expect(script).toContain('set isVisibleVoiceElement to visible of voiceElement');
    expect(script).toContain('set isInteractiveControl to my isInteractiveVoiceRole(roleText)');
    expect(script).toContain('if candidateFieldName is not "" and isInteractiveControl then');
    expect(script).toContain('if exactStartLabelFound and isInteractiveControl then');
    expect(script).toContain('perform action "AXPress" of voiceElement');
    expect(script).not.toContain('parent of voiceElement');
    expect(script).not.toContain('actions of voiceElement');
    expect(script).toContain(CHATGPT_VOICE_CANDIDATE_DIAGNOSTIC_PREFIX);
    expect(script).toContain('VOICE_START_CONTROL_UNAVAILABLE;');
    expect(script).toContain('VOICE_AX_ENUMERATION_FAILED');
    expect(script).toContain('return "accessibility-button"');
    expect(script).toContain('repeat with attempt from 1 to 2');
    expect(script).toContain('delay 0.75');
    expect(script).not.toContain('key code ');
    expect(script).not.toContain('default-hotkey');
  });

  test('uses every visible ChatGPT window only for the separately requested global Voice action', () => {
    const script = buildChatGptVoiceStartAppleScript({
      labels: CHATGPT_GLOBAL_VOICE_START_LABELS,
      surface: 'global',
      attempts: 2,
    });

    expect(script).toContain('set voiceWindows to every window');
    expect(script).not.toContain('set allVoiceWindows to every window');
    expect(script).toContain('"Resume voice chat"');
    expect(script).toContain('"음성 채팅 재개"');
    expect(script).toContain('return "accessibility-global-button"');
    expect(script).toContain('if exactStartLabelFound and isInteractiveControl then');
  });

  test('uses the resume-specific label and never uses a synthetic global hotkey', () => {
    const script = buildChatGptVoiceStartAppleScript({
      labels: CHATGPT_RESUME_VOICE_START_LABELS,
    });

    expect(script).toContain('"Start voice chat"');
    expect(script).toContain('"음성 채팅 시작"');
    expect(script).toContain('perform action "AXPress" of voiceElement');
    expect(script).not.toContain('key code ');
    expect(script).not.toContain('default-hotkey');
    expect(script).toContain('error "VOICE_START_CONTROL_UNAVAILABLE;"');
  });

  test('classifies macOS automation-permission failures separately from a missing Voice button', () => {
    expect(classifyChatGptVoiceAutomationError('System Events got an error: Not authorized to send Apple events. (-1743)'))
      .toBe('VOICE_AUTOMATION_PERMISSION_DENIED');
    expect(classifyChatGptVoiceAutomationError('Accessibility permission not allowed'))
      .toBe('VOICE_AUTOMATION_PERMISSION_DENIED');
    expect(classifyChatGptVoiceAutomationError('No matching Voice control was found'))
      .toBe('VOICE_START_CONTROL_UNAVAILABLE');
    expect(classifyChatGptVoiceAutomationError('VOICE_CHATGPT_PROCESS_NOT_FOUND (-1728)'))
      .toBe('VOICE_CHATGPT_PROCESS_NOT_FOUND');
    expect(classifyChatGptVoiceAutomationError('VOICE_AX_ENUMERATION_FAILED (-25204)'))
      .toBe('VOICE_AX_UNRESPONSIVE');
  });

  test('extracts only compact AX candidate diagnostics and keeps them out of the user-facing failure', () => {
    const raw = '273:345: execution error: VOICE_START_CONTROL_UNAVAILABLE;VOICE_AX_CANDIDATES=role=AXButton,subrole=,field=name,label=Voice settings|role=AXButton,subrole=,field=identifier,label=realtimeVoice (-2700)';

    expect(extractChatGptVoiceCandidateDiagnostic(raw)).toBe(
      'role=AXButton,subrole=,field=name,label=Voice settings|role=AXButton,subrole=,field=identifier,label=realtimeVoice',
    );
    expect(extractChatGptVoiceCandidateDiagnostic('VOICE_START_CONTROL_UNAVAILABLE;VOICE_AX_CANDIDATES=none (-2700)'))
      .toBeNull();
    expect(describeChatGptVoiceAutomationFailure(
      'VOICE_START_CONTROL_UNAVAILABLE',
      raw,
    )).not.toContain('AXButton');
    expect(describeChatGptVoiceAutomationFailure(
      'VOICE_AUTOMATION_PERMISSION_DENIED',
      'VOICE_AUTOMATION_PERMISSION_DENIED',
    )).toBe('ChatGPT Voice 자동화 권한을 확인하지 못했습니다.');
  });
});
