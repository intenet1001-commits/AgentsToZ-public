import { useSyncExternalStore } from 'react';
import { phoneIsOnline } from './phoneNetwork';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** The phone's network state, re-rendering on 'online'/'offline'. The rule lives in `phoneIsOnline`. */
export function usePhoneOnline(): boolean {
  return useSyncExternalStore(subscribe, () => phoneIsOnline(), () => true);
}
