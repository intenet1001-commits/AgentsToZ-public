/**
 * Why a voice session recognized nothing (2026-10-08: an iPhone headset session ran 30 s with zero
 * utterances and zero replies, and nothing said which layer stopped). Two halves, counts only — never
 * what was said:
 *  - the host counts what the provider reported (speech detected, transcripts done/failed, replies);
 *  - the phone measures what the microphone delivered, and says so on screen while it is happening.
 */

export interface VoiceInputStats { speechStarted: number; transcribed: number; transcriptFailed: number; responses: number }

export function emptyVoiceInputStats(): VoiceInputStats {
  return { speechStarted: 0, transcribed: 0, transcriptFailed: 0, responses: 0 };
}

export function countVoiceInputEvent(stats: VoiceInputStats, e: Record<string, unknown>): void {
  switch (e.type) {
    case 'input_audio_buffer.speech_started': stats.speechStarted += 1; break;
    case 'conversation.item.input_audio_transcription.completed': stats.transcribed += 1; break;
    case 'conversation.item.input_audio_transcription.failed': stats.transcriptFailed += 1; break;
    case 'response.done': stats.responses += 1; break;
  }
}

/** One sidecar log line per session. The session id is shortened; no text, no device names. */
export function voiceInputStatsLine(sessionId: string, provider: string, durationMs: number, stats: VoiceInputStats): string {
  const verdict = stats.speechStarted === 0 && stats.transcribed === 0
    ? ' — no speech detected (check the microphone input on the phone)'
    : stats.transcribed === 0 ? ' — speech detected but nothing transcribed' : '';
  return `[Voice] ${sessionId.slice(0, 14)} ${provider} ${Math.round(durationMs / 1000)}s: speech ${stats.speechStarted}, transcribed ${stats.transcribed}, failed ${stats.transcriptFailed}, replies ${stats.responses}${verdict}`;
}

export type VoiceInputHint = 'no-signal' | 'no-speech' | null;

/**
 * What the phone should say about its microphone while listening, from what it measured itself.
 * `peak` is the loudest meter reading (0–1) since listening began, `loudMs` how long the meter stayed above
 * a speaking level. Quiet for the first seconds is normal — the person may not have started talking.
 */
export function voiceInputHint(input: { listeningMs: number; peak: number; loudMs: number; speechSeen: boolean }): VoiceInputHint {
  if (input.speechSeen || input.listeningMs < 8_000) return null;
  if (input.peak < 0.03) return 'no-signal';
  if (input.loudMs >= 1_500) return 'no-speech';
  return null;
}

export function voiceInputHintText(hint: VoiceInputHint, device: string): string {
  const mic = device ? `마이크(${device})` : '마이크';
  if (hint === 'no-signal') return `${mic}에서 소리가 들어오지 않습니다. 헤드셋 마이크 연결을 확인하거나, 헤드셋을 빼고 휴대폰 마이크로 시도해 보세요.`;
  if (hint === 'no-speech') return `${mic}로 소리는 들어오지만 말소리로 인식되지 않습니다. 마이크에 조금 더 가까이 또렷하게 말해 보세요.`;
  return '';
}
