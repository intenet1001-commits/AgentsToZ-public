import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AGENTSTOZ_INVOCATION_VERSION,
  installAgentsToZInvocation,
  reconcileAgyCliUnfinishedWork,
  withAgentsToZInvocation,
} from '../src/agentstozInvocationInstaller';
import {AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE} from '../src/agentstozMcpAgentChoice';
import {UNFINISHED_WORK_MANAGED_MARKER, UNFINISHED_WORK_SKILL, UNFINISHED_WORK_SKILL_VERSION} from '../src/unfinishedWorkSkill';

// The always-on line that points every agent at the backlog skill (invocation 10).
const UNFINISHED_LINE_START = '- For 미처리·미완료 업무/과제, 후속 작업, backlog or 장기기억 진행 현황 of a registered AgentsToZ project (current or named, e.g. 아젠투지데브), follow the agentstoz-unfinished-work skill';
const INSTRUCTION_FILES = (home: string, hermesHome: string) => [join(home, '.codex', 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md'), join(home, '.gemini', 'GEMINI.md'), join(home, '.gemini', 'config', 'GEMINI.md'), join(hermesHome, 'SOUL.md')];

describe('AgentsToZ conversational invocation installer', () => {
  // Updated 2026-09-29 (review L5): the agy entries are written only where agy keeps its global
  // customizations, ~/.gemini/config/, and only when that folder exists (agy installed). This home
  // simulates an installed agy; the test below covers a machine without it.
  test('installs native entry points for four agents and is idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-'));
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const first = installAgentsToZInvocation({ home, hermesHome });
    expect(first.map(result => result.target)).toEqual(['codex', 'claude', 'antigravity', 'hermes']);
    expect(first.every(result => result.changed)).toBe(true);
    expect(readFileSync(join(home, '.claude', 'commands', 'agentstoz.md'), 'utf8')).toContain('$ARGUMENTS');
    expect(readFileSync(join(home, '.claude', 'commands', 'remember_agentstoz.md'), 'utf8')).toContain('only a candidate');
    expect(readFileSync(join(hermesHome, 'skills', 'remember_agentstoz', 'SKILL.md'), 'utf8')).toContain('name: remember_agentstoz');
    for (const path of [
      join(home, '.codex', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.claude', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'),
      // agy (Antigravity CLI) reads its global customizations from ~/.gemini/config/ — its bundled
      // docs name `~/.gemini/config/skills/<name>/SKILL.md` as the global skill location.
      join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md'),
      join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'),
    ]) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('agentstoz_use_create_project');
      expect(text).toContain('DEV long-term memory');
      expect(text).toContain('아젠투지오피에스');
      expect(text).toContain('아젠투지데브');
      expect(text).toContain('아젠투지총괄');
      expect(text).toContain('아젠투지개발');
      expect(text).toContain('프로젝트담당자');
      expect(text).toContain('agentstoz_use_resolve_target');
      expect(text).toContain('agentstoz_use_submit_ops_request');
      expect(text).toContain('agentstoz_use_wait_ops_request');
      expect(text).toContain('Admission or a window is not completion');
      expect(text).toContain('동명 또는 DEV 후보가 여러 개');
      expect(text).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
      expect(text).toContain('Pass the chosen surface explicitly to start/open');
      expect(text).toContain('Hermes open_code_app accepts only an explicit default');
    }
    // 팀 작전: every agent carries the same team skill, so whichever model the person opened can lead.
    for (const path of [
      join(home, '.codex', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(home, '.claude', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(home, '.gemini', 'config', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(hermesHome, 'skills', 'agentstoz-team', 'SKILL.md'),
    ]) {
      const text = readFileSync(path, 'utf8');
      for (const part of ['name: agentstoz-team', 'agentstoz_use_create_team', 'agentstoz_use_wait_team', 'agentstoz_use_report_team_task', 'agentstoz_use_close_team', 'git merge --no-ff', 'Never push']) expect(text).toContain(part);
      expect(text).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
      expect(text).not.toContain('Otherwise choose by strength');
      expect(text).not.toContain('Add one yourself when the change is risky');
      expect(text).toContain('A natural request for a team alone does not delegate AI selection');
      expect(text).toContain('Hermes default, Hermes · Claude and Hermes · Codex are distinct choices');
      expect(text).toContain('never silently changed to internal');
      expect(text).toContain('Every fresh MCP team member needs an explicit surface');
      expect(text).toContain('Legacy version 1 canonical blocks');
      expect(text).toContain('hermesVariant: "default" in MCP arguments explicitly, without asking again');
    }
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('follow the agentstoz-team skill');
    expect(readFileSync(join(home, '.claude', 'commands', 'agentstoz.md'), 'utf8')).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
    expect(AGENTSTOZ_INVOCATION_VERSION).toBeGreaterThanOrEqual(10);
    for (const path of INSTRUCTION_FILES(home, hermesHome)) {
      const text = readFileSync(path, 'utf8');
      expect(text).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
      expect(text.split(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE)).toHaveLength(2);
      expect(text).toContain(`AgentsToZ invocation-version:${AGENTSTOZ_INVOCATION_VERSION}`);
      // Claude Code lists ~1,000 user skills by bare name, so this always-on line is its reliable trigger.
      const line = text.split('\n').find(entry => entry.startsWith(UNFINISHED_LINE_START))!;
      expect(line).toBeDefined();
      expect(text.split(UNFINISHED_LINE_START)).toHaveLength(2);
      expect([...line].length).toBeLessThan(300);
      expect(line).toContain('`/agentstoz-unfinished-work`');
      expect(line).toContain('`$agentstoz-unfinished-work`');
      expect(line).toContain('improvement instructions only after the user picks');
    }
    // The same block body reaches the /agentstoz skill and command.
    expect(readFileSync(join(home, '.claude', 'commands', 'agentstoz.md'), 'utf8')).toContain(UNFINISHED_LINE_START);
    expect(readFileSync(join(hermesHome, 'skills', 'agentstoz', 'SKILL.md'), 'utf8')).toContain(UNFINISHED_LINE_START);
    expect(installAgentsToZInvocation({ home, hermesHome }).every(result => !result.changed)).toBe(true);
    const antigravity = first.find(result => result.target === 'antigravity')!;
    expect(antigravity.paths).toEqual([
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(home, '.gemini', 'skills', 'agentstoz-unfinished-work', 'SKILL.md'),
      join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md'),
      join(home, '.gemini', 'config', 'skills', 'agentstoz-team', 'SKILL.md'),
      join(home, '.gemini', 'config', 'skills', 'agentstoz-unfinished-work', 'SKILL.md'),
      join(home, '.gemini', 'GEMINI.md'),
      // agy's always-on global rule: a standalone GEMINI.md in its customization root.
      join(home, '.gemini', 'config', 'GEMINI.md'),
    ]);
    expect(readFileSync(join(home, '.gemini', 'config', 'GEMINI.md'), 'utf8')).toContain('<!-- AgentsToZ invocation:start -->');
  });

  // Review L5: agy read the skill but no always-on rule, and the installer created ~/.gemini/config
  // itself on machines without agy — which then looked like an installed agy to the next check.
  test('agy rules go to ~/.gemini/config/GEMINI.md next to user rules, and nothing is created without agy', () => {
    const bare = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-no-agy-'));
    const withoutAgy = installAgentsToZInvocation({ home: bare }).find(result => result.target === 'antigravity')!;
    expect(existsSync(join(bare, '.gemini', 'config'))).toBe(false);
    expect(withoutAgy.paths).toEqual([join(bare, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), join(bare, '.gemini', 'skills', 'agentstoz-team', 'SKILL.md'), join(bare, '.gemini', 'skills', 'agentstoz-unfinished-work', 'SKILL.md'), join(bare, '.gemini', 'GEMINI.md')]);
    expect(installAgentsToZInvocation({ home: bare }).every(result => !result.changed)).toBe(true);

    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-agy-rules-'));
    const rules = join(home, '.gemini', 'config', 'GEMINI.md');
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    writeFileSync(rules, '# My agy rules\n\nAlways answer briefly.\n');
    const first = installAgentsToZInvocation({ home }).find(result => result.target === 'antigravity')!;
    expect(first.changed).toBe(true);
    const text = readFileSync(rules, 'utf8');
    expect(text).toStartWith('# My agy rules\n\nAlways answer briefly.\n');
    expect(text.match(/AgentsToZ invocation:start/g)).toHaveLength(1);
    expect(text).toContain('agentstoz_use_get_control_profile');
    expect(installAgentsToZInvocation({ home }).find(result => result.target === 'antigravity')!.changed).toBe(false);
  });

  test('a stale agy global skill is replaced and another agy skill is left alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-agy-'));
    const skill = join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md');
    const other = join(home, '.gemini', 'config', 'skills', 'ego-browser', 'SKILL.md');
    mkdirSync(join(home, '.gemini', 'config', 'skills', 'agentstoz'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'config', 'skills', 'ego-browser'), { recursive: true });
    writeFileSync(skill, '---\nname: agentstoz\ndescription: old\n---\nold body\n');
    writeFileSync(other, '---\nname: ego-browser\n---\nuser skill\n');
    const result = installAgentsToZInvocation({ home }).find(entry => entry.target === 'antigravity')!;
    expect(result.changed).toBe(true);
    expect(readFileSync(skill, 'utf8')).toBe(readFileSync(join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), 'utf8'));
    expect(readFileSync(skill, 'utf8')).not.toContain('old body');
    expect(readFileSync(other, 'utf8')).toBe('---\nname: ego-browser\n---\nuser skill\n');
  });

  test('preserves user instructions and replaces only its managed block', () => {
    const old = `before\n\n<!-- AgentsToZ invocation:start -->\nold\n<!-- AgentsToZ invocation:end -->\n\nafter\n`;
    const next = withAgentsToZInvocation(old);
    expect(next).toStartWith('before');
    expect(next).toEndWith('\n\nafter\n');
    expect(next).not.toContain('\nold\n');
    expect(next.match(/AgentsToZ invocation:start/g)).toHaveLength(1);
  });

  test('updates a symlink target without replacing the symlink', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-link-'));
    const target = join(home, 'real-agents.md');
    const link = join(home, '.codex', 'AGENTS.md');
    writeFileSync(target, 'personal rule\n');
    Bun.spawnSync(['/bin/mkdir', '-p', join(home, '.codex')]);
    symlinkSync(target, link);
    installAgentsToZInvocation({ home });
    expect(readFileSync(target, 'utf8')).toContain('personal rule');
    expect(readFileSync(target, 'utf8')).toContain('아젠투지');
  });

  test('installs the same backlog skill for each agent and preserves a foreign skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-unfinished-'));
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(home, '.gemini', 'config'), {recursive: true});
    installAgentsToZInvocation({home, hermesHome});
    const paths = [join(home, '.codex', 'skills'), join(home, '.claude', 'skills'), join(home, '.gemini', 'skills'), join(home, '.gemini', 'config', 'skills'), join(hermesHome, 'skills')]
      .map(root => join(root, 'agentstoz-unfinished-work', 'SKILL.md'));
    const body = readFileSync(paths[0]!, 'utf8');
    expect(paths.every(path => readFileSync(path, 'utf8') === body)).toBe(true);
    expect(body).toContain('status uncertain');
    expect(body).toContain('not proof there are no outstanding requests');
    expect(body).toContain('Do not execute tasks');
    writeFileSync(paths[0]!, 'My own skill');
    installAgentsToZInvocation({home, hermesHome});
    expect(readFileSync(paths[0]!, 'utf8')).toBe('My own skill');
  });

  test('installs only the backlog skill in an existing agy CLI home and preserves user-owned or newer entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-cli-'));
    const cli = join(home, '.gemini', 'antigravity-cli');
    const skills = join(cli, 'skills');
    const folder = join(skills, 'agentstoz-unfinished-work');
    const skill = join(folder, 'SKILL.md');
    installAgentsToZInvocation({home});
    expect(existsSync(cli)).toBe(false);
    mkdirSync(cli, {recursive: true});
    const first = installAgentsToZInvocation({home}).find(result => result.target === 'antigravity')!;
    expect(first.paths).toContain(skill);
    expect(readFileSync(skill, 'utf8')).toBe(UNFINISHED_WORK_SKILL);
    expect(readdirSync(skills)).toEqual(['agentstoz-unfinished-work']);
    expect(installAgentsToZInvocation({home}).find(result => result.target === 'antigravity')!.changed).toBe(false);

    const newer = `${UNFINISHED_WORK_MANAGED_MARKER}\n<!-- AgentsToZ agentstoz-unfinished-work skill-version:${UNFINISHED_WORK_SKILL_VERSION + 1} -->\nfuture\n`;
    writeFileSync(skill, newer);
    installAgentsToZInvocation({home});
    expect(readFileSync(skill, 'utf8')).toBe(newer);
    writeFileSync(skill, 'personal skill\n');
    expect(installAgentsToZInvocation({home}).find(result => result.target === 'antigravity')!.paths).not.toContain(skill);
    expect(readFileSync(skill, 'utf8')).toBe('personal skill\n');
  });

  test('does not follow symlinks in the agy CLI skill path', () => {
    for (const linkAt of ['antigravity-cli', 'skills', 'agentstoz-unfinished-work', 'SKILL.md']) {
      const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-cli-link-'));
      const cli = join(home, '.gemini', 'antigravity-cli');
      const skills = join(cli, 'skills');
      const folder = join(skills, 'agentstoz-unfinished-work');
      const destination = join(home, 'foreign');
      mkdirSync(destination, {recursive: true});
      const link = linkAt === 'antigravity-cli' ? cli : linkAt === 'skills' ? skills : linkAt === 'agentstoz-unfinished-work' ? folder : join(folder, 'SKILL.md');
      mkdirSync(join(link, '..'), {recursive: true});
      const target = linkAt === 'SKILL.md' ? join(destination, 'personal.md') : destination;
      if (linkAt === 'SKILL.md') writeFileSync(target, 'personal\n');
      symlinkSync(target, link);
      const result = installAgentsToZInvocation({home}).find(entry => entry.target === 'antigravity')!;
      expect(result.paths).not.toContain(join(folder, 'SKILL.md'));
      expect(readdirSync(destination)).toEqual(linkAt === 'SKILL.md' ? ['personal.md'] : []);
      if (linkAt === 'SKILL.md') expect(readFileSync(target, 'utf8')).toBe('personal\n');
    }
  });

  test('first-launch reconciliation refuses to create a CLI home through a symlinked or absent parent', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-agy-cli-parent-'));
    expect(reconcileAgyCliUnfinishedWork(home, {createCliHome: true}).paths).toEqual([]);
    expect(existsSync(join(home, '.gemini'))).toBe(false);
    const foreign = join(home, 'foreign'); mkdirSync(foreign);
    symlinkSync(foreign, join(home, '.gemini'));
    expect(reconcileAgyCliUnfinishedWork(home, {createCliHome: true}).paths).toEqual([]);
    expect(readdirSync(foreign)).toEqual([]);
  });

  // Review 2026-10-28: only SKILL.md was checked, so a symlinked skill folder without a SKILL.md
  // carried the write through the link into a foreign location, against the installer's own rule.
  test('never writes the backlog skill through a symlinked, foreign or non-folder skill path', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-unfinished-folder-'));
    const foreign = join(home, 'dotfiles', 'someone-elses-skill');
    mkdirSync(foreign, {recursive: true});
    writeFileSync(join(foreign, 'notes.md'), 'theirs\n');
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(claudeSkills, {recursive: true});
    symlinkSync(foreign, join(claudeSkills, 'agentstoz-unfinished-work'));
    // A real folder with someone else's files and no SKILL.md is theirs as well.
    const codexFolder = join(home, '.codex', 'skills', 'agentstoz-unfinished-work');
    mkdirSync(codexFolder, {recursive: true});
    writeFileSync(join(codexFolder, 'README.md'), 'my draft skill\n');
    // A file where the folder should be must neither be replaced nor stop the other installs.
    mkdirSync(join(home, '.gemini', 'skills'), {recursive: true});
    writeFileSync(join(home, '.gemini', 'skills', 'agentstoz-unfinished-work'), 'not a folder\n');
    // A SKILL.md that is a folder is not ours to replace.
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(hermesHome, 'skills', 'agentstoz-unfinished-work', 'SKILL.md'), {recursive: true});

    const results = installAgentsToZInvocation({home, hermesHome});
    expect(existsSync(join(foreign, 'SKILL.md'))).toBe(false);
    expect(readdirSync(foreign)).toEqual(['notes.md']);
    expect(existsSync(join(codexFolder, 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(home, '.gemini', 'skills', 'agentstoz-unfinished-work'), 'utf8')).toBe('not a folder\n');
    expect(readdirSync(join(hermesHome, 'skills', 'agentstoz-unfinished-work', 'SKILL.md'))).toEqual([]);
    for (const result of results) expect(result.paths.some(path => path.includes('agentstoz-unfinished-work'))).toBe(false);
    // The other entry points still install next to the refused folder.
    expect(readFileSync(join(claudeSkills, 'agentstoz', 'SKILL.md'), 'utf8')).toContain('agentstoz_use_get_control_profile');

    // An empty folder (for example after an interrupted first write) is still taken over.
    const fresh = mkdtempSync(join(tmpdir(), 'agentstoz-unfinished-empty-'));
    const empty = join(fresh, '.codex', 'skills', 'agentstoz-unfinished-work');
    mkdirSync(empty, {recursive: true});
    writeFileSync(join(empty, `SKILL.md.tmp-${process.pid}-1`), 'partial');
    installAgentsToZInvocation({home: fresh});
    expect(readFileSync(join(empty, 'SKILL.md'), 'utf8')).toContain('<!-- AgentsToZ agentstoz-unfinished-work skill -->');
  });

  // 2026-10-29: outside the Workroom nothing pointed agents at the skill. The description is what
  // Codex, agy and Hermes match on, so it carries the user's wording — scoped to an AgentsToZ project
  // so a generic to-do request elsewhere does not start a memory review.
  test('the backlog skill triggers on scoped wording, reaches a named project and keeps every follow-up an explicit choice', () => {
    expect(UNFINISHED_WORK_MANAGED_MARKER).toBe('<!-- AgentsToZ agentstoz-unfinished-work skill -->');
    const [, frontmatter = '', body = ''] = UNFINISHED_WORK_SKILL.split(/^---$/m);
    expect(UNFINISHED_WORK_SKILL).toStartWith('---\nname: agentstoz-unfinished-work\ndescription: "');
    const meta = Bun.YAML.parse(frontmatter) as {name: string; description: string};
    expect(meta.name).toBe('agentstoz-unfinished-work');
    const description = meta.description;
    expect([...description].length).toBeLessThanOrEqual(1024);
    for (const term of ['AgentsToZ', '아젠투지데브', '미처리 업무', '미완료 업무', '미완료 과제', '후속 작업', '백로그', '장기기억 기반 진행 현황', '개선 지시', 'unfinished', 'pending', 'outstanding', 'backlog',
      'Read-only review first', 'drafts improvement instructions only for the user to choose']) expect(description).toContain(term);
    expect(description).not.toContain('do not use to execute the work');
    // 「남은 일」 alone is everyday wording (and app UI copy); it only appears tied to long-term memory.
    expect(description.split('남은 일').length).toBe(description.split('장기기억에서 남은 일').length);

    expect(body).toContain(UNFINISHED_WORK_MANAGED_MARKER);
    expect(body).toContain(`skill-version:${UNFINISHED_WORK_SKILL_VERSION} -->`);
    // Step 0: a named target goes through the profile and the resolver, never a guessed path.
    for (const part of ['`agentstoz_use_get_control_profile`', '`agentstoz_use_resolve_target`', 'Use only the project ID it returns', 'ask which project is meant and wait',
      '`agentstoz_use_read_reference` with role `dev`', 'that project ID as `portId`', '`agentstoz_use_recall_user_memory`', '`agentstoz_use_list_user_memory_history`',
      'at most 5 excerpted hits per reference query', 'the dated journal is excluded', 'only what this device captured',
      'only when the user explicitly asks', 'Never guess a path, ID or device']) expect(body).toContain(part);
    // Step 5: drafts first; acting needs the user's pick, launch choices and one delivery per requestId.
    for (const part of ['Improvement instructions (개선 지시)', 'start nothing before an explicit choice', 'continue with the chosen items here',
      '`agentstoz_use_prepare_agent_launch`', 'ask every question it returns and wait', 'an explicit surface', 'read its initial screen',
      '`agentstoz_use_send_workroom_instruction`', 'Keep each returned requestId', 'never resend automatically or under a new ID', '`self:true`',
      'act only on the user\'s explicit choice in step 5']) expect(body).toContain(part);
    expect(body).toContain('not proof there are no outstanding requests');
    expect(body).toContain('Do not execute tasks');
    expect(body.indexOf('0. Choose the target')).toBeLessThan(body.indexOf('1. For the current project'));
    expect(body.indexOf('4. Report')).toBeLessThan(body.indexOf('5. Improvement instructions'));
  });

  // Review 2026-10-29: every sidecar start rewrote the block unconditionally, so an older build
  // (a backup bundle, a dev api-server from an older checkout) rolled a newer block back.
  test('never downgrades a newer block, /agentstoz skill or command, or backlog skill; older and equal copies are still replaced', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentstoz-invocation-newer-'));
    const hermesHome = join(home, '.hermes');
    mkdirSync(join(home, '.gemini', 'config'), {recursive: true});
    installAgentsToZInvocation({home, hermesHome});
    const newer = AGENTSTOZ_INVOCATION_VERSION + 1;
    const block = `<!-- AgentsToZ invocation:start -->\n<!-- AgentsToZ invocation-version:${newer} -->\nnewer body\n<!-- AgentsToZ invocation:end -->`;
    const instructions = INSTRUCTION_FILES(home, hermesHome);
    for (const path of instructions) writeFileSync(path, `mine\n\n${block}\n\nalso mine\n`);
    const wholeFiles = [join(home, '.codex', 'skills', 'agentstoz', 'SKILL.md'), join(home, '.claude', 'skills', 'agentstoz', 'SKILL.md'), join(home, '.claude', 'commands', 'agentstoz.md'),
      join(home, '.gemini', 'skills', 'agentstoz', 'SKILL.md'), join(home, '.gemini', 'config', 'skills', 'agentstoz', 'SKILL.md'), join(hermesHome, 'skills', 'agentstoz', 'SKILL.md')];
    for (const path of wholeFiles) writeFileSync(path, `---\nname: agentstoz\n---\n\n<!-- AgentsToZ invocation-version:${newer} -->\nnewer skill\n`);
    const backlog = join(home, '.claude', 'skills', 'agentstoz-unfinished-work', 'SKILL.md');
    const newerBacklog = `---\nname: agentstoz-unfinished-work\n---\n\n${UNFINISHED_WORK_MANAGED_MARKER}\n<!-- AgentsToZ agentstoz-unfinished-work skill-version:${UNFINISHED_WORK_SKILL_VERSION + 1} -->\nnewer backlog skill\n`;
    writeFileSync(backlog, newerBacklog);

    installAgentsToZInvocation({home, hermesHome});
    for (const path of instructions) expect(readFileSync(path, 'utf8')).toBe(`mine\n\n${block}\n\nalso mine\n`);
    for (const path of wholeFiles) expect(readFileSync(path, 'utf8')).toContain('newer skill');
    expect(readFileSync(backlog, 'utf8')).toBe(newerBacklog);
    expect(withAgentsToZInvocation(`x\n${block}\n`)).toBe(`x\n${block}\n`);

    // An older block (v9, before this check existed) or an equal-version block with stale text is replaced in place.
    for (const version of [9, AGENTSTOZ_INVOCATION_VERSION]) {
      const next = withAgentsToZInvocation(`mine\n\n<!-- AgentsToZ invocation:start -->\n<!-- AgentsToZ invocation-version:${version} -->\nstale\n<!-- AgentsToZ invocation:end -->\n\nalso mine\n`);
      expect(next).toStartWith('mine\n\n');
      expect(next).toEndWith('\n\nalso mine\n');
      expect(next).not.toContain('\nstale\n');
      expect(next).toContain(UNFINISHED_LINE_START);
    }
    // The unstamped first release of the backlog skill (version 1) is replaced by the current one.
    writeFileSync(backlog, `---\nname: agentstoz-unfinished-work\n---\n\n${UNFINISHED_WORK_MANAGED_MARKER}\n# Unfinished work\nold\n`);
    for (const path of wholeFiles) writeFileSync(path, `---\nname: agentstoz\n---\n\n<!-- AgentsToZ invocation-version:9 -->\nolder skill\n`);
    installAgentsToZInvocation({home, hermesHome});
    expect(readFileSync(backlog, 'utf8')).toBe(UNFINISHED_WORK_SKILL);
    for (const path of wholeFiles) expect(readFileSync(path, 'utf8')).toContain(UNFINISHED_LINE_START);
    expect(installAgentsToZInvocation({home, hermesHome}).every(result => !result.changed)).toBe(true);

    // A host moving from the v4 lossless-history skill to v5 must add the end-boundary check.
    writeFileSync(backlog, `---\nname: agentstoz-unfinished-work\n---\n\n${UNFINISHED_WORK_MANAGED_MARKER}\n<!-- AgentsToZ agentstoz-unfinished-work skill-version:4 -->\nold backlog skill\n`);
    installAgentsToZInvocation({home, hermesHome});
    expect(readFileSync(backlog, 'utf8')).toBe(UNFINISHED_WORK_SKILL);
    expect(readFileSync(backlog, 'utf8')).toContain('collection-outdated means');

    // Existing v5 installs acquire bounded automatic continuation and honest release evidence.
    writeFileSync(backlog, `---\nname: agentstoz-unfinished-work\n---\n\n${UNFINISHED_WORK_MANAGED_MARKER}\n<!-- AgentsToZ agentstoz-unfinished-work skill-version:5 -->\nold backlog skill\n`);
    installAgentsToZInvocation({home, hermesHome});
    expect(readFileSync(backlog, 'utf8')).toBe(UNFINISHED_WORK_SKILL);
    expect(readFileSync(backlog, 'utf8')).toContain('continue with another bounded batch without asking again');
  });
});
