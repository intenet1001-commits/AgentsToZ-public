import {expect,test} from 'bun:test';
import {canMoveMemoryToHistory,memoryHistoryKey,moveMemoryToHistory,readMemoryHistory} from '../src/terminalMemoryHistory';
test('tidying receipts preserves active work and exposes later state changes',()=>{
 const jobs=[{sessionId:'failed-session',state:'failed' as const},{sessionId:'done-session',state:'unchanged' as const}];
 const previous=moveMemoryToHistory([],jobs);
 expect(readMemoryHistory(JSON.stringify(previous))).toEqual(previous);
 expect(previous).toContain(memoryHistoryKey(jobs[0]!));
 expect(previous).not.toContain(memoryHistoryKey({...jobs[0]!,state:'recovery-required'}));
 for(const state of ['pending','saving','retrying','backup-pending'] as const)expect(canMoveMemoryToHistory({sessionId:'active-session',state})).toBe(false);
 expect(jobs[0]!.state).toBe('failed');
 expect(moveMemoryToHistory(previous,jobs)).toEqual(previous);
 expect(readMemoryHistory('broken')).toEqual([]);
 expect(readMemoryHistory(JSON.stringify(Array.from({length:3000},(_,i)=>String(i))))).toHaveLength(2048);
});
