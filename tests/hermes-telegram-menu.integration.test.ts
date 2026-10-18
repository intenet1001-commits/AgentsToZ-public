import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { installHermesProjectMemoryAdapter } from '../project-memory-server';
import { buildAwsUbuntuMemorySetupPrompt } from '../src/awsUbuntuMemorySetup';

const roots: string[] = [];
const hermesLookup = spawnSync('bash', ['-lc', 'command -v hermes'], { encoding: 'utf8' });
const hermesCli = hermesLookup.status === 0 ? hermesLookup.stdout.trim() : '';
const liveRendererTest = hermesCli ? test : test.skip;

/** Native Hermes now owns its Python/dependency selection. Inspect only bounded literal launcher paths. */
function hasNativeRuntimeBoundary(cli: string): boolean {
  const seen = new Set<string>();
  for (let depth = 0; depth < 5; depth++) {
    try {
      const path = realpathSync(cli);
      if (seen.has(path) || statSync(path).size > 65536) return false;
      seen.add(path);
      const text = readFileSync(path, 'utf8');
      if (text.includes('--print-runtime-command')) return true;
      const next = /^\s*exec\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/m.exec(text);
      cli = next?.[1] ?? next?.[2] ?? next?.[3] ?? '';
      if (!isAbsolute(cli) || /[$`]/.test(cli)) return false;
    } catch { return false; }
  }
  return false;
}

test('Hermes native runtime discovery follows quoted or unquoted launchers and stops at loops and binaries', () => {
  const root=mkdtempSync(join(tmpdir(),'hermes-launcher-'));roots.push(root);
  const wrapper=join(root,'hermes'),native=join(root,'native'),loop=join(root,'loop');
  writeFileSync(native,'# native --print-runtime-command boundary');
  for(const target of [native,JSON.stringify(native)]){writeFileSync(wrapper,'#!/bin/sh\nexec '+target+' "$@"\n');expect(hasNativeRuntimeBoundary(wrapper)).toBe(true);}
  writeFileSync(loop,'exec '+wrapper);writeFileSync(wrapper,'exec '+loop);expect(hasNativeRuntimeBoundary(wrapper)).toBe(false);
  writeFileSync(wrapper,'x'.repeat(65537));expect(hasNativeRuntimeBoundary(wrapper)).toBe(false);
});

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
  try {
    const wrapper = readFileSync(resolved, 'utf8');
    const execTarget = wrapper.match(/^\s*exec\s+"?([^"\s]+)"?/m)?.[1];
    if (execTarget && existsSync(execTarget)) {
      // Preserve an explicit venv Python path. realpath() follows uv/venv's
      // interpreter symlink to the base runtime and loses the venv site-packages.
      if (/\/python[0-9.]*$/.test(execTarget)) return execTarget;
      // Current installer wrappers may instead exec <venv>/bin/hermes.
      const target = realpathSync(execTarget);
      const targetSibling = join(dirname(target), 'python');
      if (existsSync(targetSibling)) return targetSibling;
    }
  } catch {
    // Not a readable text wrapper — fall through to sibling detection.
  }
  const sibling = join(dirname(resolved), 'python');
  if (existsSync(sibling)) return sibling;
  return '';
}

const requiredMemoryCommands = new Set([
  'project_start',
  'project_clone',
  'project_from_memory',
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

  liveRendererTest('keeps all AgentsToZ memory/project commands visible when a real gateway home has more than 100 commands', () => {
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
      expect(status.outputStyleInstalled).toBe(true);
      expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toContain('English translation:');
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

    const native = hasNativeRuntimeBoundary(hermesCli);
    const python = native ? '' : resolveHermesPython(hermesCli);
    // The venv interpreter may resolve through uv, so derive the editable source
    // root from the wrapper's Hermes script argument rather than Python's realpath.
    const wrapperText = readFileSync(realpathSync(hermesCli), 'utf8');
    const hermesScript = wrapperText.match(/exec\s+"[^"]+"\s+"([^"]+)"/)?.[1] ?? '';
    const hermesSourceRoot = hermesScript ? dirname(hermesScript) : dirname(dirname(dirname(python)));
    const renderEnv = { ...env, PYTHONPATH: hermesSourceRoot };
    // Fail loudly rather than skip: an unresolvable interpreter means a third
    // install layout exists, and silently dropping the check would hide it.
    if (!native) expect(python, `Hermes interpreter not found from CLI at ${hermesCli}`).not.toBe('');
    const renderCode = [
      'import json',
      'from importlib import import_module',
      'from importlib.util import find_spec',
      'menu = import_module("hermes_cli.commands_platforms" if find_spec("hermes_cli.commands_platforms") else "hermes_cli.commands")',
      'telegram_menu_commands, telegram_menu_max_commands = menu.telegram_menu_commands, menu.telegram_menu_max_commands',
      'from hermes_cli.plugins import get_plugin_command_handler, get_plugin_commands',
      'cap = telegram_menu_max_commands()',
      'commands, hidden = telegram_menu_commands(cap)',
      'required = {"project_start", "project_clone", "project_from_memory", "remember_session", "memory_link", "memory_sync", "memory_status", "memory_unlink", "memory_start", "hermes_open"}',
      'plugin_commands = get_plugin_commands()',
      'print(json.dumps({"cap": cap, "names": [name for name, _ in commands], "hidden": hidden, "menu_only": sorted(name for name in required if name in plugin_commands and get_plugin_command_handler(name) is None)}))',
    ].join('; ');
    let command = python, renderArgs = ['-c', renderCode];
    if (native) {
      // Ask the official launcher for an isolated, installation-bound stdlib invocation. No shell eval or model call.
      const probe=spawnSync(hermesCli,['--print-runtime-command','--module','timeit','--','-n','1','-r','1',renderCode],{env,encoding:'utf8',timeout:10_000});
      expect(probe.error?.message).toBeUndefined();expect(probe.status).toBe(0);
      const argv: unknown=JSON.parse(probe.stdout);
      if(!Array.isArray(argv)||argv.length<4||argv.length>32||!argv.every(x=>typeof x==='string'&&x.length<65536)||!isAbsolute(argv[0])||!existsSync(argv[0]))throw Error('Invalid Hermes native runtime metadata');
      [command,...renderArgs]=argv;
    }
    // Real interpreter startup/plugin discovery can exceed Bun's 5s unit-test
    // default on a busy Mac. Bound the process itself as well as the test.
    let rendered = spawnSync(command, renderArgs, { cwd: home, env: native?env:renderEnv, encoding: 'utf8', timeout: 10_000 });
    for (let attempt = 1; attempt < 3 && rendered.error; attempt += 1) {
      const code = (rendered.error as NodeJS.ErrnoException).code;
      if (!['EAGAIN', 'EMFILE', 'ENFILE'].includes(code ?? '')) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 250);
      rendered = spawnSync(command, renderArgs, { cwd: home, env: native?env:renderEnv, encoding: 'utf8', timeout: 10_000 });
    }

    expect(rendered.error?.message).toBeUndefined();
    expect(rendered.status, rendered.stderr.slice(-4000)).toBe(0);
    const result = JSON.parse(rendered.stdout.split('\n').find(line=>line.startsWith('{')) ?? '') as { cap: number; names: string[]; hidden: number; menu_only: string[] };
    expect(result.cap).toBe(100);
    expect(result.names.length).toBeLessThanOrEqual(100);
    for (const command of requiredMemoryCommands) expect(result.names).toContain(command);
    expect(result.menu_only).toEqual([...requiredMemoryCommands].sort());
  }, 30_000);
});
