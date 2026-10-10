import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import golden from './fixtures/ops-folder-names-golden.json';
import {
  LEGACY_OPS_FOLDER_NAMES, LEGACY_OPS_GITHUB_REPOSITORY_NAMES, LEGACY_OPS_RULE_FILES, OPS_FOLDER_NAME,
  OPS_GITHUB_REPOSITORY_NAME, OPS_RULE_FILE, isLegacyOpsFolderName, isLegacyOpsGitHubRepositoryName,
  isOpsFolderName, legacyOpsGitHubRemotes, opsFolderLeaf, renamedOpsGitHubRemote,
} from '../src/opsFolderName';
import {CONTROL_CENTER_PROJECT_NAME} from '../src/controlCenterProject';
import {
  CONTROL_PROFILE_CONTROLLER, CONTROL_PROFILE_HEADER, CONTROL_PROFILE_MARKER, CONTROL_PROFILE_PRIVATE_PATH,
} from '../src/controlProfileContract';
import {AGENTSTOZ_USE_CONTROLLER_ENV} from '../src/agentstozUseCodexMcpEntry';
import {AGENTSTOZ_USE_MCP_TOOLS} from '../agentstoz-use-mcp-server';

// The OPS folder was created as AgentsToZ-Control and is now AgentsToZ-OPS. GitHub renamed the
// repository in place (same node id). Another Mac, a Supabase row or a memory revision may still
// carry the old name at any time, so both names identify the same OPS folder forever.
describe('OPS folder name', () => {
  test('the canonical name is AgentsToZ-OPS and the old name stays recognized', () => {
    expect(OPS_FOLDER_NAME).toBe('AgentsToZ-OPS');
    expect(LEGACY_OPS_FOLDER_NAMES).toEqual(['AgentsToZ-Control']);
    expect(OPS_GITHUB_REPOSITORY_NAME).toBe('AgentsToZ-OPS');
    expect(LEGACY_OPS_GITHUB_REPOSITORY_NAMES).toEqual(['AgentsToZ-Control']);
    expect(CONTROL_CENTER_PROJECT_NAME).toBe(OPS_FOLDER_NAME);
    expect(OPS_RULE_FILE).toBe('.agents/rules/agentstoz-ops.md');
    expect(LEGACY_OPS_RULE_FILES).toEqual(['.agents/rules/agentstoz-control.md']);
  });

  test('matching trims, ignores case and accepts nothing else', () => {
    for (const name of ['AgentsToZ-OPS', 'agentstoz-ops', ' AGENTSTOZ-OPS ', 'AgentsToZ-Control', 'agentstoz-control\n'])
      expect(isOpsFolderName(name)).toBe(true);
    for (const name of ['AgentsToZ OPS', 'AgentsToZ-OPS-backup', 'AgentsToZ_byCS', 'Control', 'agentstoz', '', '   ', null, undefined, 3, {}])
      expect(isOpsFolderName(name)).toBe(false);
    expect(isLegacyOpsFolderName('agentstoz-control')).toBe(true);
    expect(isLegacyOpsFolderName('AgentsToZ-OPS')).toBe(false);
    expect(isLegacyOpsGitHubRepositoryName('AGENTSTOZ-CONTROL')).toBe(true);
    expect(isLegacyOpsGitHubRepositoryName('AgentsToZ-OPS')).toBe(false);
  });

  test('the folder leaf works for POSIX and Windows paths with trailing separators', () => {
    expect(opsFolderLeaf('/Users/me/product/AgentsToZ-OPS/')).toBe('AgentsToZ-OPS');
    expect(opsFolderLeaf('C:\\work\\AgentsToZ-Control\\')).toBe('AgentsToZ-Control');
    expect(opsFolderLeaf('  /a/b  ')).toBe('b');
    expect(opsFolderLeaf(undefined)).toBe('');
  });

  test('golden cases name OPS by folder, name or alias — never by a look-alike', () => {
    expect(golden.length).toBeGreaterThan(8);
    for (const row of golden) {
      const ops = [row.name, row.leaf, row.aiName].some(value => isOpsFolderName(value));
      expect({case: row.case, ops}).toEqual({case: row.case, ops: row.expectedRole === 'ops'});
    }
  });

  test('a legacy GitHub remote is renamed in the same URL format', () => {
    const cases: Array<[string, string | null]> = [
      ['https://github.com/intenet1001-commits/AgentsToZ-Control.git', 'https://github.com/intenet1001-commits/AgentsToZ-OPS.git'],
      ['https://github.com/owner/AgentsToZ-Control', 'https://github.com/owner/AgentsToZ-OPS'],
      ['https://github.com/owner/agentstoz-control/', 'https://github.com/owner/AgentsToZ-OPS/'],
      ['git@github.com:owner/AgentsToZ-Control.git', 'git@github.com:owner/AgentsToZ-OPS.git'],
      ['ssh://git@github.com/owner/AgentsToZ-Control.git', 'ssh://git@github.com/owner/AgentsToZ-OPS.git'],
      ['ssh://git@github.com:22/owner/AgentsToZ-Control', 'ssh://git@github.com:22/owner/AgentsToZ-OPS'],
      ['https://user@GitHub.com/owner/AgentsToZ-Control.git', 'https://user@GitHub.com/owner/AgentsToZ-OPS.git'],
      ['https://github.com/owner/AgentsToZ-OPS.git', null],
      ['https://github.com/owner/other.git', null],
      ['https://gitlab.com/owner/AgentsToZ-Control.git', null],
      ['https://github.com/owner/group/AgentsToZ-Control.git', null],
      ['/local/mirror/AgentsToZ-Control.git', null],
      ['', null],
    ];
    for (const [url, expected] of cases) expect({url, renamed: renamedOpsGitHubRemote(url)}).toEqual({url, renamed: expected});
  });

  test('the inverse names the same remote under each legacy name, and nothing else', () => {
    const cases: Array<[unknown, string[]]> = [
      ['https://github.com/owner/AgentsToZ-OPS.git', ['https://github.com/owner/AgentsToZ-Control.git']],
      ['git@github.com:owner/agentstoz-ops.git', ['git@github.com:owner/AgentsToZ-Control.git']],
      ['ssh://git@github.com:22/owner/AgentsToZ-OPS/', ['ssh://git@github.com:22/owner/AgentsToZ-Control/']],
      ['https://github.com/owner/AgentsToZ-Control.git', []],
      ['https://github.com/owner/AgentsToZ-OPS-backup.git', []],
      ['https://gitlab.com/owner/AgentsToZ-OPS.git', []],
      ['https://github.com/owner/group/AgentsToZ-OPS.git', []],
      [null, []],
    ];
    for (const [url, expected] of cases) expect({url, legacy: legacyOpsGitHubRemotes(url)}).toEqual({url, legacy: expected});
    for (const legacy of legacyOpsGitHubRemotes('https://github.com/owner/AgentsToZ-OPS.git'))
      expect(renamedOpsGitHubRemote(legacy)).toBe('https://github.com/owner/AgentsToZ-OPS.git');
  });
});

