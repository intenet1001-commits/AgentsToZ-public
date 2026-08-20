import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  archiveDateStamp,
  archiveFileName,
  archiveHeader,
  archiveSlug,
  summarizeMemory,
  type MemoryArchiveMeta,
} from '../src/memoryArchive';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/memory/MemoryArchivePanel.tsx', import.meta.url), 'utf8');

const meta = (over: Partial<MemoryArchiveMeta> = {}): MemoryArchiveMeta => ({
  id: 'x', projectName: '포트관리', projectCode: 'AB12CD34', sourcePath: '/Users/x/p',
  archivedAt: '2026-08-13T13:00:00.000Z', reason: 'cleanup', bytes: 100, summary: '', file: 'f.md', ...over,
});

describe('요약 뽑기', () => {
  test('제목·마커·표는 건너뛰고 첫 산문 줄을 고른다', () => {
    // 머리말은 어느 기억이나 비슷해서 목록에서 서로 구분되지 않는다.
    const content = [
      '<!-- AgentsToZ memory-agent-version:10 -->',
      '# Project Core Memory',
      '',
      '**Project**: 포트관리',
      '| a | b |',
      '---',
      'Supabase RLS는 authenticated 역할만 허용하므로 로컬 서버는 service_role 키를 쓴다.',
    ].join('\n');
    expect(summarizeMemory(content)).toBe('Supabase RLS는 authenticated 역할만 허용하므로 로컬 서버는 service_role 키를 쓴다.');
  });

  test('머리말 키-값 줄은 건너뛴다', () => {
    // 실측에서 "**Created**: 2026-07-26"이 요약으로 뽑혀 아무 정보도 주지 못했다.
    const content = '# T\n\n**Project**: p\n**Created**: 2026-07-26\n\n이 프로젝트는 결제 연동을 다룬다';
    expect(summarizeMemory(content)).toBe('이 프로젝트는 결제 연동을 다룬다');
  });

  test('목록 기호를 벗겨 낸다', () => {
    expect(summarizeMemory('# T\n- 이 빌드는 NSIS 경로 때문에 깨진다')).toBe('이 빌드는 NSIS 경로 때문에 깨진다');
  });

  test('길면 자른다', () => {
    expect(summarizeMemory(`# T\n${'가'.repeat(400)}`).length).toBeLessThanOrEqual(180);
  });

  test('산문이 없으면 빈 문자열 — 던지지 않는다', () => {
    expect(summarizeMemory('# 제목만')).toBe('');
    expect(summarizeMemory('')).toBe('');
  });
});

describe('파일명', () => {
  test('날짜 + 이름 + 코드', () => {
    expect(archiveFileName(meta({ archivedAt: new Date(2026, 7, 13, 9, 0).toISOString() })))
      .toBe('2026-08-13-포트관리-AB12CD34.md');
  });

  test('경로를 깨뜨리는 문자를 없앤다', () => {
    expect(archiveSlug('../../etc/passwd')).not.toContain('/');
    expect(archiveSlug('a:b*c?d"e<f>g|h')).not.toMatch(/[:*?"<>|]/);
  });

  test('빈 이름이어도 파일명이 나온다', () => {
    expect(archiveSlug('')).toBe('memory');
  });

  test('깨진 시각에도 던지지 않는다', () => {
    expect(archiveDateStamp('nonsense')).toBe('0000-00-00');
  });
});

describe('머리말', () => {
  test('폴더가 사라진 뒤에도 맥락을 알 수 있게 원본 경로와 코드를 담는다', () => {
    const header = archiveHeader(meta({ sourcePath: '/Users/x/proj', projectCode: 'ZZ99' }));
    expect(header).toContain('/Users/x/proj');
    expect(header).toContain('ZZ99');
    expect(header).toContain('cleanup');
    expect(header).toContain('memory-archive');
  });
});

describe('서버', () => {
  test('분해된 문서를 합쳐 읽는다 — 색인만 읽으면 본문을 잃는다', () => {
    expect(apiSource).toContain('readMemoryDocument(status.projectRoot, status.memoryPath)');
  });

  test('기억이 없으면 오류가 아니라 archived:false 다', () => {
    expect(apiSource).toContain('archived: false, reason: "NO_MEMORY"');
  });

  test('같은 날 두 번 보관해도 덮어쓰지 않는다', () => {
    expect(apiSource).toContain('for (let n = 2; existsSync(join(dir, name)); n += 1)');
  });

  test('본문 조회는 경로 조각이 섞인 이름을 거절한다', () => {
    expect(apiSource).toContain('wanted.includes("/") || wanted.includes("\\\\") || !wanted.endsWith(".md")');
  });
});

describe('정리 워크플로', () => {
  test('보관 → 원격 삭제 → 로컬 삭제 순서다', () => {
    // 로컬을 먼저 지우면 folderPath를 잃어 기억을 보관할 수 없다.
    const archiveAt = appSource.indexOf("/api/memory-archive`, {");
    const removeAt = appSource.indexOf('setPorts(prev => prev.filter(p => p.id !== item.id));');
    expect(archiveAt).toBeGreaterThan(0);
    expect(removeAt).toBeGreaterThan(archiveAt);
  });

  test('보관 실패가 삭제를 막지 않는다', () => {
    expect(appSource).toContain('장기기억 보관 실패 — 삭제는 계속합니다');
  });

  test('원격 삭제가 실패하면 로컬도 남긴다', () => {
    // 로컬만 지우면 id를 잃어 그 원격 행은 영영 회수 불가가 된다.
    expect(appSource).toContain('Supabase 삭제 실패 — 로컬도 남깁니다');
  });

  test('원격 삭제는 id 기준 — device_id와 무관하다', () => {
    // 실측: 150행 중 138행이 현재 기기 소유가 아니어서 어떤 push로도 회수되지 않았다.
    expect(appSource).toContain("from('portmgr_ports').delete().eq('id', item.id)");
  });

  test('정리 검토에 두 갈래 삭제 버튼이 있다', () => {
    expect(appSource).toContain('data-testid="cleanup-delete-local"');
    expect(appSource).toContain('data-testid="cleanup-delete-remote"');
    expect(appSource).toContain('data-testid="cleanup-cancel"');
  });
});

describe('대시보드', () => {
  test('lazy 로드 — 열지 않으면 청크를 내려받지 않는다', () => {
    expect(appSource).toContain("const MemoryArchivePanel = lazy(() => import('./memory/MemoryArchivePanel')");
  });

  test('이름·코드·요약·경로 전부에서 검색한다', () => {
    expect(panelSource).toContain('[item.projectName, item.projectCode, item.summary, item.sourcePath]');
  });

  test('아카이브에서 지우는 길을 두지 않는다', () => {
    // 지워도 노하우는 남기려고 만든 곳이다. 여기에 삭제를 두면 같은 실수를 뒤로 미룰 뿐이다.
    // (문구가 아니라 **동작**으로 확인한다 — 주석에 '삭제'라는 낱말은 나올 수 있다.)
    expect(panelSource).not.toContain("method: 'DELETE'");
    expect(panelSource).not.toContain('memory-archive-delete');
    expect(apiSource).not.toContain('"/api/memory-archive" && req.method === "DELETE"');
  });
});
