/**
 * 로그인 계정의 홈을 계정 데이터베이스에서 읽는다. macOS는 `id`·`dscl`(디렉터리 서비스)을 쓰고, 리눅스는
 * `/etc/passwd`를 쓴다. 어느 쪽도 `$HOME`을 보지 않는다 — Bun의 `os.homedir()`·`os.userInfo().homedir`는 HOME을
 * 따르므로(2026-11-01 측정: HOME을 스크래치로 바꾼 자식이 스크래치를 돌려받았다) 그 값으로는 「스크래치 HOME이
 * 실제 홈 아래인가」를 판정할 수 없다.
 *
 * 리눅스에서 `userInfo().homedir`로 되돌아가면 자식의 HOME이 곧 「실제 홈」이 되어 가드가 스스로를 거부한다
 * (CI 실측: `refusing HOME /tmp/... — it is inside the real home (/tmp/...)`).
 */
import {readFileSync} from 'node:fs';

/** 계정 데이터베이스 파일. 테스트가 픽스처 파일로 바꿔 읽을 수 있게 인자로 받는다(기본값은 고정). */
export const ACCOUNT_DATABASE = '/etc/passwd';

/** 이 uid의 홈(`/etc/passwd` 6번째 필드). 계정 데이터베이스에 없으면 null. */
export function accountHomeFromPasswd(uid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined, database: string = ACCOUNT_DATABASE): string | null {
  if (uid === undefined) return null;
  let passwd: string;
  try { passwd = readFileSync(database, 'utf8'); } catch { return null; }
  for (const line of passwd.split('\n')) {
    const fields = line.split(':');
    const home = fields[5];
    // name:passwd:uid:gid:gecos:home:shell — 홈은 절대 경로여야 한다.
    if (fields.length >= 7 && fields[2] === String(uid) && typeof home === 'string' && home.startsWith('/')) return home;
  }
  return null;
}

/** 계정 데이터베이스의 홈. 계정을 읽지 못했을 때만 주어진 대체 값(`userInfo().homedir` 등)을 쓴다. */
export function accountHome(fallback: string): string {
  return accountHomeFromPasswd() ?? fallback;
}
