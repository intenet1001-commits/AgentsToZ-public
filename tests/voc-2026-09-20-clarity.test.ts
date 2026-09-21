import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const memory=readFileSync(new URL('../src/PortalMemoryDirectory.tsx',import.meta.url),'utf8');
const work=readFileSync(new URL('../src/AiWorkRequestPanel.tsx',import.meta.url),'utf8');
const saving=readFileSync(new URL('../src/TerminalMemoryStatus.tsx',import.meta.url),'utf8');
const styles=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');

test('memory landing explains DEV memory, current-device connections and Buzz USE Agent as separate jobs',()=>{
  expect(memory).toContain('data-testid="portal-memory-orientation"');
  expect(memory).toContain('1 · DEV 프로젝트 기억');
  expect(memory).toContain('2 · 이 단말 연결');
  expect(memory).toContain('3 · Buzz 앱 Agent');
  expect(memory).toContain('DEV 기억과 USE 운영기억은 분리됩니다');
});

test('AI Work explains the safe stale-inventory behavior and the current start prerequisite',()=>{
  expect(work).toContain('삭제되거나 연결이 끊긴 대상이면 작업을 시작하지 않습니다');
  expect(work).toContain('data-testid="ai-work-readiness"');
  expect(work).toContain('1 프로젝트 → 2 실행 방식·AI → 3 요청 → 4 실행');
});

test('Workroom saving names local memory and Supabase backup without implying automatic recovery',()=>{
  expect(saving).toContain('이곳은 대화 입력창이 아니라 저장 결과판입니다');
  expect(saving).toContain('로컬 장기기억 저장과 Supabase 백업');
  expect(saving).toContain('자동 재실행 안 함');
});

test('the legacy conversation layout remains bounded while the AI Work tab is absent',()=>{
  expect(styles).toContain('min-height: clamp(20rem, calc(var(--ui-viewport-height, 100dvh) - 14rem), 34rem)');
  expect(app).not.toContain('top-level-runtime-tab');
  expect(app).not.toContain('<AgentRuntimePanel');
});
