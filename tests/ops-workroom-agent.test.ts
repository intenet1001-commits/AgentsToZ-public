import {expect,test} from 'bun:test';
import {opsWorkroomAgentFrom} from '../src/opsWorkroomAgent';

test('the OPS workroom opens with the remembered AI, not always codex',()=>{
  for(const agent of ['claude','hermes','agy','codex'] as const){
    const preference={agent,surface:'workroom' as const,updatedAt:'2026-10-04T00:00:00.000Z'};
    expect(opsWorkroomAgentFrom(preference)).toBe(agent);
  }
});

test('a missing or damaged preference still opens codex',()=>{
  expect(opsWorkroomAgentFrom(null)).toBe('codex');
  expect(opsWorkroomAgentFrom(undefined)).toBe('codex');
  expect(opsWorkroomAgentFrom({})).toBe('codex');
  expect(opsWorkroomAgentFrom({agent:'gpt'})).toBe('codex');
  expect(opsWorkroomAgentFrom({agent:42})).toBe('codex');
});
