import {expect,test} from 'bun:test';
import {agentDialoguePublishId,agentDialoguePublishRows,agentDialoguePublishSummary,agentDialoguePublishedIds,
  agentDialogueRowChecked,type AgentDialoguePublishEnabled} from '../src/agentDialoguePublishRows';

const ops=(endpointId='ops-endpoint'):AgentDialoguePublishEnabled=>
  ({target:'ops',kind:'ops',endpointId,displayName:'아젠투지(OPS) · 아젠투지 1호'});
const project=(portId:string,endpointId=`${portId}-endpoint`,displayName=portId):AgentDialoguePublishEnabled=>
  ({target:`project:${portId}`,kind:'project',portId,endpointId,displayName});

const manyTargets=[{id:'ops',name:'아젠투지(OPS) · 아젠투지 1호'},
  ...Array.from({length:100},(_,index)=>({id:`p${index}`,name:`프로젝트 ${index}`}))];

test('published targets are checked without any staged selection',()=>{
  const rows=agentDialoguePublishRows({targets:manyTargets,enabled:[ops(),project('p7','e7','nhcs탄생기')]});
  expect(rows).toHaveLength(101);
  expect(agentDialogueRowChecked(rows[0]!)).toBe(true);
  expect(agentDialogueRowChecked(rows.find(row=>row.id==='p7')!)).toBe(true);
  expect(agentDialogueRowChecked(rows.find(row=>row.id==='p8')!)).toBe(false);
  expect(agentDialoguePublishSummary(rows)).toEqual({published:2,total:101,missing:0});
});

test('a status that has not arrived yet publishes nothing',()=>{
  const rows=agentDialoguePublishRows({targets:manyTargets,enabled:null});
  expect(agentDialoguePublishSummary(rows)).toEqual({published:0,total:101,missing:0});
});

test('ids come from kind and portId, and fall back to the target key',()=>{
  expect(agentDialoguePublishId(ops())).toBe('ops');
  expect(agentDialoguePublishId(project('abc'))).toBe('abc');
  expect(agentDialoguePublishId({target:'project:xyz',kind:'project',endpointId:'e',displayName:'x'})).toBe('xyz');
  expect(agentDialoguePublishedIds([ops(),project('abc'),project('abc','other')])).toEqual(['ops','abc']);
});

test('an in-flight change shows the intent, not the stale host state',()=>{
  const inFlight=new Map<string,'publish'|'unpublish'>([['ops','unpublish'],['p1','publish']]);
  const rows=agentDialoguePublishRows({targets:manyTargets,enabled:[ops()],inFlight});
  const opsRow=rows[0]!,p1=rows.find(row=>row.id==='p1')!;
  expect(opsRow.published).toBe(true);
  expect(agentDialogueRowChecked(opsRow)).toBe(false);
  expect(p1.published).toBe(false);
  expect(agentDialogueRowChecked(p1)).toBe(true);
  expect(agentDialoguePublishSummary(rows).published).toBe(1);
});

test('a published target the app no longer lists stays reachable to turn off',()=>{
  const rows=agentDialoguePublishRows({targets:[{id:'ops',name:'총괄'}],
    enabled:[ops(),project('gone','gone-endpoint','삭제된 프로젝트')]});
  const orphan=rows.at(-1)!;
  expect(orphan).toMatchObject({id:'gone',name:'삭제된 프로젝트',missing:true,published:true,endpointId:'gone-endpoint'});
  expect(agentDialoguePublishSummary(rows)).toEqual({published:2,total:1,missing:1});
});

test('search narrows the rows but the summary keeps the real counts',()=>{
  const all=agentDialoguePublishRows({targets:manyTargets,enabled:[ops(),project('p7','e7','프로젝트 7')]});
  // Trimmed, case-folded substring match: «프로젝트 7» also matches 70–79.
  const found=agentDialoguePublishRows({targets:manyTargets,enabled:[],search:'  프로젝트 7  '});
  expect(found.map(row=>row.id)).toEqual(['p7','p70','p71','p72','p73','p74','p75','p76','p77','p78','p79']);
  expect(agentDialoguePublishRows({targets:manyTargets,enabled:[],search:'OPS'}).map(row=>row.id)).toEqual(['ops']);
  expect(agentDialoguePublishSummary(all)).toEqual({published:2,total:101,missing:0});
});
