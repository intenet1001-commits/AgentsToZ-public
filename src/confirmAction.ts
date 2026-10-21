let pending = false;

/** Browser confirm is synchronous; Tauri's dialog plugin returns a promise at runtime.
 * Only an explicit affirmative reply authorizes an action. Concurrent requests are declined,
 * so a second click cannot queue another native prompt while the first one is unanswered.
 */
export async function confirmAction(message: string): Promise<boolean> {
  if (pending || typeof window === 'undefined') return false;
  pending = true;
  try {
    return (await window.confirm(message)) === true;
  } catch {
    return false;
  } finally {
    pending = false;
  }
}
