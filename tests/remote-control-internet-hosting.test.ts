import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const rootFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('provider-neutral hosted remote controller', () => {
  test('consumes the QR fragment before React and authenticates the exact inline bootstrap with CSP', () => {
    const html = rootFile('remote/index.html');
    const scriptMatch = html.match(/<script>(\(\(\)=>\{[\s\S]*?\}\)\(\);)<\/script>/);
    expect(scriptMatch?.[1]).toBeTruthy();
    const script = scriptMatch![1]!;
    const hash = createHash('sha256').update(script).digest('base64');
    expect(html).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(html.indexOf('__agentstozRemotePairingFragment')).toBeLessThan(
      html.indexOf('/src/remote-control-portal-main.tsx'),
    );
    expect(script).toContain('location.hash.slice(1)');
    expect(script).toContain('history.replaceState');
    expect(script).not.toContain('fetch(');
    expect(script).not.toContain('local' + 'Storage');
    expect(script).not.toContain('session' + 'Storage');
  });

  test('builds a real /remote/index.html and routes it before the portal catch-all', () => {
    const vite = rootFile('vite.portal.config.ts');
    const config = JSON.parse(rootFile('vercel.json')) as {
      rewrites: Array<{ source: string; destination: string }>;
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    expect(vite).toContain("remote: 'remote/index.html'");
    expect(config.rewrites.slice(0, 3)).toEqual([
      { source: '/setup', destination: '/setup.html' },
      { source: '/remote', destination: '/remote/index.html' },
      { source: '/remote/', destination: '/remote/index.html' },
    ]);
    const remote = config.headers.find(entry => entry.source === '/remote/(.*)');
    const remoteExact = config.headers.find(entry => entry.source === '/remote');
    const catchAllIndex = config.headers.findIndex(entry => entry.source === '/(.*)');
    const remoteExactIndex = config.headers.findIndex(entry => entry.source === '/remote');
    const remoteIndex = config.headers.findIndex(entry => entry.source === '/remote/(.*)');
    const csp = remote?.headers.find(header => header.key === 'Content-Security-Policy')?.value ?? '';
    const exactCsp = remoteExact?.headers.find(header => header.key === 'Content-Security-Policy')?.value ?? '';
    const html = rootFile('remote/index.html');
    const inlineScript = html.match(/<script>(\(\(\)=>\{[\s\S]*?\}\)\(\);)<\/script>/)?.[1] ?? '';
    const inlineHash = createHash('sha256').update(inlineScript).digest('base64');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`'sha256-${inlineHash}'`);
    expect(exactCsp).toBe(csp);
    expect(csp).toContain('https://*.supabase.co');
    expect(csp).not.toContain("'unsafe-eval'");
    expect(remote?.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
    expect(remote?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store, max-age=0' });
    expect(remoteExact?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store, max-age=0' });
    // Vercel header routes continue after a match. Put the narrow rules last so
    // the portal catch-all cannot replace the remote CSP/referrer policy.
    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeLessThan(remoteExactIndex);
    expect(catchAllIndex).toBeLessThan(remoteIndex);
  });

  test('offers a recoverable OAuth account switch without losing the sealed QR', () => {
    const source = rootFile('src/remote-control-portal-main.tsx');
    expect(source).toContain("await vaultRef.current?.seal(pairingUrl)");
    expect(source).toContain("supabase.auth.signOut({ scope: 'local' })");
    expect(source).toContain('await preflightPortalGoogleOAuth({');
    expect(source).toContain('await createPortalGoogleOAuthUrl({');
    expect(source).toContain('window.location.assign(authorizeUrl)');
    expect(source).toContain('다른 Google 계정으로 로그인');
    expect(source.indexOf('await vaultRef.current?.seal(pairingUrl)')).toBeLessThan(
      source.indexOf('await preflightPortalGoogleOAuth({'),
    );
    expect(source.indexOf('await preflightPortalGoogleOAuth({')).toBeLessThan(
      source.indexOf("supabase.auth.signOut({ scope: 'local' })"),
    );
  });

  test('shows missing-QR guidance before login and handles manual refresh failures', () => {
    const source = rootFile('src/remote-control-portal-main.tsx');
    expect(source.indexOf(") : missingPairing ? (")).toBeLessThan(
      source.indexOf(") : authState === 'signed-out' ? ("),
    );
    expect(source).toContain('const manualRefresh = async () =>');
    // `reportError` is `setError(userFacingError(...))` plus the machine token,
    // so an unmapped failure no longer collapses into "check your internet"
    // with the real code discarded.
    expect(source).toContain('reportError(refreshError)');
    expect(source).toContain('onClick={() => void manualRefresh()}');
    expect(source).toContain("closed: '종료됨'");
    expect(source).toContain("error: '연결 오류'");
    expect(source).not.toContain("status.state === 'online' ? '연결됨' : '보안 연결'");
  });

  test('keeps an approved session resumable while the user moves through portal pages', () => {
    const remote = rootFile('src/remote-control-portal-main.tsx');
    const portal = rootFile('src/portal-main.tsx');
    const controller = rootFile('src/remoteControlRelayController.ts');
    const vault = rootFile('src/remoteControlRelaySessionVault.ts');
    expect(remote).toContain('new RemoteControlRelaySessionVault()');
    expect(remote).toContain('restoredSession ? await controller.refresh() : await controller.initialize()');
    expect(remote).toContain('onSessionChanged: async snapshot =>');
    expect(remote).toContain('href="/?tab=ports"');
    expect(remote).toContain('href="/?tab=bookmarks"');
    expect(remote).toContain('href="/?tab=memories"');
    expect(portal).toContain('data-testid="open-active-remote-control"');
    expect(portal).toContain('href="/remote/"');
    expect(portal).toContain("readInitialPortalTab() ?? (readInitialSelectedDeviceId() ? 'ports' : 'bookmarks')");
    expect(controller).toContain('await this.#persistSession();');
    expect(controller).toContain('pendingOutbound: this.#pendingOutbound ? { ...this.#pendingOutbound } : null');
    expect(vault).toContain("const DATABASE_NAME = 'agentstoz-remote-control-session-v1'");
    expect(vault).not.toContain('local' + 'Storage');
    expect(vault).not.toContain('session' + 'Storage');
  });

  test('keeps app opening, fresh Codex creation, and both worktree owners distinct', () => {
    const portal = rootFile('src/remote-control-portal-main.tsx');
    const projectCard = rootFile('src/RemoteControlProjectCard.tsx');
    const api = rootFile('api-server.ts');
    expect(projectCard).toContain("'agent.codex': 'Orca · Codex'");
    expect(projectCard).toContain("'agent.claude': 'Orca · Claude'");
    expect(projectCard).toContain("'app.codex': '최근 Codex 대화 다시 열기'");
    expect(projectCard).toContain("'app.hermes': '최근 Hermes 대화 열기 요청'");
    expect(projectCard).not.toContain("'claude.thread.start': 'Claude Code 처음 연결'");
    expect(projectCard).toContain("'codex.thread.start': '새 Codex 대화 만들기'");
    expect(projectCard).toContain("'worktree.add': '+ 표준 Git 워크트리'");
    expect(projectCard).toContain("'worktree.add.orca': '+ Orca 등록 워크트리'");
    expect(projectCard).toContain('두 버튼은 중복이 아닙니다');
    expect(projectCard).toContain('최초 로그인·약관 동의·폴더 신뢰 확인은 Mac의 Orca 화면');
    expect(projectCard).toContain("'git.merge': '기본 브랜치에 Merge'");
    expect(portal).toContain("'+ 이 Mac에 프로젝트 추가'");
    expect(portal).toContain('최근 Hermes 대화 열기 요청을 Mac에 전달했습니다.');
    expect(portal).toContain('실제 대화 선택은 Mac의 Hermes Desktop에서 확인하세요.');
    expect(api).toContain('const externalLaunchRoute = remoteControlExternalLaunchRoute(action);');
    expect(api).toContain("floating: launchSurface === 'floating'");
    expect(api).toContain("import { remoteControlExternalLaunchRoute } from \"./src/remoteControlExternalLaunchRoute\";");
    expect(api).toContain("path = '/api/git-worktree-add'");
    expect(api).toContain("orcaManaged: action === 'worktree.add.orca'");
    expect(api).toContain('createCodexDesktopProjectConversation({');
    expect(api).toContain("prompt: CODEX_REMOTE_FIRST_MESSAGE");
    expect(api).toContain('waitForFreshChatGptProjectConversation(');
    expect(api).toContain('remoteCodexFirstConversationLauncher.createAndOpen({');
    expect(api).toContain('new FileCodexFirstConversationPendingStore(APP_DATA_DIR)');
    expect(api).toContain('verifyRecoveredProjectCodexThread(workingPath, threadId)');
    expect(api).toContain('error instanceof CodexFirstConversationOpenError');
    expect(api).toContain('remoteClaudeConversationManager.startAndOpen({');
    expect(api).toContain('openSession: openClaudeRemoteSessionDeepLink');
    expect(api).toContain('error instanceof ClaudeRemoteConversationError');
    expect(api).toContain('spawn: spawnContainedClaudeRemoteControl');
    expect(api).not.toContain('terminateProcessTree: pid => killProcessTree(pid)');
    expect(api).toContain("process.once('SIGINT', () => {");
    expect(api).toContain("process.once('SIGTERM', () => {");
    expect(api).toContain('remoteClaudeConversationManager.shutdown(),');
    expect(api).toContain('void shutdownRemoteControlApi(0);');
    expect(api).toContain('throw new RemoteControlError(error.code, error.message, 502)');
  });

  test('loads every project before hosted search or workspace-root filtering', () => {
    const portal = rootFile('src/remote-control-portal-main.tsx');
    expect(portal).toContain('placeholder="이름 · 별명 · 브랜치로 검색"');
    expect(portal).toContain('normalizeSearchText(project.name)');
    expect(portal).toContain("normalizeSearchText(project.alias ?? '')");
    expect(portal).toContain("normalizeSearchText(project.branch ?? '')");
    expect(portal).toContain("selectedController.sendAction('workspace-roots.list')");
    expect(portal).toContain('void loadAllProjects()');
    expect(portal).toContain('status.nextPage !== null');
    expect(portal).toContain('workspaceRootFilter.slice(WORKSPACE_ROOT_FILTER_PREFIX.length)');
    expect(portal).toContain('전체 ${status.projectCount}개를 불러와 검색·필터링하는 중입니다');
  });

  test('keeps remote Git updates conflict-averse and leaves worktree removal local', () => {
    const api = rootFile('api-server.ts');
    const safety = rootFile('src/remoteControlGitSafety.ts');
    const gateway = rootFile('src/remoteControlProcessGateway.ts');
    const pullStart = safety.indexOf('export async function executeRemoteControlSafePull');
    const pushStart = safety.indexOf('export async function executeRemoteControlSafePush');
    const mergeStart = safety.indexOf('export async function executeRemoteControlSafeMerge');
    expect(pullStart).toBeGreaterThanOrEqual(0);
    expect(pushStart).toBeGreaterThan(pullStart);
    expect(mergeStart).toBeGreaterThan(pushStart);
    const pull = safety.slice(pullStart, pushStart);
    const push = safety.slice(pushStart, mergeStart);
    const merge = safety.slice(mergeStart);
    expect(pull).toContain("['status', '--porcelain', '--untracked-files=normal']");
    expect(pull).toContain("['fetch', '--prune', 'origin']");
    expect(pull).toContain("['merge', '--ff-only', `origin/${branch}`]");
    expect(pull).toContain('GIT_BRANCH_DIVERGED');
    expect(push).toContain("['remote', 'get-url', '--push', '--all', 'origin']");
    expect(push).toContain("['push', '--set-upstream', 'origin', branch]");
    expect(merge).toContain("['ls-remote', '--symref', 'origin', 'HEAD']");
    expect(merge).toContain("['merge-tree', '--write-tree', primaryBranch, featureBranch]");
    expect(merge).toContain("['merge', '--abort']");
    expect(api).toContain('executeRemoteControlSafePull({');
    expect(api).toContain('executeRemoteControlSafePush({');
    expect(api).toContain('executeRemoteControlSafeMerge({');
    expect(gateway).not.toContain('worktree.remove');
  });

  test('does not regress the manuals to LAN-only or process-only remote control', () => {
    const manuals = [
      rootFile('README.md'),
      rootFile('AGENTS.md'),
      rootFile('docs/user-guide/GUIDE.md'),
    ];
    for (const manual of manuals) {
      expect(manual).toContain('외부 인터넷');
      expect(manual).toContain('워크트리');
      expect(manual).toContain('What I Said');
      expect(manual).not.toContain('클라우드용 HTTPS relay는 후속');
      expect(manual).not.toContain('인터넷·클라우드 원격 제어용 HTTPS relay는 후속');
    }
    expect(manuals[1]).toContain('/api/remote-control/internet/enable');
    expect(manuals[2]).toContain('fast-forward Pull');
  });

  test('keeps Vercel and What I Said out of the hosted controller runtime contract', () => {
    const html = rootFile('remote/index.html');
    expect(html).not.toContain('.vercel.app');
    expect(html).not.toContain('What I Said');
    expect(html).not.toContain('service_role');
  });
});
