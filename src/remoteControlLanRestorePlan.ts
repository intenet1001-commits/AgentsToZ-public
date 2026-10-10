/**
 * What to do with a stored LAN remote-control record at startup — one place, so the resumed
 * listener, the status surface and the operator's 「켜기」 cannot disagree about why it is off.
 *
 * The stored bind address is never trusted. A Mac on DHCP gets a different lease and a Mac that
 * moved networks never holds the old address again, so resuming there would advertise a QR nothing
 * can reach. Refusing is right; refusing *silently* was the defect: for 127 consecutive sidecar
 * starts the only trace was one line in the sidecar log, while the app reported plain
 * `enabled: false` — indistinguishable from never having turned it on.
 *
 * Rebinding is safe exactly when nothing can be stranded. A LAN session token lives in the phone's
 * web storage keyed by `http://<address>:<port>`, so a new address is a new origin that the phone
 * cannot present its token to. With no stored sessions there is no token to orphan and the
 * listener can come back by itself; with sessions, the operator decides, because that click is what
 * consents to those phones re-scanning.
 *
 * Two candidate addresses are not a choice to make for someone: binding the wrong interface (a VPN
 * leg, a second Wi-Fi) hands out a QR the phone on the real network cannot reach. Ambiguity stalls.
 */

export type RemoteControlLanStallReason =
  /** Stored phones hold origin-bound tokens a rebind would orphan. */
  | 'sessions'
  /** No private IPv4 address at all — typically Wi-Fi is not up yet. */
  | 'no-interface'
  /** More than one private address; which network to serve is the operator's call. */
  | 'ambiguous';

export type RemoteControlLanStall = {
  savedAddress: string;
  savedPort: number;
  sessions: number;
  reason: RemoteControlLanStallReason;
  /** Addresses available right now, so the surface can offer them without a second round trip. */
  available: string[];
};

export type RemoteControlLanRestorePlan =
  /** No usable record: never enabled, or locally disabled. */
  | { action: 'idle' }
  /** The stored address is still held; bring the listener and its phones back unchanged. */
  | { action: 'resume'; address: string; port: number }
  /** The address changed and nothing can be stranded; serve the current one on the stored port. */
  | { action: 'rebind'; address: string; port: number; savedAddress: string }
  | ({ action: 'stalled' } & RemoteControlLanStall);

export type RemoteControlLanRestoreInput = {
  record: { bindAddress: string; port: number; sessions: readonly unknown[] } | null;
  interfaces: readonly { address: string }[];
};

export function planRemoteControlLanRestore(
  input: RemoteControlLanRestoreInput,
): RemoteControlLanRestorePlan {
  const { record } = input;
  if (!record) return { action: 'idle' };
  const available = [...new Set(input.interfaces.map(entry => entry.address))];
  if (available.includes(record.bindAddress)) {
    return { action: 'resume', address: record.bindAddress, port: record.port };
  }
  const stall = (reason: RemoteControlLanStallReason): RemoteControlLanRestorePlan => ({
    action: 'stalled',
    savedAddress: record.bindAddress,
    savedPort: record.port,
    sessions: record.sessions.length,
    reason,
    available,
  });
  if (record.sessions.length > 0) return stall('sessions');
  if (available.length === 0) return stall('no-interface');
  if (available.length > 1) return stall('ambiguous');
  return {
    action: 'rebind',
    address: available[0]!,
    port: record.port,
    savedAddress: record.bindAddress,
  };
}

export function remoteControlLanStallOf(
  plan: RemoteControlLanRestorePlan,
): RemoteControlLanStall | null {
  if (plan.action !== 'stalled') return null;
  const { savedAddress, savedPort, sessions, reason, available } = plan;
  return { savedAddress, savedPort, sessions, reason, available };
}

/** Operator-facing reason, used by the sidecar log and the app's dialog alike. */
export function remoteControlLanStallMessage(stall: RemoteControlLanStall): string {
  const head = `저장된 LAN 주소 ${stall.savedAddress}를 이 Mac이 더는 갖고 있지 않습니다`;
  if (stall.reason === 'sessions') {
    return `${head} — 연결된 기기 ${stall.sessions}대의 접속 정보가 그 주소에 묶여 있어 자동으로 옮기지 않습니다. 「켜기」를 누르면 지금 주소로 다시 시작하고, 그 기기들은 QR을 다시 스캔해야 합니다.`;
  }
  if (stall.reason === 'no-interface') {
    return `${head} — 지금 사용할 수 있는 사설 네트워크 주소가 없습니다. Wi-Fi가 연결되면 다시 시도합니다.`;
  }
  return `${head} — 사설 네트워크 주소가 ${stall.available.length}개라 어느 쪽을 쓸지 고르지 않았습니다. 「켜기」에서 주소를 선택해 주세요.`;
}

/**
 * Short header-chip label. Lives beside the long message so the badge, the dialog and the sidecar
 * log cannot describe the same stall differently.
 */
export function remoteControlLanStallBadgeLabel(
  stall: RemoteControlLanStall,
  lang: 'ko' | 'en' = 'ko',
): string {
  if (stall.reason === 'no-interface') {
    return lang === 'ko' ? 'LAN 원격 · 네트워크 없음' : 'LAN remote · no network';
  }
  if (stall.reason === 'ambiguous') {
    return lang === 'ko' ? 'LAN 원격 · 주소 선택 필요' : 'LAN remote · pick an address';
  }
  return lang === 'ko' ? 'LAN 원격 · 주소 바뀜' : 'LAN remote · address changed';
}
