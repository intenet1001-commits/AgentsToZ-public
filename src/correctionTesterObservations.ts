import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, lstatSync, openSync, readSync} from 'node:fs';
import {isAbsolute, join} from 'node:path';
import {
  CORRECTION_OUTCOME_PROTOCOL, type CorrectionExposureUnit, type CorrectionObservation, type CorrectionOutcomeProtocol,
} from './projectMemoryCorrectionOutcome';

/**
 * Independent signal 3 (S4-06): deterministic tester-check outcomes for a correction a human bound to manifest checks.
 *
 * Reads only what the project tester already writes — the tail of `.agentstoz/maintainer/history-v1.jsonl` and the
 * current `.agentstoz/maintainer.json` — and never runs a test. A passing check proves the artifact, not the agent's
 * behaviour, so the observation is labelled 'tester-check' and still goes through the same classifier.
 *
 * Verdicts, per bound check:
 * - repeated: a run inside the window (after the binding) failed with the source unchanged during the run.
 * - avoided:  a run inside the window passed, the source fingerprint changed since the last run before the exposure,
 *             and the comparison key (config/runner/dependencies) did not.
 * - nothing:  no earlier run, a changed comparison key, a skipped or quarantined check, a check whose pinned digest
 *             differs from the bind-time one, or unreadable files.
 *
 * What the bind-time digest pins, and what it does not: the check's maintainer.json entry, plus the bytes of the
 * regular files its argv names inside the root (up to 8, each ≤1 MiB; a symlink is pinned as a link, never read
 * through). Pinning the named file matters because a changed source fingerprint is exactly what 'avoided' requires —
 * editing the test body alone would otherwise score. It does NOT pin a directory the argv names, files the test
 * imports (helpers, fixtures, the code under test), or the history rows — `.agentstoz/maintainer/history-v1.jsonl`
 * lives in the project folder the workroom agent can write, and its rows are not authenticated. So 'avoided' from this
 * source is weak evidence: an agent that edits an imported helper, or simply appends a row, can produce it. The label
 * keeps it apart from a human attestation; it is not proof the agent did not score its own work.
 *
 * One run is one observation: the binding covers the whole scope, so the observer credits a run only to the latest
 * eligible unit whose window contains it, and to none when units of more than one session apply (the same rule as a
 * re-correction, see CorrectionOutcomeObserver).
 */
export const CORRECTION_TESTER_HISTORY_MAX_BYTES = 256 * 1024;
export const CORRECTION_TESTER_MANIFEST_MAX_BYTES = 1024 * 1024;
const HISTORY = ['.agentstoz', 'maintainer', 'history-v1.jsonl'];
const MANIFEST = ['.agentstoz', 'maintainer.json'];
const SKIPPED = new Set(['budget-skipped', 'not-applicable']);

export interface TesterHistoryRow {
  at: string;
  runId: string;
  profile: string | null;
  id: string;
  state: string;
  reasonClass: string | null;
  fingerprint: string | null;
  sourceUnchanged: boolean | null;
  comparisonKey: string | null;
}
/** `digest` is computed on first read (it reads the files the argv names), so listing checks reads no test files. */
export interface TesterManifestCheck {readonly digest: string; quarantined: boolean}
export const CORRECTION_TESTER_PINNED_FILES_MAX = 8;
export const CORRECTION_TESTER_PINNED_FILE_MAX_BYTES = 1024 * 1024;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};
/** The definition digest of one manifest check: any change to it (argv, status, paths…) changes the digest. */
export const testerCheckDefinitionDigest = (check: unknown) => createHash('sha256').update(JSON.stringify(canonical(check))).digest('hex');

/** Every path component under the root must be a real directory or file — a planted symlink is refused, not followed. */
function assertNoSymlink(root: string, parts: string[]) {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('테스터 기록 경로에 심볼릭 링크가 있어 읽지 않습니다.');
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('테스터 기록 경로를 확인하세요.');
  }
  return path;
}

function readTail(path: string, maxBytes: number): {text: string; truncated: boolean} {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const size = fstatSync(fd).size, length = Math.min(size, maxBytes), buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n <= 0) break;
      read += n;
    }
    return {text: buffer.subarray(0, read).toString('utf8'), truncated: size > length};
  } finally { closeSync(fd); }
}

