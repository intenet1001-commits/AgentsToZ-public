import {MOBILE_WORKSPACE_SCOPE_LABELS,type MobileWorkspaceScope} from './mobileWorkspaceProtocol';
import {REMOTE_HISTORY_SCOPES,type RemoteHistoryScope} from './workroomHistoryRemoteProtocol';

/**
 * The permissions the person last granted a phone on this Mac, offered again for the next phone's approval.
 *
 * 2026-11-01: approving a phone meant ticking the workroom grant, choosing its scope, ticking every feature
 * (including the ones 「기능 전체 선택」 deliberately leaves out) and the Codex conversation box, one by one,
 * on every new pairing. The person asked for it to be one step next time. This only PRE-SELECTS what they
 * chose themselves before: nothing is granted until they read the 6-digit code and press approve, the card
 * says the boxes were pre-selected, and one button clears them. A preference, not a secret — local storage.
 */
export const INTERNET_APPROVAL_PRESET_KEY = 'agentstoz.internet-remote.approval-preset.v1';

export interface InternetApprovalPreset {
  workroom: boolean;
  /** A `workroomApprovalOptions` value (a project, a worktree, a root or ALL_WORKROOM_TARGETS). */
  scope: string;
  workspaceScopes: MobileWorkspaceScope[];
  historyScopes: RemoteHistoryScope[];
  conversation: boolean;
  task: boolean;
}

export type InternetApprovalPresetPatch = Partial<InternetApprovalPreset>;

const KNOWN_WORKSPACE = new Set<string>(Object.keys(MOBILE_WORKSPACE_SCOPE_LABELS));
const KNOWN_HISTORY = new Set<string>(REMOTE_HISTORY_SCOPES);

function uniqueKnown<T extends string>(value: unknown, known: Set<string>): T[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is T => typeof item === 'string' && known.has(item)))];
}

/** Strict read: anything malformed or unknown is dropped, never guessed into a grant. */
export function parseInternetApprovalPreset(raw: string | null | undefined): InternetApprovalPreset | null {
  if (!raw || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scope = typeof record.scope === 'string' && record.scope.length <= 512 ? record.scope : '';
  const preset: InternetApprovalPreset = {
    workroom: record.workroom === true,
    scope,
    workspaceScopes: uniqueKnown<MobileWorkspaceScope>(record.workspaceScopes, KNOWN_WORKSPACE),
    historyScopes: uniqueKnown<RemoteHistoryScope>(record.historyScopes, KNOWN_HISTORY),
    conversation: record.conversation === true,
    task: record.task === true,
  };
  return hasAnyGrant(preset) ? preset : null;
}

function hasAnyGrant(preset: InternetApprovalPreset): boolean {
  return preset.workroom || preset.conversation || preset.task;
}

type PresetStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function presetStorage(): PresetStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readInternetApprovalPreset(storage: PresetStorage | null = presetStorage()): InternetApprovalPreset | null {
  try { return parseInternetApprovalPreset(storage?.getItem(INTERNET_APPROVAL_PRESET_KEY)); } catch { return null; }
}

/**
 * Merge what was just saved into the remembered set. An approval writes every field; a later save on an
 * approved phone (workroom scope and features, or the Codex boxes) updates only its own fields.
 */
export function rememberInternetApproval(
  patch: InternetApprovalPresetPatch,
  storage: PresetStorage | null = presetStorage(),
): InternetApprovalPreset | null {
  const base = readInternetApprovalPreset(storage)
    ?? { workroom: false, scope: '', workspaceScopes: [], historyScopes: [], conversation: false, task: false };
  const merged = parseInternetApprovalPreset(JSON.stringify({ ...base, ...patch }));
  try {
    if (merged) storage?.setItem(INTERNET_APPROVAL_PRESET_KEY, JSON.stringify(merged));
    else storage?.removeItem(INTERNET_APPROVAL_PRESET_KEY);
  } catch { /* A refused write only costs the convenience next time. */ }
  return merged;
}

export interface InternetApprovalPrefill extends InternetApprovalPreset {
  /** The remembered workroom scope is no longer offered on this Mac: the person picks one again. */
  scopeMissing: boolean;
}

/** What to pre-select on a new pending phone. A scope that disappeared is left blank, never substituted. */
export function prefillFromPreset(
  preset: InternetApprovalPreset | null,
  options: readonly { value: string }[],
  taskExecutionEnabled: boolean,
): InternetApprovalPrefill | null {
  if (!preset) return null;
  const scopeOffered = preset.workroom && options.some(option => option.value === preset.scope);
  return {
    ...preset,
    scope: scopeOffered ? preset.scope : '',
    scopeMissing: preset.workroom && !scopeOffered,
    workspaceScopes: preset.workroom ? preset.workspaceScopes : [],
    historyScopes: preset.workroom ? preset.historyScopes : [],
    // The production gate can close after it was remembered: never pre-select what this build cannot grant.
    task: taskExecutionEnabled && preset.task,
  };
}

/** One line for the card, so pre-selected boxes are never a surprise. */
export function describeInternetApprovalPrefill(
  prefill: InternetApprovalPrefill,
  options: readonly { value: string; label: string }[],
): string {
  const parts: string[] = [];
  if (prefill.workroom) {
    const label = options.find(option => option.value === prefill.scope)?.label;
    parts.push(label ? `워크룸(${label})` : '워크룸(범위는 다시 선택)');
    if (prefill.workspaceScopes.length) parts.push(`모바일 기능 ${prefill.workspaceScopes.length}개`);
    if (prefill.historyScopes.length) parts.push(`대화 기록 ${prefill.historyScopes.length}개`);
  }
  if (prefill.conversation) parts.push('지속형 Codex 대화');
  if (prefill.task) parts.push('Codex 작업');
  return `지난번 승인과 같은 권한을 미리 골라 두었습니다: ${parts.join(' · ')}. 코드를 확인하고 승인해야 적용됩니다.`;
}
