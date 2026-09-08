/**
 * Hermes CLI가 이 기기에 실제로 있는지에 대한 판정 한 곳.
 *
 * `resolveAgentBin`은 후보 경로를 모두 놓치면 **이름 그대로**(`"hermes"`)를 돌려준다.
 * 그 값을 그대로 spawn하면 OS가 $PATH에서 다시 찾다 실패하고, 사용자는
 * `Executable not found in $PATH: "hermes"`라는 원시 오류를 본다 — 무엇을 해야 하는지
 * 알 수 없는 문구다.
 *
 * 게다가 존재 판정이 두 갈래였다: 어댑터 상태는 `~/.hermes` **폴더**만 보고, 실행은
 * **실행 파일**을 필요로 했다. 앱이 스스로 만든 `~/.hermes/config.yaml` 때문에
 * "설치됨"으로 판정돼, 있지도 않은 CLI에 대한 실행 버튼이 떴다. 두 표면이 같은
 * 사실을 보게 하려면 판정이 하나여야 한다.
 */

/** 실행 파일을 못 찾았을 때 `resolveAgentBin`이 돌려주는 값(=이름 그대로). */
export const HERMES_CLI_NAME = 'hermes';

export const HERMES_CLI_NOT_FOUND_CODE = 'HERMES_CLI_NOT_FOUND';

/**
 * 사용자가 보게 될 유일한 안내다. 원시 spawn 오류를 대체하므로 다음 행동이 들어 있어야 한다.
 * 홈 폴더는 앱이 만들 수 있으므로 "설정이 있으니 설치된 것"이라는 오해를 먼저 끊는다.
 */
export const HERMES_CLI_NOT_FOUND_MESSAGE =
  '이 기기에 Hermes CLI(`hermes`)가 없습니다. '
  + '`~/.hermes` 설정 폴더는 AgentsToZ가 만든 것이라 설치 증거가 아닙니다. '
  + 'Hermes를 설치한 뒤 다시 시도하세요.';

/**
 * `resolveAgentBin`의 결과를 "절대경로 | 없음"으로 바꾼다.
 *
 * 이름 그대로 돌아왔다는 것은 후보 탐색과 로그인 셸 폴백이 **모두** 실패했다는 뜻이므로
 * 미설치로 읽는다. 빈 문자열·공백도 같다.
 */
export function hermesCliPathFromResolved(resolved: string | null | undefined): string | null {
  const value = (resolved ?? '').trim();
  if (!value) return null;
  if (value === HERMES_CLI_NAME) return null;
  return value;
}

/**
 * 어댑터 상태 응답에서 "이 기기에 Hermes CLI가 있는가"를 읽는다. 세 값이다.
 *
 * - `true`  — 실행 파일 절대경로가 왔다.
 * - `false` — 서버가 찾아봤고 없다고 답했다. **확정된 미설치**라 버튼을 막아도 된다.
 * - `null`  — 판단 불가. `hermesCliPath` 키 자체가 없는 응답이 여기다.
 *
 * 없는 필드를 `false`로 읽으면 "모른다"가 "없다"로 승격된다. 실제로 그 승격 때문에
 * Hermes가 멀쩡히 깔린 기기에서 실행 버튼이 "설치되어 있지 않습니다"로 막혔다
 * (2026-08-14 실측: 앱이 물고 있던 sidecar 응답에 `hermesCliPath` 키가 아예 없었고,
 * 같은 기기의 새 서버는 `/Users/…/.local/bin/hermes`를 정상으로 돌려줬다).
 * 앱은 **이미 떠 있는 로컬 API를 그대로 채택**하므로 UI가 sidecar보다 새로운 상황은
 * 상시 가능하다 — 새 필드를 읽는 판정은 전부 이 세 값 규칙을 따를 것.
 */
export function hermesCliAvailabilityFromStatus(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  if (!('hermesCliPath' in payload)) return null;
  const value = (payload as { hermesCliPath?: unknown }).hermesCliPath;
  // `null`은 서버가 판정한 미설치다. `undefined`는 키만 있고 값이 빠진 형태라 믿지 않는다.
  if (value === null) return false;
  if (typeof value !== 'string') return null;
  return hermesCliPathFromResolved(value) !== null;
}
