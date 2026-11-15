/**
 * 계정 데이터베이스에서 실제 홈을 읽는 규칙(리눅스). macOS는 `id`·`dscl`을 쓰지만, 리눅스에서 `userInfo().homedir`로
 * 되돌아가면 자식의 스크래치 HOME이 곧 「실제 홈」이 되어 가드가 스스로를 거부한다(CI 실측). 여기서 고정하는 것은
 * `/etc/passwd` 6번째 필드를 uid로 찾는다는 점, 그리고 그 값이 없을 때만 대체 값(HOME을 따르는 값)을 쓴다는 점이다.
 *
 * 이 시험은 실행 호스트의 uid에 기대지 않는다: 픽스처의 uid와 "이 프로세스의 uid"를 따로 만들어 잰다.
 */
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ACCOUNT_DATABASE, accountHome, accountHomeFromPasswd} from '../scripts/emulator-e2e/accountHome';

const dir = mkdtempSync(join(tmpdir(), 'atz-account-home-'));
const database = join(dir, 'passwd');
writeFileSync(database, [
  'root:x:0:0:root:/root:/bin/sh',
  'runner:x:1001:1001:runner:/home/runner:/bin/bash',
  'broken:x:1002:1002:no home field', // 필드가 모자란 줄은 무시한다.
  'relative:x:1003:1003:relative:home/dir:/bin/sh', // 절대 경로가 아니면 홈이 아니다.
  '',
].join('\n'));

/** 이 프로세스의 uid를 가진 계정만 있는 데이터베이스. 어떤 호스트에서도 같은 판정이 나온다. */
const ownUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const ownDatabase = join(dir, 'own-passwd');
writeFileSync(ownDatabase, ownUid === undefined ? '' : `someone:x:${ownUid}:${ownUid}:someone:/fixture-home/someone:/bin/sh\n`);

describe('account database home', () => {
  test('reads the home of the uid from the field, never from HOME', () => {
    expect(accountHomeFromPasswd(1001, database)).toBe('/home/runner');
    expect(accountHomeFromPasswd(0, database)).toBe('/root');
    // 기본 경로는 고정이다(테스트만 픽스처를 넘긴다).
    expect(ACCOUNT_DATABASE).toBe('/etc/passwd');
  });

  test('has no home for an account that the database cannot answer for', () => {
    expect(accountHomeFromPasswd(4242, database)).toBeNull();
    expect(accountHomeFromPasswd(1002, database)).toBeNull();
    expect(accountHomeFromPasswd(1003, database)).toBeNull();
    expect(accountHomeFromPasswd(1001, join(dir, 'missing'))).toBeNull();
  });

  test('falls back only when the account is unknown, and the fallback is the caller\'s', () => {
    // 이 프로세스의 uid를 아는 데이터베이스: HOME이 무엇이든 그 계정의 홈을 쓴다.
    expect(accountHome('/from/caller', ownDatabase)).toBe(ownUid === undefined ? '/from/caller' : '/fixture-home/someone');
    // 답할 수 없는 데이터베이스(파일 없음): 호출자가 준 값이 남는다.
    expect(accountHome('/from/caller', join(dir, 'no-such-passwd'))).toBe('/from/caller');
    const previous = process.env.HOME;
    process.env.HOME = '/tmp/atz-account-home-scratch';
    try {
      // HOME을 스크래치로 바꿔도 계정을 아는 데이터베이스에서는 스크래치를 실제 홈으로 돌려주지 않는다.
      if (ownUid !== undefined) expect(accountHome('/tmp/atz-account-home-scratch', ownDatabase)).toBe('/fixture-home/someone');
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    }
  });
});

process.on('exit', () => rmSync(dir, {recursive: true, force: true}));
