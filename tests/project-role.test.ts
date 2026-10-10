import {describe, expect, test} from 'bun:test';
import {projectRoleWithoutBinding, projectToSelectForSection, resolveProjectRoles} from '../src/projectRole';
import {resolveControlCenterProject} from '../src/controlCenterProject';
import {resolvePrimaryProject} from '../src/primaryProject';
import golden from './fixtures/ops-folder-names-golden.json';

describe('local project roles (not bot USE/DEV purpose or authorization)', () => {
  test('projects legacy rows without rewriting them', () => {
    // The OPS folder is AgentsToZ-OPS now; a Mac that has not migrated still says AgentsToZ-Control.
    for (const opsName of ['AgentsToZ-Control', 'AgentsToZ-OPS']) {
      const rows = [{id:'ops', name:opsName}, {id:'dev', folderPath:'/work/AgentsToZ_byCS'}, {id:'song', name:'song-app'}];
      const before = JSON.stringify(rows);
      expect([...resolveProjectRoles(rows)]).toEqual([['ops','ops'], ['dev','dev'], ['song','managed']]);
      expect(JSON.stringify(rows)).toBe(before);
      expect(resolveProjectRoles(rows, {devProjectId:'ops'}).get('ops')).toBe('ops');
    }
  });
  test('golden OPS folder names give the same role by name, folder leaf or alias', () => {
    for (const row of golden) {
      const role = projectRoleWithoutBinding({name:row.name, aiName:row.aiName ?? undefined, folderPath:`/Users/me/product/${row.leaf}`});
      expect({case:row.case, role:role as string}).toEqual({case:row.case, role:row.expectedRole});
    }
  });
  test('explicit roles override names, but the bound OPS identity wins', () => {
    const rows = [
      {id:'a', name:'AgentsToZ-Control', role:'managed'},
      {id:'b', folderPath:'/work/AgentsToZ_byCS', role:'ops'},
      {id:'c', name:'renamed operations', role:'dev'},
      {id:'d', role:'future-role'},
    ];
    expect([...resolveProjectRoles(rows, {opsProjectId:'c'})]).toEqual([['a','managed'], ['b','ops'], ['c','ops'], ['d','unknown']]);
  });
  test('worktrees inherit the project role; broken families are not guessed', () => {
    const rows = [
      {id:'wt', worktreeParentId:'root', role:'managed'}, {id:'root', role:'dev'},
      {id:'missing', worktreeParentId:'absent'}, {id:'cycle-a', worktreeParentId:'cycle-b'}, {id:'cycle-b', worktreeParentId:'cycle-a'},
    ];
    const roles = resolveProjectRoles(rows);
    expect(roles.get('wt')).toBe('dev');
    for (const id of ['missing','cycle-a','cycle-b']) expect(roles.get(id)).toBe('unknown');
  });
  test('shortcuts honor explicit roles and do not select worktree aliases', () => {
    const rows = [
      {id:'clone', role:'managed', name:'AgentsToZ-Control', folderPath:'/work/AgentsToZ_byCS'},
      {id:'renamed-clone', role:'managed', name:'AgentsToZ-OPS', folderPath:'/work/AgentsToZ-OPS'},
      {id:'wt', role:'ops', worktreeParentId:'ops'},
      {id:'ops', role:'ops', name:'My operations'}, {id:'dev', role:'dev', name:'My development'},
    ];
    expect(resolveControlCenterProject(rows)?.id).toBe('ops');
    expect(resolvePrimaryProject(rows, 'https://github.com/example/project')?.id).toBe('dev');
  });
});

describe('role chip selection (VOC 2026-09-24: chip left the detail pane blank)', () => {
  const rows = [
    {id:'ops', name:'AgentsToZ-Control'},
    {id:'dev', folderPath:'/work/AgentsToZ_byCS'},
    {id:'dev-wt', folderPath:'/work/AgentsToZ_byCS/worktrees/x', worktreeParentId:'dev', worktreePath:'/work/AgentsToZ_byCS/worktrees/x'},
    {id:'a', name:'a'}, {id:'b', name:'b'},
  ];
  const roles = resolveProjectRoles(rows);
  test('a single-project role opens that project when the current selection would be hidden', () => {
    expect(projectToSelectForSection('role:dev', rows, roles, 'ops')).toBe('dev');
    expect(projectToSelectForSection('role:ops', rows, roles, 'dev')).toBe('ops');
    expect(projectToSelectForSection('role:ops', rows, roles, null)).toBe('ops');
  });
  test('keeps a selection that stays visible and never guesses among several projects', () => {
    expect(projectToSelectForSection('role:ops', rows, roles, 'ops')).toBeNull();
    expect(projectToSelectForSection('role:managed', rows, roles, 'ops')).toBeNull();
    expect(projectToSelectForSection('role:managed', rows, roles, 'a')).toBeNull();
  });
  test('only role chips select; other sections and clearing the filter change nothing', () => {
    expect(projectToSelectForSection('all', rows, roles, 'ops')).toBeNull();
    expect(projectToSelectForSection('running', rows, roles, null)).toBeNull();
    expect(projectToSelectForSection('role:unknown', rows, roles, null)).toBeNull();
  });
});
