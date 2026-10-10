/**
 * The phone's own network, said once for every remote-control screen.
 *
 * 2026-10-10 (iPhone 13, web portal, Wi‑Fi off for ~40 s): the header still said 「연결됨」, the
 * workroom blamed the Mac for a request that never left the phone, and the membership card told the
 * user to check database migrations. Nothing on either phone surface read the phone's network state.
 *
 * The LAN QR page (`remoteControlMobilePage.ts`, plain JS) embeds these with `fn.toString()`, so
 * **each function must stand alone**: no imports, no module constants, no helpers outside its body
 * (same rule as `remoteControlScreenText.ts`; `tests/phone-network.test.ts` runs them in isolation).
 */

/**
 * `navigator.onLine === false` is the only reliable direction: the device has no network at all.
 * `true` does not prove the internet is reachable (captive portal, dead Wi‑Fi), so a failed request
 * must still be judged by its own error. No navigator (server, test) reads as online.
 */
export function phoneIsOnline(nav?: { onLine?: unknown } | null): boolean {
  const source = nav === undefined ? (typeof navigator === 'undefined' ? null : navigator) : nav;
  return !source || source.onLine !== false;
}

/** The short state label — the header pill, a host tab, the LAN page status chip. */
export function phoneOfflineLabel(): string {
  return '휴대폰 오프라인';
}

/** A banner sentence: what happened and what the user can do. */
export function phoneOfflineNotice(): string {
  return '휴대폰이 인터넷에 연결되어 있지 않습니다. Wi‑Fi나 셀룰러 데이터를 켜면 저절로 다시 연결합니다.';
}

/**
 * Where a Mac's liveness would be. With no network on this side the Mac's state is unknown — saying
 * 「N분째 응답 없음 · 절전일 수 있음」 here blamed a Mac that may be perfectly awake.
 */
export function phoneOfflineHostLine(reachable: 'phone-offline' | 'relay-unreachable'): string {
  return reachable === 'phone-offline'
    ? '휴대폰 오프라인 · 다시 연결되면 Mac 상태를 확인합니다'
    : '릴레이에 연결하지 못함 · 휴대폰 네트워크를 확인하세요';
}

/**
 * The LAN QR page: the phone lost its network, so nothing is counted and nothing is forgotten.
 * `saved` — a pairing is stored and is reused; otherwise the QR just opened is still unspent and is used.
 */
export function phoneOfflineLanNotice(saved: boolean): string {
  return saved
    ? '휴대폰이 네트워크에 연결되어 있지 않습니다. 연결이 돌아오면 저장된 연결로 바로 다시 붙습니다 — QR을 다시 스캔할 필요는 없습니다.'
    : '휴대폰이 네트워크에 연결되어 있지 않습니다. 연결이 돌아오면 이 QR로 바로 연결합니다 — QR을 다시 스캔할 필요는 없습니다.';
}

/**
 * The pill and host tabs while the device reports a network but the relay cannot be reached (captive or
 * dead Wi‑Fi): 「연결됨」 would contradict the line below it, 「휴대폰 오프라인」 would contradict the device.
 */
export function relayUnreachableLabel(): string {
  return '휴대폰 네트워크 확인';
}

/**
 * The relay controller's refusal of a request made while the device reports no network
 * (`REMOTE_CONTROL_PHONE_OFFLINE`). `background` — the workroom's own list/read poll: nobody pressed anything and
 * the page reconnects by itself, so it is the banner's sentence (kept identical — a test pins it), not 「다시 시도하세요」.
 */
export function phoneOfflineRefusal(background: boolean): string {
  return background
    ? '휴대폰이 인터넷에 연결되어 있지 않습니다. Wi‑Fi나 셀룰러 데이터를 켜면 저절로 다시 연결합니다.'
    : '휴대폰이 인터넷에 연결되어 있지 않아 요청을 보내지 않았습니다. Wi‑Fi나 셀룰러 데이터를 켠 뒤 다시 시도하세요.';
}

/** The device reports a network, but the last relay call failed on it: say the phone's network, never the Mac. */
export function relayUnreachableNotice(): string {
  return '휴대폰에서 릴레이에 연결하지 못했습니다. 휴대폰 네트워크를 확인하세요. 연결되면 저절로 이어집니다.';
}

/** A request refused because the relay is out of reach from this phone; for a background poll, the notice above. */
export function relayUnreachableRefusal(background: boolean): string {
  return background
    ? '휴대폰에서 릴레이에 연결하지 못했습니다. 휴대폰 네트워크를 확인하세요. 연결되면 저절로 이어집니다.'
    : '휴대폰에서 릴레이에 연결하지 못해 Mac 상태를 확인할 수 없습니다. 요청은 보내지 않았습니다 — 휴대폰 네트워크를 확인한 뒤 다시 시도하세요.';
}

/**
 * Text typed into the workroom while the device has no network: it was not sent and it is still in the box.
 * Also used by the Mac's remote panel (driving another Mac), so it says 「인터넷」, not 「휴대폰」.
 */
export function offlineInputNotice(): string {
  return '인터넷에 연결되어 있지 않아 입력을 보내지 않았습니다. 쓴 글은 입력칸에 그대로 두었습니다 — 연결되면 다시 보내세요.';
}

/** A tap made while offline: this request was not sent and is not waiting anywhere. */
export function phoneOfflineTapNotice(actionLabel?: string): string {
  return `${actionLabel ? `${actionLabel} 요청은` : '요청을'} 보내지 않았습니다 — 휴대폰이 오프라인입니다. Wi‑Fi나 셀룰러 데이터를 켠 뒤 다시 눌러 주세요.`;
}

/**
 * A sign-in or membership check that never reached the server. Offline, the page re-checks by itself when
 * the network returns. Online-but-failing, no 'online' event will come: the page retries on a bounded timer
 * (auth-js keeps a failed token refresh for 60 s, so an immediate 「다시 확인」 can fail again), and the
 * button is the way once that timer has given up.
 */
export function portalNetworkFailureMessage(subject: 'membership' | 'session', online: boolean): string {
  const object = subject === 'membership' ? '회원 권한을' : '로그인 상태를';
  return online
    ? `네트워크 요청이 실패해 ${object} 확인하지 못했습니다. 잠시 뒤 저절로 다시 확인합니다 — 계속되면 연결을 확인한 뒤 「다시 확인」을 누르세요.`
    : `네트워크에 연결되지 않아 ${object} 확인하지 못했습니다. Wi‑Fi나 셀룰러 데이터를 켜면 저절로 다시 확인합니다.`;
}
