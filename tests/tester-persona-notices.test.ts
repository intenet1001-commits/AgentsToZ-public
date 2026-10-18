import {expect,test} from 'bun:test';
import {personaOverflowNotice} from '../src/testerPersonaNotices';
import {TESTER_MCP_TOOLS} from '../src/testerAgentMcp';

// 자동 후보는 48개 한도에서 멈춘다 — 화면이 전체 한도(64)를 인용하면 「후보 48개」 옆에 「64개 한도」가 나와 모순으로 읽힌다.
test('the overflow notice cites the discovered-draft budget that actually stopped discovery',()=>{
  expect(personaOverflowNotice({candidateLimit:64,discoveredLimit:48,additionalCandidates:3})).toBe('자동 후보 48개 한도로 3개는 이번 제안에 포함되지 않았습니다. 현재 후보를 검토한 뒤 다시 제안하세요.');
});
test('an older runner without the discovered budget does not cite a limit it did not apply',()=>{
  const notice=personaOverflowNotice({candidateLimit:64,additionalCandidates:2});
  expect(notice).toBe('후보 한도로 2개는 이번 제안에 포함되지 않았습니다. 현재 후보를 검토한 뒤 다시 제안하세요.');
  expect(notice).not.toContain('64');
});
test('no overflow, no notice',()=>{
  expect(personaOverflowNotice({candidateLimit:64,discoveredLimit:48})).toBeNull();
  expect(personaOverflowNotice({candidateLimit:64,discoveredLimit:48,additionalCandidates:0})).toBeNull();
  expect(personaOverflowNotice(undefined)).toBeNull();
});
test('a proposal that removed unreviewed drafts tells the agent to report it',()=>{
  const tool=TESTER_MCP_TOOLS.find(t=>t.name==='agentstoz_use_propose_tester_persona')!;
  expect(tool.description).toContain('droppedCandidates');
});
