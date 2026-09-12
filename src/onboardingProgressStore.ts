import { Database, constants as sqlite } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { OnboardingPlatform, OnboardingToolDiagnostic } from './onboardingInfrastructure';
import { parseOnboardingProgress, preparationEvidence, preparationSelection, type OnboardingProgress,
  type PreparationTool } from './onboardingProgress';

/** Preparation progress only. No commands, credentials or caller-supplied completion evidence. */
export class OnboardingProgressStore {
  protected db: Database;
  constructor(directory: string) {
    const folder = join(directory, 'onboarding');
    mkdirSync(folder, {recursive: true, mode: 0o700});
    const info = lstatSync(folder);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32' && info.uid !== process.getuid?.())) throw new Error('ONBOARDING_STORAGE_UNSAFE');
    if (process.platform !== 'win32') chmodSync(folder, 0o700);
    const file = join(realpathSync(folder), 'progress-v1.sqlite');
    if (!existsSync(file)) {
      try { const fd = openSync(file, 'wx', 0o600); closeSync(fd); }
      catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) throw new Error('ONBOARDING_STORAGE_UNSAFE');
    if (process.platform !== 'win32') chmodSync(file, 0o600);
    this.db = new Database(file, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW);
    try {
      const opened = lstatSync(file);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.isSymbolicLink()) throw new Error('ONBOARDING_STORAGE_UNSAFE');
      this.db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
      const schema = this.db.query('PRAGMA user_version').get() as {user_version: number};
      if (schema.user_version > 1) throw new Error('ONBOARDING_SCHEMA_UNSUPPORTED');
      this.db.exec('CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); PRAGMA user_version=1;');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  read(): OnboardingProgress | null {
    const row = this.db.query('SELECT body FROM progress WHERE id=1').get() as {body: string} | null;
    if (!row) return null;
    if (row.body.length > 16384) throw new Error('ONBOARDING_PROGRESS_UNREADABLE');
    return parseOnboardingProgress(JSON.parse(row.body));
  }
  private edit(expected: string, fn: (current: OnboardingProgress | null) => OnboardingProgress): OnboardingProgress {
    return this.db.transaction(() => {
      const current = this.read();
      if ((current?.revision ?? '0') !== expected) throw new Error('ONBOARDING_REVISION_CONFLICT');
      const result = parseOnboardingProgress(fn(current));
      this.db.query('INSERT INTO progress(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(result));
      return result;
    }).immediate();
  }
  plan(expected: string, platform: OnboardingPlatform, selected: unknown): OnboardingProgress {
    const tools = preparationSelection(selected);
    return this.edit(expected, current => {
      if (current?.operation && Date.now() - Date.parse(current.operation.startedAt) < 30000) throw new Error('ONBOARDING_CHECK_RUNNING');
      const now = new Date().toISOString();
      return {schemaVersion: 1, recipeVersion: 1, revision: randomUUID(), runId: current?.runId ?? randomUUID(),
        platform, steps: tools.map(tool => current?.platform === platform
          ? current.steps.find(s => s.tool === tool) ?? {tool, state: 'pending', checkedAt: null}
          : {tool, state: 'pending', checkedAt: null}), operation: null, updatedAt: now};
    });
  }
  defer(expected: string, tool: PreparationTool, deferred: boolean): OnboardingProgress {
    return this.edit(expected, current => {
      if (!current || !current.steps.some(s => s.tool === tool)) throw new Error('ONBOARDING_INVALID_INPUT');
      if (current.operation) throw new Error('ONBOARDING_CHECK_RUNNING');
      return {...current, revision: randomUUID(), updatedAt: new Date().toISOString(), steps: current.steps.map(s => s.tool === tool
        ? {...s, state: deferred ? 'deferred' : 'pending', checkedAt: null} : s)};
    });
  }
  beginCheck(expected: string): OnboardingProgress {
    return this.edit(expected, current => {
      if (!current) throw new Error('ONBOARDING_INVALID_INPUT');
      if (current.operation && Date.now() - Date.parse(current.operation.startedAt) < 30000) throw new Error('ONBOARDING_CHECK_RUNNING');
      const now = new Date().toISOString();
      return {...current, revision: randomUUID(), operation: {id: randomUUID(), startedAt: now}, updatedAt: now};
    });
  }
  finishCheck(started: OnboardingProgress, diagnostics: OnboardingToolDiagnostic[]): OnboardingProgress {
    return this.edit(started.revision, current => {
      if (!current || !started.operation || current.operation?.id !== started.operation.id) throw new Error('ONBOARDING_REVISION_CONFLICT');
      const now = new Date().toISOString();
      return {...current, revision: randomUUID(), operation: null, updatedAt: now,
        steps: current.steps.map(s => s.state === 'deferred' ? s : {
          tool: s.tool, state: preparationEvidence(s.tool, diagnostics.find(d => d.id === s.tool)), checkedAt: now,
        })};
    });
  }
}
