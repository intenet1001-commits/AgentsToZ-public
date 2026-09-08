/**
 * 이 브라우저의 **기기 신원** 한 곳.
 *
 * 신원(=내가 누구인가)과 조회 선택(=지금 어느 기기를 보고 있나)은 다른 개념인데
 * 예전에는 둘이 같은 값(`portalData_v1.deviceId`)을 공유했다. 그래서 다른 기기를
 * 한 번 조회하면 그 UUID 가 이 브라우저의 신원으로 굳었고, 그 상태로 Push 하면
 * `portmgr_devices` 의 **남의 기기 행**에 `last_push_at`·이름·핸드오프 메모가
 * 기록됐다. 실측(2026-08-14)으로 이 기기의 신원이 세 번 갈린 것도 같은 계열이다.
 *
 * 신원은 이 파일의 `portal-device-id` 한 키에만 산다. 조회 선택은
 * `portalSelectedDevice` 가 따로 들고 있고, 이 모듈은 그 키를 절대 읽지 않는다.
 */

export const OWN_DEVICE_ID_KEY = 'portal-device-id';
/** 조회 선택 키. 여기서는 **마이그레이션 판단에만** 쓰고 신원으로 삼지 않는다. */
export const SELECTED_DEVICE_KEY = 'portalSelectedDevice';
export const PORTAL_WEB_KEY = 'portalData_v1';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/**
 * 신원 키가 비어 있을 때 딱 한 번, 예전 위치(`portalData_v1.deviceId`)의 값을 승격한다.
 *
 * ⚠️ **조회 선택 이력이 있는 브라우저에서는 승격하지 않는다.** 그 값은 남의 기기를
 * 조회하면서 이미 덮어써졌을 수 있고, 오염된 값을 신원으로 굳히면 이 결함을 영구화한다.
 * 그때는 새 UUID 를 발급하는 편이 안전하다 — 최악이라도 "새 단말로 등록" 안내가 뜬다.
 */
function migrateLegacyIdentity(): string | null {
  if (readLocal(SELECTED_DEVICE_KEY)) return null;
  try {
    const legacy = JSON.parse(readLocal(PORTAL_WEB_KEY) ?? '{}')?.deviceId;
    return typeof legacy === 'string' && UUID_RE.test(legacy) ? legacy : null;
  } catch {
    return null;
  }
}

/** 이 브라우저의 신원. 없으면 만들어 저장한다. */
export function getOwnDeviceId(): string {
  const stored = readLocal(OWN_DEVICE_ID_KEY);
  if (stored && UUID_RE.test(stored)) return stored;
  const next = migrateLegacyIdentity() ?? crypto.randomUUID();
  setOwnDeviceId(next);
  return next;
}

/**
 * 신원을 바꾼다. **등록처럼 사용자가 명시적으로 신원을 정하는 경로에서만** 부른다 —
 * 조회 선택은 이 함수를 부르지 않는다.
 */
export function setOwnDeviceId(id: string): void {
  if (!UUID_RE.test(id)) return;
  try { localStorage.setItem(OWN_DEVICE_ID_KEY, id); } catch { /* 사파리 프라이빗 등 */ }
  // 예전 위치도 함께 맞춰 둔다. 이 값을 읽는 옛 경로가 남아 있어도 신원이 갈리지 않는다.
  try {
    const existing = JSON.parse(readLocal(PORTAL_WEB_KEY) ?? '{}');
    existing.deviceId = id;
    localStorage.setItem(PORTAL_WEB_KEY, JSON.stringify(existing));
  } catch { /* 저장 실패는 이번 세션에만 영향 */ }
}
