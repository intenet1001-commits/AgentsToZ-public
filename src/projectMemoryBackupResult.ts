export type ProjectMemoryBackupResult = Record<string, any>;

/** Returns operator-facing guidance only when the requested multi-plane backup is incomplete. */
export function projectMemoryBackupFailure(
  result: ProjectMemoryBackupResult | null | undefined,
): string | null {
  if (!result) return null;
  if (result.automaticMemory && result.localSaved !== true) return '이번 요청에서 새로 저장한 대화가 없습니다. 워크룸의 자동 기억 정리 상태에서 대기·제외·복구 필요 여부를 확인하세요.';
  if (result.backupSkipped === true) return null;
  if (result.localSaved === true && result.backupPending === true) return '로컬 기억은 저장됐으며 백업은 대기 중입니다. 자동 백업 결과를 워크룸에서 확인하세요.';
  const incompletePush = result.backupComplete === false;
  const incompleteSession = result.localSaved === true && result.remoteBackedUp === false;
  if (!incompletePush && !incompleteSession) return null;
  const remote = result.remote && typeof result.remote === "object" ? result.remote : result;
  const details = [
    result.backupError,
    remote.journalPullError,
    remote.journalError,
    remote.feedbackError,
  ].filter((value, index, values): value is string => (
    typeof value === "string" && value.trim().length > 0 && values.indexOf(value) === index
  ));
  return details.length
    ? `일부 백업이 완료되지 않았습니다: ${details.join("; ")}. 다시 Push하세요.`
    : "일부 백업이 완료되지 않았습니다. journal·feedback을 포함해 다시 Push하세요.";
}
