export interface CodexNewConversationIntent {
  scope: string;
  project: string;
  actionId: string;
}

/**
 * Browser-side write-ahead intent for a potentially effectful request.
 * The host still owns the durable receipt; this only remembers which exact ID
 * to retry after the browser or transport loses its response. Nothing stored
 * here is a bearer token, path, account name, or raw project name.
 * Self-contained so the LAN page can embed it with toString().
 */
export function createCodexNewConversationIntentStore(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  randomId: () => string,
  fingerprint: (text: string) => string,
) {
  const storageKey = 'agentstoz-codex-new-intents-v1', limit = 32;
  const failed = () => new Error('새 대화 요청 기록을 저장하거나 확인할 수 없습니다. 브라우저 저장 공간을 확인하세요.');
  const read = (): Record<string, {project: string; actionId: string}> => {
    try {
      const text = storage.getItem(storageKey);
      if (text === null) return {};
      if (text.length > 12_000) throw failed();
      const value = JSON.parse(text);
      if (!value || value.schemaVersion !== 1 || Object.keys(value).sort().join() !== 'entries,schemaVersion'
        || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw failed();
      const entries = Object.entries(value.entries);
      if (entries.length > limit || entries.some(([key, item]) => {
        if (!/^[a-f0-9]{64}$/.test(key) || !item || typeof item !== 'object' || Array.isArray(item)) return true;
        const record = item as Record<string, unknown>;
        return Object.keys(record).sort().join() !== 'actionId,project'
          || typeof record.project !== 'string' || !/^[a-f0-9]{64}$/.test(record.project)
          || typeof record.actionId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(record.actionId);
      })) throw failed();
      return {...value.entries};
    } catch { throw failed(); }
  };
  const save = (entries: Record<string, {project: string; actionId: string}>) => {
    try { storage.setItem(storageKey, JSON.stringify({schemaVersion: 1, entries})); } catch { throw failed(); }
  };
  return {
    inspect(hostId: string, controllerId: string): CodexNewConversationIntent | null {
      if ([hostId, controllerId].some(value => typeof value !== 'string' || !value || value.length > 1000)) throw failed();
      const scope = fingerprint(JSON.stringify([hostId, controllerId]));
      const existing = read()[scope];
      return existing ? {scope, ...existing} : null;
    },
    rebind(intent: CodexNewConversationIntent, projectDescriptor: string, verifiedActionId: string): CodexNewConversationIntent {
      if (!projectDescriptor || projectDescriptor.length > 1000 || verifiedActionId !== intent.actionId) throw failed();
      const entries = read(), current = entries[intent.scope];
      if (!current || current.actionId !== intent.actionId || current.project !== intent.project) throw failed();
      const project = fingerprint(projectDescriptor);
      entries[intent.scope] = {project, actionId: intent.actionId}; save(entries);
      return {scope: intent.scope, project, actionId: intent.actionId};
    },
    reserve(hostId: string, controllerId: string, projectDescriptor: string): CodexNewConversationIntent {
      if ([hostId, controllerId, projectDescriptor].some(value => typeof value !== 'string' || !value || value.length > 1000)) throw failed();
      const scope = fingerprint(JSON.stringify([hostId, controllerId]));
      const project = fingerprint(projectDescriptor);
      const entries = read(), existing = entries[scope];
      if (existing) {
        if (existing.project !== project) throw new Error('이 Mac에 결과를 확인하지 못한 새 대화 요청이 있습니다. 해당 프로젝트의 요청부터 확인하세요.');
        return {scope, ...existing};
      }
      if (Object.keys(entries).length >= limit) throw failed();
      const actionId = randomId();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(actionId)) throw failed();
      entries[scope] = {project, actionId}; save(entries);
      return {scope, project, actionId};
    },
    complete(intent: CodexNewConversationIntent): void {
      const entries = read(), current = entries[intent.scope];
      if (!current || current.actionId !== intent.actionId || current.project !== intent.project) throw failed();
      delete entries[intent.scope]; save(entries);
    },
  };
}

/** A restarted host can assign a different control ID to the same project.
 * Rebind only when that exact authenticated project returns the saved request ID. */
export async function reserveVerifiedCodexNewIntent(input: {
  store: ReturnType<typeof createCodexNewConversationIntentStore>;
  hostId: string;
  controllerId: string;
  projectControlId: string;
  fingerprint: (text: string) => string;
  reviewExact(actionId: string): Promise<{actionId: string} | null>;
  cancelMissing?(actionId: string): Promise<boolean>;
}): Promise<CodexNewConversationIntent | null> {
  const existing = input.store.inspect(input.hostId, input.controllerId);
  if (!existing || existing.project === input.fingerprint(input.projectControlId)) {
    return input.store.reserve(input.hostId, input.controllerId, input.projectControlId);
  }
  const receipt = await input.reviewExact(existing.actionId);
  if (!receipt && input.cancelMissing && await input.cancelMissing(existing.actionId)) {
    input.store.complete(existing);
    return null;
  }
  if (!receipt || receipt.actionId !== existing.actionId) {
    throw new Error('이전에 보낸 새 대화 요청의 프로젝트를 확인할 수 없습니다. Mac의 해당 프로젝트에서 결과를 확인하세요.');
  }
  return input.store.rebind(existing, input.projectControlId, receipt.actionId);
}
