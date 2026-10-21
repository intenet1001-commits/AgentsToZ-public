import {expect, test} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ProjectRoleFilters} from '../src/ProjectRoleLabels';
import {AgentsToZMascot} from '../src/components/AgentsToZMascot';

test('the OPS filter row opens the OPS Workroom with plain text — the character is the voice dock only (VOC 2026-09-29)', () => {
  const html = renderToStaticMarkup(<ProjectRoleFilters projects={[{id: 'ops', name: 'AgentsToZ-Control'}]} roles={new Map([['ops', 'ops']])} section="all" onSelect={() => {}} onOpenOpsWorkroom={() => {}} />);
  expect(html).toContain('data-testid="project-role-open-ops-workroom"');
  expect(html).toContain('OPS 워크룸 열기');
  expect(html).not.toContain('agentstoz-mascot');
});

test('the 아젠투지 character cycles its poses and stays out of the accessibility tree (VOC 2026-09-24)', () => {
  const html = renderToStaticMarkup(<AgentsToZMascot />);
  expect(html).toContain('data-testid="agentstoz-mascot"');
  expect(html).toContain('data-mode="cycle"');
  expect(html).toContain('aria-hidden="true"');
});
