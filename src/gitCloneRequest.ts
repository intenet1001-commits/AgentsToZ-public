/**
 * 「새 폴더 만들기」에 GitHub 주소를 넣었을 때의 판정 한 곳.
 *
 * 이 칸이 단순한 메모가 아닌 이유: `githubUrl`은 장기기억의 **계보 키**다
 * (`claimProjectMemoryIdentity`, pull의 `.eq("github_url", …)`). `mkdir` + `git init`으로
 * 만든 폴더에는 remote가 없어 `withDetectedGithubUrl`이 아무것도 못 찾고, 결국 사용자가
 * `memoryId`를 손으로 옮겨야 다른 기기의 기억과 이어진다. clone으로 만들면 origin이
 * 처음부터 있으므로 그 우회가 통째로 사라진다.
 *
 * 정규화 결과는 **항상** `https://github.com/<소유자>/<저장소>` 꼴이다. 덕분에 이 경로로
 * 만들어진 값에는 `--upload-pack=…` 같은 옵션 모양이 애초에 들어올 수 없다. 다만 백엔드는
 * 이 모듈을 거치지 않은 입력도 받으므로(로컬 HTTP·IPC) 같은 방어를 각자 한 번 더 한다.
 */
import { normalizeGitHubRepositoryUrl } from './githubUrls';

export const GIT_CLONE_URL_HINT =
  'GitHub 저장소 주소를 넣으세요 — https://github.com/<소유자>/<저장소> 또는 git@github.com:<소유자>/<저장소>.git';

export interface GitCloneRequest {
  /** git에 넘길 정규화된 https 주소. */
  url: string;
  /** 주소에서 끌어낸 저장소 이름. 폴더 이름을 비워둔 경우의 기본값이다. */
  repositoryName: string;
}

/**
 * 폴더 이름으로 쓸 수 없는 저장소 이름을 걸러낸다.
 *
 * GitHub이 실제로 허용하지 않는 이름들이지만, 여기서 막지 않으면 정규화된 주소를 믿고
 * `<루트>/..` 같은 경로를 만들 수 있다. 판정이 값을 만드는 자리에서 끝나야 한다.
 */
function usableRepositoryName(name: string): boolean {
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  return !/[\\/]/.test(name);
}

/**
 * 입력이 clone에 쓸 수 없으면 사람이 읽을 이유를, 쓸 수 있으면 null을 돌려준다.
 * 빈 문자열은 "주소를 안 쓴 것"이라 문제 아님 — 그때는 지금처럼 `mkdir` 경로로 간다.
 */
export function gitCloneUrlProblem(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const normalized = normalizeGitHubRepositoryUrl(trimmed);
  if (!normalized) return GIT_CLONE_URL_HINT;
  if (!usableRepositoryName(normalized.split('/').pop() ?? '')) return GIT_CLONE_URL_HINT;
  return null;
}

/** 쓸 수 있는 주소면 clone 요청으로, 아니면 null. 빈 입력도 null이다. */
export function parseGitCloneRequest(raw: string): GitCloneRequest | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const url = normalizeGitHubRepositoryUrl(trimmed);
  if (!url) return null;
  const repositoryName = url.split('/').pop() ?? '';
  if (!usableRepositoryName(repositoryName)) return null;
  return { url, repositoryName };
}
