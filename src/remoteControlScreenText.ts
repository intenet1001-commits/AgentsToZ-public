/**
 * Words the two phone surfaces show for the same thing — the internet portal (React) and the
 * same-Wi-Fi QR page (`remoteControlMobilePage.ts`, plain JS). The QR page embeds these with
 * `fn.toString()`, so **each function must stand alone**: no imports, no module constants, no
 * helpers outside its own body.
 *
 * They lived twice and drifted (2026-10-07 audit): the Orca button read 「Orca 탭」 on one surface
 * and 「Orca localhost」 on the other, a
 * dirty-tree refusal told the QR page what to do but the portal nothing, the QR page's session list
 * said raw "codex · running", and an unknown OPS state printed "undefined" on the portal.
 */

/** Button label for a project action; unknown actions fall back to their id rather than a blank button. */
export function remoteControlActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'ops.status': '운영기억 상태 확인', 'ops.memory.pending': '저장 후보 확인', 'ops.open': '아젠투지(OPS) 열기',
    start: '실행', stop: '중지', restart: '재실행',
    'folder.open': 'Finder',
    'localhost.open': '브라우저',
    'orca.open': 'Orca localhost',
    'agent.claude': 'Orca · Claude',
    'agent.codex': 'Orca · Codex',
    'agent.agy': 'Orca · Antigravity',
    'agent.hermes': 'Orca · Hermes',
    'app.codex': '최근 Codex 대화 다시 열기',
    'app.hermes': '최근 Hermes 대화 열기 요청',
    // Kept for old paired clients; current cards do not advertise this redundant entry point.
    // (app.claude is not offered anywhere any more — tests/remote-control-claude-cli.test.ts.)
    'claude.thread.start': 'Claude Code 원격 대화',
    'codex.thread.start': 'Mac의 Codex 앱에서 열기',
    'git.commit': 'Commit',
    'git.pull': 'Pull',
    'git.push': 'Push',
    'git.merge': '기본 브랜치에 Merge',
    'worktree.add': '+ 표준 Git 워크트리',
    'worktree.add.orca': '+ Orca 등록 워크트리',
  };
  return Object.prototype.hasOwnProperty.call(labels, action) ? labels[action]! : action;
}

/**
 * The confirm question for a project action — a sentence per action, not 「<button> 기능을 실행할까요?」, which read
 * 「Finder 기능을 실행할까요?」 and 「+ 표준 Git 워크트리 기능을 실행할까요?」 (2026-10-16 audit).
 */
export function remoteControlActionConfirm(action: string): string {
  const questions: Record<string, string> = {
    'ops.status': '운영기억 상태를 확인할까요?',
    'ops.memory.pending': '운영기억 저장 후보를 확인할까요?',
    'ops.open': 'Mac에서 아젠투지(OPS) 운영 프로젝트를 열까요?',
    start: 'Mac에서 이 프로젝트를 실행할까요?',
    stop: '실행 중인 서버를 중지할까요?',
    restart: '서버를 중지한 뒤 다시 실행할까요?',
    'folder.open': 'Mac의 Finder에서 이 폴더를 열까요?',
    'localhost.open': 'Mac의 브라우저에서 이 프로젝트의 localhost를 열까요?',
    'orca.open': 'Mac의 Orca에서 localhost 탭을 열까요?',
    'agent.claude': 'Mac의 Orca에서 Claude를 시작할까요?',
    'agent.codex': 'Mac의 Orca에서 Codex를 시작할까요?',
    'agent.agy': 'Mac의 Orca에서 Antigravity를 시작할까요?',
    'agent.hermes': 'Mac의 Orca에서 Hermes를 시작할까요?',
    'app.codex': 'Mac의 Codex 앱에서 이 프로젝트의 최근 대화를 다시 열까요?',
    'app.hermes': 'Mac의 Hermes Desktop에 이 프로젝트의 최근 대화를 열어 달라고 요청할까요?',
    'claude.thread.start': 'Mac에서 Claude Code 원격 대화를 시작할까요?',
    'codex.thread.start': 'Mac의 Codex 앱에서 이 프로젝트의 새 대화를 열까요?',
    'git.commit': '변경한 파일을 커밋할까요(git commit)?',
    'git.pull': '원격 저장소의 변경을 받아올까요(git pull)?',
    'git.push': '커밋을 원격 저장소에 올릴까요(git push)?',
    'git.merge': '이 브랜치를 기본 브랜치에 병합할까요(git merge)?',
    'worktree.add': '새 표준 Git 워크트리를 만들까요?',
    'worktree.add.orca': '새 Orca 등록 워크트리를 만들까요?',
  };
  return Object.prototype.hasOwnProperty.call(questions, action) ? questions[action]! : `「${action}」 동작을 실행할까요?`;
}

/**
 * What the Mac reported doing once it answered yes — not 「Pull 요청을 완료했습니다」 (a GitHub pull request?) or
 * 「Finder 요청을 완료했습니다」 (did a folder open?). An app the Mac only asks to open says so, not that it opened.
 */
