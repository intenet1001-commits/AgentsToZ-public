import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const remoteCard = readFileSync(new URL('../src/RemoteControlProjectCard.tsx', import.meta.url), 'utf8');
const lan = readFileSync(new URL('../src/remoteControlMobilePage.ts', import.meta.url), 'utf8');

describe('project identity copy controls', () => {
  test('keeps the project-code copy and adds a name plus code copy beside it (ui-glossary: 프로젝트 코드, not 해시)', () => {
    expect(app).toContain('data-testid="meta-copy-project-code"');
    expect(app).toContain('data-testid="meta-copy-project-name-code"');
    expect(app).toContain('projectIdentityClipboard(sel.name, sel.id)');
    expect(app).toContain('#프로젝트명 + 코드 복사');
    expect(app).toContain('프로젝트 코드는 이 기기의 보조 식별값이며 라우팅에는 필수가 아닙니다.');
  });
  test('offers the same project mention identity on both mobile remote surfaces',()=>{
    expect(remoteCard).toContain('remoteProjectMentionClipboard(project.name,project.controlId)');
    expect(remoteCard).toContain('#프로젝트명 + 코드 복사');
    expect(lan).toContain('#프로젝트명 + 코드 복사');
    // The QR page embeds the portal's own function, so the two copies cannot drift.
    expect(lan).toContain('const projectMentionClipboard=${remoteProjectMentionClipboard.toString()};');
  });
});
