/**
 * portal.json 의 기기 신원(deviceId)을 **저장이 떨어뜨리지 못하게** 지키는 규칙 한 곳.
 *
 * 신원은 portal.json 한 파일에만 살았다. 그래서 신원 없이 portal.json 을 통째로 덮는
 * 쓰기 한 번(2026-09-27: 앱이 띄운 워크룸 안에서 돈 테스트 API 가 실제 앱 데이터 폴더에
 * 픽스처를 POST 했다)이면 신원이 사라졌고, 앱은 조용히 새 UUID 를 발급했다. 새 UUID 에는
 * 별칭이 없으므로 원격제어는 이 Mac 소유 프로젝트 139개 중 2개만 보여 주었고 OPS 도
 * 찾지 못했다 — 에러는 「새로고침해 주세요」뿐이었다.
 *
 * 규칙:
 * - 들어오는 값에 유효한 id 가 있으면 그것이 신원이다(온보딩 같은 **의도한 변경**).
 * - 없으면 디스크의 portal.json → 신원 기록(portal-device-identity.json) 순으로 되살린다.
 * - 이름은 **같은 id** 에서 온 것만 붙인다. 다른 신원의 이름을 붙이면 기기가 뒤섞인다.
 * - 아무 데도 없으면 비워 둔다 — 그때만 앱이 새로 발급한다(첫 설치).
 *
 * TS(api-server)와 Rust(load_portal/save_portal)가 같은 규칙을 쓴다.
 * 두 구현은 tests/fixtures/portal-device-identity-golden.json 한 표로 고정한다.
 */

export const PORTAL_DEVICE_IDENTITY_FILE_NAME = 'portal-device-identity.json';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PortalDeviceIdentityRecord = { deviceId: string; deviceName?: string };

function validId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function validName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : null;
}

export function readPortalDeviceIdentityRecord(value: unknown): PortalDeviceIdentityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const deviceId = validId(source.deviceId);
  if (!deviceId) return null;
  const deviceName = validName(source.deviceName);
  return deviceName ? { deviceId, deviceName } : { deviceId };
}

export function applyPortalDeviceIdentity<T extends Record<string, unknown>>(input: {
  incoming: T;
  current: Record<string, unknown> | null;
  record: unknown;
}): { portal: T; record: PortalDeviceIdentityRecord | null; restored: boolean } {
  const record = readPortalDeviceIdentityRecord(input.record);
  const current = input.current ?? {};
  const incomingId = validId(input.incoming.deviceId);
  const currentId = validId(current.deviceId);
  const deviceId = incomingId ?? currentId ?? record?.deviceId ?? null;
  if (!deviceId) return { portal: { ...input.incoming }, record, restored: false };

  const nameFor = (id: string | null, name: unknown) => (id === deviceId ? validName(name) : null);
  const deviceName = validName(input.incoming.deviceName)
    ?? nameFor(currentId, current.deviceName)
    ?? nameFor(record?.deviceId ?? null, record?.deviceName);

  const portal = { ...input.incoming, deviceId } as T & { deviceName?: string };
  if (deviceName) portal.deviceName = deviceName;
  return {
    portal,
    record: deviceName ? { deviceId, deviceName } : { deviceId },
    restored: !incomingId,
  };
}

export function samePortalDeviceIdentityRecord(
  left: PortalDeviceIdentityRecord | null,
  right: PortalDeviceIdentityRecord | null,
): boolean {
  return (left?.deviceId ?? null) === (right?.deviceId ?? null)
    && (left?.deviceName ?? null) === (right?.deviceName ?? null);
}
