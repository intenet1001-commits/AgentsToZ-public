import { basename } from 'node:path';
import {
  resolveRegisteredProjectMemory,
  type RegisteredProjectMemoryCandidate,
} from './projectMemoryProjectResolver';

export interface RegisteredAgentRuntimeTargetCandidate extends RegisteredProjectMemoryCandidate {
  aiName?: string | null;
}

export type AgentRuntimeTargetResolution =
  | {
      ok: true;
      targetId: string;
      projectLabel: string;
      /** Internal-only canonical registered working directory. */
      cwd: string;
    }
  | {
      ok: false;
      code: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' | 'TARGET_INVALID';
      error: string;
    };

const TARGET_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function safeLabel(value: unknown, fallback: string): string {
  const cleaned = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return (cleaned || fallback || '프로젝트').slice(0, 120);
}

/**
 * Resolves only an opaque persisted row id. It never accepts a path from the
 * caller; the selected row's current path is canonicalized again immediately
 * before execution.
 */
export function resolveRegisteredAgentRuntimeTarget(
  targetIdInput: string,
  registered: readonly RegisteredAgentRuntimeTargetCandidate[],
): AgentRuntimeTargetResolution {
  const targetId = typeof targetIdInput === 'string' ? targetIdInput.trim() : '';
  if (!TARGET_ID_RE.test(targetId)) {
    return { ok: false, code: 'TARGET_INVALID', error: '프로젝트 식별자가 올바르지 않습니다.' };
  }
  const exactRows = registered.filter(candidate => candidate?.id === targetId);
  if (exactRows.length === 0) {
    return { ok: false, code: 'TARGET_NOT_FOUND', error: '현재 등록된 프로젝트를 찾지 못했습니다.' };
  }
  if (exactRows.length > 1) {
    return { ok: false, code: 'TARGET_AMBIGUOUS', error: '같은 식별자의 등록 프로젝트가 여러 개입니다.' };
  }
  const selected = exactRows[0]!;
  // A generated worktree row can retain both fields for compatibility. The
  // runtime must execute in the selected worktree, not silently fall back to
  // the main checkout merely because folderPath is listed first.
  const requestedPath = typeof selected.worktreePath === 'string' && selected.worktreePath.trim()
    ? selected.worktreePath.trim()
    : typeof selected.folderPath === 'string'
      ? selected.folderPath.trim()
      : '';
  const resolution = resolveRegisteredProjectMemory(
    requestedPath,
    registered,
    undefined,
    { requireInitialized: false },
  );
  if (!resolution.ok) {
    return {
      ok: false,
      code: resolution.code === 'PROJECT_AMBIGUOUS' ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
      error: resolution.code === 'PROJECT_AMBIGUOUS'
        ? '등록 프로젝트의 실행 폴더를 하나로 확정하지 못했습니다.'
        : '등록 프로젝트의 실행 폴더를 확인하지 못했습니다.',
    };
  }
  return {
    ok: true,
    targetId,
    projectLabel: safeLabel(selected.aiName, safeLabel(selected.name, basename(resolution.requestedPath))),
    cwd: resolution.requestedPath,
  };
}
