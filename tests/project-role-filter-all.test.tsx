import {expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectRoleFilters} from '../src/ProjectRoleLabels';

const projects = [{id: 'a', name: 'A'}, {id: 'b', name: 'B'}, {id: 'c', name: 'C'}];
const roles = new Map([['a', 'ops'], ['b', 'dev'], ['c', 'dev']] as const);

function render(section: string, onSelect: (s: string) => void = () => {}) {
  return renderToStaticMarkup(<ProjectRoleFilters projects={projects} roles={roles} section={section} onSelect={onSelect} />);
}

test('role filters show an explicit 「전체 역할」 chip counting every role', () => {
  const html = render('all');
  expect(html).toContain('data-testid="project-role-filter-all"');
  expect(html).toMatch(/data-testid="project-role-filter-all" aria-pressed="true"[^>]*>전체 역할 · 3</);
});

test('「전체 역할」 is not pressed while a role filter is active', () => {
  expect(render('role:dev')).toMatch(/data-testid="project-role-filter-all" aria-pressed="false"/);
  // 역할이 아닌 섹션(실행 중 등)은 역할 필터가 없는 상태다.
  expect(render('running')).toMatch(/data-testid="project-role-filter-all" aria-pressed="true"/);
});

test('clicking 「전체 역할」 clears only a role filter', () => {
  const calls: string[] = [];
  const element = ProjectRoleFilters({projects, roles, section: 'role:dev', onSelect: s => calls.push(s)}) as React.ReactElement<{children: React.ReactNode[]}>;
  const allChip = (element.props.children as React.ReactNode[]).find(
    (child): child is React.ReactElement<{onClick: () => void; 'data-testid': string}> =>
      React.isValidElement(child) && (child.props as {'data-testid'?: string})['data-testid'] === 'project-role-filter-all');
  expect(allChip).toBeDefined();
  allChip!.props.onClick();
  expect(calls).toEqual(['all']);

  const idle: string[] = [];
  const running = ProjectRoleFilters({projects, roles, section: 'running', onSelect: s => idle.push(s)}) as React.ReactElement<{children: React.ReactNode[]}>;
  const runningChip = (running.props.children as React.ReactNode[]).find(
    (child): child is React.ReactElement<{onClick: () => void}> =>
      React.isValidElement(child) && (child.props as {'data-testid'?: string})['data-testid'] === 'project-role-filter-all');
  runningChip!.props.onClick();
  expect(idle).toEqual([]);
});
