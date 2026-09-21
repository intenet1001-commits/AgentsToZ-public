/**
 * 매뉴얼·로그 관리 칸에 넣을 수 있는 **문서 파일**의 판정.
 *
 * 이 칸에 담긴 경로는 나중에 OS 기본 앱으로 열린다(`open`). 그래서 확장자 검사가 하는
 * 일은 형식 보증이 아니라 **실행 파일을 문서로 붙여 두는 것을 막는 것**이다 —
 * `.command`·`.app`·`.sh` 를 매뉴얼로 등록해 두면 「매뉴얼 열기」가 곧 실행이 된다.
 *
 * ⚠️ 그래서 목록을 좁게 유지하지 않는다. 좁은 화이트리스트는 안전을 주지 않으면서
 * (`.txt` 안에 무엇이든 넣을 수 있다) 정당한 문서만 막는다. 실제로 화면은
 * "HTML·MD·PDF **등**"이라고 적어 두고 검증은 9종 닫힌 목록이어서, 한글 문서나 오피스
 * 파일을 넣으면 거부됐다(VOC 2026-08-14). 문구가 약속한 것과 코드가 지킨 것이 달랐다.
 */

/** 문서로 허용하는 확장자. 사람이 읽는 문서 형식만 담는다. */
export const PROJECT_DOCUMENT_EXTENSIONS = [
  // 웹·텍스트
  'html', 'htm', 'md', 'markdown', 'txt', 'text', 'rtf', 'log', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml',
  // 인쇄 문서
  'pdf',
  // 오피스
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  // 한글 (국내 프로젝트 문서에서 흔하다)
  'hwp', 'hwpx',
  // 오픈도큐먼트
  'odt', 'ods', 'odp',
  // 화면 캡처로 만든 안내서
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
] as const;

/**
 * 문서로 **받지 않는** 확장자. 여는 순간 실행되는 것들이라, 목록을 넓히더라도
 * 이쪽은 반드시 남는다. 확장자가 없는 파일도 같은 이유로 거부한다 — macOS 에서
 * 실행 권한만 있으면 이름에 점이 없어도 실행된다.
 */
export const PROJECT_DOCUMENT_BLOCKED_EXTENSIONS = [
  'command', 'app', 'sh', 'bash', 'zsh', 'exe', 'bat', 'cmd', 'ps1', 'scpt', 'applescript',
  'jar', 'msi', 'pkg', 'dmg', 'scr', 'com', 'vbs', 'js', 'mjs', 'cjs', 'py', 'rb', 'pl',
] as const;

export interface ProjectDocumentPathProblem {
  code: 'not-absolute' | 'blocked-type' | 'unsupported-type';
  message: string;
}

/** 경로 끝의 확장자를 소문자로. 없으면 빈 문자열. */
export function projectDocumentExtension(path: string): string {
  const base = path.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // 선행 점만 있는 이름(`.gitignore`)은 확장자가 아니라 이름이다.
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 문서 경로로 받을 수 있는지. 받을 수 있으면 `null`.
 *
 * 거부할 때는 **무엇이 거부됐는지**를 문구에 담는다. 예전 문구는 허용 목록만 나열해서,
 * 사용자가 자기 파일의 무엇이 문제인지 알 수 없었다.
 */
export function projectDocumentPathProblem(
  rawPath: string,
  isAbsolute: (value: string) => boolean,
): ProjectDocumentPathProblem | null {
  const path = rawPath.trim();
  if (!isAbsolute(path)) {
    return { code: 'not-absolute', message: '문서 파일의 절대경로를 확인하지 못했습니다.' };
  }
  const ext = projectDocumentExtension(path);
  if ((PROJECT_DOCUMENT_BLOCKED_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      code: 'blocked-type',
      message: `실행되는 파일(.${ext})은 문서로 등록할 수 없습니다. 열기 버튼이 곧 실행이 되기 때문입니다.`,
    };
  }
  if (!(PROJECT_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext)) {
    return {
      code: 'unsupported-type',
      message: ext
        ? `.${ext} 파일은 문서로 등록할 수 없습니다. 문서·표·이미지 형식(PDF·HWP·DOCX·XLSX·MD·HTML·PNG 등)을 넣어 주세요.`
        : '확장자가 없는 파일은 문서로 등록할 수 없습니다.',
    };
  }
  return null;
}
