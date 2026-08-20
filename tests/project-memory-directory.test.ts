import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildMemoryDirectory,
  describeMemoryQueryFailure,
  filterMemoryDirectory,
  matchMemoryForProject,
  type MemoryRevisionRow,
} from '../src/projectMemoryDirectory';

const row = (over: Partial<MemoryRevisionRow> & { memory_id: string; created_at: string }): MemoryRevisionRow => ({
  id: `${over.memory_id}-${over.created_at}`,
  project_name: '프로젝트',
  github_url: null,
  device_id: 'device-a',
  device_name: 'MacBook',
  content_hash: 'hash',
  ...over,
});

describe('기억 목록 접기', () => {
  test('한 기억의 여러 리비전을 하나로 접고 최신 값을 쓴다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '옛 이름', device_name: 'iMac', device_id: 'device-b' }),
      row({ memory_id: 'm1', created_at: '2026-08-10T00:00:00Z', project_name: '새 이름', device_name: 'MacBook' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.projectName).toBe('새 이름');
    expect(entries[0]!.lastDeviceName).toBe('MacBook');
    expect(entries[0]!.revisionsInWindow).toBe(2);
    expect(entries[0]!.deviceCountInWindow).toBe(2);
  });

  test('입력 순서가 달라도 같은 결과가 나온다', () => {
    const rows = [
      row({ memory_id: 'm1', created_at: '2026-08-10T00:00:00Z', project_name: '새 이름' }),
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '옛 이름' }),
    ];
    expect(buildMemoryDirectory(rows)).toEqual(buildMemoryDirectory([...rows].reverse()));
  });

  test('최근 갱신 순으로 정렬한다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      row({ memory_id: 'new', created_at: '2026-08-14T00:00:00Z' }),
    ]);
    expect(entries.map(e => e.memoryId)).toEqual(['new', 'old']);
  });

  // ID 를 건네는 것이 이 화면의 목적이다. 이름이 비었다고 목록에서 빠지면 건넬 방법이 없어진다.
  test('이름이 비어도 목록에서 사라지지 않는다', () => {
    const entries = buildMemoryDirectory([row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '  ' })]);
    expect(entries[0]!.projectName).toBe('(이름 없음)');
  });

  test('memory_id 가 없는 줄은 건너뛴다 — 가리킬 대상이 없다', () => {
    expect(buildMemoryDirectory([
      row({ memory_id: '', created_at: '2026-08-01T00:00:00Z' }),
      { ...row({ memory_id: 'x', created_at: '2026-08-01T00:00:00Z' }), memory_id: null },
    ])).toEqual([]);
  });

  test('시각이 없거나 깨진 줄은 더 오래된 것으로 다루고 버리지 않는다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'm1', created_at: 'not-a-date', project_name: '깨진 시각' }),
      row({ memory_id: 'm1', created_at: '2026-08-01T00:00:00Z', project_name: '정상' }),
    ]);
    expect(entries[0]!.projectName).toBe('정상');
    expect(entries[0]!.revisionsInWindow).toBe(2);
  });

  test('저장소가 있는 기억과 없는 기억을 모두 담는다', () => {
    const entries = buildMemoryDirectory([
      row({ memory_id: 'repo', created_at: '2026-08-02T00:00:00Z', github_url: 'https://github.com/o/r' }),
      row({ memory_id: 'norepo', created_at: '2026-08-01T00:00:00Z', github_url: '   ' }),
    ]);
    expect(entries.find(e => e.memoryId === 'repo')!.githubUrl).toBe('https://github.com/o/r');
    expect(entries.find(e => e.memoryId === 'norepo')!.githubUrl).toBeNull();
  });
});

describe('검색', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'aaaa-1111', created_at: '2026-08-02T00:00:00Z', project_name: 'ShadowLoop', device_name: 'MacBook' }),
    row({ memory_id: 'bbbb-2222', created_at: '2026-08-01T00:00:00Z', project_name: 'Portal', github_url: 'https://github.com/o/portal', device_name: 'iMac' }),
  ]);

  test('빈 검색어는 전부 통과시킨다', () => {
    expect(filterMemoryDirectory(entries, '   ')).toHaveLength(2);
  });

  test('이름·기기·저장소로 찾는다', () => {
    expect(filterMemoryDirectory(entries, 'shadow')[0]!.memoryId).toBe('aaaa-1111');
    expect(filterMemoryDirectory(entries, 'imac')[0]!.memoryId).toBe('bbbb-2222');
    expect(filterMemoryDirectory(entries, 'github.com/o/portal')[0]!.memoryId).toBe('bbbb-2222');
  });

  // 다른 기기에서 복사한 ID 조각을 그대로 붙여넣어 확인하는 것이 실제 사용 흐름이다.
  test('ID 일부만 붙여넣어도 찾는다', () => {
    expect(filterMemoryDirectory(entries, 'bbbb')[0]!.memoryId).toBe('bbbb-2222');
  });
});

