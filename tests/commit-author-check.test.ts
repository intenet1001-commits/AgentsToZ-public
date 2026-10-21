import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  commitEmailProblem,
  describeCommitAuthorFailure,
  isDeployableCommitEmail,
} from '../src/commitAuthorCheck';

const workflow = readFileSync(new URL('../.github/workflows/verify.yml', import.meta.url), 'utf8');
const script = readFileSync(new URL('../scripts/check-commit-authors.ts', import.meta.url), 'utf8');

describe('배포를 막는 이메일 판정', () => {
  test('실측으로 차단된 주소들을 잡는다', () => {
    // 2026-08-14: 이 두 주소의 커밋이 Vercel에서 BLOCKED 14건을 냈다.
    expect(isDeployableCommitEmail('developer@workstation.local')).toBe(false);
    expect(isDeployableCommitEmail('ubuntu@private-host.compute.internal')).toBe(false);
  });

  test('실측으로 통과한 주소는 통과시킨다', () => {
    // 같은 기간 이 주소의 커밋은 READY 10건이었다.
    expect(isDeployableCommitEmail('owner@example.com')).toBe(true);
  });

  test('GitHub noreply 주소를 막지 않는다', () => {
    expect(isDeployableCommitEmail('12345+owner@users.noreply.github.com')).toBe(true);
  });

  test('호스트명뿐인 도메인을 잡는다', () => {
    expect(commitEmailProblem('user@macbook')?.reason).toBe('no-domain');
    expect(commitEmailProblem('root@localhost')?.reason).toBe('no-domain');
  });

  test('빈 값·형식 파괴를 잡는다', () => {
    expect(commitEmailProblem('')?.reason).toBe('empty');
    expect(commitEmailProblem(null)?.reason).toBe('empty');
    expect(commitEmailProblem('없는골뱅이')?.reason).toBe('no-domain');
    expect(commitEmailProblem('@example.com')?.reason).toBe('no-domain');
    expect(commitEmailProblem('user@')?.reason).toBe('no-domain');
  });

  test('대소문자를 가리지 않는다', () => {
    expect(isDeployableCommitEmail('CS-Work@CS-WorkUI-MacBookPro.LOCAL')).toBe(false);
  });

  test('애매하면 통과시킨다 — 거짓 실패로 남의 푸시를 막지 않는다', () => {
    // 사내 도메인·희귀 TLD는 GitHub에 등록돼 있을 수 있다. 확실한 것만 잡는다.
    for (const ok of ['dev@corp.example', 'a@b.co', 'x@sub.domain.io', '이름@example.com']) {
      expect(isDeployableCommitEmail(ok)).toBe(true);
    }
  });
});

describe('안내 문구', () => {
  const text = describeCommitAuthorFailure([
    { sha: 'ef72eab2b934816527e92c51433d919a291cb9d1', email: 'developer@workstation.local', subject: 'chore: bump to v181' },
  ]);

  test('원인·조치·기존 커밋 복구법을 모두 담는다', () => {
    expect(text).toContain('COMMIT_AUTHOR_REQUIRED');
    expect(text).toContain('git config --global user.email');
    expect(text).toContain('users.noreply.github.com');
    expect(text).toContain('새 커밋을 하나 올리면');
  });

  test('어느 커밋인지 짚어 준다', () => {
    expect(text).toContain('ef72eab2');
    expect(text).toContain('developer@workstation.local');
  });
});

describe('CI 배선', () => {
  test('push마다 검사한다', () => {
    expect(workflow).toContain('commit-author:');
    expect(workflow).toContain('bun scripts/check-commit-authors.ts "$RANGE"');
  });

  test('범위를 보려면 전체 히스토리가 필요하다', () => {
    expect(workflow).toContain('fetch-depth: 0');
  });

  test('push 이벤트에서만 before..after 범위를 준다', () => {
    expect(workflow).toContain("github.event_name == 'push'");
    expect(workflow).toContain('github.event.before');
  });

  test('범위를 못 읽으면 통과시킨다 — 검사 실패가 푸시 실패가 되면 안 된다', () => {
    expect(script).toContain('커밋 범위를 읽지 못해 검사를 건너뜁니다');
    expect(script).toContain('process.exit(0)');
  });

  test('첫 푸시·force push의 null sha를 범위로 쓰지 않는다', () => {
    expect(script).toContain('NULL_SHA');
    expect(script).toContain("'HEAD~0'");
  });

  test('작성자와 커미터를 둘 다 본다', () => {
    expect(script).toContain('new Set([authorEmail, committerEmail])');
  });
});
