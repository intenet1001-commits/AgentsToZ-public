import { describe, expect, test } from 'bun:test';
import {
  githubRepositoryIdentity,
  normalizeGithubCollaborators,
  repositoryRolesFor,
} from '../src/githubRepositoryRoles';

describe('GitHub 저장소 소유자·협업자', () => {
  test('저장소 URL에서 소유자와 정규화 URL을 구한다', () => {
    expect(githubRepositoryIdentity('git@github.com:Intenet1001/AgentsToZ.git')).toEqual({
      repositoryUrl: 'https://github.com/intenet1001/agentstoz',
      ownerLogin: 'Intenet1001',
      repositoryName: 'AgentsToZ',
    });
  });

  test('협업자 입력은 @·쉼표·줄바꿈을 받고 중복을 제거한다', () => {
    expect(normalizeGithubCollaborators('@intenet1002, INTENET1002\nhelper'))
      .toEqual(['intenet1002', 'helper']);
  });

  test('저장된 역할이 없으면 URL 소유자를 쓰고 있으면 명시값을 쓴다', () => {
    expect(repositoryRolesFor('https://github.com/intenet1001/repo', null))
      .toEqual(expect.objectContaining({ ownerLogin: 'intenet1001', collaborators: [] }));
    expect(repositoryRolesFor('https://github.com/intenet1001/repo', {
      repository_url: 'https://github.com/intenet1001/repo',
      owner_login: 'intenet1002',
      collaborators: ['intenet1001'],
      updated_at: '2026-08-23T00:00:00Z',
    })).toEqual(expect.objectContaining({ ownerLogin: 'intenet1002', collaborators: ['intenet1001'] }));
  });
});
