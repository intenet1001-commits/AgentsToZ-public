import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const design = readFileSync(new URL('../src/workspaceDesign.css', import.meta.url), 'utf8');

/**
 * VOC 2026-09-22: "이 공간이 너무 작아져서 상당히 불편해졌음 개선필요"
 * (anchor: top-toolbar · sidebar-project-row · project-role-badge · sidebar-pin-project)
 *
 * 실측(1000x907 창, 프로젝트 31개)으로 원인을 좁혔다. 사이드바 폭은 오히려
 * 232px -> 264px 로 넓어졌고 문제는 세로였다. 사이드바 548px 안에서 목록
 * (`flex:1; overflow-y:auto`)에 남은 높이가 195px — 49px 짜리 행이 2개만 보였다.
 * 목록 위 고정 블록이 306px 을 차지한 탓이다:
 *
 *   역할칩 86 + 필터칩 80 + 검색 64 + 오래된프로젝트 37 + 태그 39
 *
 * 세 칩/검색 블록은 한 줄이면 충분한 내용인데 세로 여백이 과했다. 창이 짧을 때만
 * 이 여백을 줄여 목록에 높이를 되돌려준다. 목록 자체의 스크롤 구조는 이미 올바르므로
 * 건드리지 않는다.
 */
describe('sidebar keeps a usable project list height', () => {
  test('the blocks stacked above the list shrink on short viewports', () => {
    // 목록과 세로 공간을 다투는 것은 사이드바 '안'의 칩·검색 블록이다.
    // 사이드바 바깥의 탭만 줄이면 실제 목록 높이는 그대로였다(실측 확인).
    expect(design).toContain('@media (max-height: 1100px)');
    const short = design.match(/@media \(max-height: 1100px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(short).toBeTruthy();
    expect(short).toContain('.workspace-project-sidebar > div:first-child');
    // 검색 블록은 클래스로 집는다. 예전 `> div:nth-child(2)` 는 역할 칩 <nav> 가 두 번째 자식으로
    // 끼어든 뒤 아무것도 가리키지 않아 이 규칙이 조용히 죽어 있었다(2026-09 감사).
    expect(short).toContain('.workspace-project-sidebar > .workspace-sidebar-search');
    expect(design).not.toContain('.workspace-project-sidebar > div:nth-child(2)');
    expect(short).toContain('[data-testid="stale-projects-review-bar"]');
  });

  test('the project list is guaranteed a minimum height', () => {
    // flex 아이템은 형제가 공간을 다 쓰면 0 까지 줄어든다. 목록에는 바닥을 준다.
    // `min-height: 0` 은 «줄어들어도 된다»는 뜻이라 바닥이 아니다 — 실제 값이 필요하다.
    const host = design.match(/\.workspace-sidebar-host\s*\{[^}]*\}/)?.[0] ?? '';
    expect(host).toBeTruthy();
    const min = host.match(/min-height:\s*([^;]+);/)?.[1]?.trim();
    expect(min).toBeDefined();
    expect(min).not.toBe('0');
  });

  test('the list keeps its own scroll area rather than growing the sidebar', () => {
    // 회귀 방지: 목록이 스크롤을 잃고 사이드바 전체를 늘리면 푸터가 밀려난다.
    expect(design).toContain('.workspace-sidebar-host');
    expect(design).toMatch(/\.workspace-sidebar-host[^}]*overflow:\s*hidden/);
  });

  test('rows collapse their meta lines on short viewports instead of stacking three', () => {
    // 실측: 31행 중 24행이 88px 이었다. 행 안이 세 줄로 쌓인 탓이다.
    //   24px 이름+역할 / 21px 별명·태그 / 20px 시각
    // 짧은 창에서는 별명·태그 줄과 시각 줄을 한 줄로 합쳐 행을 낮춘다.
    // 내용을 숨기지 않고 넘치는 부분만 말줄임한다.
    const short = design.match(/@media \(max-height: 1100px\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(short).toBeTruthy();
    expect(short).toContain('[data-testid="sidebar-project-row"] > div');
    expect(short).toContain('text-overflow: ellipsis');
  });
});
