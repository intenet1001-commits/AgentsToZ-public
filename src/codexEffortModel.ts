import {readFileSync, statSync, existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {TEAM_CODEX_EXTRA_EFFORT_MODELS, TEAM_CODEX_LMH_MODELS, teamCodexEffortLevels} from './teamEffortCatalog';

/**
 * Codex rejects a reasoning effort its model does not offer («Reasoning effort `X` is not supported for model `Y`»),
 * so 「에포트 자동」 (w16) passes `-c model_reasoning_effort` only when the model is proven to be a catalog model.
 * The catalog is Codex's own model metadata (src/teamEffortCatalog.ts: `~/.codex/models_cache.json` of codex-cli 0.163.0,
 * re-read 2026-10-28, which lists this Mac's configured default `gpt-6.1-terra`); every catalog model offers low, medium
 * and high, and auto never chooses anything else. Anything unproven — another model, provider, profile, catalog file, base URL, a
 * launch argument that picks a model, a line we cannot parse, a file we cannot read — answers `ok:false` (no flag).
 * `launchModel` is the `-m` the app itself passes (a team member's chosen model): it replaces every config `model`, so
 * it is the one proven against the catalog, while the provider, profile, catalog and base-URL checks still apply.
 *
 * Read-only and bounded: the same files `codexHooksAreAgentsToZOnly` reads (`$CODEX_HOME/config.toml`, each
 * `.codex/config.toml` from the working folder up to the repository root) plus the legacy managed config. Only the
 * top-level keys before the first `[table]` are read; each file at most 64 KiB.
 */

export const CODEX_EFFORT_CONFIG_MAX_BYTES = 64 * 1024;
const LMH: readonly WorkroomEffortLevel[] = ['low', 'medium', 'high'];
/** Model-specific proven levels. The automatic classifier itself still chooses only low, medium or high. */
export const CODEX_EFFORT_CATALOG: Readonly<Record<string, readonly WorkroomEffortLevel[]>> =
  Object.fromEntries([...TEAM_CODEX_EXTRA_EFFORT_MODELS, ...TEAM_CODEX_LMH_MODELS].map(model => [model, teamCodexEffortLevels(model)!]));
export const CODEX_MANAGED_CONFIG_PATH = '/etc/codex/managed_config.toml';

export type CodexEffortUnknown = 'model' | 'provider' | 'profile' | 'catalog' | 'base-url' | 'launch-args' | 'unparsed' | 'unreadable';
export type CodexEffortModel = {ok: true; model: string | null; allowed: readonly WorkroomEffortLevel[]} | {ok: false; why: CodexEffortUnknown};

export interface CodexEffortConfigFiles {
  /** The file's text, null when it does not exist; throws when it exists but cannot be read (or is too large). */
  read(path: string): string | null;
  /** The folder that ends the upward walk (Codex's project root marker). */
  isRepositoryRoot(dir: string): boolean;
}
const realFiles: CodexEffortConfigFiles = {
  read(path) {
    let size: number;
    try { const stat = statSync(path); if (!stat.isFile()) throw new Error('not a file'); size = stat.size; }
    catch (error: any) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; throw error; }
    if (size > CODEX_EFFORT_CONFIG_MAX_BYTES) throw new Error('config too large');
    const text = readFileSync(path, 'utf8');
    if (Buffer.byteLength(text) > CODEX_EFFORT_CONFIG_MAX_BYTES) throw new Error('config too large');
    return text;
  },
  isRepositoryRoot: dir => existsSync(join(dir, '.git')),
};

/** Keys that decide which model (and so which efforts) Codex runs. */
const MODEL_KEYS = ['model', 'model_provider', 'profile', 'model_catalog_json', 'oss_provider', 'openai_base_url'] as const;
type ModelKey = (typeof MODEL_KEYS)[number];

/**
 * The model-deciding top-level keys of a config.toml. Scanning stops at the first table header; a multi-line string
 * or array value is skipped as a whole so a `[` inside it is not taken for a header. A model-deciding key whose value
 * is not a plain one-line string is listed in `unparsed` (the caller treats it as unknown).
 */