describe('조회 실패 안내', () => {
  // 실측(2026-08-14)으로 받은 문구다. anon 으로 나갔거나, 로그인했어도 정책이 using(false)면
  // 똑같이 이 오류가 온다 — 원문만 보여주면 사용자가 로그인만 반복한다.
  const denied = new Error('permission denied for table portmgr_project_memory_revisions');

  // 세션이 없으면 쿼리가 anon 으로 나간다. 그런데 portmgr_ports 는 anon 에게도 열려 있어
  // 프로젝트 목록은 멀쩡히 보인다 — 그래서 사용자는 로그인된 줄 알고 여기만 고장 났다고 읽는다.
  test('세션이 없으면 익명 조회였다고 말하고 다시 로그인시킨다', () => {
    const text = describeMemoryQueryFailure(denied, false);
    expect(text).toContain('permission denied');
    expect(text).toContain('익명');
    expect(text).toContain('다시 로그인');
    // 멀쩡한 DB 를 건드리게 만드는 오답을 이 경우에 내면 안 된다.
    expect(text).not.toContain('SQL을 다시 실행');
  });

  test('세션이 있는데도 거부되면 그때만 정책을 의심한다', () => {
    const text = describeMemoryQueryFailure(denied, true);
    expect(text).toContain('정책');
    expect(text).toContain('SQL을 다시 실행');
  });

  test('세션을 모르면 단정하지 않는다', () => {
    const text = describeMemoryQueryFailure(denied);
    expect(text).toContain('로그인 상태를 먼저 확인');
    expect(text).not.toContain('SQL을 다시 실행');
  });

  test('테이블 부재는 설치 안내로 보낸다', () => {
    expect(describeMemoryQueryFailure({ message: 'relation does not exist' })).toContain('테이블 생성');
  });

  test('모르는 오류는 원문 그대로 둔다 — 지어내지 않는다', () => {
    expect(describeMemoryQueryFailure(new Error('network unreachable'))).toBe('network unreachable');
  });
});

describe('포털 화면 계약', () => {
  const view = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  test('기기로 거르지 않는다 — 다른 기기의 기억을 찾는 화면이다', () => {
    expect(view).not.toContain(".eq('device_id'");
  });

  test('목록에서는 content 를 받지 않는다', () => {
    // 컬럼 목록은 공유 모듈이 정본이다(두 소비자가 같은 조회를 쓰므로).
    const dir = readFileSync(new URL('../src/projectMemoryDirectory.ts', import.meta.url), 'utf8');
    expect(dir).toContain("'id, memory_id, project_name, github_url, device_id, device_name, content_hash, created_at'");
    expect(dir).not.toContain('content,');
    expect(view).toContain('MEMORY_LIST_COLUMNS');
  });

  test('조회 구간을 넘기면 잘렸다고 말한다', () => {
    expect(view).toContain('data-testid="portal-memory-window-warning"');
  });

  test('ID 복사와 저장소 없음 표시가 있다', () => {
    expect(view).toContain('data-testid="portal-memory-copy-id"');
    expect(view).toContain('저장소 없음 · ID로만 연결');
  });

  test('탭이 두 레이아웃 모두에서 닿는다 — 본문은 분기 바깥에 하나', () => {
    expect(portal).toContain("type Tab = 'bookmarks' | 'ports' | 'memories';");
    // 본문을 레이아웃 분기 밖으로 뺀 뒤로는 한 번만 쓴다(리마운트 방지).
    expect(portal.match(/activeTab === 'memories' && \(/g) ?? []).toHaveLength(1);
    // 대신 탭 진입점이 사이드바(전체)와 헤더 둘째 줄(컴팩트) 두 곳에 있다.
    expect(portal).toContain("['memories', '장기기억'");
    expect(portal).toContain('{tabsEl}');
  });
});

describe('프로젝트 행에 붙일 기억 고르기', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'repo-m', created_at: '2026-08-02T00:00:00Z', project_name: '다른 이름', github_url: 'https://github.com/o/repo' }),
    row({ memory_id: 'name-m', created_at: '2026-08-01T00:00:00Z', project_name: 'tele' }),
    row({ memory_id: 'dup-a', created_at: '2026-08-01T00:00:00Z', project_name: '겹침' }),
    row({ memory_id: 'dup-b', created_at: '2026-08-01T00:00:00Z', project_name: '겹침' }),
  ]);

  test('저장소가 이름보다 우선한다 — 이름은 바뀌어도 저장소는 계보 키다', () => {
    const matched = matchMemoryForProject(entries, { name: 'tele', githubUrl: 'https://github.com/o/repo' });
    expect(matched?.memoryId).toBe('repo-m');
  });

  test('.git 꼬리와 대소문자가 달라도 같은 저장소로 본다', () => {
    expect(matchMemoryForProject(entries, { githubUrl: 'https://GitHub.com/o/repo.git' })?.memoryId).toBe('repo-m');
  });

  test('저장소가 없으면 이름으로 잇는다', () => {
    expect(matchMemoryForProject(entries, { name: 'tele' })?.memoryId).toBe('name-m');
  });

  // 틀린 ID 를 복사하면 남의 기억에 이 프로젝트를 합류시키게 된다. 애매하면 보여주지 않는다.
  test('후보가 여럿이면 고르지 않는다', () => {
    expect(matchMemoryForProject(entries, { name: '겹침' })).toBeNull();
  });

  test('맞는 것이 없으면 null', () => {
    expect(matchMemoryForProject(entries, { name: 'CS볼트V6_remote' })).toBeNull();
    expect(matchMemoryForProject(entries, {})).toBeNull();
  });
});

