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

  test('원격 삭제를 선택했는데 설정이 없으면 로컬 ID도 보존한다', () => {
    const cleanupStart = appSource.indexOf('const cleanupProject = async');
    const start = appSource.indexOf("if (options.deleteRemote && (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey))", cleanupStart);
    const branch = appSource.slice(start, appSource.indexOf('} else {', start));
    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(cleanupStart);
    expect(branch).toContain('원격 삭제와 로컬 삭제를 중단합니다');
    expect(branch).toContain('return;');
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
    expect(appSource).toContain("label = '이 기기 소유인데 로컬에 없음'; warning = null; reclaimable = true;");
    expect(appSource).toContain('label = `등록되지 않은 기기 (${owner.slice(0, 8)}…)`;');
    expect(appSource).toContain('자동 회수 대상으로 보지 않습니다.');
    const unregistered = appSource.slice(
      appSource.indexOf('} else if (!deviceNames.has(owner)) {'),
      appSource.indexOf('} else {', appSource.indexOf('} else if (!deviceNames.has(owner)) {') + 1),
    );
    expect(unregistered).toContain('reclaimable = false;');
    expect(appSource).toContain('다른 기기의 현재 프로젝트일 수 있습니다.');
    expect(appSource).toContain('data-testid="cleanup-orphan-risk"');
  });

  test('다른 기기 소유는 다른 testid로 구분한다 — 실수 클릭을 구분할 수 있어야 한다', () => {
    expect(appSource).toContain("group.reclaimable ? 'cleanup-orphan-delete' : 'cleanup-orphan-delete-other'");
  });

  test('로컬에 있는 행은 고아가 아니다', () => {
    expect(appSource).toContain('if (localIds.has(row.id)) continue;');
  });

  test('조회 당시의 완전한 원격 신원을 삭제 요청에 보존한다', () => {
    expect(appSource).toContain("select('id,name,device_id,sync_generation')");
    expect(appSource).toContain('device_id: row.device_id');
    expect(appSource).toContain('sync_generation: row.sync_generation');
  });

  test('명시적 삭제만 exact-ID tombstone을 먼저 남기고 공유 lease 안에서 지운다', () => {
    const deletion = appSource.slice(
      appSource.indexOf('const deleteOrphanGroup = async'),
      appSource.indexOf('// Quick-add project modal'),
    );
    expect(deletion.indexOf("await persistRemoteDeletedPortIds(ids, 'add')"))
      .toBeLessThan(deletion.indexOf('await withPortalSafetyLease(cfg'));
    expect(deletion).toContain('ids.some(id => !tombstones.has(id))');
    expect(deletion.indexOf('await withPortalSafetyLease(cfg'))
      .toBeLessThan(deletion.indexOf('deletePortsWithDurableFence('));
    expect(deletion).toContain('await deletePortsWithDurableFence(supabase, expectedRows, crypto.randomUUID())');
    expect(deletion).toContain('error instanceof PortDurableFenceError && error.mutationMayHaveCommitted');
    expect(deletion).toContain('await rollbackRejectedRemoteDeletionMarkers(markerIdsAddedThisAttempt)');
    expect(deletion).not.toContain("await persistRemoteDeletedPortIds(ids, 'remove')");
    expect(deletion).not.toContain("supabase.from('portmgr_ports').delete()");
    expect(deletion).not.toContain(".delete().in('id'");
    const scan = appSource.slice(
      appSource.indexOf('const scanSupabaseOrphans = useCallback'),
      appSource.indexOf('const deleteOrphanGroup = async'),
    );
    expect(scan).not.toContain('persistRemoteDeletedPortIds');
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
