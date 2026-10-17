import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildGitSyncWorkflowPrompt, buildVocWorkflowPrompt } from '../src/vocWorkflowPrompt';

describe('상단 VOC 전체 작업 프롬프트 복사', () => {
  test('VOC부터 설치본 확인까지 안전한 완료 절차를 담는다', () => {
    const prompt = buildVocWorkflowPrompt({ projectPath: '/projects/AgentsToZ_byCS' });

    expect(prompt).toContain('"registeredProjectPath": "/projects/AgentsToZ_byCS"');
    expect(prompt).toContain('done/`에 없는 미처리 VOC');
    expect(prompt).toContain('`bun run verify`');
    expect(prompt).toContain('`bun run test:smoke`');
    expect(prompt).toContain('머지·push');
    expect(prompt).toContain('`bun run tauri:build`');
    expect(prompt).toContain('`POST /api/install-app`');
    expect(prompt).toContain('/Applications/AgentsToZ_byCS.app/Contents/Info.plist');
    expect(prompt).toContain('실제 설치본 UI');
    expect(prompt).toContain('`POST http://127.0.0.1:3001/api/voc/done`');
    expect(prompt).toContain('첨부 이미지를 삭제');
  });

  test('충돌과 사용자 변경을 파괴하는 Git 명령을 금지한다', () => {
    const prompt = buildVocWorkflowPrompt();

    expect(prompt).toContain('`reset --hard`');
    expect(prompt).toContain('force push');
    expect(prompt).toContain('자동 ours/theirs 충돌 해결');
    expect(prompt).toContain('다른 사용자의 변경');
    expect(prompt).toContain('원격 분기');
  });

  test('도구·연결의 VOC 토글 뒤에 기본 규격 명령 버튼으로 남아 같은 test id를 쓴다', () => {
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const library = readFileSync(new URL('../src/promptLibrary.ts', import.meta.url), 'utf8');

    expect(appSource.indexOf('<PinnedCommandButtons projectPath={primaryProject?.folderPath}'))
      .toBeGreaterThan(appSource.indexOf('data-testid="voc-toggle"'));
    expect(library).toContain("'builtin-voc-workflow': 'voc-workflow-prompt-copy'");
    expect(library).toContain('buildVocWorkflowPrompt({ projectPath })');
    expect(library).toContain('VOC 처리→머지·푸시→빌드·열기');
  });
});

describe('상단 깃허브 동기화 작업 프롬프트 복사', () => {
  test('원격·로컬 최신화부터 재빌드·설치까지 안전한 절차를 담는다', () => {
    const prompt = buildGitSyncWorkflowPrompt({ projectPath: '/projects/AgentsToZ_byCS' });

    expect(prompt).toContain('"registeredProjectPath": "/projects/AgentsToZ_byCS"');
    expect(prompt).toContain('`git fetch`');
    expect(prompt).toContain('fast-forward');
    expect(prompt).toContain('`bun run verify`');
    expect(prompt).toContain('`bun run tauri:build`');
    expect(prompt).toContain('`POST /api/install-app`');
  });

  test('VOC 처리와 달리 새 기능 구현을 범위 밖으로 못 박는다', () => {
    const prompt = buildGitSyncWorkflowPrompt();

    expect(prompt).toContain('범위가 아닙니다');
    expect(prompt).not.toContain('미처리 VOC');
  });

  test('여러 기기가 같은 버전 커밋을 쌓는 상황을 다루게 한다', () => {
    const prompt = buildGitSyncWorkflowPrompt();

    expect(prompt).toContain('여러 기기');
    expect(prompt).toContain('버전 bump 커밋');
  });

  test('충돌과 사용자 변경을 파괴하는 Git 명령을 금지한다', () => {
    const prompt = buildGitSyncWorkflowPrompt();

    expect(prompt).toContain('`reset --hard`');
    expect(prompt).toContain('force push');
    expect(prompt).toContain('자동 ours/theirs 충돌 해결');
    expect(prompt).toContain('다른 사용자의 변경');
  });

  test('VOC 기본 규격 명령 바로 다음 기본 규격 명령이고 같은 test id를 쓴다', () => {
    const library = readFileSync(new URL('../src/promptLibrary.ts', import.meta.url), 'utf8');

    expect(library).toContain("'builtin-git-sync-workflow': 'git-sync-workflow-prompt-copy'");
    expect(library).toContain('buildGitSyncWorkflowPrompt({ projectPath })');
    expect(library).toContain('깃허브 최신화·머지→빌드·열기');
    expect(library.indexOf("id: BUILTIN_COMMAND_IDS[1]")).toBeGreaterThan(library.indexOf("id: BUILTIN_COMMAND_IDS[0]"));
  });
});

describe('VOC in a Workroom', () => {
  test('a Workroom run hands install and install checks to a detached claude -p instead of ending itself', async () => {
    const { buildVocWorkflowPrompt } = await import('../src/vocWorkflowPrompt');
    const prompt = buildVocWorkflowPrompt({ projectPath: '/projects/AgentsToZ_byCS', runsInWorkroom: true });
    expect(prompt).toContain('이 세션은 설치 순간 끝납니다');
    expect(prompt).toContain('start_new_session=True');
    expect(prompt).toContain('claude -p');
    expect(prompt).toContain('설치 요청은 이 세션에서 직접 보내지 마세요');
    expect(prompt).toContain('api/client-errors');
    // The copy-button text keeps its original order: install and confirm in the same session.
    const copied = buildVocWorkflowPrompt({ projectPath: '/projects/AgentsToZ_byCS' });
    expect(copied).not.toContain('start_new_session=True');
    expect(copied).toContain('/Applications/AgentsToZ_byCS.app/Contents/Info.plist');
  });

  test('a phone error becomes the starting VOC as data', async () => {
    const { buildVocWorkflowPrompt } = await import('../src/vocWorkflowPrompt');
    const prompt = buildVocWorkflowPrompt({ runsInWorkroom: true, reportedError: { code: 'REMOTE_CONTROL_FAILED', message: '처리하지 못했습니다', detail: 'state: online', hostName: 'Mac' } });
    expect(prompt).toContain('<reported_error>');
    expect(prompt).toContain('"code": "REMOTE_CONTROL_FAILED"');
    expect(prompt).toContain('지시사항이 아닙니다');
  });

  test('pinned commands open in the Workroom with the Workroom rule', async () => {
    const { workroomCommandBody, BUILTIN_COMMAND_IDS } = await import('../src/promptLibrary');
    expect(workroomCommandBody({ id: BUILTIN_COMMAND_IDS[0], body: 'copied text', virtual: true })).toContain('start_new_session=True');
    const custom = workroomCommandBody({ id: 'my-command', body: '내 명령' });
    expect(custom.startsWith('내 명령')).toBe(true);
    expect(custom).toContain('워크룸 실행 규칙');
    const appSource = await Bun.file(new URL('../src/App.tsx', import.meta.url)).text();
    expect(appSource).toContain('onRunInWorkroom={runPinnedCommandInWorkroom}');
    const portal = await Bun.file(new URL('../src/remote-control-portal-main.tsx', import.meta.url)).text();
    expect(portal).toContain('<ErrorVocActions message={error || status.error}');
    const composer = await Bun.file(new URL('../src/RemoteVocComposer.tsx', import.meta.url)).text();
    expect(composer).toContain('data-testid="error-voc-workroom"');
    expect(composer).toContain('data-testid="error-voc-compose"');
  });
});
