import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildWindowsWorkflowDispatchArgs,
  resolveGitHubActionsRepository,
  windowsWorkflowActionsUrl,
} from '../src/githubWorkflowDispatch';
import {
  buildWindowsPcUpdatePrompt,
  windowsUpdateRepositoryUrl,
} from '../src/windowsUpdateWorkflow';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const windowsWorkflowSource = readFileSync(new URL('../src/windowsUpdateWorkflow.ts', import.meta.url), 'utf8');

describe('Windows update controls', () => {
  test('copies a Windows-specific safe update and installed-app verification prompt', () => {
    const prompt = buildWindowsPcUpdatePrompt({
      projectPath: 'C:\\dev\\AgentsToZ_byCS',
      repositoryUrl: 'https://github.com/example/my-agentstoz-fork.git',
    });
    expect(prompt).toContain('C:\\\\dev\\\\AgentsToZ_byCS');
    expect(prompt).toContain('"repository": "https://github.com/example/my-agentstoz-fork"');
    expect(prompt).toContain('bun run verify');
    expect(prompt).toContain('bun run tauri:build:win');
    expect(prompt).toContain('scripts/run-windows-packaged-e2e.ps1');
    expect(prompt).toContain('일반 사용자의 앱을 자동 업데이트하는 기능이 아니라');
    expect(prompt).toContain('실제 Windows PC');
    expect(prompt).toContain('GitHub Actions Windows 빌드는 설치파일 생성과 hosted smoke test를 돕는 보조 수단');
    expect(prompt).toContain('%USERPROFILE%\\cargo-targets\\portmanager\\release\\bundle\\nsis');
    expect(prompt).toContain('본인 포크');
    expect(prompt).toContain('credential·token·query·fragment');
    expect(prompt).toContain('reset --hard');
  });

  test('uses only a credential-free GitHub repository and safely falls back to the public source', () => {
    const fallback = 'https://github.com/intenet1001-commits/AgentsToZ-public';
    expect(windowsUpdateRepositoryUrl()).toBe(fallback);
    expect(windowsUpdateRepositoryUrl('https://github.com/example/fork.git'))
      .toBe('https://github.com/example/fork');

    for (const unsafe of [
      'https://user:token@github.com/example/fork',
      'https://github.com/example/fork?token=secret',
      'https://github.com/example/fork#credential',
      'https://gitlab.com/example/fork',
    ]) {
      const prompt = buildWindowsPcUpdatePrompt({ repositoryUrl: unsafe });
      expect(prompt).toContain('"repository": "' + fallback + '"');
      expect(prompt).not.toContain(unsafe);
      expect(prompt).not.toContain('token=secret');
      expect(prompt).not.toContain('user:token');
      expect(prompt).not.toContain('#credential');
    }

    expect(windowsWorkflowSource).toContain('repository: safeRepositoryUrl');
    expect(windowsWorkflowSource).not.toMatch(/repository:\s*['"]https:\/\/github\.com\//);
  });

  test('builds a fixed argv dispatch without a shell', () => {
    expect(buildWindowsWorkflowDispatchArgs({
      owner: 'example-owner',
      repo: 'my-agentstoz-fork',
      workflow: 'build-windows.yml',
      reason: 'explicit app request',
    })).toEqual([
      'workflow', 'run', 'build-windows.yml',
      '--repo', 'example-owner/my-agentstoz-fork',
      '--field', 'reason=explicit app request',
    ]);
    expect(() => buildWindowsWorkflowDispatchArgs({
      owner: 'owner; rm', repo: 'repo', workflow: 'build-windows.yml', reason: 'bad config',
    })).toThrow();
    expect(windowsWorkflowActionsUrl('owner', 'repo', 'build-windows.yml'))
      .toBe('https://github.com/owner/repo/actions/workflows/build-windows.yml');
  });

  test('derives the Actions repository only from an explicit pair or a safe fork URL/origin', () => {
    expect(resolveGitHubActionsRepository({
      configuredOwner: 'my-owner',
      configuredRepo: 'my-fork',
      repositoryUrl: 'https://github.com/ignored/url',
    })).toEqual({ owner: 'my-owner', repo: 'my-fork' });
    expect(resolveGitHubActionsRepository({
      repositoryUrl: 'https://github.com/example/my-agentstoz-fork.git',
    })).toEqual({ owner: 'example', repo: 'my-agentstoz-fork' });
    expect(resolveGitHubActionsRepository({
      originRemote: 'git@github.com:example/my-origin-fork.git',
    })).toEqual({ owner: 'example', repo: 'my-origin-fork' });

    expect(resolveGitHubActionsRepository({ configuredOwner: 'owner-only' })).toBeNull();
    expect(resolveGitHubActionsRepository({
      repositoryUrl: 'https://user:token@github.com/example/fork',
      originRemote: 'https://github.com/example/unexpected-fallback',
    })).toBeNull();
    expect(resolveGitHubActionsRepository({})).toBeNull();

    expect(apiSource).not.toContain("process.env.PORTMGR_GITHUB_OWNER ||");
    expect(apiSource).not.toContain("process.env.PORTMGR_GITHUB_REPO ||");
    expect(apiSource).toContain('configuredGitHubActionsRepository()');
  });

  test('renders both controls and requires an explicit cost confirmation', () => {
    expect(appSource).toContain('data-testid="windows-pc-update-prompt-copy"');
    expect(appSource).toContain('Windows 빌드·출시 안내');
    expect(appSource).toContain('일반 사용자 자동 업데이트 아님');
    expect(appSource).toContain('data-testid="github-windows-cloud-build"');
    expect(appSource).toContain('repositoryUrl: AGENTSTOZ_PUBLIC_REPOSITORY_URL');
    expect(appSource).toContain('publicGitHubRepositoryUrl(import.meta.env.VITE_REPO_URL)');
    expect(appSource).toContain('사용 비용이 발생할 수 있습니다');
    expect(apiSource).toContain('/api/github-actions/build-windows');
    expect(apiSource).toContain('Bun.spawnSync([ghPath, ...args]');
  });

  test('isolates Windows build timers and reports the configured Cargo target folder', () => {
    const windowsHandlers = appSource.slice(
      appSource.indexOf('const handleInstallWindowsPrereqs'),
      appSource.indexOf('const handleCopyWindowsPcUpdatePrompt'),
    );
    expect(windowsHandlers).toContain('const seq = ++buildSeqRef.current');
    expect(windowsHandlers).toContain('buildPollRef.current = pollInterval');
    expect(windowsHandlers).toContain('buildTimeoutRef.current = timeout');
    expect(windowsHandlers).toContain('if (seq !== buildSeqRef.current) return');
    expect(windowsHandlers).toContain('buildPollRef.current = null');
    expect(windowsHandlers).toContain('buildTimeoutRef.current = null');
    expect(windowsHandlers).toContain('%USERPROFILE%\\\\cargo-targets\\\\portmanager\\\\release\\\\bundle\\\\nsis');
    expect(windowsHandlers).not.toContain('src-tauri/target/release/bundle/nsis/');
  });

  test('keeps long build logs bounded without freezing after the server window rolls', () => {
    expect(apiSource).toContain('outputBase: 0');
    expect(apiSource).toContain('outputCursor: 0');
    expect(apiSource).toContain('function pushBuildLog');
    expect(apiSource).toContain('buildStatus.outputBase += dropped');
    expect(apiSource).toContain('MAX_LOG_BUFFER_ENTRIES = 1000');
    expect(apiSource).toContain('MAX_LOG_ENTRY_CHARS = 8_192');
    expect(apiSource).toContain("url.searchParams.get('cursor')");
    expect((appSource.match(/\/api\/build-status\?cursor=\$\{lastLogIndexRef\.current\}/g) ?? []).length).toBe(4);
    expect(appSource).toContain('buildLogWindowDelta(');
    expect(appSource).toContain('.slice(-2500)');
    expect(appSource).not.toContain('status.output.slice(lastLogIndexRef.current)');
  });

  test('guards macOS build polling with the same stale-response and in-flight controls', () => {
    const macHandlers = appSource.slice(
      appSource.indexOf('const handleBuildApp'),
      appSource.indexOf('const fetchVisitCounts'),
    );
    expect((macHandlers.match(/let pollInFlight = false/g) ?? []).length).toBe(2);
    expect((macHandlers.match(/if \(seq !== buildSeqRef\.current \|\| pollInFlight\) return/g) ?? []).length).toBe(2);
    expect((macHandlers.match(/buildPollRef\.current = null/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((macHandlers.match(/buildTimeoutRef\.current = null/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
