import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveProjectRoles } from '../src/projectRole';
import { resolveConversationTargetAlias } from '../src/conversationTargetAlias';

// 2026-09-27 실측: 역할이 저장되지 않은 AgentsToZ_byCS 때문에 「아젠투지개발」이 항상
// "role=dev인 현재 등록 프로젝트를 찾지 못했습니다"로 실패했다. MCP 목록이 저장값만 읽었다.
test('역할 미저장 등록 프로젝트도 앱과 같은 규칙으로 DEV가 되어 호칭이 풀린다', () => {
  // OPS 폴더는 AgentsToZ-OPS로 바뀌었고, 아직 이전하지 않은 Mac은 옛 이름 그대로다.
  for (const opsName of ['AgentsToZ-Control', 'AgentsToZ-OPS']) {
    const ports = [
      { id: 'ops-1', name: opsName, folderPath: `/u/p/${opsName}` },
      { id: 'dev-1', name: 'AgentsToZ_byCS', folderPath: '/u/p/AgentsToZ_byCS' },
      { id: 'wt-1', name: 'AgentsToZ_byCS · feat', worktreeParentId: 'dev-1', worktreePath: '/u/p/AgentsToZ_byCS/worktrees/feat' },
      { id: 'm-1', name: '이봉이주차에이전트', role: 'managed', folderPath: '/u/p/x' },
    ];
    const roles = resolveProjectRoles(ports);
    expect(roles.get('dev-1')).toBe('dev');
    expect(roles.get('ops-1')).toBe('ops');
    const projects = ports.map(p => ({ id: p.id, name: p.name, role: roles.get(p.id), scope: ('worktreeParentId' in p ? 'worktree' : 'main') as 'main' | 'worktree' }));
    expect(resolveConversationTargetAlias('아젠투지개발', projects)).toMatchObject({ kind: 'project', projectId: 'dev-1' });
  }
});

test('MCP 프로젝트 목록은 resolveProjectRoles 결과를 역할로 싣는다', () => {
  const src = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function listAgentsToZUseProjects'), src.indexOf('type AgentsToZUseWorkspaceRoot'));
  // 2026-09-29: 역할은 agentsToZUseProjectRoles를 거친다 — resolveProjectRoles에 OPS 프로필의 연결 프로젝트를
  // 함께 넘겨 resolve-target·음성과 같은 역할을 싣는다(동작은 agentstoz-use-target-consistency.test.ts가 본다).
  expect(fn).toContain('agentsToZUseProjectRoles(registered)');
  expect(fn).toContain('roles.get(candidate.id)');
  const helper = src.slice(src.indexOf('function agentsToZUseProjectRoles'), src.indexOf('async function agentsToZUseProjectStatus'));
  expect(helper).toContain('resolveProjectRoles(unique, { opsProjectId: boundOpsProjectId() })');
});
