import { describe, expect, test } from 'bun:test';
import { buildHermesProjectHandoffPrompt } from '../src/hermesProjectHandoffPrompt';

describe('project to local Hermes profile handoff', () => {
  test('includes the selected project and profile and excludes Telegram group creation', () => {
    const prompt = buildHermesProjectHandoffPrompt({
      projectName: 'csncompany2-0',
      canonicalPath: '/work/csncompany2-0',
      memoryId: 'memory-1',
      githubUrl: 'https://github.com/example/project',
      profileName: 'csncompany2-0-hermes',
    });
    expect(prompt).toContain('csncompany2-0');
    expect(prompt).toContain('/work/csncompany2-0');
    expect(prompt).toContain('memory-1');
    expect(prompt).toContain('csncompany2-0-hermes');
    expect(prompt).toContain('Telegram 그룹이나 Telegram Bot은 만들지 말고');
    expect(prompt).not.toMatch(/\\d{8,}:[A-Za-z0-9_-]{20,}/);
  });

  test('fails closed when project identity or profile is missing', () => {
    expect(buildHermesProjectHandoffPrompt({ profileName: 'profile-1' })).toBe('');
    expect(buildHermesProjectHandoffPrompt({ projectName: 'p', canonicalPath: '/p', memoryId: 'm', profileName: '' })).toBe('');
  });
});
