/**
 * A Workroom entry that only selects a session — no prompt of its own — may ask to leave the new-task composer alone
 * (`keepDraft`). Selecting a conversation the phone just resumed from its history must not wipe a request the person
 * is still writing there; target and AI stay too, so that draft still starts where it was written. Anything else
 * applies as before.
 */
export function entryKeepsComposerDraft(entry: { keepDraft?: boolean; sessionId?: string; prompt?: string }, prompt: string, title: string): boolean {
  return !!entry.keepDraft && !!entry.sessionId && !entry.prompt && (prompt.trim() !== '' || title.trim() !== '');
}
