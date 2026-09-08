/**
 * Telegram으로 **어느 호스트의 Hermes를 제어하는가**.
 *
 * 두 경로 모두 조작은 Telegram 대화 하나로 같다. 갈리는 것은 그 대화를 받는 gateway가
 * 어디서 도느냐이고, 그것이 곧 제어 대상이다 — 이 Mac의 gateway가 받으면 이 Mac을,
 * AWS의 gateway가 받으면 AWS를 제어한다. 한 호스트에 하나씩 띄우는 것이 전제다
 * (설치 프롬프트도 gateway 중복 실행을 금지한다).
 *
 * 명령어 문자열은 호스트로 갈리지 않는다 — 스킬 본문이 전부 `127.0.0.1:3001`을 부르므로
 * 같은 명령이 "붙여넣은 대화가 도는 호스트"의 API를 친다. 그래서 목록을 두 벌로 복제하는
 * 탭은 만들지 않는다(7개 중 6개가 글자까지 같다). 갈리는 것은 다음 셋뿐이고, 이 파일이
 * 그 셋의 정본이다:
 *
 *   1. `/hermes_open`은 데스크톱 창을 연다 → 화면이 없는 호스트에서는 해당 없음.
 *      실측 근거: AWS 설치 검증(`awsUbuntuMemorySetup.ts`)이 요구하는 스킬은 6개이고
 *      `hermes-open`이 빠져 있다. AWS Telegram 메뉴에 7개만 뜬 이유가 이것이다.
 *   2. 경로 인자는 그 호스트 기준이다 — 앱의 복사 버튼은 이 Mac의 절대경로를 담는다.
 *   3. 저장 대상이 그 호스트의 폴더·세션 기록이다. 같은 `/remember_session`이라도
 *      무엇이 기억되는지가 달라진다.
 *
 * 설치 상태는 로컬에서만 읽을 수 있다. 원격을 고른 동안 「이 PC의 Hermes에는 아직 없음」을
 * 그대로 두면, 잘 도는 원격 명령을 못 쓰는 것으로 읽는다.
 */

export type HermesCommandHost = 'local' | 'remote';

export const HERMES_COMMAND_HOST_STORAGE_KEY = 'portmanager-hermes-command-host';

export const HERMES_COMMAND_HOSTS: readonly HermesCommandHost[] = ['local', 'remote'];

/**
 * 라벨은 **제어 대상**을 말한다. "이 PC의 Hermes"처럼 대상만 적으면 Telegram 제어라는
 * 축이 지워져, 로컬 터미널에서 Hermes를 쓰는 이야기와 섞여 읽힌다.
 */
export const HERMES_COMMAND_HOST_LABELS: Record<HermesCommandHost, string> = {
  local: 'Telegram → 이 PC의 Hermes',
  remote: 'Telegram → AWS의 Hermes',
};

/**
 * 저장값을 읽는다. 깨진 값·모르는 이름은 **로컬**로 떨어진다 — 이 앱이 실제로 설치·검증할
 * 수 있는 쪽이 로컬이고, 원격으로 잘못 떨어지면 설치 버튼이 통째로 사라져 고장으로 읽힌다.
 */
export function parseHermesCommandHost(raw: string | null | undefined): HermesCommandHost {
  return raw === 'remote' ? 'remote' : 'local';
}

/** 이 호스트에서 그 명령이 의미가 있는가. `desktopOnly`는 창을 여는 명령이다. */
export function isHermesCommandAvailable(
  host: HermesCommandHost,
  command: { desktopOnly?: boolean },
): boolean {
  return !(command.desktopOnly && host === 'remote');
}

export interface HermesHostNotes {
  /** 그 대화를 받는 gateway가 어디서 도는가 = 제어 대상. */
  gateway: string;
  /** 언제 응답하는가. 두 경로를 실제로 가르는 이유가 대개 이것이다. */
  uptime: string;
  /** 이 topic에서 저장되는 것이 무엇인지. */
  captures: string;
  /** 경로 인자를 어떻게 다뤄야 하는지. */
  pathHint: string;
  /** 데스크톱 명령이 왜 해당 없는지. 로컬에서는 null. */
  desktopUnavailable: string | null;
}

export function hermesCommandHostNotes(host: HermesCommandHost): HermesHostNotes {
  if (host === 'remote') {
    return {
      gateway: 'AWS에서 도는 Hermes gateway가 그 대화를 받습니다.',
      uptime: '이 Mac이 꺼져 있어도 응답합니다. 그래서 AWS에 두는 것입니다.',
      captures: 'AWS에 clone된 폴더와 AWS의 세션 기록이 저장됩니다. 이 Mac에서 한 작업은 담기지 않습니다.',
      pathHint: '경로 인자는 AWS 기준으로 바꿔야 합니다 — 복사 버튼은 이 Mac의 절대경로를 담습니다.',
      desktopUnavailable: 'AWS에는 열 데스크톱이 없어 해당 없음',
    };
  }
  return {
    gateway: '이 Mac에서 도는 Hermes gateway가 그 대화를 받습니다.',
    uptime: '이 Mac이 켜져 있고 gateway가 떠 있을 때만 응답합니다.',
    captures: '이 Mac의 프로젝트 폴더와 이 Mac의 세션 기록이 저장됩니다.',
    pathHint: '복사 버튼의 경로가 이 PC 기준이라 그대로 쓸 수 있습니다.',
    desktopUnavailable: null,
  };
}
