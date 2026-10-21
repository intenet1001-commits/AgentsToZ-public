import {expect,test} from 'bun:test';
import {reconcileTerminalSummaries} from '../src/terminalSummaryReconciliation';
import type {AiTerminalSummary} from '../src/aiTerminalProtocol';

const session:AiTerminalSummary={id:'session-123',targetId:'target-123',agent:'codex',state:'running',createdAt:'2026-09-21T00:00:00Z',exitCode:null,cols:80,rows:24};
test('identical Workroom inventory polls preserve React identity',()=>{
 const previous=[session];
 expect(reconcileTerminalSummaries(previous,[{...session}])).toBe(previous);
 expect(reconcileTerminalSummaries(previous,[{...session,rows:30}])).not.toBe(previous);
});
test('a late stale inventory cannot revive a locally exited terminal',()=>{
 const exited={...session,state:'exited' as const,exitCode:0};
 const previous=[exited];
 expect(reconcileTerminalSummaries(previous,[{...session}])).toBe(previous);
});
