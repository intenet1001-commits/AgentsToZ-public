export const ORCHESTRATION_MISSION_SCHEMA_VERSION = 1;

export const ORCHESTRATION_MISSION_STATES = [
  "active", "paused", "interrupted", "completed",
] as const;
export type OrchestrationMissionState = typeof ORCHESTRATION_MISSION_STATES[number];

export const ORCHESTRATION_PROJECT_ROLES = ["source", "target", "participant"] as const;
export type OrchestrationProjectRole = typeof ORCHESTRATION_PROJECT_ROLES[number];

export const ORCHESTRATION_EVENT_KINDS = [
  "mission-created", "mission-resumed", "mission-paused", "mission-interrupted",
  "mission-completed", "project-bound", "workroom-started", "instruction-sent",
  "utterance-linked", "result-verified", "memory-candidate-created",
] as const;
export type OrchestrationEventKind = typeof ORCHESTRATION_EVENT_KINDS[number];

export interface OrchestrationMission {
  id: string;
  title: string;
  goal: string;
  state: OrchestrationMissionState;
  createdAt: string;
  updatedAt: string;
  checkpoint: string | null;
}

export interface OrchestrationMissionEvent {
  id: string;
  missionId: string;
  kind: OrchestrationEventKind;
  occurredAt: string;
  requestId: string;
  projectIds: string[];
  /** Bounded orchestration fact. Never raw prompt or terminal output. */
  summary: string;
  whatISaidEventId: string | null;
}

export class OrchestrationMissionModelError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OrchestrationMissionModelError"; }
}

function fail(code: string): never { throw new OrchestrationMissionModelError(code); }
function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail("MISSION_INPUT_INVALID");
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if ((!allowEmpty && !normalized) || Buffer.byteLength(normalized, "utf8") > max) fail("MISSION_INPUT_INVALID");
  return normalized;
}
function id(value: unknown, prefix?: string): string {
  const normalized = text(value, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized) || (prefix && !normalized.startsWith(prefix))) fail("MISSION_INPUT_INVALID");
  return normalized;
}

export function normalizeMissionCreate(input: unknown): { title: string; goal: string; requestId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MISSION_INPUT_INVALID");
  const row = input as Record<string, unknown>;
  return { title: text(row.title, 240), goal: text(row.goal, 4_000), requestId: id(row.requestId) };
}

export function normalizeMissionEvent(input: unknown): Omit<OrchestrationMissionEvent, "id" | "occurredAt"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("MISSION_INPUT_INVALID");
  const row = input as Record<string, unknown>;
  const kind = text(row.kind, 64) as OrchestrationEventKind;
  if (!ORCHESTRATION_EVENT_KINDS.includes(kind)) fail("MISSION_INPUT_INVALID");
  if (!Array.isArray(row.projectIds) || row.projectIds.length > 16) fail("MISSION_INPUT_INVALID");
  const projectIds = [...new Set(row.projectIds.map(value => id(value)))].sort();
  const whatISaidEventId = row.whatISaidEventId == null ? null : id(row.whatISaidEventId, "wis_");
  if (whatISaidEventId !== null && !/^wis_[0-9a-f]{64}$/.test(whatISaidEventId)) fail("MISSION_INPUT_INVALID");
  return {
    missionId: id(row.missionId, "mission_"), kind, requestId: id(row.requestId),
    projectIds, summary: text(row.summary, 2_000),
    whatISaidEventId,
  };
}

export function nextMissionState(current: OrchestrationMissionState, event: OrchestrationEventKind): OrchestrationMissionState {
  if (event === "mission-resumed" && (current === "paused" || current === "interrupted")) return "active";
  if (event === "mission-paused" && current === "active") return "paused";
  if (event === "mission-interrupted" && current === "active") return "interrupted";
  if (event === "mission-completed" && (current === "active" || current === "paused" || current === "interrupted")) return "completed";
  if (["project-bound", "workroom-started", "instruction-sent", "utterance-linked", "result-verified", "memory-candidate-created"].includes(event) && current === "active") return current;
  fail("MISSION_STATE_TRANSITION_INVALID");
}

export function projectMemoryRecipients(input: {
  mentionedProjectIds: string[];
  changedProjectIds: string[];
  decisionProjectIds: string[];
  verifiedResultProjectIds: string[];
}): string[] {
  const affected = new Set([...input.changedProjectIds, ...input.decisionProjectIds, ...input.verifiedResultProjectIds]);
  return [...affected].filter(projectId => input.mentionedProjectIds.includes(projectId)).sort();
}
