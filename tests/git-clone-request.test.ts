import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  GIT_CLONE_URL_HINT,
  gitCloneUrlProblem,
  parseGitCloneRequest,
} from '../src/gitCloneRequest';
import { isUnknownApiEndpoint, unknownApiEndpointMessage } from '../src/apiEndpointSupport';

const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const rustSource = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('clone 주소 판정', () => {
  test('빈 입력은 문제가 아니다 — 지금까지의 mkdir 경로로 간다', () => {
    expect(gitCloneUrlProblem('')).toBeNull();
    expect(gitCloneUrlProblem('   ')).toBeNull();
    expect(parseGitCloneRequest('')).toBeNull();
  });

  test('https와 ssh 표기를 모두 받고 같은 값으로 정규화한다', () => {
    const https = parseGitCloneRequest('https://github.com/intenet1001-commits/AgentsToZ_byCS');
    const ssh = parseGitCloneRequest('git@github.com:intenet1001-commits/AgentsToZ_byCS.git');
    expect(https).toEqual({ url: 'https://github.com/intenet1001-commits/AgentsToZ_byCS', repositoryName: 'AgentsToZ_byCS' });
    expect(ssh).toEqual(https!);
  });

  test('.git 꼬리와 뒤따르는 슬래시를 떼고 저장소 이름을 뽑는다', () => {
    expect(parseGitCloneRequest('https://github.com/octocat/Hello-World.git')?.repositoryName).toBe('Hello-World');
    expect(parseGitCloneRequest('https://github.com/octocat/Hello-World/')?.repositoryName).toBe('Hello-World');
  });

  test('GitHub 저장소가 아닌 입력은 이유와 함께 거절한다', () => {
    for (const bad of [
      'https://gitlab.com/owner/repo',
      'https://github.com/owner',
      'https://github.com/owner/repo/tree/main',
      'not a url',
      'file:///etc/passwd',
    ]) {
      expect(gitCloneUrlProblem(bad)).toBe(GIT_CLONE_URL_HINT);
      expect(parseGitCloneRequest(bad)).toBeNull();
    }
  });

  // 정규화 결과는 항상 https://github.com/<소유자>/<저장소> 라서 옵션 모양이 살아남을 수 없다.
  // `git clone --upload-pack=…` 류의 인자 주입이 구조적으로 불가능하다는 뜻이다.
  test('옵션처럼 생긴 입력은 통과하지 못한다', () => {
    for (const bad of ['--upload-pack=touch /tmp/pwned', '-u ssh', '--config=core.pager=sh']) {
      expect(parseGitCloneRequest(bad)).toBeNull();
    }
    const request = parseGitCloneRequest('git@github.com:owner/repo.git');
    expect(request!.url.startsWith('https://github.com/')).toBe(true);
  });

  test('폴더 이름으로 쓸 수 없는 저장소 이름은 거절한다', () => {
    expect(parseGitCloneRequest('https://github.com/owner/..')).toBeNull();
    expect(parseGitCloneRequest('https://github.com/owner/.')).toBeNull();
  });
});

describe('두 백엔드가 같은 방어를 한다', () => {
  // URL 문법 검사는 UI 쪽 한 곳(gitCloneRequest)에만 둔다 — 백엔드마다 다른 규칙을 두면
  // 그 자체가 어긋남의 원인이다. 대신 백엔드가 반드시 스스로 해야 하는 것들만 여기서 고정한다.
  test('옵션 주입·상대경로·기존 폴더를 각자 막는다', () => {
    expect(apiSource).toContain('if (cloneUrl.startsWith("-"))');
    expect(rustSource).toContain("if clone_url.starts_with('-')");
    expect(apiSource).toContain('"절대경로가 필요합니다"');
    expect(rustSource).toContain('"절대경로가 필요합니다"');
    expect(apiSource).toContain('"이미 존재하는 폴더입니다"');
    expect(rustSource).toContain('"이미 존재하는 폴더입니다"');
  });

  test('자격증명 프롬프트를 끄고 실행한다 — GUI에는 프롬프트가 뜨지 않아 영원히 매달린다', () => {
    for (const source of [apiSource, rustSource]) {
      expect(source).toContain('GIT_TERMINAL_PROMPT');
      expect(source).toContain('GIT_ASKPASS');
      expect(source).toContain('BatchMode=yes');
    }
  });

  test('실패하면 부분 생성된 폴더를 지운다', () => {
    // 남겨두면 다음 시도가 "이미 존재하는 폴더입니다"로 막혀 사용자가 손으로 지워야 한다.
    expect(apiSource).toContain('rmSync(target, { recursive: true, force: true })');
    expect(rustSource).toContain('let _ = fs::remove_dir_all(path);');
  });

  test('Tauri 커맨드는 async다 — sync면 clone 동안 앱 창이 통째로 얼어붙는다', () => {
    expect(rustSource).toContain('#[tauri::command(async)]\nfn clone_repository(');
    expect(rustSource).toContain('clone_repository,');
  });

  test('git 실행 파일을 PATH desert에서도 찾는다', () => {
    expect(rustSource).toContain('let git_bin = resolve_bin("git");\n    let output = Command::new(&git_bin)\n        .args(["clone", "--", &clone_url, &target])');
  });
});

