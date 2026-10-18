/**
 * Codex rejects a reasoning effort its model does not offer («Reasoning effort `X` is not supported for model `Y`»),
 * so 「에포트 자동」 passes `-c model_reasoning_effort` only when the model is proven to be one of the bundled catalog
 * models (all of which offer low, medium and high — strings of codex-cli 0.162.1). Anything else: no flag.
 * Read-only, bounded; never touches the real ~/.codex in these tests.
 */
import {afterEach, expect, test} from 'bun:test';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODEX_EFFORT_CATALOG, CODEX_EFFORT_CONFIG_MAX_BYTES, codexEffortModel, codexTopLevelConfig, type CodexEffortConfigFiles} from '../src/codexEffortModel';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(dir, 0o700); } catch {} rmSync(dir, {recursive: true, force: true}); } });

const HOME = '/fixture/home', CODEX_HOME = '/fixture/home/.codex', CWD = '/fixture/repo/app';
function memory(files: Record<string, string>): CodexEffortConfigFiles & {reads: string[]} {
  const reads: string[] = [];
  return {reads, read(path) { reads.push(path); if (path in files) return files[path]!; return null; }, isRepositoryRoot: path => path === '/fixture/repo'};
}
const check = (files: Record<string, string>, extra: {args?: string[]; env?: Record<string, string>} = {}) =>
  codexEffortModel({env: {HOME, ...(extra.env ?? {})}, cwd: CWD, args: extra.args ?? [], managedConfigPath: '/fixture/etc/managed_config.toml'}, memory(files));

test('no model configured → the Codex default (a catalog model) → low, medium and high', () => {
  expect(check({})).toEqual({ok: true, model: null, allowed: ['low', 'medium', 'high']});
  expect(check({[`${CODEX_HOME}/config.toml`]: 'approval_policy = "on-request"\n[tui]\nmodel = "not-top-level"\n'})).toMatchObject({ok: true, model: null});
});

test('every catalog model offers low, medium and high', () => {
  expect(Object.keys(CODEX_EFFORT_CATALOG).length).toBeGreaterThan(5);
  for (const [model, levels] of Object.entries(CODEX_EFFORT_CATALOG)) expect([...levels]).toEqual(['low', 'medium', 'high']);
  expect(check({[`${CODEX_HOME}/config.toml`]: 'model = "gpt-6-sol"   # mine\n'})).toEqual({ok: true, model: 'gpt-6-sol', allowed: ['low', 'medium', 'high']});
  expect(check({[`${CODEX_HOME}/config.toml`]: "model = 'gpt-5.5'\n"})).toMatchObject({ok: true, model: 'gpt-5.5'});
});

test('anything that is not a proven catalog model gives no flag', () => {
  const user = `${CODEX_HOME}/config.toml`;
  expect(check({[user]: 'model = "my-local-llama"\n'})).toEqual({ok: false, why: 'model'});
  expect(check({[user]: 'model_provider = "ollama"\n'})).toEqual({ok: false, why: 'provider'});
  expect(check({[user]: 'model_provider = "openai"\nmodel = "gpt-6-luna"\n'})).toMatchObject({ok: true, model: 'gpt-6-luna'});
  expect(check({[user]: 'profile = "fast"\n'})).toEqual({ok: false, why: 'profile'});
  expect(check({[user]: 'model_catalog_json = "/x.json"\n'})).toEqual({ok: false, why: 'catalog'});
  expect(check({[user]: 'oss_provider = "lmstudio"\n'})).toEqual({ok: false, why: 'provider'});
  expect(check({[user]: 'openai_base_url = "http://proxy"\n'})).toEqual({ok: false, why: 'base-url'});
  expect(check({}, {env: {OPENAI_BASE_URL: 'http://proxy'}})).toEqual({ok: false, why: 'base-url'});
  expect(check({[user]: 'model = gpt-6-sol\n'})).toEqual({ok: false, why: 'unparsed'});
  expect(check({[user]: 'model = """gpt-6-sol"""\n'})).toEqual({ok: false, why: 'unparsed'});
  // The project's own config (cwd up to the repository root) and the managed config count too.
  expect(check({'/fixture/repo/.codex/config.toml': 'model = "other"\n'})).toEqual({ok: false, why: 'model'});
  expect(check({'/fixture/etc/managed_config.toml': 'model = "other"\n'})).toEqual({ok: false, why: 'model'});
  expect(check({'/fixture/.codex/config.toml': 'model = "other"\n'})).toMatchObject({ok: true}); // above the repository root
});

