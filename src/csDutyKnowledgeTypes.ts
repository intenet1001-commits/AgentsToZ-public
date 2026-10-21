/** Shared DTOs contain no local absolute paths or executable inputs. */
export type DutySource = {
    id: string; kind: 'document' | 'memory'; title: string; hash: string; bytes: number;
    warning?: string;
    unavailable?: boolean;
};
export type DutySourceSelection = { id: string; hash: string };
export type DutySourceBody = DutySource & { body: string };
export type DutyKnowledgeStatus = {
    revision: number; snapshotId: string | null; createdAt: number | null;
    expiresAt: number | null; sourceCount: number; sources: DutySource[];
    state: 'empty' | 'ready' | 'expired' | 'revoked';
};
export type DutyKnowledgeCandidate = {
    id: string; manifestHash: string; sources: DutySource[]; bytes: number;
    changed: number; removed: number; reused: number;
};
export type DutyKnowledgeJob = {
    id: string; state: 'building' | 'ready' | 'failed' | 'cancelled';
    error?: string; candidate?: DutyKnowledgeCandidate;
};
export type DutyEvidence = { id: string; title: string; body: string; score: number };
export type DutyPreview = { answer: string | null; evidence: DutyEvidence[]; aiUsed: boolean; snapshotId: string | null };
export type DutyAnswerContext = { evidence: DutyEvidence[]; snapshotId: string | null };
export const EMPTY_DUTY_KNOWLEDGE: DutyKnowledgeStatus = {
    revision: 0, snapshotId: null, createdAt: null, expiresAt: null, sourceCount: 0, sources: [], state: 'empty',
};
