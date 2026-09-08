import { githubRepositoryFromRemote } from './publicRepositoryRemote';

const SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const SAFE_WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

export interface GitHubActionsRepository {
  owner: string;
  repo: string;
}

export function resolveGitHubActionsRepository(input: {
  configuredOwner?: unknown;
  configuredRepo?: unknown;
  repositoryUrl?: unknown;
  originRemote?: unknown;
}): GitHubActionsRepository | null {
  const configuredOwner = typeof input.configuredOwner === 'string' ? input.configuredOwner.trim() : '';
  const configuredRepo = typeof input.configuredRepo === 'string' ? input.configuredRepo.trim() : '';
  if (configuredOwner || configuredRepo) {
    return SAFE_REPOSITORY_PART.test(configuredOwner) && SAFE_REPOSITORY_PART.test(configuredRepo)
      ? { owner: configuredOwner, repo: configuredRepo }
      : null;
  }

  const parse = (value: unknown): GitHubActionsRepository | null => {
    if (typeof value !== 'string' || !value.trim()) return null;
    const repository = githubRepositoryFromRemote(value);
    if (!repository) return null;
    const [owner, repo] = repository.split('/');
    return owner && repo ? { owner, repo } : null;
  };

  if (typeof input.repositoryUrl === 'string' && input.repositoryUrl.trim()) {
    return parse(input.repositoryUrl);
  }
  return parse(input.originRemote);
}

export interface WindowsWorkflowDispatchInput {
  owner: string;
  repo: string;
  workflow: string;
  reason: string;
}

export function buildWindowsWorkflowDispatchArgs(input: WindowsWorkflowDispatchInput): string[] {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const workflow = input.workflow.trim();
  const reason = input.reason.trim();

  if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo)) {
    throw new Error('GitHub 저장소 설정이 올바르지 않습니다.');
  }
  if (!SAFE_WORKFLOW_FILE.test(workflow)) {
    throw new Error('GitHub Actions 워크플로 파일명이 올바르지 않습니다.');
  }
  if (reason.length < 3 || reason.length > 200 || /[\r\n]/.test(reason)) {
    throw new Error('Windows 빌드 실행 사유는 한 줄 3~200자로 입력해야 합니다.');
  }

  return [
    'workflow', 'run', workflow,
    '--repo', `${owner}/${repo}`,
    '--field', `reason=${reason}`,
  ];
}

export function windowsWorkflowActionsUrl(owner: string, repo: string, workflow: string): string {
  if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo) || !SAFE_WORKFLOW_FILE.test(workflow)) {
    throw new Error('GitHub Actions URL 설정이 올바르지 않습니다.');
  }
  return `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`;
}
