import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/ProjectMemoryPanel.tsx', import.meta.url), 'utf8');

/**
 * VOC: "여기삭제도 정리검토의 삭제처럼 수파베이스까지 지울지 선택 기능이 있어야지,
 *       그리고 … 포트는 지웠는데 수파베이스는 남아있는것들 관리 기능이 필요할거같음"
 */
describe('카드 삭제도 두 갈래', () => {
  test('로컬만 / Supabase까지 / 취소', () => {
    expect(appSource).toContain('data-testid="delete-confirm-local"');
    expect(appSource).toContain('data-testid="delete-confirm-remote"');
    expect(appSource).toContain('data-testid="delete-confirm-cancel"');
  });

  test('정리 검토와 같은 경로(cleanupProject)를 쓴다', () => {
    // 삭제 경로가 둘로 갈리면 한쪽만 아카이브·원격 정리를 하게 된다.
    expect(appSource).toContain("void cleanupProject(t, { deleteRemote: true })");
    expect(appSource).toContain("void cleanupProject(t, { deleteRemote: false })");
  });

  test('장기기억 보관 여부를 미리 알린다', () => {
    expect(appSource).toContain('장기기억이 있으면 아카이브에 보관한 뒤 삭제합니다.');
  });
});

describe('원격 고아 정리', () => {
  test('소유자별로 갈라서 분류한다', () => {
    // "내 목록에 없다" = 쓰레기가 아니다. 다른 기기가 쓰는 행일 수 있다.
    for (const marker of ["key = 'mine'", "key = 'unowned'", 'key = `unregistered:${owner}`', 'key = `device:${owner}`']) {
      expect(appSource).toContain(marker);
    }
  });

  test('회수 가능한 것만 기본 정리 대상으로 표시한다', () => {
    expect(appSource).toContain("label = '이 기기 소유인데 로컬에 없음'; reclaimable = true;");
    expect(appSource).toContain("소유 — 그 기기에서 사용 중일 수 있음`; reclaimable = false;");
  });

  test('다른 기기 소유는 다른 testid로 구분한다 — 실수 클릭을 구분할 수 있어야 한다', () => {
    expect(appSource).toContain("group.reclaimable ? 'cleanup-orphan-delete' : 'cleanup-orphan-delete-other'");
  });

  test('로컬에 있는 행은 고아가 아니다', () => {
    expect(appSource).toContain('if (localIds.has(row.id)) continue;');
  });

  test('삭제는 나눠 보낸다 — URL 길이 제한', () => {
    expect(appSource).toContain('i += 50');
  });

  test('조회는 열었을 때가 아니라 버튼으로 한다', () => {
    // 정리 검토를 열 때마다 원격을 때리면 느려지고, 대부분은 조회할 이유가 없다.
    expect(appSource).toContain('data-testid="cleanup-orphan-scan"');
    expect(appSource).toContain('void scanSupabaseOrphans()');
  });
});

describe('Hermes 명령의 쓰임새 구분', () => {
  test('로컬 터미널 줄에 Hermes 버튼이 있다', () => {
    expect(panelSource).toContain('data-testid="copy-hermes-remember-session-local"');
  });

  test('로컬용은 인자가 붙은 형태다', () => {
    // 스킬 규약상 인자 없는 /remember_session 은 Telegram topic 바인딩을 따르므로
    // 로컬 터미널에서는 대상이 없어 멈춘다.
    const at = panelSource.indexOf('copy-hermes-remember-session-local');
    expect(panelSource.slice(at, at + 400)).toContain('hermesRememberSessionPathCommand');
  });

  test('Hermes 상자는 Telegram용이라고 먼저 못 박는다', () => {
    expect(panelSource).toContain('data-testid="project-memory-hermes-scope"');
    expect(panelSource).toContain('여기 명령은 Telegram의 Hermes 대화에 붙여넣습니다.');
    expect(panelSource).toContain('Hermes 명령 <span style={{ fontWeight: 400 }}>— Telegram 대화에 붙여넣는 것</span>');
  });

  test('호스트가 이 PC일 수도 AWS일 수도 있음을 밝힌다', () => {
    // 같은 명령이라도 제어 대상이 갈린다는 사실을 두 축 모두로 말한다:
    // 무엇이 그것을 정하는가(gateway 위치)와, 그 결과 무엇을 제어하는가.
    expect(panelSource).toContain('그 대화를 받는 gateway가 도는 호스트');
    expect(panelSource).toContain('“Telegram으로 이 PC를 제어”');
    expect(panelSource).toContain('“Telegram으로 AWS를 제어”');
  });
});
