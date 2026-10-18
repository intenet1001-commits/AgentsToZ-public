import {afterEach, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {workroomEffortRuntimeSupport} from '../src/workroomEffortRuntimeSupport';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'effort-support-')); roots.push(root);
  const put = (file: string, text: string) => { mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, text); return file; };
  const executable = put(join(root, 'release/bin/codex'), 'not an executable — metadata inspection must never start it');
  const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const env = {HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home')};
  const support = (path = executable, agent = 'codex') => workroomEffortRuntimeSupport(path, agent, env, cwd);
  return {root, put, executable, cwd, env, support};
}
test('official standalone Codex metadata works through a symlink without running a provider', () => {
  const f = fixture(); f.put(join(f.root, 'release/codex-package.json'), JSON.stringify({version: '0.163.0', target: 'aarch64-apple-darwin'}));
  const link = join(f.root, 'codex'); symlinkSync(f.executable, link);
  expect(f.support(link)).toEqual({claudeSessionPicker: false, codexDefaultKeys: true});
});
test('npm metadata is supported and unverified old or malformed packages stay unsupported', () => {
  const f = fixture(); const file = join(f.root, 'release/package.json');
  for (const version of ['0.163.0', '0.163.1']) { f.put(file, JSON.stringify({name: '@openai/codex', version})); expect(f.support().codexDefaultKeys).toBe(true); }
  for (const version of ['0.123.0', '0.162.1', '1.0.0', '0.163.0-unknown']) { f.put(file, JSON.stringify({name: '@openai/codex', version})); expect(f.support().codexDefaultKeys).toBe(false); }
  f.put(file, JSON.stringify({name: 'unrelated', version: '0.163.0'})); expect(f.support().codexDefaultKeys).toBe(false);
});
test('an ancestor cannot impersonate official standalone metadata', () => {
  const f = fixture(); f.put(join(f.root, 'codex-package.json'), JSON.stringify({version: '0.163.0', target: 'aarch64-apple-darwin'})); expect(f.support().codexDefaultKeys).toBe(false);
});
test('custom user and project keymaps disable shortcuts; ordinary config and auth files are not credentials to reuse', () => {
  const f = fixture(); f.put(join(f.root, 'release/package.json'), JSON.stringify({name: '@openai/codex', version: '0.163.0'}));
  f.put(join(f.env.CODEX_HOME, 'auth.json'), 'invalid JSON: not read');
  const config = join(f.env.CODEX_HOME, 'config.toml');
  f.put(config, '# custom keymap is not configured\nmodel = "fixture"\n'); expect(f.support().codexDefaultKeys).toBe(true);
  f.put(config, '[tui.keybindings]\n'); expect(f.support().codexDefaultKeys).toBe(false);
  f.put(config, ''); f.put(join(f.cwd, '.codex/config.toml'), '[tui.keymap]\n'); expect(f.support().codexDefaultKeys).toBe(false);
});
test('oversized config is refused, and Claude session-only support requires verified metadata without launching Claude', () => {
  const f = fixture(); const file = join(f.root, 'release/package.json');
  f.put(file, JSON.stringify({name: '@openai/codex', version: '0.163.0'})); f.put(join(f.env.CODEX_HOME, 'config.toml'), 'x'.repeat(65537)); expect(f.support().codexDefaultKeys).toBe(false);
  for (const [version, supported] of [['2.1.256', false], ['2.1.257', true], ['2.2.0', true]] as const) {
    f.put(file, JSON.stringify({name: '@anthropic-ai/claude-code', version})); expect(f.support(f.executable, 'claude').claudeSessionPicker).toBe(supported);
  }
  expect(f.support(join(f.root, 'missing'), 'claude')).toEqual({claudeSessionPicker: false, codexDefaultKeys: false});
});
