import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');

describe('Codex automatic remember API wiring', () => {
  test('runs on the host even when the usage panel is closed', () => {
    expect(/const codexAutoRememberCoordinator(?::CodexAutoRememberCoordinator)? = new CodexAutoRememberCoordinator\(/.test(api)).toBe(true);
    const observations=api.slice(api.indexOf('async function readThreadCheckpointObservations'),api.indexOf('const codexAutoRememberCoordinator'));
    expect(observations).toContain('readCodexAutoRememberObservations()');expect(observations).toContain('readClaudeAutoRememberObservations()');
    const tick=api.slice(api.indexOf('async function tickWorkroomMemory'),api.indexOf('// Background capture is independent'));
    expect(tick).toContain('if(threadCheckpointTickRunning)return');
    expect(tick).toContain('await workroomThreadService.checkpointTick();await codexAutoRememberCoordinator.tick();');
    expect(tick).toContain('finally{threadCheckpointObservations=null;threadCheckpointTickRunning=false;}');
    expect(tick).toContain('setInterval(() => {void tickWorkroomMemory().catch(()=>{});}, 15_000)');
    expect(tick).toContain('queueMicrotask(() => { void tickWorkroomMemory().catch(()=>{}); });');
    expect(api.includes('listObservations: readThreadCheckpointObservations')).toBe(true);
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
