import {agentsToZUseMcpConfiguredCommand} from '../src/agentsToZUseMcpLauncher';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  agentsToZUseCodexMcpAddArgv,
  classifyAgentsToZUseCodexMcpEntry,
} from '../src/agentstozUseCodexMcpEntry';
import { createControlProfileConnections } from '../src/controlProfileConnections';

const exe = '/Applications/AgentsToZ.app/Contents/MacOS/agentstoz-use-mcp';

/** `codex mcp get agentstoz_use --json` for an entry written by the given argv. */
function codexGet(argv: string[]) {
  const dash = argv.indexOf('--');
  const env: Record<string, string> = {};
  for (let i = 0; i < dash; i++) if (argv[i] === '--env') {
    const [key, value] = argv[i + 1]!.split('=');
    env[key!] = value!;
  }
  return { name: 'agentstoz_use', enabled: true, transport: { type: 'stdio', command: argv[dash + 1], args: argv.slice(dash + 2), env: Object.keys(env).length ? env : null, cwd: null } };
}

describe('one Codex agentstoz_use entry shape', () => {
  test('the profile installer and the Buzz bootstrap installer write the same command', () => {
    const profile = agentsToZUseCodexMcpAddArgv('codex', exe);
    const bootstrap = agentsToZUseCodexMcpAddArgv('codex', exe, 'ctrl-1');
    expect(profile).toEqual(['codex', 'mcp', 'add', 'agentstoz_use', '--', exe]);
    expect(bootstrap).toEqual(['codex', 'mcp', 'add', '--env', 'AGENTSTOZ_CONTROLLER_PORT_ID=ctrl-1', 'agentstoz_use', '--', exe]);
  });

  test('each installer accepts the entry the other one wrote', () => {
    const profileEntry = codexGet(agentsToZUseCodexMcpAddArgv('codex', exe));
    const bootstrapEntry = codexGet(agentsToZUseCodexMcpAddArgv('codex', exe, 'ctrl-1'));
    // Profile view: controller pin is optional (the profile token wins in the API).
    expect(classifyAgentsToZUseCodexMcpEntry(profileEntry, { executable: exe })).toBe('ready');
    expect(classifyAgentsToZUseCodexMcpEntry(bootstrapEntry, { executable: exe })).toBe('ready');
    // Bootstrap view: a profile entry is enough when the profile token is readable.
    expect(classifyAgentsToZUseCodexMcpEntry(profileEntry, { executable: exe, controllerPortId: 'ctrl-1', profileAvailable: true })).toBe('ready');
    expect(classifyAgentsToZUseCodexMcpEntry(bootstrapEntry, { executable: exe, controllerPortId: 'ctrl-1', profileAvailable: false })).toBe('ready');
  });

  test('a profile entry without a readable profile cannot call tools for the bootstrap controller', () => {
    const profileEntry = codexGet(agentsToZUseCodexMcpAddArgv('codex', exe));
    expect(classifyAgentsToZUseCodexMcpEntry(profileEntry, { executable: exe, controllerPortId: 'ctrl-1', profileAvailable: false })).toBe('needs-controller');
  });

  test('real conflicts stay conflicts', () => {
    const entry = codexGet(agentsToZUseCodexMcpAddArgv('codex', exe, 'ctrl-1'));
    expect(classifyAgentsToZUseCodexMcpEntry(null, { executable: exe })).toBe('missing');
    expect(classifyAgentsToZUseCodexMcpEntry({ ...entry, enabled: false }, { executable: exe })).toBe('conflict');
    expect(classifyAgentsToZUseCodexMcpEntry({ ...entry, transport: { ...entry.transport, command: '/other' } }, { executable: exe })).toBe('conflict');
    expect(classifyAgentsToZUseCodexMcpEntry({ ...entry, transport: { ...entry.transport, args: ['--x'] } }, { executable: exe })).toBe('conflict');
    expect(classifyAgentsToZUseCodexMcpEntry({ ...entry, transport: { type: 'streamable_http', url: 'http://x' } }, { executable: exe })).toBe('conflict');
    expect(classifyAgentsToZUseCodexMcpEntry(entry, { executable: exe, controllerPortId: 'other', profileAvailable: true })).toBe('conflict');
  });

  test('the profile connection list reports a bootstrap-written Codex entry as configured', async () => {
    const bootstrapEntry = codexGet(agentsToZUseCodexMcpAddArgv('codex', exe, 'ctrl-1'));
    const connections = createControlProfileConnections({
      home: '/nonexistent-home', appDataDir: '/nonexistent-app', executable: exe,
      agents: { codex: '/bin/codex' },
      run: async argv => argv.includes('get') ? { stdout: JSON.stringify(bootstrapEntry), exitCode: 0 } : { stdout: '', exitCode: 1 },
    });
    const [codex] = await connections.list();
    expect(codex).toMatchObject({ agent: 'codex', state: 'configured' });
  });

  test('both installers build their argv from the shared helper', () => {
    const profile = readFileSync(new URL('../src/controlProfileConnections.ts', import.meta.url), 'utf8');
    const bootstrap = readFileSync(new URL('../buzz-agent-bootstrap-server.ts', import.meta.url), 'utf8');
    for (const source of [profile, bootstrap]) {
      expect(source).toContain('agentsToZUseCodexMcpAddArgv(');
      expect(source).toContain('classifyAgentsToZUseCodexMcpEntry(');
    }
  });
});

