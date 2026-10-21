/**
 * Recovering from a project creation that failed after its folder existed.
 *
 * Creation quarantines a partially-built project by moving it to
 * `<root>/.agentstoz-failed/<name>-<ts>`. On POSIX that move always succeeds.
 * ⚠️ On Windows `rename` fails with EPERM while **any handle is still open
 * inside the directory** (measured on Windows 11 26100: empty / with a file /
 * after `git init` all moved fine; with one open descriptor it failed and the
 * folder stayed). The failure is swallowed to preserve the original error, so
 * the folder survived — and because registration never happened, every retry
 * then died on "같은 이름의 폴더가 작업 루트에 이미 있습니다" while
 * `existingOpsControlCenter()` could not see it either. A dead end with no way
 * out from the UI; that is exactly how `AgentsToZ OPS · 0` got stuck.
 *
 * So an attempt records itself, and a later attempt may reclaim a folder that
 * its own record names. ⚠️ A folder with no record is never touched: a
 * directory of the same name may be the user's own work.
 *
 * ⚠️ The record lives in app data, never inside the project folder. A marker
 * file inside it was committed by the initial snapshot and then deleted,
 * leaving a brand-new repository dirty (`D .agentstoz-creating.json`) — which
 * is the state this function's own comment warns immediately blocks the
 * worktree safety gate. An in-flight attempt is app state, not project content.
 */

/** Directory under the app data root holding one record per in-flight attempt. */
export const CREATION_ATTEMPT_DIRECTORY = 'project-creation';

export interface CreationAttempt {
  schemaVersion: 1;
  /** Project id this attempt intended to register. */
  projectId: string;
  /** Folder the attempt was building. Compared to decide what may be reclaimed. */
  folderPath: string;
  startedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function creationAttempt(projectId: string, folderPath: string, now = new Date()): CreationAttempt {
  return { schemaVersion: 1, projectId, folderPath, startedAt: now.toISOString() };
}

/** File name for one attempt. The project id is a UUID, so it needs no escaping. */
export function creationAttemptFileName(projectId: string): string {
  if (!UUID.test(projectId)) throw new Error('creation attempt id must be a UUID');
  return `${projectId}.json`;
}

/**
 * One attempt record, or null. Anything unparsable, oversized, or carrying an
 * unexpected field is treated as absent so a stray file can never authorize
 * touching a directory.
 */
export function parseCreationAttempt(raw: unknown): CreationAttempt | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempt = value as CreationAttempt;
  if (attempt.schemaVersion !== 1) return null;
  if (typeof attempt.projectId !== 'string' || !UUID.test(attempt.projectId)) return null;
  if (typeof attempt.folderPath !== 'string' || attempt.folderPath.length === 0 || attempt.folderPath.length > 4096) return null;
  if (typeof attempt.startedAt !== 'string' || !Number.isFinite(Date.parse(attempt.startedAt))) return null;
  if (Object.keys(attempt).sort().join(',') !== 'folderPath,projectId,schemaVersion,startedAt') return null;
  return attempt;
}

/** Same folder, ignoring a trailing separator and (Windows) letter case. */
export function isSameFolderPath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  // Case is folded only where the file system ignores it (Windows, default macOS). On case-sensitive Linux a stale
  // record for `Foo` would otherwise let a retry move the user's own `foo` aside.
  const insensitive = platform === 'win32' || platform === 'darwin';
  const folded = (value: string) => { const trimmed = value.replace(/[/\\]+$/, ''); return insensitive ? trimmed.toLowerCase() : trimmed; };
  return folded(left) === folded(right);
}

/**
 * The attempt that was building `folderPath`, or null.
 */
export function findCreationAttempt(
  records: readonly (string | null)[],
  folderPath: string,
): CreationAttempt | null {
  for (const raw of records) {
    const attempt = parseCreationAttempt(raw);
    if (attempt && isSameFolderPath(attempt.folderPath, folderPath)) return attempt;
  }
  return null;
}

/**
 * Whether a leftover folder may be reclaimed.
 *
 * Both conditions are required. The record proves this app created the folder,
 * and the absence of a registration proves the attempt never reached its commit
 * point — a registered project is live data and must never be moved out from
 * under the project list.
 */
export function canReclaimCreationLeftover(input: {
  attempt: CreationAttempt | null;
  registeredProjectIds: readonly string[];
  registeredFolderPaths: readonly string[];
  folderPath: string;
}): boolean {
  if (!input.attempt) return false;
  if (input.registeredProjectIds.includes(input.attempt.projectId)) return false;
  return !input.registeredFolderPaths.some(path => isSameFolderPath(path, input.folderPath));
}

/**
 * Message for a folder that exists and cannot be used. The old text named no
 * path, so a user facing the dead end had nothing to act on.
 */
export function creationFolderExistsMessage(folderPath: string, reclaimable: boolean): string {
  return reclaimable
    ? `이전 생성 시도가 남긴 폴더를 정리하지 못했습니다. 그 폴더를 사용하는 프로그램을 닫은 뒤 다시 시도하세요: ${folderPath}`
    : `같은 이름의 폴더가 작업 루트에 이미 있습니다: ${folderPath}`;
}