export function remoteControlActionDone(action: string): string {
  const done: Record<string, string> = {
    'ops.status': '운영기억 상태를 확인했습니다.',
    'ops.memory.pending': '운영기억 저장 후보를 확인했습니다.',
    'ops.open': 'Mac에서 아젠투지(OPS) 운영 프로젝트를 열었습니다.',
    start: 'Mac에서 실행을 시작했습니다.',
    stop: '서버를 중지했습니다.',
    restart: '서버를 다시 실행했습니다.',
    'folder.open': 'Mac의 Finder에서 폴더를 열었습니다.',
    'localhost.open': 'Mac의 브라우저에서 localhost를 열었습니다.',
    'orca.open': 'Mac의 Orca에서 localhost 탭을 열었습니다.',
    'agent.claude': 'Mac의 Orca에서 Claude를 시작했습니다.',
    'agent.codex': 'Mac의 Orca에서 Codex를 시작했습니다.',
    'agent.agy': 'Mac의 Orca에서 Antigravity를 시작했습니다.',
    'agent.hermes': 'Mac의 Orca에서 Hermes를 시작했습니다.',
    'app.codex': 'Mac의 Codex 앱에 최근 대화 열기를 요청했습니다. 실제 화면은 Mac에서 확인하세요.',
    'app.hermes': 'Mac의 Hermes Desktop에 최근 대화 열기를 요청했습니다. 실제 대화 선택은 Mac에서 확인하세요.',
    'claude.thread.start': 'Mac에서 Claude Code 원격 대화를 시작했습니다.',
    'codex.thread.start': 'Mac의 Codex 앱에 새 대화 열기를 요청했습니다. 실제 화면은 Mac에서 확인하세요.',
    'git.commit': '커밋했습니다(git commit).',
    'git.pull': '원격 변경을 받아왔습니다(git pull).',
    'git.push': '원격 저장소에 올렸습니다(git push).',
    'git.merge': '기본 브랜치에 병합했습니다(git merge).',
    'worktree.add': '새 워크트리를 만들었습니다.',
    'worktree.add.orca': '새 Orca 워크트리를 만들었습니다.',
    // The QR page's own requests, which come back through the same result handler.
    'projects.list': '프로젝트 목록을 받았습니다.',
    'project.create': '새 프로젝트를 만들었습니다.',
  };
  return Object.prototype.hasOwnProperty.call(done, action) ? done[action]! : `「${action}」 요청을 마쳤습니다.`;
}

/** One line under a project card's title. */
export function remoteProjectStatusLabel(project: { status?: string; port?: number | null; kind?: string }): string {
  if (project.status === 'running') return project.port ? `실행 중 · 포트 ${project.port}` : '실행 중';
  if (project.status === 'stopped') return '중지됨';
  if (project.port) return `포트 ${project.port} · 상태 확인 필요`;
  return project.kind === 'worktree' ? '워크트리 · 포트 없음' : '프로젝트 폴더 · 포트 없음';
}

/** What to do about a refusal the Mac sent; null when the message already says enough. */
export function remoteActionErrorHint(code: string): string | null {
  const hints: Record<string, string> = {
    GIT_WORKTREE_DIRTY: '이 프로젝트 카드의 Commit 버튼으로 먼저 커밋한 뒤 다시 시도하세요.',
    WORKTREE_SOURCE_DIRTY: '이 프로젝트 카드의 Commit 버튼으로 먼저 커밋한 뒤 다시 시도하세요.',
    DETACHED_HEAD: 'Mac에서 브랜치를 체크아웃한 뒤 다시 시도하세요.',
    ACTION_IN_PROGRESS: '진행 중인 작업이 끝난 뒤 다시 시도하세요.',
    RATE_LIMITED: '잠시 뒤 자동으로 다시 시도합니다. 목록이 짧아 보이면 상태 새로고침을 누르세요.',
    SESSION_DISCONNECTED: '요청 도중 연결이 끊겨 실행하지 않았습니다. 상태를 새로고침한 뒤 다시 누르세요.',
    PROJECT_NOT_FOUND: 'Mac의 AgentsToZ 앱에서 이 프로젝트가 등록되어 있는지 확인하세요.',
    ORCA_WORKTREE_CREATE_NOT_VERIFIED: 'Mac에서 Orca 상태를 확인한 뒤 다시 시도하세요.',
    CODEX_PROJECT_SESSION_NOT_FOUND: '위의 새 Codex 대화 만들기를 사용하세요.',
    HERMES_PROJECT_SESSION_NOT_FOUND: '아래 Orca에서 열기의 Hermes 버튼으로 새 세션을 시작하세요.',
  };
  return Object.prototype.hasOwnProperty.call(hints, code) ? hints[code]! : null;
}

/** 「실행 중」 or 「종료 N」 beside a Workroom session's name. */
export function workroomSessionStateLabel(session: { state?: string; exitCode?: number | null }): string {
  if (session.state === 'running') return '실행 중';
  return typeof session.exitCode === 'number' ? `종료 ${session.exitCode}` : '종료';
}

/**
 * The OPS memory status line. An unknown state reads as 「상태 확인 필요」, never "undefined". The saved time is the
 * phone's one format (`phoneDateTime` in phoneTime.ts, written out here because the QR page embeds this alone —
 * a test keeps the two equal): `toLocaleString()` followed the device region and printed 「10/16/2026, 2:04:05 PM」.
 */
export function opsStatusText(ops: { state?: string; pendingCount?: number; lastSavedAt?: string | null }): string {
  const labels: Record<string, string> = {
    ready: '운영기억 연결됨', preparing: '준비 중', 'needs-attention': '연결 확인 필요', unconfigured: '프로필 준비 필요',
  };
  const state = ops.state && Object.prototype.hasOwnProperty.call(labels, ops.state) ? labels[ops.state]! : '상태 확인 필요';
  const at = ops.lastSavedAt ? new Date(ops.lastSavedAt) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const saved = at && !Number.isNaN(at.getTime())
    ? ` · 마지막 저장 ${at.getFullYear() !== new Date().getFullYear() ? `${at.getFullYear()}년 ` : ''}${at.getMonth() + 1}월 ${at.getDate()}일 ${pad(at.getHours())}:${pad(at.getMinutes())}`
    : '';
  return `${state} · 저장 후보 ${Number(ops.pendingCount) || 0}개${saved}`;
}
