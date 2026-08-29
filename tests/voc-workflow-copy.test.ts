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
    expect(prompt).toContain('`voc/done/`으로 이동');
  });

  test('충돌과 사용자 변경을 파괴하는 Git 명령을 금지한다', () => {
    const prompt = buildVocWorkflowPrompt();

    expect(prompt).toContain('`reset --hard`');
    expect(prompt).toContain('force push');
    expect(prompt).toContain('자동 ours/theirs 충돌 해결');
    expect(prompt).toContain('다른 사용자의 변경');
    expect(prompt).toContain('원격 분기');
  });

  test('상단 VOC 토글 바로 옆에 발견 가능한 복사 버튼이 있다', () => {
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('data-testid="voc-workflow-prompt-copy"');
    expect(appSource).toContain('buildVocWorkflowPrompt({');
    expect(appSource).toContain('VOC 처리→머지·푸시→빌드·열기');
    expect(appSource.indexOf('data-testid="voc-workflow-prompt-copy"'))
      .toBeGreaterThan(appSource.indexOf('data-testid="voc-toggle"'));
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

  test('VOC 복사 버튼 옆에 발견 가능한 복사 버튼이 있다', () => {
    const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('data-testid="git-sync-workflow-prompt-copy"');
    expect(appSource).toContain('buildGitSyncWorkflowPrompt({');
    expect(appSource).toContain('깃허브 최신화·머지→빌드·열기');
    expect(appSource.indexOf('data-testid="git-sync-workflow-prompt-copy"'))
      .toBeGreaterThan(appSource.indexOf('data-testid="voc-workflow-prompt-copy"'));
  });
});
