/**
 * The iPhone app's 「이 앱의 연결 정보 지우기」 asks the portal (`window.agentstozDisconnect`) to end its Mac
 * connections, then deletes the page's whole store. Revoking only the Mac on screen left every other paired Mac
 * holding this phone as an approved controller, with nothing left on the phone to end it. So: tell every Mac at
 * once, give up waiting after a bound (the app waits 10 s for the page), and always forget each one locally — a
 * revoke that did not answer is unconfirmed, never reported as done.
 */
export const REMOTE_HOST_REVOKE_ALL_TIMEOUT_MS = 8_000;

export interface RevokeEveryRemoteHostResult { total: number; confirmed: number }

export async function revokeEveryRemoteHost(hostIds: readonly string[], options: {
  revoke: (hostId: string) => Promise<void>;
  forget: (hostId: string) => void | Promise<void>;
  timeoutMs?: number;
}): Promise<RevokeEveryRemoteHostResult> {
  const unique = [...new Set(hostIds)];
  const timeoutMs = options.timeoutMs ?? REMOTE_HOST_REVOKE_ALL_TIMEOUT_MS;
  const answered = await Promise.all(unique.map(hostId => new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Promise.resolve().then(() => options.revoke(hostId)).then(
      () => { clearTimeout(timer); resolve(true); },
      () => { clearTimeout(timer); resolve(false); },
    );
  })));
  for (const hostId of unique) {
    try { await options.forget(hostId); } catch { /* one Mac's local cleanup must not keep the others */ }
  }
  return { total: unique.length, confirmed: answered.filter(Boolean).length };
}