describe('새 폴더 만들기 화면', () => {
  test('주소가 있으면 mkdir 대신 clone하고 git init을 다시 돌리지 않는다', () => {
    expect(appSource).toContain('? await API.cloneRepository(cloneRequest.url, fullPath)\n        : await API.createFolder(fullPath);');
    expect(appSource).toContain('if (initializeNewProjectGit && !cloneRequest) {');
  });

  test('이름을 비우면 저장소 이름을 쓴다', () => {
    expect(appSource).toContain("const trimmed = newProjectName.trim() || cloneRequest?.repositoryName || '';");
    expect(appSource).toContain('disabled={!newProjectName.trim() && !newProjectCloneRequest}');
  });

  test('잘못된 주소는 폴더를 만들기 전에 막는다', () => {
    expect(appSource).toContain('const cloneUrlProblem = gitCloneUrlProblem(newProjectGithubUrl);');
    expect(appSource).toContain('data-testid="new-project-github-url-problem"');
  });
});

describe('clone한 저장소의 장기기억은 Pull이 먼저다', () => {
  const memoryServer = readFileSync(new URL('../project-memory-server.ts', import.meta.url), 'utf8');

  test('원격에 기억이 있으면 가져오고, 없을 때만 새로 올린다', () => {
    // 곧장 push하면 다른 기기가 쌓아둔 기억 위에 방금 만든 빈 문서가 올라간다.
    expect(appSource).toContain("if (pullError?.code !== 'REMOTE_BACKUP_MISSING') throw pullError;");
    expect(appSource).toContain('githubUrl: cloneRequest.url,');
    const cloneBranch = appSource.slice(appSource.indexOf('} else if (cloneRequest) {'));
    expect(cloneBranch.indexOf('projectMemoryApi.pull')).toBeLessThan(cloneBranch.indexOf('projectMemoryApi.push'));
  });

  test('"백업 없음"은 문구가 아니라 코드로 구분한다', () => {
    // 문구를 정규식으로 맞히면 문구를 고치는 순간 조용히 깨진다.
    expect(memoryServer).toContain('"REMOTE_BACKUP_MISSING",');
    expect(apiSource).toContain('JSON.stringify({ error: error.message, code: error.code }), { status: 500, headers }');
  });
});

describe('서버가 오래돼 엔드포인트를 모를 때', () => {
  test('폴백 404만 "서버가 오래됨"으로 읽는다', () => {
    // 실측(2026-08-14): 07:57에 뜬 api-server가 10:58에 추가된 엔드포인트를 몰라
    // 마지막 폴백의 {"error":"Not found"} 를 돌려줬다.
    expect(isUnknownApiEndpoint(404, { error: 'Not found' })).toBe(true);
    expect(isUnknownApiEndpoint(404, { error: '  Not found  ' })).toBe(true);
  });

  test('엔드포인트가 있으면서 낸 404는 건드리지 않는다', () => {
    expect(isUnknownApiEndpoint(404, { error: '저장소를 찾지 못했습니다' })).toBe(false);
    expect(isUnknownApiEndpoint(404, {})).toBe(false);
    expect(isUnknownApiEndpoint(404, null)).toBe(false);
    expect(isUnknownApiEndpoint(500, { error: 'Not found' })).toBe(false);
    expect(isUnknownApiEndpoint(200, { error: 'Not found' })).toBe(false);
  });

  test('문구가 원인과 다음 행동을 함께 말한다', () => {
    const message = unknownApiEndpointMessage('/api/clone-repository');
    expect(message).toContain('/api/clone-repository');
    expect(message).toContain('오래된');
    expect(message).toContain('실행.command');
  });

  test('clone 호출이 이 판정을 거친다', () => {
    expect(appSource).toContain("if (isUnknownApiEndpoint(response.status, payload)) {");
    expect(appSource).toContain("unknownApiEndpointMessage('/api/clone-repository')");
  });
});
