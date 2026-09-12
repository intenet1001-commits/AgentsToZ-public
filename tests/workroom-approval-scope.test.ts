import {expect,test} from 'bun:test';
import {ALL_WORKROOM_TARGETS,workroomApprovalScope,workroomApprovalOptions} from '../src/workroomApprovalScope';
const options=[{value:ALL_WORKROOM_TARGETS,label:'전체'},{value:'target:a',label:'A'},{value:'target:b',label:'B'},{value:'root:r',label:'R'}];
test('partial discovery allows all validated targets with an exclusion notice',()=>{
  const result=workroomApprovalOptions({complete:false,targets:[{targetId:'a',label:'A'},{targetId:'b',label:'B'}]});
  expect(result.options[0]?.label).toBe('현재 확인된 전체 프로젝트·워크트리 (2개)');
  expect(result.notice).toContain('확인되지 않은 항목은 제외');
  expect(workroomApprovalScope(ALL_WORKROOM_TARGETS,result.options)).toEqual({targetIds:['a','b']});
});
test('empty partial inventories and over-limit inventories cannot create bulk grants',()=>{
  for(const targets of [[],Array.from({length:257},(_,i)=>({targetId:String(i),label:String(i)}))]){
    const result=workroomApprovalOptions({complete:false,targets});
    expect(result.options.some(o=>o.value===ALL_WORKROOM_TARGETS)).toBe(false);
    expect(()=>workroomApprovalScope(ALL_WORKROOM_TARGETS,result.options)).toThrow();
  }
});
test('all consent snapshots exact targets without granting future roots or extra capabilities',()=>{
  expect(workroomApprovalScope(ALL_WORKROOM_TARGETS,options)).toEqual({targetIds:['a','b']});
});
test('individual and future controller-created root scopes remain separate',()=>{
  expect(workroomApprovalScope('target:a',options)).toEqual({targetIds:['a']});
  expect(workroomApprovalScope('root:r',options)).toEqual({workspaceRootIds:['r']});
});
test('unavailable all choice, empty inventory and oversized grants fail closed',()=>{
  expect(()=>workroomApprovalScope(ALL_WORKROOM_TARGETS,options.slice(1))).toThrow();
  expect(()=>workroomApprovalScope(ALL_WORKROOM_TARGETS,options.slice(0,1))).toThrow();
  expect(()=>workroomApprovalScope(ALL_WORKROOM_TARGETS,[options[0]!,...Array.from({length:257},(_,i)=>({value:`target:${i}`,label:String(i)}))])).toThrow();
});
