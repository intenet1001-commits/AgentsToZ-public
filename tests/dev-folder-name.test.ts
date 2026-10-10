import { expect, test } from 'bun:test';
import {
  DEV_FOLDER_NAME,
  LEGACY_DEV_FOLDER_NAMES,
  devGitHubRepositorySegment,
  isCurrentDevFolderName,
  isDevFolderName,
  isDevRepositoryUrl,
} from '../src/devFolderName';
import { projectRoleWithoutBinding, resolveProjectRoles } from '../src/projectRole';
import { resolvePrimaryProject } from '../src/primaryProject';

test('both development folder names identify the same repository', () => {
  expect(isDevFolderName(DEV_FOLDER_NAME)).toBe(true);
  for (const legacy of LEGACY_DEV_FOLDER_NAMES) expect(isDevFolderName(legacy)).toBe(true);
  // The repository was renamed in place, so a clone made before the rename keeps
  // the old folder until someone moves it by hand.
  expect(isDevFolderName('portmanagement')).toBe(true);
  expect(isDevFolderName(' AgentsToZ_byCS ')).toBe(true);
  expect(isDevFolderName('agentstoz_bycs')).toBe(true);

  for (const other of ['', 'AgentsToZ-OPS', 'AgentsToZ-public', 'portmanagement-backup', 'port', null, 42]) {
    expect(isDevFolderName(other as never)).toBe(false);
  }
});

test('only the current name is the current name', () => {
  // Used to prefer a migrated checkout when an old one is still registered.
  expect(isCurrentDevFolderName('AgentsToZ_byCS')).toBe(true);
  expect(isCurrentDevFolderName('portmanagement')).toBe(false);
});

test('the repository segment is read out of any GitHub remote form', () => {
  for (const url of [
    'https://github.com/example-owner/AgentsToZ_byCS',
    'https://github.com/example-owner/AgentsToZ_byCS.git',
    'https://github.com/example-owner/AgentsToZ_byCS/',
    'git@github.com:example-owner/AgentsToZ_byCS.git',
    'ssh://git@github.com/example-owner/AgentsToZ_byCS',
  ]) {
    expect(devGitHubRepositorySegment(url)).toBe('AgentsToZ_byCS');
    expect(isDevRepositoryUrl(url)).toBe(true);
  }
  // The former repository name redirects on GitHub and is still stored in older rows.
  expect(isDevRepositoryUrl('https://github.com/example-owner/portmanagement')).toBe(true);
  for (const other of [
    '', 'not a url', 'https://gitlab.com/x/AgentsToZ_byCS',
    'https://github.com/example-owner/AgentsToZ-public',
    'https://github.com/example-owner/AgentsToZ-OPS',
  ]) {
    expect(isDevRepositoryUrl(other)).toBe(false);
  }
});

test('a checkout in the former folder is DEV, not 관리 프로젝트', () => {
  // Measured on a real machine: folder `portmanagement`, origin `AgentsToZ_byCS`.
  // Before this, the sidebar read `AgentsToZ DEV · 0` and the project was counted
  // as 관리 프로젝트, with no UI able to write an explicit role.
  expect(projectRoleWithoutBinding({ folderPath: 'D:\\window_product\\portmanagement' })).toBe('dev');
  expect(projectRoleWithoutBinding({ folderPath: '/Users/x/AgentsToZ_byCS' })).toBe('dev');
  // The repository is a second signal, because a clone can live in any directory.
  expect(projectRoleWithoutBinding({
    folderPath: '/Users/x/some-other-name',
    githubUrl: 'https://github.com/example-owner/AgentsToZ_byCS',
  })).toBe('dev');
  // An unrelated project stays 관리 프로젝트.
  expect(projectRoleWithoutBinding({ folderPath: '/Users/x/my-site' })).toBe('managed');
});

test('an explicit role still wins over every inference', () => {
  expect(projectRoleWithoutBinding({ role: 'managed', folderPath: '/x/portmanagement' })).toBe('managed');
  expect(projectRoleWithoutBinding({ role: 'ops', folderPath: '/x/AgentsToZ_byCS' })).toBe('ops');
  expect(projectRoleWithoutBinding({ role: 'nonsense', folderPath: '/x/portmanagement' })).toBe('unknown');
});

test('OPS keeps precedence over the development inference', () => {
  // A project that is both bound as OPS and sitting in a dev-named folder is OPS.
  const projects = [{ id: 'a', folderPath: '/x/portmanagement' }];
  expect(resolveProjectRoles(projects, { opsProjectId: 'a' }).get('a')).toBe('ops');
});

test('the sidebar counts one DEV for the measured registration set', () => {
  // The five rows this machine actually had, which rendered `AgentsToZ DEV · 0`.
  const projects = [
    { id: '1', name: '테스트 프로젝트' },
    { id: '2', name: '테스트_자동화' },
    { id: '3', name: 'Desktop', folderPath: 'C:\\Users\\x\\OneDrive\\Desktop' },
    { id: '4', name: '프로젝트관리', folderPath: 'D:\\window_product\\portmanagement' },
    { id: '5', name: 'CSnCOMPANY', folderPath: 'C:\\Users\\x\\.claude\\plugins\\marketplaces\\CSnCompany_2-0' },
  ];
  const roles = resolveProjectRoles(projects, {});
  const counts = { ops: 0, dev: 0, managed: 0, unknown: 0 };
  for (const project of projects) counts[roles.get(project.id) ?? 'unknown']++;
  expect(counts).toEqual({ ops: 0, dev: 1, managed: 4, unknown: 0 });
});

test('the primary project resolves from the former folder name too', () => {
  const projects = [{ id: '4', name: '프로젝트관리', folderPath: 'D:\\window_product\\portmanagement' }];
  // Previously null, which left `devProjectId` undefined for the whole app.
  expect(resolvePrimaryProject(projects, 'https://github.com/example-owner/AgentsToZ-public')?.id).toBe('4');

  // A migrated checkout wins when both are registered, so the DEV role does not
  // land on the stale copy.
  const both = [
    { id: 'old', folderPath: '/x/portmanagement' },
    { id: 'new', folderPath: '/x/AgentsToZ_byCS' },
  ];
  expect(resolvePrimaryProject(both, 'https://github.com/example-owner/AgentsToZ-public')?.id).toBe('new');

  // And the registered repository works when the directory is named anything.
  const renamed = [{ id: 'r', folderPath: '/x/whatever', githubUrl: 'git@github.com:example-owner/AgentsToZ_byCS.git' }];
  expect(resolvePrimaryProject(renamed, 'https://github.com/example-owner/AgentsToZ-public')?.id).toBe('r');
});
