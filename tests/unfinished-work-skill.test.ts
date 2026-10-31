import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTSTOZ_USE_MCP_TOOLS } from '../agentstoz-use-mcp-server';
import { UNFINISHED_WORK_SKILL, UNFINISHED_WORK_SKILL_NAME } from '../src/unfinishedWorkSkill';
import { userMemoryRange } from '../src/userMemoryRecall';
import { workroomUnfinishedWorkCopy } from '../src/workroomUnfinishedWorkCopy';
import { USER_MEMORY_HISTORY_INCOMPLETE_REASONS } from '../src/userMemoryHistoryServer';

// The skill is prose the agent follows literally; a renamed tool, enum value or
// error code would silently turn the dated review into a guess.
test('the unfinished-work skill names only tools, values and error codes the host provides', () => {
  const tools = new Map(AGENTSTOZ_USE_MCP_TOOLS.map(tool => [tool.name, tool] as const));
  const named = [...new Set(UNFINISHED_WORK_SKILL.match(/agentstoz_use_[a-z_]+/g) ?? [])];
  expect(named).toContain('agentstoz_use_list_user_memory_history');
  for (const name of named) expect(tools.has(name)).toBe(true);
  const schema = tools.get('agentstoz_use_list_user_memory_history')!.inputSchema as { properties: Record<string, { enum?: string[] }> };
  const origins = [...UNFINISHED_WORK_SKILL.matchAll(/origin "([a-z]+)"/g)].map(match => match[1]!);
  expect(new Set(origins)).toEqual(new Set(['human', 'all']));
  for (const origin of origins) expect(schema.properties.origin?.enum).toContain(origin);
  const server = readFileSync(join(import.meta.dir, '..', 'api-server.ts'), 'utf8');
  const codes = [...new Set(UNFINISHED_WORK_SKILL.match(/USER_MEMORY_[A-Z_]+/g) ?? [])];
  expect(codes).toEqual(['USER_MEMORY_CURSOR_EXPIRED']);
  for (const code of codes) expect(server).toContain(`'${code}'`);
  const example = UNFINISHED_WORK_SKILL.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/)?.[0];
  expect(example).toBeDefined();
  const later = new Date(Date.parse(example!) + 86_400_000).toISOString();
  expect(userMemoryRange(example, later).start).toBe(new Date(example!).toISOString());
  // What I Said captures only these two agents (its store schema allows no other source).
  expect(UNFINISHED_WORK_SKILL).toContain('only prompts captured from Claude and Codex conversations');
  expect(UNFINISHED_WORK_SKILL).toContain('collection-outdated means');
  expect(UNFINISHED_WORK_SKILL).toContain('even if an older host says complete:true');
  expect(UNFINISHED_WORK_SKILL).toContain('never trigger capture automatically');
  expect(UNFINISHED_WORK_SKILL).toContain('older host omits retentionGuard');
  expect(UNFINISHED_WORK_SKILL).toContain('retention-expired means');
  expect(UNFINISHED_WORK_SKILL).toContain('older host omits clockGuard');
  expect(UNFINISHED_WORK_SKILL).toContain('clock-reversed means');
  expect(UNFINISHED_WORK_SKILL).toContain('Human-delivery evidence is not proof that every record is an independent user request');
  expect(readFileSync(join(import.meta.dir, '..', 'src', 'whatISaidStore.ts'), 'utf8')).toContain('export type WhatISaidAgent = "claude" | "codex";');
});

test('the tool description and skill name exactly the incomplete reasons a page can give', () => {
  const tool = AGENTSTOZ_USE_MCP_TOOLS.find(item => item.name === 'agentstoz_use_list_user_memory_history')!;
  const listed = tool.description.match(/incomplete names each reason it is not \(([^)]*)\)/)?.[1]?.split(/,\s*|\s+or\s+/).map(reason => reason.trim());
  expect(new Set(listed)).toEqual(new Set(USER_MEMORY_HISTORY_INCOMPLETE_REASONS.filter(reason => reason !== 'unavailable')));
  for (const reason of UNFINISHED_WORK_SKILL.match(/\b(?:collection-[a-z]+|retention-[a-z]+|clock-(?:unknown|reversed)|truncated-excerpts|more-pages|skipped-rows)\b/g) ?? []) {
    expect(USER_MEMORY_HISTORY_INCOMPLETE_REASONS as readonly string[]).toContain(reason);
  }
});

test('the skill frontmatter is valid for every agent and each Workroom request names it exactly', () => {
  const frontmatter = UNFINISHED_WORK_SKILL.match(/^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n/);
  expect(frontmatter?.[1]).toBe(UNFINISHED_WORK_SKILL_NAME);
  expect(UNFINISHED_WORK_SKILL_NAME).toMatch(/^[a-z0-9-]{1,64}$/);
  expect(frontmatter![2]!.length).toBeLessThanOrEqual(1024);
  for (const copy of Object.values(workroomUnfinishedWorkCopy)) expect(copy.request).toContain(UNFINISHED_WORK_SKILL_NAME);
});

test('a full-period review continues bounded batches and distinguishes search coverage from release evidence', () => {
  expect(UNFINISHED_WORK_SKILL).toContain('at most 12 pages or 15 seconds');
  expect(UNFINISHED_WORK_SKILL).toContain('continue with another bounded batch without asking again');
  expect(UNFINISHED_WORK_SKILL).not.toContain('when the user explicitly asks to read to the end');
  expect(UNFINISHED_WORK_SKILL).toContain('when any prompts were filtered out');
  expect(UNFINISHED_WORK_SKILL).toContain('human-only pass cannot establish that all user requests were reviewed');
  expect(UNFINISHED_WORK_SKILL).toContain('no cursor (cursors are origin-bound)');
  expect(UNFINISHED_WORK_SKILL).toContain('unreviewed scope');
  expect(UNFINISHED_WORK_SKILL).toContain('implementation, tests, deployment or installation, and real-use verification');
  expect(UNFINISHED_WORK_SKILL).toContain('source commit or simulator pass alone leaves the requested deployment unverified or unfinished');
});


test('restarts do not carry stale decisions across changed or expired records', () => {
  const cursor = UNFINISHED_WORK_SKILL.split('On USER_MEMORY_CURSOR_EXPIRED alone,')[1]!.split('On an unavailable page,')[0]!;
  expect(cursor).toContain('verifies the same content hash and provenance');
  expect(cursor).toContain('Reassess changed content or provenance');
  expect(cursor).toContain('discard findings for ids absent from the completed restarted traversal');
  expect(cursor).toContain('never skip a record based on id alone');
  expect(cursor).toContain('changed or were deleted');
  expect(cursor).toContain('discard all assessments and evidence notes from previous passes over the period');
  expect(cursor).toContain('reassess the new traversal without reusing prior id-based decisions');
  expect(cursor).toContain('If the restart fails or the condition recurs, report the review incomplete');

  const retention = UNFINISHED_WORK_SKILL.split('retention-expired means')[1]!.split('Inspect coverage.retentionGuard')[0]!;
  expect(retention).toContain('discard assessments and evidence notes from all previous passes over the period');
  expect(retention).toContain('discard expired originals and fragments without changing them');
  expect(retention).toContain('reassess the surviving records');
  expect(UNFINISHED_WORK_SKILL).toContain('discard findings for ids absent from the completed all pass');
});
