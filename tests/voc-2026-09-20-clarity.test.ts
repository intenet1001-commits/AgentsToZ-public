import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';

const memory=readFileSync(new URL('../src/PortalMemoryDirectory.tsx',import.meta.url),'utf8');
const work=readFileSync(new URL('../src/AiWorkRequestPanel.tsx',import.meta.url),'utf8');
const saving=readFileSync(new URL('../src/TerminalMemoryStatus.tsx',import.meta.url),'utf8');
const styles=readFileSync(new URL('../src/index.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');

test('memory landing explains DEV memory, current-device connections and Buzz USE Agent as separate jobs',()=>{
  expect(memory).toContain('data-testid="portal-memory-orientation"');
  expect(memory).toContain('1 · AI가 작업 내용을 기억하게 하기');
  expect(memory).toContain('2 · 이 기기에서 Telegram으로 대화하기');
  expect(memory).toContain('3 · Buzz 앱에서 대화할 에이전트 만들기');
  expect(memory).toContain('개발 기억(DEV)과 서비스 운영기억(USE)은 따로 보관합니다');
});

test('AI Work explains the safe stale-inventory behavior and the current start prerequisite',()=>{
  expect(work).toContain('삭제되거나 연결이 끊긴 대상이면 작업을 시작하지 않습니다');
  expect(work).toContain('data-testid="ai-work-readiness"');
  expect(work).toContain('1 프로젝트 → 2 실행 방식·AI → 3 요청 → 4 실행');
});

test('Workroom saving names local memory and Supabase backup without implying automatic recovery',()=>{
  expect(saving).toContain('작업 내용이 저장됐는지 확인하는 곳입니다');
  expect(saving).toContain('로컬 장기기억 저장과 Supabase 백업');
  expect(saving).toContain('자동 재실행 안 함');
});

test('the legacy conversation layout remains bounded while the AI Work tab is absent',()=>{
  expect(styles).toContain('min-height: clamp(20rem, calc(var(--ui-viewport-height, 100dvh) - 14rem), 34rem)');
  expect(app).not.toContain('top-level-runtime-tab');
  expect(app).not.toContain('<AgentRuntimePanel');
});
