export const ALL_WORKROOM_TARGETS = 'all-targets';
export interface WorkroomScopeOption { value: string; label: string }

/** Incomplete discovery still yields individually validated targets. Consent is
 * the explicit snapshot below, never an assertion that discovery was exhaustive. */
export function workroomApprovalOptions(inventory: {
  targets: {targetId: string; label: string}[];
  complete: boolean;
}) {
  const targets = inventory.targets.map(t => ({value: 'target:' + t.targetId, label: t.label}));
  const count = new Set(inventory.targets.map(t => t.targetId)).size;
  const canApproveAll = count > 0 && count <= 256;
  return {
    options: [...(canApproveAll ? [{value: ALL_WORKROOM_TARGETS, label: `${inventory.complete ? '현재 등록된' : '현재 확인된'} 전체 프로젝트·워크트리 (${count}개)`}] : []), ...targets],
    notice: count > 256 ? '전체 승인은 최대 256개까지 지원합니다. 프로젝트를 선택하세요.'
      : !inventory.complete ? `일부 등록 항목을 확인하지 못했습니다. 현재 확인된 ${count}개만 승인할 수 있으며, 확인되지 않은 항목은 제외됩니다.` : '',
  };
}

export function workroomApprovalScope(scope: string, options: WorkroomScopeOption[]) {
  if (!options.some(option => option.value === scope)) throw new Error('허용 범위를 다시 선택하세요.');
  if (scope === ALL_WORKROOM_TARGETS) {
    const targetIds = [...new Set(options.filter(o => o.value.startsWith('target:')).map(o => o.value.slice(7)))];
    if (!targetIds.length || targetIds.length > 256) throw new Error('전체 승인은 1~256개의 프로젝트·워크트리를 지원합니다.');
    return { targetIds };
  }
  if (scope.startsWith('root:')) return { workspaceRootIds: [scope.slice(5)] };
  if (scope.startsWith('target:')) return { targetIds: [scope.slice(7)] };
  throw new Error('허용 범위를 다시 선택하세요.');
}
