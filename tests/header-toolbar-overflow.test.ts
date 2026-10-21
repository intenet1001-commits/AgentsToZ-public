import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VOC: "업데이트 버튼이 안눌러지고, 그리고 new project 가 버튼 가리는 현상 개선해"
 *
 * 두 증상은 헤더 도구줄 하나에서 나온다. 그 줄이 `overflowX: auto` + 숨긴 스크롤바였고,
 * 헤더 자체는 `overflow: hidden` 이었다.
 *
 *  - 업데이트 배지와 AI 표시 설정은 아래로 열리는 팝오버를 갖는데, 잘리는 상자 안에서
 *    열리니 클릭은 먹었는데 화면에는 아무것도 안 떴다. 실측(1000px 폭): 팝오버 y 224~420,
 *    잘리는 경계 221 → 보이는 높이 -3px, elementFromPoint 로도 닿지 않음.
 *  - 같은 줄의 내용은 795px 인데 보이는 폭은 445px 이라 뒤쪽 버튼 절반이 사라졌고,
 *    잘린 자리가 New project 바로 왼쪽이라 "New project 가 버튼을 가린다"로 읽혔다.
 */
const app = readFileSync(join(import.meta.dir, '..', 'src', 'App.tsx'), 'utf8');

const headerBlock = (() => {
  const start = app.indexOf('data-testid="project-main-header"');
  expect(start).toBeGreaterThan(0);
  const end = app.indexOf('data-testid="header-new-project"', start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
})();

/** 헤더 자신의 style 객체만 — h1 의 말줄임과 런처의 라운드 클립은 별개다. */
const headerOwnStyle = headerBlock.slice(0, headerBlock.indexOf('<h1'));

const actionsBlock = (() => {
  const start = headerBlock.indexOf('data-testid="project-main-actions"');
  expect(start).toBeGreaterThan(0);
  return headerBlock.slice(start, start + 400);
})();

describe('헤더 도구줄은 잘라 내지 않는다', () => {
  test('헤더가 팝오버를 잘라 내지 않는다', () => {
    // 이 줄의 컨트롤은 아래로 열린다. overflow:hidden 이면 열려도 보이지 않고,
    // 사용자에게는 "버튼이 안 눌린다"로 보인다.
    expect(headerOwnStyle).toContain("overflow:'visible'");
    expect(headerOwnStyle).not.toContain("overflow:'hidden'");
  });

  test('도구줄은 숨은 가로 스크롤이 아니라 줄바꿈으로 넘긴다', () => {
    expect(actionsBlock).toContain("flexWrap:'wrap'");
    // 스크롤바를 숨긴 가로 스크롤은 넘친 버튼을 "없는 것"으로 만든다.
    expect(actionsBlock).not.toContain("overflowX:'auto'");
    expect(actionsBlock).not.toContain("scrollbarWidth:'none'");
  });

  test('New project 는 도구줄 밖에 남아 오른쪽에 고정된다', () => {
    // 줄바꿈으로 바뀌었다고 이 버튼까지 흘려보내면 위치가 매번 달라진다.
    const actionsAt = app.indexOf('data-testid="project-main-actions"');
    const newProjectAt = app.indexOf('data-testid="header-new-project"');
    expect(newProjectAt).toBeGreaterThan(actionsAt);
    expect(app.slice(actionsAt, newProjectAt)).toContain('</div>');
    expect(app.slice(newProjectAt, newProjectAt + 600)).toContain('flexShrink:0');
  });
});
