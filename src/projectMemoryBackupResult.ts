export type ProjectMemoryBackupResult = Record<string, any>;

/** Returns operator-facing guidance only when the requested multi-plane backup is incomplete. */
export function projectMemoryBackupFailure(
  result: ProjectMemoryBackupResult | null | undefined,
): string | null {
  if (!result || result.backupSkipped === true) return null;
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
