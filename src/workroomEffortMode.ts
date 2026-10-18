/** Shared Workroom preference; it never changes the selected model or provider. */
export const WORKROOM_EFFORT_MODES = ['auto', 'recommend', 'off'] as const;
export type WorkroomEffortMode = typeof WORKROOM_EFFORT_MODES[number];
export const WORKROOM_EFFORT_MODE_LABELS: Record<WorkroomEffortMode, string> = {auto: '자동선택', recommend: '추천제공', off: '미선택'};
export function isWorkroomEffortMode(value: unknown): value is WorkroomEffortMode {
  return (WORKROOM_EFFORT_MODES as readonly unknown[]).includes(value);
}
