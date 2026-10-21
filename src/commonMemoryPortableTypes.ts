import type {MetaCommonMemory,MetaMemorySummary} from './metaCommonMemoryContract';
export type PortableCommonKnowledge={schemaVersion:1;snapshot:MetaCommonMemory;current:MetaCommonMemory;sourceFingerprint:string;importedAt:string};
export type PortableCommonKnowledgeSummary=MetaMemorySummary;
