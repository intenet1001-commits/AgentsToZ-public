/**
 * 커밋 이메일이 GitHub 계정과 연결될 수 있는 형태인지 검사한다.
 *
 * 왜 필요한가 (2026-08-14 실측)
 *   Vercel은 커밋 작성자를 GitHub 사용자와 연결하지 못하면 배포를 **차단**한다:
 *     readyState: BLOCKED
 *     readyStateReason: "The Deployment was blocked because GitHub could not
 *                        associate the committer with a GitHub user."
 *     seatBlock.blockCode: COMMIT_AUTHOR_REQUIRED
 *   그런데 이 차단은 **조용하다.** 빌드가 시작조차 하지 않으므로 로그가 비어 있고(0ms),
 *   GitHub 쪽에는 실패 표시가 없으며, 프로덕션 URL은 옛 번들을 계속 200으로 서빙한다.
 *   실제로 11커밋(v177~v181)이 이 상태로 쌓여 웹이 14시간 넘게 멎어 있었다.
 *
 *   갈린 지점은 딱 하나였다 — git 이메일:
 *     owner@example.com                                → READY 10건
 *     developer@workstation.local                      → BLOCKED 13건
 *     ubuntu@private-host.compute.internal              → BLOCKED 1건
 *
 *   즉 `user.email`을 설정하지 않은 기기에서 git이 **호스트명으로 자동 생성한 주소**가
 *   원인이다. 사람이 알아채기 어려운 실패라서, 조용히 막히기 전에 CI에서 크게 깨뜨린다.
 *
 * 무엇을 판정할 수 있고 없는가
 *   "이 이메일이 정말 GitHub 계정에 등록돼 있는가"는 여기서 알 수 없다(네트워크·권한 필요).
 *   대신 **확실히 안 되는 모양**만 잡는다. 애매하면 통과시킨다 — 거짓 실패로 남의 푸시를
 *   막는 쪽이, 잡지 못한 한 건보다 나쁘다.
 */

/** git이 호스트명으로 주소를 만들 때 붙는 로컬 전용 도메인들. */
const LOCAL_DOMAIN_SUFFIXES = ['.local', '.localdomain', '.lan', '.internal', '.home', '.arpa'];

export interface CommitAuthorProblem {
  email: string;
  reason: 'empty' | 'no-domain' | 'local-domain';
}

/**
 * 배포를 막을 것이 **확실한** 이메일인지. 확실하지 않으면 null.
 *
 * git의 자동 생성 주소는 `<user>@<hostname>` 형태라 도메인에 점이 없거나
 * `.local`·`.internal` 같은 로컬 전용 접미사로 끝난다. 그 둘만 잡는다.
 */
export function commitEmailProblem(rawEmail: string | null | undefined): CommitAuthorProblem | null {
  const email = (rawEmail ?? '').trim().toLowerCase();
  if (!email) return { email: '', reason: 'empty' };
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return { email, reason: 'no-domain' };
  const domain = email.slice(at + 1);
  if (LOCAL_DOMAIN_SUFFIXES.some(suffix => domain.endsWith(suffix))) {
    return { email, reason: 'local-domain' };
  }
  // 점이 없는 도메인 = 호스트명 그대로 (`user@macbook`). 공개 도메인일 수 없다.
  if (!domain.includes('.')) return { email, reason: 'no-domain' };
  return null;
}

export function isDeployableCommitEmail(email: string | null | undefined): boolean {
  return commitEmailProblem(email) === null;
}

/** CI 로그에 그대로 찍히는 안내. 무엇을 어디서 고쳐야 하는지까지 담는다. */
export function describeCommitAuthorFailure(problems: Array<{ sha: string; email: string; subject: string }>): string {
  const lines = [
    '✗ GitHub 계정에 연결할 수 없는 이메일로 만든 커밋이 있습니다.',
    '',
    '  Vercel은 이런 커밋의 배포를 조용히 차단합니다 (COMMIT_AUTHOR_REQUIRED).',
    '  빌드 로그가 비어 있고 프로덕션은 옛 번들을 계속 서빙하므로 알아채기 어렵습니다.',
    '',
  ];
  for (const p of problems) {
    lines.push(`  ${p.sha.slice(0, 8)}  ${p.email || '(빈 이메일)'}  ${p.subject.slice(0, 60)}`);
  }
  lines.push(
    '',
    '  커밋을 만든 기기에서 git 이메일을 GitHub 계정 주소로 설정하세요:',
    '',
    '    git config --global user.email "<GitHub에 등록된 이메일>"',
    '    git config --global user.name  "<GitHub 사용자명>"',
    '',
    '  (프라이버시 설정을 쓰면 <ID>+<username>@users.noreply.github.com 도 됩니다.)',
    '  이미 만든 커밋은 이메일이 정상인 기기에서 새 커밋을 하나 올리면 함께 배포됩니다.',
  );
  return lines.join('\n');
}
