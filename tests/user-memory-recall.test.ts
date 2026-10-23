import { describe, expect, test } from 'bun:test';
import { recallUserInstructions, userMemoryQuery } from '../src/userMemoryRecall';

const row = (id = 'one', text = '지난 요청 원문', memoryId = 'memory-one') => ({ id, text, memoryId, recordedAt: '2026-10-22T00:00:00Z', agent: 'codex', promptOrigin: 'human' });
describe('explicit user instruction recall', () => {
  test('validates the actual normalized UTF-8 search budget before a store read', () => {
    expect(userMemoryQuery('  검증\n 요청  ')).toBe('검증 요청');
    expect(userMemoryQuery('a'.repeat(1024))).toHaveLength(1024);
    for (const query of ['', 'a'.repeat(1025), '한'.repeat(342), '\ufdfa'.repeat(50)]) expect(()=>userMemoryQuery(query)).toThrow();
  });
  test('queries only one exact memory locally and preserves provenance as historical evidence', async () => {
    const result = await recallUserInstructions({memoryId:'memory-one',query:'지난 요청',list: async request => {
      expect(request).toEqual({memoryIds:['memory-one'],query:'지난 요청',limit:5,source:'local'});
      return {items:[row()],hasMore:false,scan:{complete:true}};
    }});
    expect(result.state).toBe('ready'); expect(result.complete).toBe(true);
    expect(result.hits[0]).toMatchObject({source:'user-instruction',authority:'historical-evidence',memoryId:'memory-one',id:'one',recordedAt:'2026-10-22T00:00:00Z',promptOrigin:'human',caution:true});
  });
  test('never claims a complete search after a scope mismatch, scan failure or withheld data', async () => {
    for (const page of [
      {items:[row('other','다른 프로젝트','other-memory')],hasMore:false},
      {items:[row()],hasMore:true}, {items:[row()],hasMore:false,scan:{complete:false}},
      {items:[row()],hasMore:false,scan:{complete:true,unreadable:1}},
      {items:[row()],hasMore:false,scan:{complete:true,withheld:1}},
    ]) {
      const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>page});
      expect(result.complete).toBe(false);expect(result.hits.every(hit=>hit.memoryId==='memory-one')).toBe(true);
    }
  });
  test('bounds hits, UTF-8 and escaped JSON without splitting Korean or emoji', async () => {
    for (const text of ['한글😀'.repeat(2000),'\u0001'.repeat(5000)]) {
      const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>({items:Array.from({length:10},(_,i)=>row(String(i),text)),hasMore:true})});
      expect(result.hits).toHaveLength(5);expect(result.complete).toBe(false);
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(16_384);
      expect(result.hits.every(hit=>!hit.excerpt.includes('\ufffd')&&hit.excerptTruncated)).toBe(true);
    }
  });
  test('returns an unavailable read without leaking a provider error or retrying', async () => {
    let calls=0;
    const result=await recallUserInstructions({memoryId:'memory-one',query:'요청',list:async()=>{calls++;throw Error('/private/key-provider secret');}});
    expect(calls).toBe(1);expect(result).toEqual({state:'unavailable',scope:'project-local',memoryId:'memory-one',hits:[],complete:false});
  });
});
