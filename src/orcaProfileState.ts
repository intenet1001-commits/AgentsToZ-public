import {Database} from 'bun:sqlite';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Orca's persisted workspace session (provider session → pane/tab/worktree), read-only.
 *
 * Orca 1.4 moved its profile state from `orca-data.json` into the SQLite `profile-state.db` (one row per top-level
 * domain; `profile_state_meta.legacy_json_acceptance` records the JSON revision it adopted). After that the JSON is
 * never written again — on the 1호 Mac it stopped on 2026-10-13 — so every Orca pane opened later had no provider
 * binding in it, and the context list called those live terminals `gone` (and 「창으로 이동」 refused them).
 * When the database exists it is the only answer; the JSON answers only for an Orca that predates it. (Orca's own
 * rollback to JSON removes the database files.)
 *
 * Never opened writable and never created: a read-only connection does not checkpoint Orca's WAL.
 */
export type OrcaWorkspaceSessionState =
  | {kind: 'ok'; source: 'sqlite' | 'json'; state: unknown}
  | {kind: 'unavailable'};

export const ORCA_PROFILE_DATABASE = 'profile-state.db';
export const ORCA_PROFILE_LEGACY_JSON = 'orca-data.json';

function readDatabase(path: string): unknown {
  let database: Database | null = null;
  try {
    database = new Database(path, {readonly: true, create: false});
    const row = database.query("SELECT payload FROM profile_state_documents WHERE domain = 'workspaceSession'")
      .get() as {payload: unknown} | null;
    if (typeof row?.payload !== 'string') return null;
    // The legacy JSON nests the same document under `workspaceSession`; keep that shape for the binding lookup.
    return {workspaceSession: JSON.parse(row.payload)};
  } finally {
    database?.close();
  }
}

export function readOrcaWorkspaceSessionState(profileDir: string): OrcaWorkspaceSessionState {
  const databasePath = join(profileDir, ORCA_PROFILE_DATABASE), jsonPath = join(profileDir, ORCA_PROFILE_LEGACY_JSON);
  if (existsSync(databasePath)) {
    // A database that cannot be read never falls back to the JSON: a frozen file would turn live terminals `gone`.
    try { const state = readDatabase(databasePath); return state ? {kind: 'ok', source: 'sqlite', state} : {kind: 'unavailable'}; }
    catch { return {kind: 'unavailable'}; }
  }
  try { return {kind: 'ok', source: 'json', state: JSON.parse(readFileSync(jsonPath, 'utf8'))}; }
  catch { return {kind: 'unavailable'}; }
}
