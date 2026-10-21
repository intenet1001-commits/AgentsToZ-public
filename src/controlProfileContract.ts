export const CONTROL_PROFILE_VERSION = 1;
export const CONTROL_PROFILE_ALIASES = ['agentstoz', '아젠투지', '에이전츠투지'] as const;
export const CONTROL_PROFILE_HEADER = 'X-AgentsToZ-Control-Profile';
export const CONTROL_PROFILE_CONTROLLER = 'agentstoz-profile';
export const CONTROL_PROFILE_PRIVATE_PATH = '.agentstoz-private/control-bootstrap.json';
export const CONTROL_PROFILE_MARKER = '.agentstoz-control-profile.json';
export const CONTROL_PROFILE_CORE = 'AgentsToZ is your cross-project operating profile. Recall the relevant operating memory, resolve registered project IDs, and use each target project’s own memory for implementation. Keep live work in missions/Workroom. A memory candidate is not a completed save.';
export type ControlProfileSync = {state:'not-configured'|'current'|'needs-attention';lastCheckedAt:string|null;problem:string|null};
export type ControlProfileStatus = {
  state: 'unprepared' | 'preparing' | 'ready' | 'needs-attention';
  profileId: string | null; memoryId: string | null; displayName: 'AgentsToZ';
  aliases: readonly string[]; projectId: string | null; revision: string | null;
  lastSavedAt: string | null; problem: string | null; pendingCount: number;
  backend: 'control-folder' | 'app-data' | null;
  coordinationPolicy: 'agentstoz' | 'cs-ceo';
  sync?: ControlProfileSync;
};
export function addressedAgentsToZ(text: string): {request: string} | null {
  const normalized = text.normalize('NFKC').trim();
  const match = /^(?:[/$]?agentstoz|아젠투지|에이전츠투지)(?=$|[\s,:，：!！])(?:[\s,:，：!！]*)([\s\S]*)$/i.exec(normalized);
  return match ? {request: match[1] ?? ''} : null;
}
export class ControlProfileError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function controlProfileText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max || /\0/.test(value))
    throw new ControlProfileError('CONTROL_PROFILE_INPUT_INVALID', '입력 크기와 내용을 확인하세요.', 400);
  return value.trim();
}
export function controlProfileId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new ControlProfileError('CONTROL_PROFILE_ID_INVALID', '프로필 또는 기억 식별자가 올바르지 않습니다.');
  return value.toLowerCase();
}
