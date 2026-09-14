import { githubRepositoryIdentity } from './githubRepositoryRoles';

export type MemorySurvivorChoice = 'a' | 'b' | 'new';
export type RepositoryMergeChoice = 'a' | 'b' | 'new' | 'memory-only';

export const MEMORY_DISPLAY_NAME_MAX = 60;

export function normalizeMemoryDisplayName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MEMORY_DISPLAY_NAME_MAX);
}

export function fallbackMemoryDisplayName(projectName?: string | null, githubUrl?: string | null): string {
  const project = normalizeMemoryDisplayName(projectName ?? '');
  if (project && project !== '(이름 없음)') return project;
  return githubRepositoryIdentity(githubUrl)?.repositoryName ?? '이름 없는 장기기억';
}

export function composeMergedMemory(input: {
  primaryContent: string;
  secondaryContent: string;
  primaryMemoryId: string;
  secondaryMemoryId: string;
  secondaryName: string;
}): string {
  const primary = input.primaryContent.trim();
  const secondary = input.secondaryContent.trim();
  if (!secondary || secondary === primary) return `${primary}\n`;
  return `${primary}\n\n---\n\n## 합병된 이전 장기기억: ${input.secondaryName}\n\n`
    + `> 이전 memoryId: \`${input.secondaryMemoryId}\`  \n`
    + `> 이 절은 계보 합병 당시 원문을 보존한 것입니다. 검토 후 중복 내용을 정리할 수 있습니다.\n\n`
    + `${secondary}\n`;
}

export function resolveMergeTarget(input: {
  choice: MemorySurvivorChoice;
  memoryA: string;
  memoryB: string;
  newMemoryId: string;
}): string {
  if (input.choice === 'a') return input.memoryA;
  if (input.choice === 'b') return input.memoryB;
  return input.newMemoryId;
}

export function repositoryUrlForChoice(input: {
  choice: RepositoryMergeChoice;
  githubA: string | null;
  githubB: string | null;
  newGithubUrl: string;
}): string | null {
  if (input.choice === 'memory-only') return null;
  if (input.choice === 'a') return input.githubA;
  if (input.choice === 'b') return input.githubB;
  return githubRepositoryIdentity(input.newGithubUrl)?.repositoryUrl ?? null;
}

export function memoryMergeValidation(input: {
  memoryA: string;
  memoryB: string;
  targetMemoryId: string;
  repositoryChoice: RepositoryMergeChoice;
  repositoryUrl: string | null;
  displayName: string;
  mergedContent: string;
}): string | null {
  if (!input.memoryA || !input.memoryB || input.memoryA === input.memoryB) return '서로 다른 장기기억 두 개를 선택하세요.';
  if (!input.targetMemoryId) return '존속할 장기기억 ID가 필요합니다.';
  if (input.repositoryChoice !== 'memory-only' && !input.repositoryUrl) return '선택한 GitHub 저장소 주소를 확인하세요.';
  if (!normalizeMemoryDisplayName(input.displayName)) return '사용자용 장기기억 별칭을 입력하세요.';
  if (!input.mergedContent.trim()) return '합병할 장기기억 내용이 비어 있습니다.';
  if (new TextEncoder().encode(input.mergedContent).byteLength > 1_000_000) return '합병 결과가 1MB를 초과합니다. 내용을 먼저 정리하세요.';
  return null;
}
