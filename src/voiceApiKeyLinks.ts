import type {VoiceProvider} from './voiceSessionProtocol';

/**
 * Official key-issuance pages, opened through `openPreferredBrowser` so the user's
 * chosen browser handles them -- a plain `<a target="_blank">` can do nothing in a
 * Tauri webview.
 *
 * ⚠️ The OpenAI URL cannot be liveness-checked from a build machine:
 * platform.openai.com answers 403 to every path for a non-browser client
 * (measured -- a real page and a nonsense path both returned 403), so a probe
 * there proves nothing either way. The Gemini URL measured 200 following
 * redirects on 2026-10-03.
 */
export const VOICE_API_KEY_PAGES:Record<VoiceProvider,string>={
  openai:'https://platform.openai.com/api-keys',
  gemini:'https://aistudio.google.com/apikey',
};
