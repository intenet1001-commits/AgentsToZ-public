import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const panelSource = readFileSync(new URL('../src/ProjectMemoryPanel.tsx', import.meta.url), 'utf8');

/**
 * VOC: "고정영역과, 최근 사용했던 날짜 유휴된것들 정보가 이상하게 안맞는거같은데 검토하고,
 *       오래된 프로젝트는 몇일 이상이면 포함시킬지 기간을 설정하는 기능도 있으면 좋을거같음"
 *
 * 원인은 기준이 두 벌이었던 것이다. 행 라벨·정렬·섹션 카운트는 lastActivityFor
 * (= max(앱 방문, git 커밋))인데, 유휴 소그룹과 정리 검토 라벨만 lastVisits(앱 방문)만 봤다.
 * 실측 97개 중 7개가 "행에는 4~14일 전인데 오래됨(30일+)으로 분류"됐고, 그 7개가 정리
 * 검토의 삭제 후보에 올라 있었다.
 */
describe('활동 기준은 한 벌이어야 한다', () => {
  const idleBlock = (() => {
    const start = appSource.indexOf('const IDLE_RECENT_MS');
    const end = appSource.indexOf('const inpV3', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return appSource.slice(start, end);
  })();

  test('유휴 소그룹 셋 다 lastActivityFor를 쓴다', () => {
    const uses = idleBlock.match(/lastActivityFor\(p\.id\)/g) ?? [];
    expect(uses.length).toBe(3); // recent · aging · stale
  });

  test('소그룹이 lastVisits만 보는 코드가 남아 있지 않다', () => {
    // 이 한 줄이 남아 있으면 같은 불일치가 그대로 돌아온다.
    expect(idleBlock).not.toContain('const last = lastVisits[p.id];');
  });

  test('소그룹은 gitActivity 변화에도 다시 계산된다', () => {
    // deps에 gitActivity가 없으면 커밋 후에도 옛 분류가 남는다.
    const deps = idleBlock.match(/\[v3Idle, lastVisits, gitActivity[^\]]*\]/g) ?? [];
    expect(deps.length).toBe(3);
  });

  test('정리 검토 라벨도 같은 기준을 쓴다', () => {
    expect(appSource).toContain('const last = lastActivityFor(item.id);');
    expect(appSource).toContain("`${Math.floor((Date.now() - last) / 86400000)}일 전 활동`");
    expect(appSource).toContain("'활동 기록 없음'");
    // 예전 문구가 남아 있으면 방문만 본다는 뜻이다.
    expect(appSource).not.toContain("'방문 기록 없음'");
  });
});

describe('오래됨 기준 일수 설정', () => {
  test('기기별 localStorage에 저장한다', () => {
    expect(appSource).toContain("localStorage.getItem('portmanager-stale-days')");
    expect(appSource).toContain("localStorage.setItem('portmanager-stale-days', String(next))");
  });

  test('비정상 값은 기본 30일로 되돌린다', () => {
    // 0이면 전부 "오래됨"이 되어 정리 검토가 통째로 위험해진다.
    expect(appSource).toContain('raw >= 1 && raw <= 3650 ? Math.floor(raw) : 30');
    expect(appSource).toContain('value >= 1 && value <= 3650 ? Math.floor(value) : 30');
  });

  test('임계값이 설정을 따른다 — 30일이 박혀 있지 않다', () => {
    expect(appSource).toContain('const IDLE_STALE_MS = staleDays * 86400000;');
    expect(appSource).not.toContain('const IDLE_STALE_MS = 30 * 86400000;');
  });

  test('사이드바·모달 문구가 설정값을 보여 준다', () => {
    expect(appSource).toContain('오래됨 ({staleDays}일+/기록 없음)');
    expect(appSource).toContain('정리 검토 — {staleDays}일 이상 미사용');
    expect(appSource).toContain('data-testid="cleanup-stale-days"');
  });

  test('설명이 활동의 두 근거를 밝힌다', () => {
    expect(appSource).toContain('활동(앱에서 열기 또는 git 커밋)이 없는');
  });
});

describe('Hermes 명령 블록 접기', () => {
  test('항상 쓰는 것이 아니므로 아코디언이다', () => {
    const at = panelSource.indexOf('data-testid="project-memory-hermes-commands"');
    expect(at).toBeGreaterThan(0);
    // 여는 태그가 details 인지 (testid 앞 100자 안에 <details 가 있어야 한다)
    expect(panelSource.slice(Math.max(0, at - 100), at)).toContain('<details');
    expect(panelSource.slice(at, at + 2200)).toContain('<summary');
  });

  test('접힌 상태가 기본 — 이 상자는 팝업으로만 열린다', () => {
    // 인라인으로 작게 펼치는 길을 없앴다. 같은 내용을 작게/크게 두 벌로 보여주면
    // 사용자는 둘의 차이를 먼저 묻게 되고, 정작 작은 쪽은 읽히지 않는다
    // (글씨가 작다는 VOC 가 이 상자에서 나왔다).
    expect(panelSource).not.toContain('const [hermesOpen, setHermesOpen]');
    expect(panelSource).toContain('open={hermesZoom}');
    const at = panelSource.indexOf('data-testid="project-memory-hermes-commands"');
    expect(panelSource.slice(Math.max(0, at - 100), at + 400)).not.toContain(' open>');
    expect(panelSource.slice(Math.max(0, at - 100), at + 400)).not.toContain('open={true}');
  });

  test('크게 보기는 사본이 아니라 같은 상자를 띄운다', () => {
    // VOC: 이 영역 글씨가 너무 작다 → 팝업으로 키운다. 다만 내용을 두 벌로 그리면
    // 복사 버튼과 testid 가 둘이 되므로, 같은 details 를 고정 오버레이로 올린다.
    expect(panelSource).toContain('data-testid="project-memory-hermes-zoom"');
    expect(panelSource).toContain('data-testid="project-memory-hermes-zoom-backdrop"');
    expect(panelSource).toContain('const [hermesZoom, setHermesZoom] = useState(false);');
    // 오버레이는 패널을 감싼 모달(z 9500)보다 위에 있어야 한다.
    expect(panelSource).toContain('zIndex: 9700');
    expect(panelSource).toContain('zIndex: 9701');
    // 그리고 Esc 로 닫혀야 한다 — 패널이 모달 안에 있을 때 다른 출구가 없다.
    expect(panelSource).toContain("if (e.key === 'Escape')");
    // 상자가 하나뿐이라는 증거: hermes-commands testid 는 소스에 한 번만 나온다.
    expect(panelSource.split('data-testid="project-memory-hermes-commands"').length - 1).toBe(1);
  });

  test('안쪽 명령 버튼들은 그대로 있다', () => {
    // topic 명령은 표(hermesTopicCommands)에서 렌더되므로 id가 JSX가 아니라 표에 있다.
    for (const id of [
      'copy-hermes-memory-link', 'copy-hermes-remember-session',
      'copy-hermes-memory-sync', 'copy-hermes-memory-status',
    ]) {
      expect(panelSource).toContain(`testId: '${id}'`);
    }
    // 경로 인자형의 복사 버튼은 항상 보이는 「로컬 터미널 AI」 줄에 하나만 둔다.
    expect(panelSource).toContain('data-testid="copy-hermes-remember-session-local"');
  });
});
