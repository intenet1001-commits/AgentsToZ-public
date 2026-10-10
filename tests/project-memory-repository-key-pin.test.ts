import {afterEach, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {initializeProjectMemory, projectRepositoryKey} from '../project-memory-server';
import {pinnedProjectRepositoryKey, proposedMemoryIdForRepository} from '../src/projectMemoryIdentity';

// The Supabase registry maps memory_id (PK) ↔ canonical_repo_key (UNIQUE). Renaming the GitHub
// repository and following it with origin would present a new key for an existing memory_id and
// break every claim and revision insert. A repo-local `agentstoz.repositoryKey` pins the key the
// registry already knows; without a pin the origin decides exactly as before.
const dirs: string[] = [];
const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
});
function repository(origin?: string) {
  const root = mkdtempSync(join(tmpdir(), 'repository-key-pin-'));
  dirs.push(root);
  Bun.spawnSync(['git', 'init', '-q'], {cwd: root});
  if (origin) Bun.spawnSync(['git', 'remote', 'add', 'origin', origin], {cwd: root});
  return root;
}
const pin = (root: string, value: string) => Bun.spawnSync(['git', 'config', '--local', 'agentstoz.repositoryKey', value], {cwd: root});

test('without a pin the origin decides, unchanged', () => {
  expect(projectRepositoryKey(repository('https://github.com/owner/AgentsToZ-OPS.git'))).toBe('https://github.com/owner/agentstoz-ops');
  expect(projectRepositoryKey(repository('git@github.com:owner/AgentsToZ-Control.git'))).toBe('https://github.com/owner/agentstoz-control');
  expect(projectRepositoryKey(repository(), 'https://github.com/owner/Supplied.git')).toBe('https://github.com/owner/supplied');
  expect(projectRepositoryKey(repository())).toBeNull();
});

test('a pinned canonical key wins over the renamed origin', () => {
  const root = repository('https://github.com/owner/AgentsToZ-OPS.git');
  pin(root, 'https://github.com/owner/agentstoz-control');
  expect(projectRepositoryKey(root)).toBe('https://github.com/owner/agentstoz-control');
  expect(projectRepositoryKey(root, 'https://github.com/owner/Other.git')).toBe('https://github.com/owner/agentstoz-control');
});

test('a pin that is not already a canonical key is ignored', () => {
  for (const value of ['https://github.com/Owner/AgentsToZ-Control.git', 'not a repository', 'https://github.com/owner/agentstoz-control extra']) {
    const root = repository('https://github.com/owner/AgentsToZ-OPS.git');
    pin(root, value);
    expect({value, key: projectRepositoryKey(root)}).toEqual({value, key: 'https://github.com/owner/agentstoz-ops'});
  }
});

test('only a repository-local pin counts; a global one would give every project the same identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'repository-key-global-'));
  dirs.push(home);
  const globalConfig = join(home, 'gitconfig');
  writeFileSync(globalConfig, '[agentstoz]\n\trepositoryKey = https://github.com/owner/agentstoz-control\n');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  expect(projectRepositoryKey(repository('https://github.com/owner/unrelated.git'))).toBe('https://github.com/owner/unrelated');
});

test('a fresh memory in a pinned clone proposes the identity its lineage was created with', () => {
  const pinned = repository('https://github.com/owner/AgentsToZ-OPS.git');
  pin(pinned, 'https://github.com/owner/agentstoz-control');
  expect(initializeProjectMemory({folderPath: pinned, projectName: 'OPS', autoBackup: false}).config?.memoryId)
    .toBe(proposedMemoryIdForRepository('https://github.com/owner/agentstoz-control'));
  const plain = repository('https://github.com/owner/AgentsToZ-OPS.git');
  expect(initializeProjectMemory({folderPath: plain, projectName: 'OPS', autoBackup: false}).config?.memoryId)
    .toBe(proposedMemoryIdForRepository('https://github.com/owner/agentstoz-ops'));
});

test('pin validation accepts only canonical keys', () => {
  expect(pinnedProjectRepositoryKey('https://github.com/owner/agentstoz-control')).toBe('https://github.com/owner/agentstoz-control');
  expect(pinnedProjectRepositoryKey(' https://github.com/owner/agentstoz-control\n')).toBe('https://github.com/owner/agentstoz-control');
  expect(pinnedProjectRepositoryKey('https://gitlab.com/owner/project')).toBe('https://gitlab.com/owner/project');
  for (const value of ['', 'https://github.com/Owner/Repo', 'https://github.com/owner/repo.git', 'github.com/owner/repo', null, undefined, 7])
    expect(pinnedProjectRepositoryKey(value)).toBeNull();
});
