import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

describe('project identity copy controls', () => {
  test('keeps local hash copy and adds a name plus hash copy beside it', () => {
    expect(app).toContain('data-testid="meta-copy-project-code"');
    expect(app).toContain('data-testid="meta-copy-project-name-code"');
    expect(app).toContain('projectIdentityClipboard(sel.name, sel.id)');
    expect(app).toContain('#프로젝트명 + 해시 복사');
    expect(app).toContain('로컬프로젝트해시는 이 기기의 보조 식별값이며 라우팅에는 필수가 아닙니다.');
  });
});
