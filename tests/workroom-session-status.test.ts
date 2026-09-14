import {test,expect} from 'bun:test';
import {codexContextUsedFromFooter,validWorkroomSessionStatus,claudeWorkroomContext} from '../src/workroomSessionStatus';
import {normalizeMobileWorkspaceRequest,workspaceScope} from '../src/mobileWorkspaceProtocol';
test('context footer uses remaining percentage, never arbitrary prose or out of range values',()=>{
 expect(codexContextUsedFromFooter(['  32% context left'])).toBe(68);
 expect(codexContextUsedFromFooter(['100% left'])).toBe(0);
 for(const line of ['I have 32% left','101% left','-3% left','used 68%','model gpt-6'])expect(codexContextUsedFromFooter([line])).toBeNull();
});
test('workroom requests require exact session and separate memory permission',()=>{
 const r={operation:'workspace',requestId:'request-1234',targetId:'project-1234',workspace:{action:'workroom.status',sessionId:'session-1234'}} as const;
 expect(normalizeMobileWorkspaceRequest(r)).toEqual(r);expect(workspaceScope('workroom.save')).toBe('memory.save');
 expect(()=>normalizeMobileWorkspaceRequest({...r,workspace:{action:'workroom.status'}})).toThrow();
 expect(()=>normalizeMobileWorkspaceRequest({...r,workspace:{...r.workspace,folderPath:'/tmp'}})).toThrow();
 expect(validWorkroomSessionStatus({})).toBe(false);
});

test('Claude telemetry must belong to the exact Workroom session and lifetime',()=>{
 const session={id:'session-1234',cwd:'/fixture',createdAt:'2026-09-13T00:00:00Z'},now=Date.parse('2026-09-13T00:10:00Z');
 const snap={sessionId:session.id,cwd:session.cwd,capturedAt:'2026-09-13T00:05:00Z',contextWindow:{used_percentage:51}};
 expect(claudeWorkroomContext(session,snap,now).usedPercent).toBe(51);
 for(const patch of [{sessionId:'other-session'},{cwd:'/other'},{capturedAt:'2026-09-12T00:00:00Z'},{capturedAt:'2026-09-14T00:00:00Z'},{contextWindow:{used_percentage:NaN}}])expect(claudeWorkroomContext(session,{...snap,...patch},now).usedPercent).toBeNull();
});
