/**
 * OS credential store for the voice API key.
 *
 * macOS keeps its existing `/usr/bin/security` workflow in `voiceCredentials.ts`
 * (an interactive `-i` command, because the password prompt silently truncates
 * at 128 characters). Windows has no counterpart to that CLI, so it uses
 * `Bun.secrets`, which is backed by the Windows Credential Manager.
 *
 * Measured on Bun 1.3.12 / Windows 11 26100: a set → get → delete round trip
 * returns the stored value exactly.
 *
 * ⚠️ Do not widen `VoiceResponse['keySource']` for this. The wire validator in
 * `voiceSessionProtocol.ts` accepts only `environment | keychain | none`, so a
 * new value would be rejected by every client that has not been updated.
 * `keychain` means "the OS credential store" -- Keychain on macOS, Credential
 * Manager on Windows -- and the UI words it per platform.
 */

export interface VoiceSecretStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<void>;
}

/** Same service/account identity the macOS keychain entry uses. */
export const VOICE_SECRET_SERVICE = 'com.agentstoz.voice.openai.v1';
export const VOICE_SECRET_ACCOUNT = 'realtime';

/** The one shape a stored voice key may have. Shared by write and readback. */
export const VOICE_SECRET_PATTERN = /^[A-Za-z0-9_-]{20,512}$/;

interface BunSecrets {
  get(options: { service: string; name: string }): Promise<string | null | undefined>;
  set(options: { service: string; name: string; value: string }): Promise<unknown>;
  delete(options: { service: string; name: string }): Promise<unknown>;
}

function bunSecrets(): BunSecrets {
  const secrets = (globalThis as { Bun?: { secrets?: BunSecrets } }).Bun?.secrets;
  if (!secrets) throw new Error('이 Bun 런타임에는 자격 증명 저장소가 없습니다.');
  return secrets;
}

/**
 * Credential Manager store. Every write is confirmed by reading the value back,
 * the same discipline the macOS path uses: an apparently successful save that
 * stored nothing would otherwise be reported to the user as configured.
 */
export function createWindowsVoiceSecretStore(
  secrets: BunSecrets = bunSecrets(),
): VoiceSecretStore {
  const identity = { service: VOICE_SECRET_SERVICE, name: VOICE_SECRET_ACCOUNT };
  return {
    get: async () => {
      const value = await secrets.get(identity);
      if (typeof value !== 'string') return null;
      // A stored value that no longer matches the accepted shape is treated as
      // absent rather than handed to the provider.
      return VOICE_SECRET_PATTERN.test(value) ? value : null;
    },
    set: async value => {
      if (!VOICE_SECRET_PATTERN.test(value)) throw new Error('API 키 형식을 확인하세요.');
      await secrets.set({ ...identity, value });
      const readback = await secrets.get(identity);
      if (readback !== value) {
        throw new Error('자격 증명 관리자에 저장한 키가 입력값과 일치하는지 확인하지 못했습니다. 다시 저장하세요.');
      }
    },
    delete: async () => {
      // An absent entry is already the requested end state; only a store that
      // still returns the value after the delete is a failure.
      try { await secrets.delete(identity); } catch { /* fall through to the readback */ }
      const readback = await secrets.get(identity);
      if (typeof readback === 'string' && readback.length > 0) {
        throw new Error('자격 증명 관리자에서 음성 키를 지우지 못했습니다.');
      }
    },
  };
}

/** Platform wording for the place the key is kept. Used in user-facing text only. */
export function voiceSecretStoreName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '자격 증명 관리자' : platform === 'darwin' ? 'Keychain' : 'OS 자격 증명 저장소';
}