const optionalText = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' && value.length <= 512 ? value : undefined;

/**
 * Digests of the regular files a check's argv names inside the root, as `path:marker` lines. A token is a candidate only
 * when it is relative, has no `..` segment and exists; directories and missing tokens (`bun`, `test`, flags) are
 * skipped. A symlink — anywhere on the path — is pinned as `link`, never followed, so its target cannot reach the digest
 * and swapping a file for a link changes it. Unreadable or oversized files are pinned by a stable marker.
 */
function pinnedFileLines(root: string, check: unknown): string[] {
  const argv = check && typeof check === 'object' && Array.isArray((check as {argv?: unknown}).argv) ? (check as {argv: unknown[]}).argv : [];
  const lines: string[] = [], seen = new Set<string>();
  for (const raw of argv) {
    if (lines.length >= CORRECTION_TESTER_PINNED_FILES_MAX) break;
    if (typeof raw !== 'string') continue;
    const token = raw.startsWith('{root}/') ? raw.slice('{root}/'.length) : raw;
    if (!token || token.length > 512 || token.startsWith('-') || token.includes('\0') || isAbsolute(token)) continue;
    const parts = token.split(/[\\/]+/).filter(part => part && part !== '.');
    if (!parts.length || parts.includes('..')) continue;
    const rel = parts.join('/');
    if (seen.has(rel)) continue;
    let marker: string | null = null, path = root;
    try {
      for (const [index, part] of parts.entries()) {
        path = join(path, part);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { marker = 'link'; break; }
        if (index < parts.length - 1) { if (!stat.isDirectory()) break; continue; }
        if (!stat.isFile()) break;
        if (stat.size > CORRECTION_TESTER_PINNED_FILE_MAX_BYTES) { marker = `too-large:${stat.size}`; break; }
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const size = Math.min(fstatSync(fd).size, CORRECTION_TESTER_PINNED_FILE_MAX_BYTES + 1), buffer = Buffer.alloc(size);
          let read = 0;
          while (read < size) { const n = readSync(fd, buffer, read, size - read, read); if (n <= 0) break; read += n; }
          marker = read > CORRECTION_TESTER_PINNED_FILE_MAX_BYTES ? `too-large:${read}` : createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
        } finally { closeSync(fd); }
      }
    } catch (error: any) {
      marker = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : 'unreadable';
    }
    if (marker === null) continue;
    seen.add(rel);
    lines.push(`${rel}:${marker}`);
  }
  return lines;
}

/**
 * The bind-time pin of one check: its definition digest, extended with the files its argv names. A check that names no
 * file keeps exactly its definition digest.
 */
export function testerCheckPinnedDigest(root: string, check: unknown) {
  const definition = testerCheckDefinitionDigest(check), files = pinnedFileLines(root, check);
  return files.length ? createHash('sha256').update([definition, ...files].join('\n')).digest('hex') : definition;
}

/** Rows from the last ≤256 KiB of the history. A missing file is no rows; malformed lines are skipped. */
export function readTesterHistoryTail(root: string, maxBytes = CORRECTION_TESTER_HISTORY_MAX_BYTES): TesterHistoryRow[] {
  let path: string;
  try { path = assertNoSymlink(root, HISTORY); } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const {text, truncated} = readTail(path, maxBytes);
  const lines = text.split('\n');
  if (truncated) lines.shift(); // The first line may start mid-row.
  const rows: TesterHistoryRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const at = raw.at, fingerprint = optionalText(raw.fingerprint), comparisonKey = optionalText(raw.comparisonKey);
    const reasonClass = optionalText(raw.reasonClass), profile = optionalText(raw.profile);
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof raw.runId !== 'string' || !raw.runId || raw.runId.length > 128
      || typeof raw.id !== 'string' || !raw.id || raw.id.length > 128 || typeof raw.state !== 'string'
      || fingerprint === undefined || comparisonKey === undefined || reasonClass === undefined || profile === undefined
      || !(raw.sourceUnchanged === null || raw.sourceUnchanged === undefined || typeof raw.sourceUnchanged === 'boolean')) continue;
    rows.push({at, runId: raw.runId, profile, id: raw.id, state: raw.state, reasonClass, fingerprint,
      sourceUnchanged: typeof raw.sourceUnchanged === 'boolean' ? raw.sourceUnchanged : null, comparisonKey});
  }
  return rows;
}

