#!/usr/bin/env bun
/**
 * 푸시된 커밋의 작성자·커미터 이메일을 검사한다.
 *
 * Vercel이 조용히 배포를 차단하기 전에 CI에서 크게 깨뜨리는 것이 목적이다 —
 * 판정 근거는 `src/commitAuthorCheck.ts` 주석에 있다.
 *
 *   bun scripts/check-commit-authors.ts                 # HEAD 한 개
 *   bun scripts/check-commit-authors.ts <base>..<head>  # 범위
 */
import { commitEmailProblem, describeCommitAuthorFailure } from '../src/commitAuthorCheck';

const NULL_SHA = '0000000000000000000000000000000000000000';

const range = (() => {
  const arg = process.argv[2]?.trim();
  if (arg && !arg.includes(NULL_SHA)) return arg;
  // 첫 푸시·force push·PR 등 before를 믿을 수 없을 때는 HEAD 하나만 본다.
  // 과거 커밋까지 훑어 이미 지나간 실패로 새 푸시를 막지 않는다.
  return 'HEAD~0';
})();

const format = '%H%x1f%ae%x1f%ce%x1f%s%x1e';
const args = range === 'HEAD~0'
  ? ['log', '-1', `--format=${format}`]
  : ['log', `--format=${format}`, range];

const proc = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
if (proc.exitCode !== 0) {
  // git 범위를 못 읽는 것은 이 검사의 실패이지 커밋의 실패가 아니다. 통과시킨다.
  console.log(`커밋 범위를 읽지 못해 검사를 건너뜁니다: ${proc.stderr.toString().trim().slice(0, 200)}`);
  process.exit(0);
}

const problems: Array<{ sha: string; email: string; subject: string }> = [];
let checked = 0;
for (const record of proc.stdout.toString().split('\x1e')) {
  const line = record.trim();
  if (!line) continue;
  const [sha, authorEmail, committerEmail, subject = ''] = line.split('\x1f');
  checked += 1;
  // 작성자와 커미터 **둘 다** 본다. Vercel이 보는 것은 커미터지만, 작성자만 깨진
  // 커밋도 GitHub 화면에서 사용자와 연결되지 않아 같은 혼란을 만든다.
  for (const email of new Set([authorEmail, committerEmail])) {
    if (commitEmailProblem(email)) problems.push({ sha: sha ?? '', email: email ?? '', subject });
  }
}

if (problems.length === 0) {
  console.log(`✓ 커밋 ${checked}개의 이메일이 모두 GitHub 계정에 연결 가능한 형태입니다.`);
  process.exit(0);
}

console.error(describeCommitAuthorFailure(problems));
process.exit(1);
