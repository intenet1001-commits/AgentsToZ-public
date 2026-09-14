/** Public explanations contain no owner token or filesystem diagnostics. */
export function workspaceLeaseMessage(code:string):string {
  switch(code) {
    case 'WORKSPACE_LEASE_BUSY': return '이 프로젝트에서는 다른 에이전트 또는 Git 작업이 실행 중입니다. 완료 후 다시 시도해 주세요.';
    case 'WORKSPACE_LEASE_RECOVERY_REQUIRED': return '종료된 프로세스의 작업공간 잠금이 남아 있습니다. 관련 AI·Git 작업이 모두 끝났는지 확인한 뒤 「도구 및 설정 → 작업공간 잠금 복구」에서 잠금을 복구하세요. 앱 재시작만으로는 해제되지 않습니다.';
    case 'WORKSPACE_LEASE_UNSAFE': return '작업공간을 안전하게 확인하지 못해 변경을 시작하지 않았습니다.';
    default: return '작업공간 잠금 상태를 확인하지 못해 변경을 시작하지 않았습니다. 앱을 재시작한 뒤 다시 시도해 주세요.';
  }
}
