import { createHash } from 'node:crypto';

import {
  AGENT_RUNTIME_TARGET_LIST_LIMIT,
  type AgentRuntimeTarget,
  type AgentRuntimeTargetScope,
} from './agentRuntimeApiContract';

export interface AgentRuntimeRegisteredTargetInput {
  targetId: string;
  label: string;
  /** Internal-only canonical directory. */
  cwd: string;
  scopeHint: AgentRuntimeTargetScope;
  parentTargetId: string | null;
}

export interface AgentRuntimeDiscoveredWorktreeInput {
  /** Internal-only canonical directory reported by Git porcelain. */
  cwd: string;
  branch: string | null;
  isMain: boolean;
  locked: boolean;
}

export interface AgentRuntimeDiscoveredFamilyInput {
  projectTargetId: string;
  worktrees: AgentRuntimeDiscoveredWorktreeInput[];
}

export interface AgentRuntimeInternalTarget extends AgentRuntimeTarget {
  /** Never serialize this field into an HTTP response. */
  cwd: string;
}

export interface AgentRuntimeTargetInventory {
  targets: AgentRuntimeInternalTarget[];
  complete: boolean;
}

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function compareTarget(left: AgentRuntimeInternalTarget, right: AgentRuntimeInternalTarget): number {
  return left.label.localeCompare(right.label, 'ko')
    || (left.scope === right.scope ? 0 : left.scope === 'main' ? -1 : 1)
    || (left.branch ?? '').localeCompare(right.branch ?? '', 'ko')
    || left.targetId.localeCompare(right.targetId);
}

function worktreeLabel(parentLabel: string, branch: string | null): string {
  const suffix = branch?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    || '분리된 워크트리';
  return `${parentLabel} · ${suffix}`.slice(0, 120);
}

/**
 * Stable only while the exact Git worktree path remains registered. Moving or
 * removing a worktree changes/invalidates the ID, forcing execution to resolve
 * the current Git inventory again instead of trusting a stale client path.
 */
export function deriveAgentRuntimeWorktreeTargetId(
  projectTargetId: string,
  canonicalWorktreeDirectory: string,
): string {
  const digest = createHash('sha256')
    .update('agentstoz-runtime-worktree-v1\0')
    .update(projectTargetId)
    .update('\0')
    .update(pathKey(canonicalWorktreeDirectory))
    .digest('hex');
  return `rwt_${digest.slice(0, 48)}`;
}

/**
 * Joins persisted project rows with Git-owned worktree evidence. Persisted
 * worktree rows are admitted only when the current porcelain inventory still
 * contains their exact canonical directory. Unregistered linked worktrees get
 * a deterministic opaque ID; their directory never crosses the HTTP boundary.
 */
export function buildAgentRuntimeTargetInventory(input: {
  registered: readonly AgentRuntimeRegisteredTargetInput[];
  families: readonly AgentRuntimeDiscoveredFamilyInput[];
  discoveryComplete: boolean;
}): AgentRuntimeTargetInventory {
  const registeredById = new Map(input.registered.map(target => [target.targetId, target]));
  const gitFamilyIds = new Set(input.families
    .filter(family => family.worktrees.length > 0)
    .map(family => family.projectTargetId));
  let complete = input.discoveryComplete;
  const discoveryByDirectory = new Map<string, {
    projectTargetId: string;
    worktree: AgentRuntimeDiscoveredWorktreeInput;
  }>();
  const ambiguousDiscoveryDirectories = new Set<string>();
  for (const family of input.families) {
    if (!registeredById.has(family.projectTargetId)) continue;
    for (const worktree of family.worktrees) {
      const key = pathKey(worktree.cwd);
      if (ambiguousDiscoveryDirectories.has(key)) continue;
      const previous = discoveryByDirectory.get(key);
      if (previous && (previous.projectTargetId !== family.projectTargetId
        || previous.worktree.branch !== worktree.branch
        || previous.worktree.isMain !== worktree.isMain
        || previous.worktree.locked !== worktree.locked)) {
        discoveryByDirectory.delete(key);
        ambiguousDiscoveryDirectories.add(key);
        complete = false;
        continue;
      }
      discoveryByDirectory.set(key, {
        projectTargetId: family.projectTargetId,
        worktree,
      });
    }
  }

  const targets: AgentRuntimeInternalTarget[] = [];
  const targetIds = new Set<string>();
  const targetByDirectory = new Map<string, AgentRuntimeInternalTarget>();

  for (const registered of input.registered) {
    const registeredDirectory = pathKey(registered.cwd);
    if (ambiguousDiscoveryDirectories.has(registeredDirectory)) continue;
    const discovery = discoveryByDirectory.get(registeredDirectory);
    // A row that claims worktree provenance is only an execution target while
    // Git still reports that exact non-main linked checkout.
    if (registered.scopeHint === 'worktree'
      && (!discovery || discovery.worktree.isMain)) continue;
    const scope: AgentRuntimeTargetScope = discovery && !discovery.worktree.isMain
      ? 'worktree'
      : registered.scopeHint;
    // Persisted provenance is only a hint. Git is the authority for the
    // checkout family, and a disagreement must not route the management UI to
    // one project while execution occurs inside another project's checkout.
    if (scope === 'worktree' && discovery
      && registered.parentTargetId
      && registered.parentTargetId !== discovery.projectTargetId) {
      complete = false;
      continue;
    }
    const projectTargetId = scope === 'main'
      ? registered.targetId
      : discovery?.projectTargetId ?? registered.targetId;
    const target: AgentRuntimeInternalTarget = {
      targetId: registered.targetId,
      projectTargetId,
      label: registered.label,
      scope,
      branch: discovery?.worktree.branch ?? null,
      locked: discovery?.worktree.locked ?? false,
      worktreeCapable: scope === 'worktree' || gitFamilyIds.has(projectTargetId),
      cwd: registered.cwd,
    };
    if (targetIds.has(target.targetId)) {
      complete = false;
      continue;
    }
    targetIds.add(target.targetId);
    targets.push(target);
    targetByDirectory.set(pathKey(target.cwd), target);
  }

  for (const family of input.families) {
    const parent = registeredById.get(family.projectTargetId);
    if (!parent) {
      complete = false;
      continue;
    }
    for (const worktree of family.worktrees) {
      if (worktree.isMain
        || ambiguousDiscoveryDirectories.has(pathKey(worktree.cwd))
        || targetByDirectory.has(pathKey(worktree.cwd))) continue;
      const targetId = deriveAgentRuntimeWorktreeTargetId(family.projectTargetId, worktree.cwd);
      // A malicious/corrupt persisted ID must not shadow an independently
      // derived worktree authority. Omit the ambiguous target and report the
      // inventory as incomplete instead of inventing another identifier.
      if (targetIds.has(targetId) || registeredById.has(targetId)) {
        complete = false;
        continue;
      }
      const target: AgentRuntimeInternalTarget = {
        targetId,
        projectTargetId: family.projectTargetId,
        label: worktreeLabel(parent.label, worktree.branch),
        scope: 'worktree',
        branch: worktree.branch,
        locked: worktree.locked,
        worktreeCapable: true,
        cwd: worktree.cwd,
      };
      targetIds.add(targetId);
      targets.push(target);
      targetByDirectory.set(pathKey(target.cwd), target);
    }
  }

  targets.sort(compareTarget);
  if (targets.length > AGENT_RUNTIME_TARGET_LIST_LIMIT) {
    targets.length = AGENT_RUNTIME_TARGET_LIST_LIMIT;
    complete = false;
  }
  return { targets, complete };
}
