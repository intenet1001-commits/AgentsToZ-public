import { describe, expect, test } from 'bun:test';
import { buildExistingMemoryConnectionPrompt, memoryDirectoryPurpose, projectMemoryLinkRecovery } from '../src/projectMemoryConnectionGuidance';

const memoryId = '51c574e8-2109-4065-92e0-66523c206fe8';

describe('existing memory connection guidance', () => {
  test('OPS and its legacy repository display as operating memory while ordinary projects stay DEV', () => {
    for (const projectName of ['AgentsToZ-OPS', 'AgentsToZ-Control', ' agentstoz-ops ']) {
      expect(memoryDirectoryPurpose({ projectName, githubUrl: null })).toMatchObject({ kind: 'ops', label: 'OPS 운영 기억' });
    }
    expect(memoryDirectoryPurpose({ projectName: '운영 총괄', githubUrl: 'git@github.com:owner/AgentsToZ-Control.git' }).kind).toBe('ops');
    expect(memoryDirectoryPurpose({ projectName: '고객관리', githubUrl: 'https://github.com/owner/AgentsToZ-OPS' }).kind).toBe('ops');
    for (const projectName of ['my-ops', 'AgentsToZ-OPS-backup', 'AgentsToZ_byCS']) {
      expect(memoryDirectoryPurpose({ projectName, githubUrl: null }).kind).toBe('dev');
    }
    expect(memoryDirectoryPurpose({ projectName: 'demo', githubUrl: 'https://example.org/owner/AgentsToZ-OPS' }).kind).toBe('dev');
  });

  test('OPS requests preserve its ID and profile marker and keep review independent from topic linking', () => {
    const prompt = buildExistingMemoryConnectionPrompt({ memoryId, projectName: 'AgentsToZ-OPS', githubUrl: 'https://github.com/owner/AgentsToZ-OPS' });
    expect(JSON.parse(prompt.split('\n')[1]!.replace('대상 정보(JSON): ', '')).memoryId).toBe(memoryId);
    expect(prompt).toContain('같은 ID');
    expect(prompt).toContain('.agentstoz-control-profile.json');
    expect(prompt).toContain('새 profileId·memoryId를 만들지 마세요');
    expect(prompt).toContain('인증된 사람의 검토');
    expect(prompt).toContain('일반 project-memory 저장으로 승인 경계를 우회하지');
    expect(prompt).toContain('"project": 위 memoryId');
  });

  test('missing local registration preserves the exact requested selector without claiming missing remote memory', () => {
    expect(projectMemoryLinkRecovery(` ${memoryId} `)).toMatchObject({ project: memoryId, requiresLocalRegistration: true });
    const prompt = buildExistingMemoryConnectionPrompt({ memoryId, projectName: 'demo', githubUrl: null });
    expect(prompt).toContain('Supabase에 기억이 없다는 뜻은 아닙니다');
    expect(prompt).toContain('/project_from_memory <기존 memoryId>');
    expect(prompt).toContain('/memory_start는 새 독립 기억');
  });

  test('copied repository metadata omits URL credentials and unrelated fields', () => {
    const prompt = buildExistingMemoryConnectionPrompt({ memoryId, projectName: 'demo', githubUrl: 'https://user:secret@github.com/owner/demo.git?token=private-token#secret-fragment' });
    expect(prompt).toContain('https://github.com/owner/demo');
    expect(prompt).not.toContain('private-token');
    expect(prompt).not.toContain('secret');
  });
});
