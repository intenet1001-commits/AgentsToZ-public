import type {WorkroomEffortLevel} from './workroomEffortPolicy';

/** Browser-safe (no node imports): the levels agentstoz_use_set_workroom_effort accepts. Logic: src/workroomEffortChoice.ts. */
export const WORKROOM_EFFORT_CHOICE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly WorkroomEffortLevel[];
export type WorkroomEffortChoiceLevel = WorkroomEffortLevel | 'auto';