/** The current manifest's checks with their pinned digests (computed lazily). Throws when the manifest is missing or unreadable. */
export function readTesterManifestChecks(root: string): Map<string, TesterManifestCheck> {
  const path = assertNoSymlink(root, MANIFEST);
  const {text, truncated} = readTail(path, CORRECTION_TESTER_MANIFEST_MAX_BYTES);
  if (truncated) throw new Error('테스터 설정 파일이 너무 큽니다.');
  const manifest = JSON.parse(text);
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.checks)) throw new Error('테스터 설정 형식을 확인하세요.');
  const checks = new Map<string, TesterManifestCheck>();
  for (const check of manifest.checks) {
    if (!check || typeof check !== 'object' || typeof check.id !== 'string' || !check.id || checks.has(check.id)) continue;
    let digest: string | null = null;
    checks.set(check.id, {get digest() { return digest ??= testerCheckPinnedDigest(root, check); }, quarantined: check.status === 'quarantined'});
  }
  return checks;
}

/** Pure verdict rules (see the module comment). At most one observation per bound check; a failure wins over a pass. */
export function testerCheckObservations(
  unit: Pick<CorrectionExposureUnit, 'unitId' | 'writtenAt'>,
  binding: {checks: readonly {id: string; digest: string}[]; boundAt: string},
  rows: readonly TesterHistoryRow[],
  current: ReadonlyMap<string, TesterManifestCheck>,
  protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL,
): Extract<CorrectionObservation, {source: 'tester-check'}>[] {
  if (!unit.writtenAt) return [];
  const start = Date.parse(unit.writtenAt), end = start + protocol.windowMs, from = Math.max(start, Date.parse(binding.boundAt));
  if (!Number.isFinite(start) || !Number.isFinite(from)) return [];
  const out: Extract<CorrectionObservation, {source: 'tester-check'}>[] = [];
  for (const check of binding.checks) {
    const definition = current.get(check.id);
    if (!definition || definition.digest !== check.digest || definition.quarantined) continue;
    const own = rows.filter(row => row.id === check.id).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const pre = own.filter(row => Date.parse(row.at) < start).at(-1) ?? null;
    const post = own.filter(row => {
      const at = Date.parse(row.at);
      return at >= from && at <= end && row.sourceUnchanged === true && !SKIPPED.has(row.reasonClass ?? '')
        && (!pre || row.comparisonKey === pre.comparisonKey);
    });
    const observe = (row: TesterHistoryRow, verdict: 'avoided' | 'repeated') =>
      out.push({source: 'tester-check', unitId: unit.unitId, checkId: check.id, verdict, runId: row.runId, at: row.at});
    const failed = post.find(row => row.state === 'failed');
    if (failed) { observe(failed, 'repeated'); continue; }
    if (!pre?.fingerprint) continue;
    const passed = post.find(row => row.state === 'passed' && !!row.fingerprint && row.fingerprint !== pre.fingerprint && row.comparisonKey === pre.comparisonKey);
    if (passed) observe(passed, 'avoided');
  }
  return out;
}

/**
 * IO wrapper for the observer: reads the history tail and manifest of `root` once per tick (cached in `tick`), then
 * applies the rules. Unreadable files give no signal.
 */
export function correctionTesterObservationsFor(
  root: string,
  unit: CorrectionExposureUnit,
  binding: {checks: readonly {id: string; digest: string}[]; boundAt: string},
  tick: Map<string, unknown>,
  protocol: CorrectionOutcomeProtocol = CORRECTION_OUTCOME_PROTOCOL,
) {
  const key = 'tester:' + root;
  if (!tick.has(key)) {
    let value: {rows: TesterHistoryRow[]; checks: Map<string, TesterManifestCheck>} | null = null;
    try { value = {rows: readTesterHistoryTail(root), checks: readTesterManifestChecks(root)}; } catch { value = null; }
    tick.set(key, value);
  }
  const files = tick.get(key) as {rows: TesterHistoryRow[]; checks: Map<string, TesterManifestCheck>} | null;
  return files ? testerCheckObservations(unit, binding, files.rows, files.checks, protocol) : [];
}
