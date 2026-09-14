import {test,expect} from 'bun:test';
import {workspaceLeaseMessage} from '../src/workspaceLeaseMessage';
test('dead manual owners explain recovery separately from temporary contention and I/O failures',()=>{
  const recovery=workspaceLeaseMessage('WORKSPACE_LEASE_RECOVERY_REQUIRED');
  expect(recovery).toContain('관련 AI·Git 작업이 모두 끝났는지');
  expect(recovery).toContain('앱 재시작만으로는 해제되지 않습니다');
  expect(workspaceLeaseMessage('WORKSPACE_LEASE_BUSY')).toContain('완료 후 다시 시도');
  expect(workspaceLeaseMessage('WORKSPACE_LEASE_IO')).not.toBe(recovery);
});
test('the recovery message names where the lock can be recovered inside the app',()=>{
  // Without a location the user is told to "recover the lock" with no way to do it.
  expect(workspaceLeaseMessage('WORKSPACE_LEASE_RECOVERY_REQUIRED')).toContain('도구 및 설정 → 작업공간 잠금 복구');
});