test('launch arguments that pick a model or profile give no flag', () => {
  for (const args of [['-m', 'gpt-6-sol'], ['--model', 'x'], ['--model=x'], ['-p', 'fast'], ['--profile', 'fast'], ['--oss'], ['-c', 'model="x"'], ['--config', 'model_provider="ollama"'], ['-c', 'profile="p"']])
    expect(check({}, {args})).toEqual({ok: false, why: 'launch-args'});
  // The account store's own overrides are fine.
  expect(check({}, {args: ['-c', 'cli_auth_credentials_store="file"', '-c', 'log_dir="/tmp/x"']})).toMatchObject({ok: true});
});

test('CODEX_HOME moves the user config', () => {
  const files = memory({'/elsewhere/config.toml': 'model = "nope"\n'});
  expect(codexEffortModel({env: {HOME, CODEX_HOME: '/elsewhere'}, cwd: CWD, args: [], managedConfigPath: '/fixture/etc/managed_config.toml'}, files)).toEqual({ok: false, why: 'model'});
  expect(files.reads).toContain('/elsewhere/config.toml');
});

test('top-level scan: tables end it, multi-line strings and arrays do not end it early', () => {
  const toml = [
    'developer_instructions = """',
    '[not a table]',
    'model = "inside a string"',
    '"""',
    'notify = [',
    '  ["a", "b"],',
    ']',
    'model = "gpt-6-sol"',
    '[profiles.fast]',
    'model = "local"',
  ].join('\n');
  expect(codexTopLevelConfig(toml)).toEqual({values: {model: 'gpt-6-sol'}, unparsed: []});
  expect(codexTopLevelConfig('model = "a" # "b"\nprofile="p"').values).toEqual({model: 'a', profile: 'p'});
  expect(codexTopLevelConfig('model = 42').unparsed).toEqual(['model']);
});

test('real files: absent is fine, unreadable or oversized is unknown (read-only)', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-effort-')); dirs.push(root);
  const home = join(root, 'home'), repo = join(root, 'repo');
  mkdirSync(join(home, '.codex'), {recursive: true}); mkdirSync(join(repo, '.git'), {recursive: true});
  const input = {env: {HOME: home}, cwd: repo, args: [] as string[], managedConfigPath: join(root, 'managed_config.toml')};
  expect(codexEffortModel(input)).toEqual({ok: true, model: null, allowed: ['low', 'medium', 'high']});
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');
  expect(codexEffortModel(input)).toMatchObject({ok: true, model: 'gpt-6-sol'});
  writeFileSync(join(home, '.codex', 'config.toml'), '# ' + 'x'.repeat(CODEX_EFFORT_CONFIG_MAX_BYTES) + '\n');
  expect(codexEffortModel(input)).toEqual({ok: false, why: 'unreadable'});
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');
  chmodSync(join(home, '.codex', 'config.toml'), 0o000);
  expect(codexEffortModel(input)).toEqual({ok: false, why: 'unreadable'});
  chmodSync(join(home, '.codex', 'config.toml'), 0o600);
  mkdirSync(join(repo, '.codex', 'config.toml'), {recursive: true}); // a directory where a file is expected
  expect(codexEffortModel(input)).toEqual({ok: false, why: 'unreadable'});
});

test('prototype property names are not catalog models', () => {
  for (const model of ['constructor', '__proto__', 'toString'])
    expect(check({[`${CODEX_HOME}/config.toml`]: `model = "${model}"\n`})).toEqual({ok: false, why: 'model'});
});

test('a config walk that exhausts its bound cannot prove the selected model', () => {
  const cwd = '/fixture/repo/' + Array.from({length: 40}, (_, i) => `level${i}`).join('/');
  const files = memory({'/fixture/repo/.codex/config.toml': 'model = "other"\n'});
  expect(codexEffortModel({env: {HOME}, cwd}, files)).toEqual({ok: false, why: 'unreadable'});
  expect(files.reads.length).toBeLessThanOrEqual(34);
});
