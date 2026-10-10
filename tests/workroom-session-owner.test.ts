import {expect,test} from 'bun:test';
import {workroomSessionOwner} from '../src/workroomSessionOwner';

test('only the OPS Workroom uses the 총괄 label',()=>{
  expect(workroomSessionOwner('ops','ops','아젠투지 1호')).toBe('총괄(아젠투지 1호)');
  expect(workroomSessionOwner('project','ops','아젠투지 1호')).toBe('아젠투지 1호');
  expect(workroomSessionOwner('project','ops','아젠투지 3호',true)).toBe('아젠투지 3호');
  expect(workroomSessionOwner('ops','ops','아젠투지 3호',true)).toBe('총괄(아젠투지 3호)');
  expect(workroomSessionOwner('project',undefined,'\u202e잘못된 이름',true)).toBe('연결된 기기');
});
