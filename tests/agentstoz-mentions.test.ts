import {afterEach, expect, test} from 'bun:test';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AGENTSTOZ_MENTION_SKILL, AGENTSTOZ_MENTION_VERSION, parseAgentMentionReference, referenceExcerpt, withAgentsToZMentions} from '../src/agentstozMention';
import {AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE} from '../src/agentstozMcpAgentChoice';
import {initializeProjectMemory, installProjectMentionAdapters, upgradeProjectMemoryAdapters} from '../project-memory-server';
import {resolveConversationTargetAlias} from '../src/conversationTargetAlias';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
const fixture = () => {const root = mkdtempSync(join(tmpdir(), 'atz-mentions-')); roots.push(root); return root;};

test('project creation and adapter-only upgrade install portable call/reference skills without changing memory identity or content', () => {
  const root = fixture();
  writeFileSync(join(root, 'AGENTS.md'), '# Personal project instructions\n');
  const first = initializeProjectMemory({folderPath: root, autoBackup: false});
  const config = readFileSync(join(root, '.agent-memory/config.json'));
  const memory = readFileSync(join(root, first.config!.sourcePath));
  const skill = join(root, '.agents/skills/agentstoz-mentions/SKILL.md');
  expect(readFileSync(skill, 'utf8')).toBe(AGENTSTOZ_MENTION_SKILL);
  expect(readFileSync(skill, 'utf8')).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
  expect(readFileSync(join(root, '.claude/skills/agentstoz-mentions/SKILL.md'), 'utf8')).toBe(AGENTSTOZ_MENTION_SKILL);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('# Personal project instructions\n');
  rmSync(skill);
  expect(upgradeProjectMemoryAdapters({folderPath: root}).memoryAgent.adaptersUpdateAvailable).toBe(false);
  expect(readFileSync(skill, 'utf8')).toBe(AGENTSTOZ_MENTION_SKILL);
  expect(readFileSync(join(root, '.agent-memory/config.json')).equals(config)).toBe(true);
  expect(readFileSync(join(root, first.config!.sourcePath)).equals(memory)).toBe(true);
});

test('registration installs only guidance, is idempotent and preserves an existing user skill', () => {
  const root = fixture(); installProjectMentionAdapters(root);
  expect(existsSync(join(root, '.git'))).toBe(false);
  expect(existsSync(join(root, '.agent-memory'))).toBe(false);
  const before = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  expect(before).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
  expect(before).toContain(`AgentsToZ mentions-version:${AGENTSTOZ_MENTION_VERSION}`);
  expect(before).toContain('An @ target selects the project/role, not an AI or launch surface');
  expect(before).toContain('Pass the chosen surface explicitly to start/open');
  expect(before).toContain('Hermes open_code_app accepts only an explicit default');
  installProjectMentionAdapters(root);
  expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(before);
  expect(withAgentsToZMentions(before)).toBe(before);
  const other = fixture(), skill = join(other, '.agents/skills/agentstoz-mentions/SKILL.md');
  mkdirSync(join(other, '.agents/skills/agentstoz-mentions'), {recursive: true}); writeFileSync(skill, 'my personal skill');
  expect(() => installProjectMentionAdapters(other)).toThrow('사용자 스킬');
  expect(readFileSync(skill, 'utf8')).toBe('my personal skill');
  expect(existsSync(join(other, 'AGENTS.md'))).toBe(false);
});

test('external literal @/# names resolve the same OPS, DEV and USE without inventing another project', () => {
  const projects = [{id: 'project-shadowloop', name: 'ShadowLoop'}];
  for (const prefix of ['@', '#']) {
    expect(resolveConversationTargetAlias(prefix + 'OPS', projects)).toEqual({kind: 'ops', label: 'AgentsToZ OPS'});
    expect(resolveConversationTargetAlias(prefix + 'ShadowLoop-DEV', projects)).toMatchObject({projectId: projects[0]!.id, executionRole: 'dev'});
    expect(resolveConversationTargetAlias(prefix + 'ShadowLoop-USE', projects)).toMatchObject({projectId: projects[0]!.id, executionRole: 'use'});
  }
});

test('reference requests accept only one read scope and bounded UTF-8 query, never an app or shell operation', () => {
  expect(parseAgentMentionReference({role: 'ops', query: ' narrow topic '})).toEqual({role: 'ops', query: 'narrow topic'});
  expect(parseAgentMentionReference({role: 'use', portId: 'project-shadowloop', query: 'memory'})).toEqual({role: 'use', portId: 'project-shadowloop', serviceKey: 'default', query: 'memory'});
  for (const input of [
    {role: 'ops', query: 'topic', portId: 'another-project'}, {role: 'dev', query: 'topic', portId: '../private'},
    {role: 'dev', query: 'topic', portId: 'project-shadowloop', serviceKey: 'default'},
    {role: 'use', query: 'topic', portId: 'project-shadowloop', call: {tool: 'materials.generate'}},
    {role: 'ops', query: '한'.repeat(667)}, {role: 'ops', query: ''},
  ]) expect(() => parseAgentMentionReference(input)).toThrow();
  const excerpt = referenceExcerpt('한글😀'.repeat(1000), 100);
  expect(excerpt).not.toContain('\ufffd'); expect(new TextEncoder().encode(excerpt).length).toBeLessThanOrEqual(103);
});
