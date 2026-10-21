import {isTauri} from './lib/env';

/**
 * Bring the hidden main window forward (receiving OPS work, the voice window's device choice). A main-only
 * Rust command (`reveal_main_window`) so the main capability needs no `core:window:allow-show/allow-set-focus`.
 * Outside the app there is no window to reveal.
 */
export async function revealMainWindow():Promise<void>{
  if(!isTauri())return;
  const {invoke}=await import('@tauri-apps/api/core');
  await invoke('reveal_main_window');
}