// These names are wire, disk or UI-test contracts. The OPS folder rename must not move them:
// installed AIs, older app versions and other Macs keep using exactly these values.
describe('identifiers the OPS rename must never change', () => {
  test('profile marker, seed, header, controller and env names', () => {
    expect(CONTROL_PROFILE_MARKER).toBe('.agentstoz-control-profile.json');
    expect(CONTROL_PROFILE_PRIVATE_PATH).toBe('.agentstoz-private/control-bootstrap.json');
    expect(CONTROL_PROFILE_HEADER).toBe('X-AgentsToZ-Control-Profile');
    expect(CONTROL_PROFILE_CONTROLLER).toBe('agentstoz-profile');
    expect(AGENTSTOZ_USE_CONTROLLER_ENV).toBe('AGENTSTOZ_CONTROLLER_PORT_ID');
  });

  test('the MCP tool, API routes, error-code family and test ids stay', () => {
    expect(AGENTSTOZ_USE_MCP_TOOLS.map(tool => tool.name)).toContain('agentstoz_use_create_control_center');
    const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(api).toContain('url.pathname === "/api/control-center/create"');
    expect(api).toContain("url.pathname.startsWith('/api/control-profile/')");
    const store = readFileSync(new URL('../src/controlProfileStore.ts', import.meta.url), 'utf8');
    for (const code of ['CONTROL_PROFILE_MEMORY_MISMATCH', 'CONTROL_PROFILE_MARKER_MISMATCH', 'CONTROL_PROFILE_NOT_READY'])
      expect(store).toContain(`'${code}'`);
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    for (const id of ['control-center-project-shortcut', 'control-center-remote-candidate', 'control-profile-open'])
      expect(app).toContain(`data-testid="${id}"`);
  });
});
