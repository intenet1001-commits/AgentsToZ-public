/** One allowlist shared by the endpoint and its boundary tests. */
export const DUTY_OPERATIONS: Record<string, readonly string[]> = {
    createConnection: ['operation','targetId','chatId','chatTitle'],
    revealChat: ['operation', 'targetId'],
    status: ['operation', 'targetId'], diagnose: ['operation', 'targetId'], discover: ['operation', 'targetId'],
    documents: ['operation', 'targetId'], documentText: ['operation', 'targetId', 'paths'],
    save: ['operation', 'targetId', 'config'], enable: ['operation', 'targetId', 'revision', 'knowledgeRevision', 'consent'], disable: ['operation', 'targetId'],
    sources: ['operation', 'targetId', 'includeMemory'],
    sourcePreview: ['operation', 'targetId', 'selection', 'includeMemory'],
    prepareKnowledge: ['operation', 'targetId', 'selections', 'includeMemory', 'revision'],
    knowledgeJob: ['operation', 'targetId'], cancelKnowledgeJob: ['operation', 'targetId'],
    candidatePreview: ['operation', 'targetId', 'candidateId', 'sourceId'],
    applyKnowledge: ['operation', 'targetId', 'candidateId', 'manifestHash', 'revision', 'configRevision', 'consent'],
    revokeKnowledge: ['operation', 'targetId'], checkKnowledgeUpdates: ['operation', 'targetId'],
    previewAnswer: ['operation', 'targetId', 'question', 'generate'],
};
export function validDutyOperation(body: unknown): body is { operation: string; targetId: string; [key: string]: any } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.targetId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(b.targetId) || typeof b.operation !== 'string' || !Object.hasOwn(DUTY_OPERATIONS, b.operation)) return false;
    if (Object.keys(b).sort().join() !== [...DUTY_OPERATIONS[b.operation]!].sort().join()) return false;
    if ('includeMemory' in b && typeof b.includeMemory !== 'boolean') return false;
    if ('knowledgeRevision' in b && (!Number.isSafeInteger(b.knowledgeRevision) || (b.knowledgeRevision as number) < 0)) return false;
    if ('generate' in b && typeof b.generate !== 'boolean') return false;
    if ('revision' in b && (!Number.isSafeInteger(b.revision) || (b.revision as number) < 0)) return false;
    return true;
}
