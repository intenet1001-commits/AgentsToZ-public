/**
 * 계정 데이터베이스에서 실제 홈을 읽는 규칙(리눅스). macOS는 `id`·`dscl`을 쓰지만, 리눅스에서 `userInfo().homedir`로
 * 되돌아가면 자식의 스크래치 HOME이 곧 「실제 홈」이 되어 가드가 스스로를 거부한다(CI 실측). 여기서 고정하는 것은
 * `/etc/passwd` 6번째 필드를 uid로 찾는다는 점, 그리고 그 값이 없을 때만 대체 값(HOME을 따르는 값)을 쓴다는 점이다.
 */
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {accountHome, accountHomeFromPasswd} from '../scripts/emulator-e2e/accountHome';

const dir = mkdtempSync(join(tmpdir(), 'atz-account-home-'));
const database = join(dir, 'passwd');
writeFileSync(database, [
  'root:x:0:0:root:/root:/bin/sh',
  'runner:x:1001:1001:runner:/home/runner:/bin/bash',
  'broken:x:1002:1002:no home field', // 필드가 모자란 줄은 무시한다.
  'relative:x:1003:1003:relative:home/dir:/bin/sh', // 절대 경로가 아니면 홈이 아니다.
  ':' .repeat(3) + 'nohome:x:1004:1004:::/bin/sh',
  '',
].join('\n'));

describe('account database home', () => {
  test('reads the home of the uid from the field, never from HOME', () => {
    expect(accountHomeFromPasswd(1001, database)).toBe('/home/runner');
    expect(accountHomeFromPasswd(0, database)).toBe('/root');
  });

  test('has no home for an account that the database cannot answer for', () => {
    expect(accountHomeFromPasswd(4242, database)).toBeNull();
    expect(accountHomeFromPasswd(1002, database)).toBeNull();
    expect(accountHomeFromPasswd(1003, database)).toBeNull();
    expect(accountHomeFromPasswd(undefined, database)).toBeNull();
    expect(accountHomeFromPasswd(1001, join(dir, 'missing'))).toBeNull();
  });

  test('falls back only when the account is unknown, and the fallback is the caller\'s', () => {
    const previous = process.env.HOME;
    process.env.HOME = '/tmp/atz-account-home-scratch';
    try {
      // 존재하지 않는 uid: 계정 데이터베이스가 답할 수 없으니 호출자가 준 값이 남는다.
      expect(accountHome('/from/caller')).toBe('/from/caller');
      // 이 프로세스의 uid는 이 환경의 계정 데이터베이스에 있든 없든, 답이 있으면 HOME을 쓰지 않는다.
      const fromDatabase = accountHomeFromPasswd();
      expect(accountHome('/from/caller')).toBe(fromDatabase ?? '/from/caller');
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    }
  });
});

process.on('exit', () => rmSync(dir, {recursive: true, force: true}));
