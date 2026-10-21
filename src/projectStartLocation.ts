/**
 * `/project_start` 가 새 프로젝트 폴더를 **어디에 무슨 이름으로** 만들지 정하는 규칙.
 *
 * `/memory_start` 는 앱 데이터 폴더 아래 `telegram-memory-<uuid>` 를 만든다. 사람이 고른
 * 경로가 아니어서 코드를 둘 곳으로는 쓸 수 없다. 이쪽은 사용자의 작업 루트 아래에
 * 사람이 읽는 이름으로 만든다.
 *
 * ⚠️ 판정 축은 OS가 아니라 **작업 루트 등록 여부**다. 루트 등록은 "나는 이 호스트에서
 * 작업한다"는 선언이라, 로컬 맥과 원격 개발 상자를 한 규칙으로 덮는다. OS로 가르면
 * "AWS인데 거기서 개발하는" 경우를 틀리게 막는다.
 *
 * 루트가 하나도 없으면 홈 아래 기본 위치(`~/projects/<이름>`)에 만든다. 한동안 이 경우를
 * 거절했는데, 그 판단은 "루트가 없는 호스트 = 메시지 중계일 뿐"이라는 좁은 전제 위에
 * 서 있었다. AgentsToZ 와 Hermes 가 깔린 AWS 는 **에이전트가 실제로 코드를 쓰는 곳**이라
 * 거기 만든 폴더는 빈 폴더가 아니다. GUI 가 없어 작업 루트를 등록할 방법도 마땅치 않으므로,
 * 거절하면 그 호스트에서는 프로젝트를 시작할 길이 아예 없어진다.
 *
 * ⚠️ 대신 **어디에 만들었는지 반드시 알린다.** 이 경우 위치는 사용자가 고른 것이 아니므로,
 * 알리지 않으면 자기 프로젝트가 어디 있는지 모르는 상태가 된다.
 *
 * 파일시스템을 건드리지 않는다. 호출부가 결과를 받아 mkdir 한다.
 */

import { join } from 'node:path';

export interface WorkspaceRootChoice {
  id?: string;
  name?: string;
  path: string;
}

export type ProjectStartTarget =
  /** 만들 위치가 정해졌다. */
  | { status: 'ok'; folderName: string; folderPath: string; rootPath: string; rootWasDefaulted: boolean }
  /** 루트가 여럿이라 사용자가 골라야 한다. 스킬이 이 목록을 그대로 되묻는다. */
  | { status: 'need-root'; roots: WorkspaceRootChoice[] }
  | { status: 'error'; code: string; error: string };

/**
 * 사용자가 준 이름을 폴더명으로 바꾼다.
 *
 * 이 값은 **파일시스템에 닿는 입력**이다. 경로 구분자가 남으면 루트 밖에 폴더가 생기고,
 * 선행 점이 남으면 숨김 폴더나 `..` 가 된다.
 */
/** 작업 루트가 하나도 등록되지 않은 호스트에서 쓰는 기본 위치(홈 기준 상대경로). */
export const DEFAULT_PROJECT_ROOT_REL = 'projects';

/** 폴더명에 들어가면 경로가 되거나 셸에서 문제가 되는 문자들. */
const FORBIDDEN_NAME_CHARS = '\\/:*?"<>|';

export function sanitizeProjectFolderName(raw: string): string {
  const text = typeof raw === 'string' ? raw : '';
  // NFC로 모아야 한글 자모가 분리된 입력도 한 글자로 센다.
  const collapsed = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  // 경로 구분자·제어문자·Windows 예약문자를 없앤다. 한글 등 유니코드 글자는 남긴다.
  // 공백과 대시는 남긴다 — 바로 아래에서 공백을 대시로 바꾼다.
  // 정규식 리터럴에 제어문자를 직접 넣으면 소스에 보이지 않는 바이트가 박히므로 코드포인트로 거른다.
  const cleaned = Array.from(collapsed)
    .filter(ch => {
      const code = ch.codePointAt(0)!;
      if (code <= 0x1f || code === 0x7f) return false;
      return !FORBIDDEN_NAME_CHARS.includes(ch);
    })
    .join('')
    .trim();
  const dashed = cleaned
    .replace(/ /g, '-')
    .replace(/-{2,}/g, '-')
    // 선행/후행 점과 대시를 없애 `.hidden`·`..`·`-flag` 꼴을 막는다.
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return dashed.slice(0, 60);
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

/**
 * 만들 대상 경로를 정한다.
 *
 * - 루트가 여럿인데 지정이 없으면 `need-root` — 임의로 고르지 않는다. 프로젝트가 엉뚱한
 *   곳에 생기면 사용자는 그것을 찾지 못하고, 지우기도 어렵다.
 * - 루트가 하나뿐이면 되묻지 않는다. 고를 것이 없는데 묻는 것은 잡음이다.
 * - 루트가 없으면 홈 아래 기본 위치로 떨어진다.
 */
export function resolveProjectStartTarget(input: {
  name: string;
  rootPath?: string | null;
  roots: WorkspaceRootChoice[];
  /** 루트가 하나도 없을 때 기본 위치의 기준. */
  homeDir: string;
}): ProjectStartTarget {
  const folderName = sanitizeProjectFolderName(input.name);
  if (!folderName) {
    return {
      status: 'error',
      code: 'PROJECT_START_NAME_REQUIRED',
      error: '새 프로젝트 이름이 필요합니다. 예: /project_start 매출대시보드',
    };
  }

  const roots = (input.roots ?? []).filter(root => typeof root?.path === 'string' && root.path.trim() !== '');
  const requested = typeof input.rootPath === 'string' ? input.rootPath.trim() : '';

  if (requested) {
    // 루트가 등록돼 있으면 그중 하나여야 한다. 오타 하나로 홈 밖에 폴더가 생기는 것을 막는다.
    if (roots.length > 0) {
      const matched = roots.find(root => samePath(root.path, requested));
      if (!matched) {
        return {
          status: 'error',
          code: 'PROJECT_START_UNKNOWN_ROOT',
          error: `등록된 작업 루트가 아닙니다: ${requested}`,
        };
      }
      return target(matched.path, folderName);
    }
    if (!requested.startsWith('/')) {
      return {
        status: 'error',
        code: 'PROJECT_START_ROOT_NOT_ABSOLUTE',
        error: `작업 루트는 절대경로여야 합니다: ${requested}`,
      };
    }
    return target(requested, folderName);
  }

  if (roots.length === 1) return target(roots[0]!.path, folderName);
  if (roots.length > 1) return { status: 'need-root', roots };
  // 루트가 없는 호스트(GUI 로 등록할 방법이 없는 AWS 등) — 기본 위치로 만들고,
  // 호출부가 `rootWasDefaulted` 를 보고 어디에 만들었는지 알리게 한다.
  return target(join(input.homeDir, DEFAULT_PROJECT_ROOT_REL), folderName, true);
}

function target(rootPath: string, folderName: string, rootWasDefaulted = false): ProjectStartTarget {
  const root = rootPath.replace(/\/+$/, '');
  return { status: 'ok', folderName, folderPath: join(root, folderName), rootPath: root, rootWasDefaulted };
}
