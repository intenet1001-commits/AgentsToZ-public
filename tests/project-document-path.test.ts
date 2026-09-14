import { describe, expect, test } from 'bun:test';
import {
  PROJECT_DOCUMENT_EXTENSIONS,
  projectDocumentExtension,
  projectDocumentPathProblem,
} from '../src/projectDocumentPath';

const absolute = (value: string) => value.startsWith('/');
const problem = (path: string) => projectDocumentPathProblem(path, absolute);

describe('projectDocumentExtension', () => {
  test('reads the extension from the basename only', () => {
    expect(projectDocumentExtension('/a.b/c/manual.PDF')).toBe('pdf');
    expect(projectDocumentExtension('/x/y/report.tar.gz')).toBe('gz');
  });

  // `.gitignore` 는 확장자가 gitignore 인 파일이 아니라 이름이 그것인 파일이다.
  test('treats a leading dot as a name, not an extension', () => {
    expect(projectDocumentExtension('/x/.gitignore')).toBe('');
    expect(projectDocumentExtension('/x/README')).toBe('');
  });
});

describe('projectDocumentPathProblem', () => {
  test('accepts the document formats the field advertises', () => {
    for (const ext of ['pdf', 'md', 'html', 'txt', 'csv', 'log']) {
      expect(problem(`/docs/manual.${ext}`)).toBeNull();
    }
  });

  // VOC 2026-08-14: 화면은 "HTML·MD·PDF 등"이라 적어 두고 검증은 9종 닫힌 목록이라
  // 한글 문서와 오피스 파일이 거부됐다. 문구가 약속한 것을 코드가 지키게 한다.
  test('accepts Korean and office documents that the old whitelist rejected', () => {
    for (const ext of ['hwp', 'hwpx', 'docx', 'xlsx', 'pptx', 'odt']) {
      expect(problem(`/docs/설명서.${ext}`)).toBeNull();
    }
  });

  test('accepts screenshots, since a guide is often a picture', () => {
    for (const ext of ['png', 'jpg', 'svg']) {
      expect(problem(`/docs/guide.${ext}`)).toBeNull();
    }
  });

  // 이 경로는 나중에 OS 기본 앱으로 열린다. 실행 파일을 문서로 등록해 두면
  // 「매뉴얼 열기」가 곧 실행이 된다 — 목록을 넓히더라도 이쪽은 남는다.
  test('refuses files that would execute when opened', () => {
    for (const ext of ['command', 'app', 'sh', 'exe', 'bat', 'ps1', 'py']) {
      const result = problem(`/x/run.${ext}`);
      expect(result?.code).toBe('blocked-type');
      expect(result?.message).toContain(ext);
    }
  });

  test('refuses an extensionless file, which may still be executable', () => {
    expect(problem('/usr/local/bin/tool')?.code).toBe('unsupported-type');
  });

  test('requires an absolute path', () => {
    expect(problem('docs/manual.pdf')?.code).toBe('not-absolute');
  });

  // 거부 사유가 "허용 목록 나열"뿐이면 사용자는 자기 파일의 무엇이 문제인지 모른다.
  test('names the rejected extension so the user can see why', () => {
    expect(problem('/x/archive.zip')?.message).toContain('.zip');
  });

  test('the accepted list has no duplicates', () => {
    expect(new Set(PROJECT_DOCUMENT_EXTENSIONS).size).toBe(PROJECT_DOCUMENT_EXTENSIONS.length);
  });
});