describe('앱 번들 경로로 적힌 옛 항목은 충돌이 아니라 올릴 것 (2026-10-06)', () => {
  const LAUNCHER = '/Users/x/.agentstoz/bin/agentstoz-use-mcp';
  const BUNDLED = '/Applications/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp';
  const entry = (command: string) => ({transport: {type: 'stdio', command}});

  test('우리가 적은 옛 모양은 outdated — 사용자에게 고치라고 하지 않는다', () => {
    expect(classifyAgentsToZUseCodexMcpEntry(entry(BUNDLED), {executable: LAUNCHER, bundledExecutable: BUNDLED})).toBe('outdated');
    // 설치 위치가 달라도 우리 것이다.
    expect(classifyAgentsToZUseCodexMcpEntry(entry('/Users/x/Apps/AgentsToZ_byCS.app/Contents/Resources/resources/agentstoz-use-mcp'),
      {executable: LAUNCHER, bundledExecutable: BUNDLED})).toBe('outdated');
  });

  test('남이 만든 연결은 여전히 충돌이다', () => {
    expect(classifyAgentsToZUseCodexMcpEntry(entry('/usr/local/bin/other-mcp'), {executable: LAUNCHER, bundledExecutable: BUNDLED})).toBe('conflict');
    expect(classifyAgentsToZUseCodexMcpEntry(entry('npx'), {executable: LAUNCHER, bundledExecutable: BUNDLED})).toBe('conflict');
  });

  test('런처로 적혀 있으면 준비됨', () => {
    expect(classifyAgentsToZUseCodexMcpEntry(entry(LAUNCHER), {executable: LAUNCHER, bundledExecutable: BUNDLED})).toBe('ready');
  });

  test('두 설치기가 같은 명령을 기대한다 — 런처가 있으면 런처, 없으면 번들', () => {
    expect(agentsToZUseMcpConfiguredCommand('/Users/x', BUNDLED, path => path === LAUNCHER, 'darwin')).toBe(LAUNCHER);
    expect(agentsToZUseMcpConfiguredCommand('/Users/x', BUNDLED, () => false, 'darwin')).toBe(BUNDLED);
    // Windows 는 셸 런처를 쓰지 않는다.
    expect(agentsToZUseMcpConfiguredCommand('/Users/x', BUNDLED, () => true, 'win32')).toBe(BUNDLED);
    expect(agentsToZUseMcpConfiguredCommand('/Users/x', null, () => true, 'darwin')).toBeNull();
  });
});