describe('프로젝트 행의 기억 칩', () => {
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  test('GitHub 칩 바로 옆에 붙는다 — 본래 요청이 그 자리였다', () => {
    expect(portal).toContain("{inlineUrlPill(p, 'github_url')}\n                {memoryPill(p)}");
    expect(portal).toContain('data-testid="portal-row-memory-id"');
  });

  test('기억 조회가 실패해도 프로젝트 행은 그대로 나온다', () => {
    // 세션이 없으면 이 테이블만 거부된다(포트는 anon 에게도 열려 있다).
    // 곁들이는 정보 때문에 목록 자체가 사라지면 안 된다.
    expect(portal).toContain('if (!cancelled) setMemoryEntries([]);');
  });

  test('맞는 기억이 없으면 아무것도 그리지 않는다', () => {
    expect(portal).toContain('if (!matched) return null;');
  });
});

describe('세션 복원을 기다린 뒤 조회한다', () => {
  const view = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');
  const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');

  // supabase-js 는 세션을 비동기로 되살리는데 화면 게이트는 localStorage 플래그로 즉시
  // 통과시킨다. 마운트 직후에 쏘면 JWT 가 붙기 전이라 anon 으로 나가 42501 이 온다.
  test('두 조회 모두 getSession() 뒤에 쿼리한다', () => {
    for (const source of [view, portal]) {
      const call = source.indexOf('.auth.getSession()');
      const query = source.indexOf("from('portmgr_project_memory_revisions')");
      expect(call).toBeGreaterThan(-1);
      expect(call).toBeLessThan(query);
    }
  });

  test('로그인이 늦게 도착해도 스스로 다시 읽는다', () => {
    for (const source of [view, portal]) {
      expect(source).toContain('onAuthStateChange');
      expect(source).toContain("event === 'SIGNED_IN'");
    }
  });
});

describe('행이 기억 ID를 직접 들고 있으면 추측하지 않는다', () => {
  const entries = buildMemoryDirectory([
    row({ memory_id: 'exact-1', created_at: '2026-08-02T00:00:00Z', project_name: '다른 이름' }),
    row({ memory_id: 'byname', created_at: '2026-08-01T00:00:00Z', project_name: 'CS볼트V6' }),
  ]);

  test('memory_id 가 저장소·이름보다 우선한다', () => {
    const matched = matchMemoryForProject(entries, {
      memoryId: 'exact-1', name: 'CS볼트V6', githubUrl: 'https://github.com/o/r',
    });
    expect(matched?.memoryId).toBe('exact-1');
  });

  // 실측 사례: 포트 이름 CS볼트V6_remote, 기억 이름 CS볼트V6, 기억의 저장소는 null —
  // 간접 키 둘 다 실패했다. ID 를 실으면 이런 조합도 정확히 붙는다.
  test('이름이 다르고 저장소가 없어도 붙는다', () => {
    expect(matchMemoryForProject(entries, { memoryId: 'byname', name: 'CS볼트V6_remote' })?.memoryId)
      .toBe('byname');
  });

  test('아는 ID 가 목록에 없으면 다른 기억으로 내려가지 않는다', () => {
    // 틀린 기억을 보여주는 것이 아무것도 안 보여주는 것보다 나쁘다.
    expect(matchMemoryForProject(entries, { memoryId: '없는-id', name: 'CS볼트V6' })).toBeNull();
  });

  test('ID 가 없으면 예전처럼 간접 키로 내려간다', () => {
    expect(matchMemoryForProject(entries, { memoryId: null, name: 'CS볼트V6' })?.memoryId).toBe('byname');
  });
});
