import {describe,expect,test} from 'bun:test';
import {aiInitialPromptDraftError,aiInitialPromptError,AI_INITIAL_PROMPT_DRAFT_MAX_BYTES,AI_INITIAL_PROMPT_MAX_BYTES} from '../src/aiInitialPrompt';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {mergeAiWorkTargets} from '../src/AiWorkRequestPanel';
import {aiWorkTargetDisplayName,buildAiWorkMissionPrompt} from '../src/aiWorkOrchestration';
import {groupTerminalMemoryJobs} from '../src/TerminalMemoryStatus';

describe('shared initial CLI prompt budget',()=>{
  const request=(prompt:unknown,agent='codex')=>({operation:'start',requestId:'request_fixture_1',targetId:'target_fixture_1',agent,cols:100,rows:28,prompt});
  test.each(['a'.repeat(24_000),'한'.repeat(8_000),'😀'.repeat(6_000),'😀'.repeat(5_999)+'한a'])('accepts exact UTF-8 boundaries in UI and host',prompt=>{
    expect(new TextEncoder().encode(prompt).length).toBe(AI_INITIAL_PROMPT_MAX_BYTES);
    expect(aiInitialPromptError(prompt)).toBeNull();
    expect(normalizeAiTerminalRequest(request(prompt)).prompt).toBe(prompt);
  });
  test.each(['a'.repeat(24_001),'한'.repeat(8_000)+'a','😀'.repeat(6_000)+'a','before\0after',null,123])('rejects invalid input in UI and host',prompt=>{
    expect(aiInitialPromptError(prompt)).not.toBeNull();
    expect(()=>normalizeAiTerminalRequest(request(prompt))).toThrow();
  });
  test('preserves empty CLI start and provider restrictions',()=>{
    expect(aiInitialPromptError('')).toBeNull();
    expect(normalizeAiTerminalRequest(request('')).prompt).toBe('');
    expect(()=>normalizeAiTerminalRequest(request('read this','hermes'))).toThrow();
  });
  test('keeps invalid execution requests editable within a distinct 1MiB draft budget',()=>{
    expect(aiInitialPromptDraftError('한'.repeat(8001))).toBeNull();
    expect(aiInitialPromptDraftError('before\0after')).toBeNull();
    expect(aiInitialPromptDraftError('a'.repeat(AI_INITIAL_PROMPT_DRAFT_MAX_BYTES))).toBeNull();
    expect(aiInitialPromptDraftError('😀'.repeat(AI_INITIAL_PROMPT_DRAFT_MAX_BYTES/4))).toBeNull();
    expect(aiInitialPromptDraftError('😀'.repeat(AI_INITIAL_PROMPT_DRAFT_MAX_BYTES/4)+'a')).not.toBeNull();
    expect(aiInitialPromptDraftError('a'.repeat(AI_INITIAL_PROMPT_DRAFT_MAX_BYTES+1))).not.toBeNull();
  });
});

describe('Workroom memory receipt grouping',()=>{
  test('groups only identical target and state without deleting queue records',()=>{
    const jobs=[
      {sessionId:'one',targetId:'A',state:'failed' as const},
      {sessionId:'two',targetId:'A',state:'failed' as const},
      {sessionId:'three',targetId:'A',state:'saved' as const},
      {sessionId:'four',targetId:'B',state:'failed' as const},
    ];
    expect(groupTerminalMemoryJobs(jobs)).toEqual([
      {key:'A\0failed',targetId:'A',state:'failed',count:2},
      {key:'A\0saved',targetId:'A',state:'saved',count:1},
      {key:'B\0failed',targetId:'B',state:'failed',count:1},
    ]);
    expect(jobs).toHaveLength(4);
  });
});

describe('AI work mission orchestration',()=>{
  test('uses the stable project display name instead of runtime branch decoration',()=>{
    expect(aiWorkTargetDisplayName('프로젝트 A · codex/work')).toBe('프로젝트 A');
  });
  test('builds a bounded AgentsToZ mission prompt with selected workers',()=>{
    const prompt=buildAiWorkMissionPrompt({title:'출하 준비',goal:'테스트하고 배포해',targetLabel:'프로젝트 A',workers:['codex','hermes'],policy:'agentstoz'});
    expect(prompt).toContain('create_mission');
    expect(prompt).toContain('“프로젝트 A”');
    expect(prompt).toContain('codex, hermes');
    expect(prompt).toContain('AgentsToZ-Control');
    expect(prompt).not.toContain('Goal Gate');
  });
  test('adds cs-ceo only as the planning and review strategy',()=>{
    const prompt=buildAiWorkMissionPrompt({title:'복잡한 미션',goal:'다중 프로젝트 검증',targetLabel:'프로젝트 A',workers:['claude','agy'],policy:'cs-ceo'});
    expect(prompt).toContain('cs-ceo의 Goal Gate');
    expect(prompt).toContain('계획자와 검토자');
    expect(prompt).toContain('claude, agy');
  });
});

describe('AI request target inventory',()=>{
  const a={targetId:'target_fixture_a',label:'A'},b={targetId:'target_fixture_b',label:'B'};
  test('partial response retains prior targets and updates incoming labels',()=>{
    expect(mergeAiWorkTargets([a,b],[{...a,label:'new A'}],false)).toEqual([{...a,label:'new A'},b]);
    expect(mergeAiWorkTargets([a,b],[],false)).toEqual([a,b]);
  });
  test('only a complete response can remove a missing target',()=>{
    expect(mergeAiWorkTargets([a,b],[a],true)).toEqual([a]);
    expect(mergeAiWorkTargets([a,b],[],true)).toEqual([]);
  });
});
