export interface HermesDesktopBackendRecord {
  pid?: unknown;
  profile?: unknown;
  command?: unknown;
}

/** Read only live, profile-scoped Hermes Desktop servers from its ownership ledger. */
export function liveHermesDesktopProfiles(
  input: unknown,
  isPidRunning: (pid: number) => boolean,
): Set<string> {
  const records = input && typeof input === 'object' && Array.isArray((input as { backends?: unknown }).backends)
    ? (input as { backends: HermesDesktopBackendRecord[] }).backends
    : [];
  const live = new Set<string>();
  for (const record of records) {
    const pid = Number(record?.pid);
    const profile = typeof record?.profile === 'string' ? record.profile.trim() : '';
    const command = typeof record?.command === 'string' ? record.command : '';
    if (!Number.isInteger(pid) || pid <= 0 || !profile) continue;
    if (!command.includes('hermes_cli.main') || !command.includes(' serve')) continue;
    if (profile !== 'default' && !command.includes(`--profile ${profile} `)) continue;
    if (isPidRunning(pid)) live.add(profile);
  }
  return live;
}