export function codexTopLevelConfig(toml: string): {values: Partial<Record<ModelKey, string>>; unparsed: ModelKey[]} {
  const values: Partial<Record<ModelKey, string>> = {}, unparsed: ModelKey[] = [];
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.replace(/^["']|["']$/g, '');
    const value = m[2]!;
    // Skip a value that continues on later lines.
    const triple = /^("""|''')/.exec(value);
    if (triple && !value.slice(3).includes(triple[1]!)) { while (++i < lines.length && !lines[i]!.includes(triple[1]!)); }
    else if (/^[[{]/.test(value)) {
      let depth = 0;
      const count = (text: string) => { for (const ch of text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '')) { if (ch === '[' || ch === '{') depth++; else if (ch === ']' || ch === '}') depth--; } };
      count(value.replace(/#.*$/, ''));
      while (depth > 0 && ++i < lines.length) count(lines[i]!.replace(/#.*$/, ''));
    }
    if (!(MODEL_KEYS as readonly string[]).includes(key)) continue;
    const parsed = /^(?:"((?:[^"\\\n])*)"|'([^'\n]*)')\s*(?:#.*)?$/.exec(value.trim());
    if (!parsed || triple) { unparsed.push(key as ModelKey); continue; }
    values[key as ModelKey] = parsed[1] ?? parsed[2]!;
  }
  return {values, unparsed};
}

const MODEL_FLAGS = new Set(['-m', '--model', '-p', '--profile', '--oss', '--local-provider']);
function launchArgsPickModel(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (MODEL_FLAGS.has(arg) || /^--(?:model|profile|local-provider)=/.test(arg)) return true;
    if ((arg === '-c' || arg === '--config') && /^\s*(?:model|model_provider|profile|model_catalog_json|oss_provider|openai_base_url)\s*=/.test(args[i + 1] ?? '')) return true;
    if (/^--config=\s*(?:model|model_provider|profile|model_catalog_json|oss_provider|openai_base_url)\s*=/.test(arg)) return true;
  }
  return false;
}

export function codexEffortModel(input: {env: Record<string, string | undefined>; cwd: string; args?: readonly string[]; launchModel?: string; managedConfigPath?: string}, files: CodexEffortConfigFiles = realFiles): CodexEffortModel {
  if (launchArgsPickModel(input.args ?? [])) return {ok: false, why: 'launch-args'};
  if (input.launchModel !== undefined && !Object.hasOwn(CODEX_EFFORT_CATALOG, input.launchModel)) return {ok: false, why: 'model'};
  if (input.env.OPENAI_BASE_URL) return {ok: false, why: 'base-url'};
  const codexHome = input.env.CODEX_HOME || join(input.env.HOME || homedir(), '.codex');
  const paths = [join(codexHome, 'config.toml'), input.managedConfigPath ?? CODEX_MANAGED_CONFIG_PATH];
  let complete = false;
  for (let dir = input.cwd, depth = 0; depth < 32; depth++) {
    paths.push(join(dir, '.codex', 'config.toml'));
    if (files.isRepositoryRoot(dir)) { complete = true; break; }
    const parent = dirname(dir);
    if (parent === dir) { complete = true; break; }
    dir = parent;
  }
  // An unvisited ancestor may still choose another model. Exhausting the bound is not proof of a default.
  if (!complete) return {ok: false, why: 'unreadable'};
  const models: string[] = [];
  for (const path of [...new Set(paths)]) {
    let text: string | null;
    try { text = files.read(path); } catch { return {ok: false, why: 'unreadable'}; }
    if (text === null) continue;
    const {values, unparsed} = codexTopLevelConfig(text);
    if (unparsed.length) return {ok: false, why: 'unparsed'};
    if (values.profile !== undefined) return {ok: false, why: 'profile'};
    if (values.model_catalog_json !== undefined) return {ok: false, why: 'catalog'};
    if (values.oss_provider !== undefined) return {ok: false, why: 'provider'};
    if (values.openai_base_url !== undefined) return {ok: false, why: 'base-url'};
    if (values.model_provider !== undefined && values.model_provider !== 'openai') return {ok: false, why: 'provider'};
    if (values.model !== undefined && input.launchModel === undefined) models.push(values.model);
  }
  if (models.some(model => !Object.hasOwn(CODEX_EFFORT_CATALOG, model))) return {ok: false, why: 'model'};
  // Precedence among several files does not matter: every one of them names a catalog model.
  const model = input.launchModel ?? models.at(-1) ?? null;
  return {ok: true, model, allowed: model ? CODEX_EFFORT_CATALOG[model]! : LMH};
}
