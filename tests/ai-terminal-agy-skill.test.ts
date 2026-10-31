import {afterEach, expect, test} from 'bun:test';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalService} from '../src/aiTerminalService';
import {installAgentsToZInvocation} from '../src/agentstozInvocationInstaller';
import {UNFINISHED_WORK_SKILL} from '../src/unfinishedWorkSkill';

const dirs: string[] = [];
const services: AiTerminalService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.shutdown()));
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

test.each([[false, false], [true, false], [false, true]])('agy CLI home exists: %s, synchronization disabled: %s', async (alreadyExists, disabled) => {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-late-')); dirs.push(home);
  const cliHome = join(home, '.gemini', 'antigravity-cli');
  const skill = join(cliHome, 'skills', 'agentstoz-unfinished-work', 'SKILL.md');
  installAgentsToZInvocation({home});
  expect(existsSync(cliHome)).toBe(false);
  const executable = join(home, 'agy');
  writeFileSync(executable, '#!/bin/sh\n'); chmodSync(executable, 0o755);
  // Either the CLI created its own home after boot, or this is its first launch.
  if (alreadyExists) mkdirSync(cliHome, {recursive: true});
  let observedAtSpawn = '';
  let settle!: (code: number) => void;
  let eof!: () => void;
  const exited = new Promise<number>(resolve => {settle = resolve;});
  const service = new AiTerminalService({
    resolveTarget: async () => ({cwd: home}), executable: () => executable,
    env: {HOME: home, ...(disabled ? {AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC: '1'} : {})},
    spawn: ((_args: unknown, options: any) => {
      observedAtSpawn = existsSync(skill) ? readFileSync(skill, 'utf8') : ''; eof = options.terminal.exit;
      return {pid: 987654321, exited, kill: () => {eof(); settle(0);}, terminal: {write: () => 0, resize() {}, close() {}}};
    }) as any,
    signalGroup: () => {eof(); settle(0);},
  });
  services.push(service);
  const session = await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-fixture-123', agent: 'agy', cols: 80, rows: 24});
  expect(session.session?.state).toBe('running');
  expect(observedAtSpawn).toBe(disabled ? '' : UNFINISHED_WORK_SKILL);
  if (disabled) expect(existsSync(cliHome)).toBe(false);
});

test('a non-executable agy file cannot create the CLI home', async () => {
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-nonexec-')); dirs.push(home);
  mkdirSync(join(home, '.gemini'));
  const executable = join(home, 'agy'); writeFileSync(executable, '#!/bin/sh\n', {mode: 0o600});
  let settle!: (code: number) => void;
  let eof!: () => void;
  const exited = new Promise<number>(resolve => {settle = resolve;});
  const service = new AiTerminalService({resolveTarget: async () => ({cwd: home}), executable: () => executable, env: {HOME: home},
    spawn: ((_args: unknown, options: any) => {eof = options.terminal.exit; return {pid: 987654320, exited, kill: () => {eof(); settle(0);}, terminal: {write: () => 0, resize() {}, close() {}}};}) as any,
    signalGroup: () => {eof(); settle(0);},
  });
  services.push(service);
  await service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-fixture-123', agent: 'agy', cols: 80, rows: 24});
  expect(existsSync(join(home, '.gemini', 'antigravity-cli'))).toBe(false);
});

test('a missing CLI does not create an agy profile at launch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-missing-')); dirs.push(home);
  const service = new AiTerminalService({resolveTarget: async () => ({cwd: home}), executable: () => null, env: {HOME: home}});
  services.push(service);
  await expect(service.perform({operation: 'start', requestId: crypto.randomUUID(), targetId: 'project-fixture-123', agent: 'agy', cols: 80, rows: 24})).rejects.toThrow('설치');
  expect(existsSync(join(home, '.gemini', 'antigravity-cli'))).toBe(false);
});
