import type {VoiceProvider} from './voiceSessionProtocol';

/**
 * Per-device voice preferences (VOC 2026-09-25). Only one voice conversation
 * runs at a time, so OPS and every Workroom share one provider choice. Consent
 * to send audio is remembered per provider after the first explicit check and
 * can be withdrawn from the panel. Broken or unreadable storage falls back to
 * "not chosen / not consented", which only means asking again.
 */
const KEY = 'portmanager-voice-preferences';
type Store = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;
/** Subtitles (VOC 2026-09-29): off, what was said, or what was said plus its translation (default). */
export type VoiceCaptionMode = 'off' | 'original' | 'bilingual';
export type VoiceInteractionMode = 'voice' | 'text';
const MODE_EVENT='agentstoz:conversation-mode';
interface Preferences {provider?: VoiceProvider; consent?: Partial<Record<VoiceProvider, boolean>>; textConsent?: Partial<Record<VoiceProvider, boolean>>; interactionMode?:VoiceInteractionMode; captions?: VoiceCaptionMode; record?: boolean}

const isProvider = (value: unknown): value is VoiceProvider => value === 'openai' || value === 'gemini';

function read(store: Store): Preferences {
  try {
    const parsed = JSON.parse(store?.getItem(KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function write(store: Store, next: Preferences): void {
  try { store?.setItem(KEY, JSON.stringify(next)); } catch { /* Private browsing refuses the write. */ }
}

export function readVoiceProvider(store: Store): VoiceProvider | null {
  const provider = read(store).provider;
  return isProvider(provider) ? provider : null;
}

export function writeVoiceProvider(store: Store, provider: VoiceProvider): void {
  write(store, {...read(store), provider});
}

export function readVoiceConsent(store: Store, provider: VoiceProvider): boolean {
  return read(store).consent?.[provider] === true;
}

export function writeVoiceConsent(store: Store, provider: VoiceProvider, consented: boolean): void {
  const current = read(store);
  write(store, {...current, consent: {...(current.consent ?? {}), [provider]: consented}});
}

/** Existing voice consent already covers typed messages; text consent never permits microphone capture. */
export function readTextConsent(store:Store,provider:VoiceProvider):boolean {
  const preferences=read(store);
  const text=preferences.textConsent?.[provider];return text===undefined?preferences.consent?.[provider]===true:text===true;
}
export function writeTextConsent(store:Store,provider:VoiceProvider,consented:boolean):void {
  const current=read(store);write(store,{...current,textConsent:{...(current.textConsent??{}),[provider]:consented}});
}
export function readVoiceInteractionMode(store:Store):VoiceInteractionMode {return read(store).interactionMode==='text'?'text':'voice';}
export function voiceInteractionModeSnapshot():VoiceInteractionMode {return readVoiceInteractionMode(voicePreferenceStorage());}
export function writeVoiceInteractionMode(store:Store,interactionMode:VoiceInteractionMode):void {
  write(store,{...read(store),interactionMode});
  if(typeof window!=='undefined')window.dispatchEvent(new Event(MODE_EVENT));
}
export function subscribeVoiceInteractionMode(listener:()=>void):()=>void {
  if(typeof window==='undefined')return()=>{};
  window.addEventListener(MODE_EVENT,listener);window.addEventListener('storage',listener);
  return()=>{window.removeEventListener(MODE_EVENT,listener);window.removeEventListener('storage',listener);};
}

export function readVoiceCaptionMode(store: Store): VoiceCaptionMode {
  const mode = read(store).captions;
  return mode === 'off' || mode === 'original' || mode === 'bilingual' ? mode : 'bilingual';
}

export function writeVoiceCaptionMode(store: Store, mode: VoiceCaptionMode): void {
  write(store, {...read(store), captions: mode});
}

/** Whether voice is saved to 내가 한 말 (the panel's checkbox). On unless the person turned it off; the dock follows it. */
export function readVoiceRecord(store: Store): boolean {
  return read(store).record !== false;
}

export function writeVoiceRecord(store: Store, on: boolean): void {
  write(store, {...read(store), record: on});
}

export function voicePreferenceStorage(): Store {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
