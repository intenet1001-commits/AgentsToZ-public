import {describe,expect,test} from 'bun:test';
import {AGENT_DIALOGUE_COMMUNITY_IDLE_MIGRATION, AGENT_DIALOGUE_DATABASE_OUTDATED, describeAgentDialogueRpcError, isAgentDialogueOperationUnknown} from '../src/agentDialogueDatabaseState';

const refused=new Error('postgres error: AGENT_DIALOGUE_OPERATION_INVALID');

test('a new operation the database does not know becomes an instruction, not a code',()=>{
  const described=describeAgentDialogueRpcError('community-status',refused);
  expect(described?.code).toBe(AGENT_DIALOGUE_DATABASE_OUTDATED);
  expect(described?.message).toContain('커뮤니티');
  expect(described?.message).toContain('20261004030000_agent_dialogue_community.sql');
  expect(describeAgentDialogueRpcError('pairings',refused)?.message).toContain('1:1 연결');
});

test('an operation the first release already had keeps its original error',()=>{
  // The same code also means «genuinely no such operation»; only the newer ones are reinterpreted.
  expect(describeAgentDialogueRpcError('send',refused)).toBeNull();
  expect(describeAgentDialogueRpcError('status',refused)).toBeNull();
});

test('any other failure is left alone',()=>{
  expect(describeAgentDialogueRpcError('community-join',new Error('network down'))).toBeNull();
  expect(isAgentDialogueOperationUnknown(new Error('network down'))).toBe(false);
  expect(isAgentDialogueOperationUnknown('AGENT_DIALOGUE_OPERATION_INVALID')).toBe(true);
  expect(isAgentDialogueOperationUnknown(null)).toBe(false);
});

describe('적용되지 않은 유휴 면제 마이그레이션 (2026-10-06)', () => {
  // 커뮤니티는 **나가지 않는 한 계속**이므로 「방이 유휴」로 거절될 수 없다 — 유일하게 알려진 원인이
  // 그 마이그레이션 미적용이다. 그런데 이 변경은 새 동작 이름이 아니라 기존 `send` 의 **행동**을
  // 바꿨고, 커뮤니티 보내기는 RPC 이름이 `send` 라서 이름 경로가 이중으로 막혀 있었다.
  test('커뮤니티 보내기가 유휴로 거절되면 그 파일 이름을 말한다', () => {
    const refusal = new Error('AGENT_DIALOGUE_ROOM_INACTIVE');
    const described = describeAgentDialogueRpcError('community-send', refusal);
    expect(described?.code).toBe(AGENT_DIALOGUE_DATABASE_OUTDATED);
    expect(described?.message).toContain(AGENT_DIALOGUE_COMMUNITY_IDLE_MIGRATION);
    expect(described?.message).toContain('나가지 않는 한 계속');
  });

  test('일반 1:1 방의 유휴 거절은 그대로 둔다 — 그 방은 정말 2시간 규칙을 받는다', () => {
    expect(describeAgentDialogueRpcError('send', new Error('AGENT_DIALOGUE_ROOM_INACTIVE'))).toBeNull();
    expect(describeAgentDialogueRpcError('read', new Error('AGENT_DIALOGUE_ROOM_INACTIVE'))).toBeNull();
  });

  test('호스트가 와이어 이름이 아니라 설명용 라벨로 번역한다', async () => {
    const source = await Bun.file(new URL('../src/agentDialogueHost.ts', import.meta.url)).text();
    // 와이어는 계속 `send`·`read` 다 — 라벨만 커뮤니티로 넘긴다.
    expect(source).toContain("'community-send');");
    expect(source).toContain("'community-read');");
    expect(source).toContain('describeAgentDialogueRpcError(label,error)');
  });
});
