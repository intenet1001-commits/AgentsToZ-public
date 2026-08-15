import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installHermesProjectMemoryAdapter } from '../project-memory-server';
import { buildAwsUbuntuMemorySetupPrompt } from '../src/awsUbuntuMemorySetup';

const roots: string[] = [];
const hermesLookup = spawnSync('bash', ['-lc', 'command -v hermes'], { encoding: 'utf8' });
const hermesCli = hermesLookup.status === 0 ? hermesLookup.stdout.trim() : '';
const liveRendererTest = hermesCli ? test : test.skip;

// The renderer check has to run under Hermes' own interpreter — the one that can
// import `hermes_cli`. Two install layouts are in the wild and only the first
// keeps the interpreter next to the CLI:
//   1. `hermes` is a symlink into the venv's `bin/`  → sibling `python`
//   2. `hermes` is a bash wrapper that execs the venv `python` by absolute path
// Assuming (1) resolved to `<prefix>/bin/python`, which does not exist on a
// wrapper install, so the spawn failed with ENOENT and the test read as a
// product regression.
function resolveHermesPython(cli: string): string {
  if (!cli) return '';
  const resolved = realpathSync(cli);
  const sibling = join(dirname(resolved), 'python');
  if (existsSync(sibling)) return sibling;
  try {
    const wrapper = readFileSync(resolved, 'utf8');
    const execTarget = wrapper.match(/^\s*exec\s+"?([^"\s]+\/python[0-9.]*)"?/m)?.[1];
    if (execTarget && existsSync(execTarget)) return execTarget;
  } catch {
    // Not a readable text wrapper — fall through to the explicit failure below.
  }
  return '';
}

const requiredMemoryCommands = new Set([
  'remember_session',
  'memory_link',
  'memory_sync',
  'memory_status',
  'memory_unlink',
  'memory_start',
  'hermes_open',
]);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Hermes Telegram command menu compatibility', () => {
  test('does not make a stale claim about unsupported priority settings', () => {
    const prompt = buildAwsUbuntuMemorySetupPrompt({
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-public-key',
      projectReference: 'https://github.com/example/project',
    });

    expect(prompt).toContain('platforms.telegram.extra.command_menu.max_commands 100');
    expect(prompt).not.toContain('priority 설정이 core 명령에만 적용');
    expect(prompt).not.toContain('config set의 배열은 문자열');
  });

  liveRendererTest('keeps all seven memory commands visible when a real gateway home has more than 100 commands', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-hermes-menu-'));
    roots.push(home);
    mkdirSync(home, { recursive: true });
    const env = { ...process.env, HERMES_HOME: home };
    const previousHome = process.env.HERMES_HOME;

    try {
      process.env.HERMES_HOME = home;
      const status = installHermesProjectMemoryAdapter({ hermesCliPath: hermesCli });
      expect(status.externalDirRegistered).toBe(true);
      expect(status.menuPluginInstalled).toBe(true);
      expect(status.menuPluginEnabled).toBe(true);
      expect(status.menuCommandCap).toBe(100);
      for (const command of requiredMemoryCommands) {
        expect(status.installed).toContain(command.replaceAll('_', '-'));
      }
    } finally {
      if (previousHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHome;
    }

    // A real Hermes installation can have far more than Telegram's 100-command
    // hard limit. The regression only appears in that crowded state: external
    // skills are sorted alphabetically and the memory commands land after the
    // cap even when max_commands is raised from 60 to 100.
    for (let index = 0; index < 120; index += 1) {
      const name = `aaa-crowded-${String(index).padStart(3, '0')}`;
      const dir = join(home, 'agentstoz-skills', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), [
        '---',
        `name: ${name}`,
        `description: "Crowded menu fixture ${index}"`,
        '---',
        '',
        `# ${name}`,
        '',
      ].join('\n'));
    }

    const python = resolveHermesPython(hermesCli);
    // Fail loudly rather than skip: an unresolvable interpreter means a third
    // install layout exists, and silently dropping the check would hide it.
    expect(python, `Hermes interpreter not found from CLI at ${hermesCli}`).not.toBe('');
    const renderArgs = ['-c', [
      'import json',
      'from hermes_cli.commands import telegram_menu_commands, telegram_menu_max_commands',
      'from hermes_cli.plugins import get_plugin_command_handler, get_plugin_commands',
      'cap = telegram_menu_max_commands()',
      'commands, hidden = telegram_menu_commands(cap)',
      'required = {"remember-session", "memory-link", "memory-sync", "memory-status", "memory-unlink", "memory-start", "hermes-open"}',
      'plugin_commands = get_plugin_commands()',
      'print(json.dumps({"cap": cap, "names": [name for name, _ in commands], "hidden": hidden, "menu_only": sorted(name for name in required if name in plugin_commands and get_plugin_command_handler(name) is None)}))',
    ].join('; ')];
    let rendered = spawnSync(python, renderArgs, { cwd: home, env, encoding: 'utf8' });
    for (let attempt = 1; attempt < 3 && rendered.error; attempt += 1) {
      const code = (rendered.error as NodeJS.ErrnoException).code;
      if (!['EAGAIN', 'EMFILE', 'ENFILE'].includes(code ?? '')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
      rendered = spawnSync(python, renderArgs, { cwd: home, env, encoding: 'utf8' });
    }

    expect(rendered.error?.message).toBeUndefined();
    expect(rendered.status).toBe(0);
    const result = JSON.parse(rendered.stdout) as { cap: number; names: string[]; hidden: number; menu_only: string[] };
    expect(result.cap).toBe(100);
    expect(result.names.length).toBeLessThanOrEqual(100);
    for (const command of requiredMemoryCommands) expect(result.names).toContain(command);
    expect(result.menu_only).toEqual([...requiredMemoryCommands].map(command => command.replaceAll('_', '-')).sort());
  });
});
