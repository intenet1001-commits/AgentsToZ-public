import {describe, expect, test} from 'bun:test';
import {resolveProjectRoles} from '../src/projectRole';
import {resolveControlCenterProject} from '../src/controlCenterProject';
import {resolvePrimaryProject} from '../src/primaryProject';

describe('local project roles (not bot USE/DEV purpose or authorization)', () => {
  test('projects legacy rows without rewriting them', () => {
    const rows = [{id:'ops', name:'AgentsToZ-Control'}, {id:'dev', folderPath:'/work/AgentsToZ_byCS'}, {id:'song', name:'song-app'}];
    const before = JSON.stringify(rows);
    expect([...resolveProjectRoles(rows)]).toEqual([['ops','ops'], ['dev','dev'], ['song','managed']]);
    expect(JSON.stringify(rows)).toBe(before);
    expect(resolveProjectRoles(rows, {devProjectId:'ops'}).get('ops')).toBe('ops');
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
      {id:'wt', role:'ops', worktreeParentId:'ops'},
      {id:'ops', role:'ops', name:'My operations'}, {id:'dev', role:'dev', name:'My development'},
    ];
    expect(resolveControlCenterProject(rows)?.id).toBe('ops');
    expect(resolvePrimaryProject(rows, 'https://github.com/example/project')?.id).toBe('dev');
  });
});
