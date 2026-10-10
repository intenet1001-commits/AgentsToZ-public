import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('Codex automatic remember API wiring', () => {
  test('runs on the host even when the usage panel is closed', () => {
    expect(api).toContain("const codexAutoRememberCoordinator = new CodexAutoRememberCoordinator({");
    expect(api).toContain('listObservations: async () => [...await readCodexAutoRememberObservations(), ...readClaudeAutoRememberObservations()]');
    expect(api).toContain('const codexAutoRememberTimer = setInterval(() => {');
    expect(api).toContain('void codexAutoRememberCoordinator.tick();');
  });

  test('uses the registered canonical memory root and shared workspace lease', () => {
    const checkpoint = api.slice(api.indexOf('const prepareCodexAutoRememberProjectResolver'), api.indexOf('const server = Bun.serve({'));
    expect(checkpoint).toContain('readRegistered: readPortsFileStrict');
    expect(checkpoint).toContain('detectIdentity: detectProjectMemoryIdentity');
    expect(checkpoint).toContain('prepareProjectResolver: prepareCodexAutoRememberProjectResolver');
    expect(checkpoint).not.toContain('candidate => detectProjectMemory(candidate)');
    expect(checkpoint).toContain('withManagedWorkspaceLease(');
    expect(checkpoint.indexOf('withManagedWorkspaceLease(')).toBeLessThan(checkpoint.indexOf('await project.validateRegistration?.()'));
    expect(checkpoint.indexOf('await project.validateRegistration?.()')).toBeLessThan(checkpoint.indexOf('const current = detectProjectMemory('));
    expect(checkpoint).toContain('!isActive() || !await project.validateRegistration?.() || !isActive()');
    expect(checkpoint).toContain('current.config.memoryId !== project.memoryId');
    expect(checkpoint).toContain("agent: observation.sourceAgent ?? 'codex'");
    expect(checkpoint).toContain('preservePreferredAgent: true');
  });

  test('exposes only explicit local settings and status endpoints', () => {
    expect(api).toContain('"/api/project-memory/auto-checkpoint/status"');
    expect(api).toContain('"/api/project-memory/auto-checkpoint/settings"');
    expect(api).toContain("typeof body.enabled !== 'boolean'");
    expect(api).toContain('프로젝트 기억 자동 체크포인트 사용 여부가 필요합니다.');
    expect(api).not.toContain('자동 세션 기억 사용 여부가 필요합니다.');
  });
});
