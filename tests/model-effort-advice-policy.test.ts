import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProjectMemory, upgradeProjectMemoryAgent } from '../project-memory-server';
import { MODEL_EFFORT_ADVICE_POLICY } from '../src/modelEffortAdvicePolicy';
import { hasCurrentSharedOutputStyle } from '../src/agentOutputStyle';
import { buildStandaloneInitPrompt } from '../src/externalMemorySetupPrompts';
import { CURRENT_PROJECT_MEMORY_VERSION } from '../src/projectMemoryVersion';

test('initialization and upgrade deliver one shared recommendation policy without replacing project instructions or memories', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-effort-policy-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'Keep my project instruction.\n');
    initializeProjectMemory({ folderPath: root, projectName: 'advice', agent: 'codex', autoBackup: false });
    const memory = readFileSync(join(root, '.agent-memory/CORE.md'), 'utf8');
    for (let repeat = 0; repeat < 2; repeat++) {
      upgradeProjectMemoryAgent({ folderPath: root });
      for (const path of ['.agents/skills/project-memory/SKILL.md', '.claude/skills/project-memory/SKILL.md']) {
        const skill = readFileSync(join(root, path), 'utf8');
        expect(skill.split(MODEL_EFFORT_ADVICE_POLICY)).toHaveLength(2);
        expect(skill).toContain(`memory-agent-version:${CURRENT_PROJECT_MEMORY_VERSION}`);
      }
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('Keep my project instruction.');
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain("connected project's auto/recommend/off mode");
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).not.toContain('Recommend only;\n  never auto-switch');
      for (const path of ['AGENTS.md', 'CLAUDE.md', '.agents/rules/agentstoz-output-style.md']) {
        const instructions = readFileSync(join(root, path), 'utf8');
        expect(hasCurrentSharedOutputStyle(instructions)).toBe(true);
        expect(instructions.split(MODEL_EFFORT_ADVICE_POLICY.trimEnd())).toHaveLength(2);
      }
      expect(readFileSync(join(root, '.agent-memory/CORE.md'), 'utf8')).toBe(memory);
    }
    expect(buildStandaloneInitPrompt()).toContain(MODEL_EFFORT_ADVICE_POLICY);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('memory-delivered desktop guidance is advice-only with independent two-mode host preference and bounded reads',()=>{
 expect(MODEL_EFFORT_ADVICE_POLICY).toContain('Desktop apps never auto-change effort');
 expect(MODEL_EFFORT_ADVICE_POLICY).toContain('have recommend (default) and off only');
 expect(MODEL_EFFORT_ADVICE_POLICY).toContain('desktop-effort-advice.json (v1 mode: recommend or off)');
 expect(MODEL_EFFORT_ADVICE_POLICY).toContain('CLI and desktop choices are independent');
 expect(MODEL_EFFORT_ADVICE_POLICY).toContain('maximum 4096 bytes');
});
