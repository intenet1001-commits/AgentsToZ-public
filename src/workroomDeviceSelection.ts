/**
 * 「아젠투지 호출 → 워크룸 열기」에서 고른 기기를 워크룸 화면에 전달하는 길.
 *
 * 도크는 워크룸 패널의 바깥(앱 루트)에 있어 그 선택 상태를 직접 들고 있지 않다. 그래서 창별
 * 저장소에 적고 이벤트로 알린다 — 음성 도크가 워크룸으로 이동할 때 쓰는 기존 방식
 * (`agentstoz:voice-target-change`)과 같은 모양이다.
 *
 * `ops:true`면 그 기기의 **OPS 프로젝트까지** 골라 준다(목록이 도착한 뒤 한 번).
 */
export const WORKROOM_DEVICE_STORAGE_KEY = 'agentstoz-workroom-device';
export const WORKROOM_DEVICE_EVENT = 'agentstoz:workroom-device';
/** An OPS request made before the Workroom screen existed (it loads lazily): read once when it mounts. */
export const WORKROOM_DEVICE_PENDING_KEY = 'agentstoz-workroom-device-pending';

export interface WorkroomDeviceRequest {
  /** 커뮤니티 기기 식별자: Mac은 endpointId, 휴대폰은 불투명 기기 참조. 빈 값은 「이 기기」. */
  device: string;
  /** 그 기기의 OPS 프로젝트를 자동으로 고를지. */
  ops: boolean;
  /** 같은 기기를 다시 눌러도 전달되도록 하는 일련번호. */
  nonce: number;
}

let nonce = 0;
export function requestWorkroomDevice(device: string, options: {ops?: boolean} = {}): WorkroomDeviceRequest {
  const request: WorkroomDeviceRequest = {device, ops: options.ops === true, nonce: ++nonce};
  try {
    if (device) sessionStorage.setItem(WORKROOM_DEVICE_STORAGE_KEY, device);
    else sessionStorage.removeItem(WORKROOM_DEVICE_STORAGE_KEY);
    sessionStorage.setItem(WORKROOM_DEVICE_PENDING_KEY, JSON.stringify(request));
  } catch { /* per-window convenience only */ }
  try { window.dispatchEvent(new CustomEvent(WORKROOM_DEVICE_EVENT, {detail: request})); } catch { /* no window */ }
  return request;
}

/** 이벤트에서 꺼낸 값이 쓸 수 있는 요청인지. 모양이 아닌 것은 무시한다(창 밖에서 온 이벤트). */
export function workroomDeviceRequest(detail: unknown): WorkroomDeviceRequest | null {
  if (!detail || typeof detail !== 'object') return null;
  const value = detail as Record<string, unknown>;
  if (typeof value.device !== 'string' || value.device.length > 200) return null;
  if (typeof value.nonce !== 'number' || !Number.isFinite(value.nonce)) return null;
  return {device: value.device, ops: value.ops === true, nonce: value.nonce};
}

/** The request waiting for a Workroom screen that was not mounted when it was made — consumed on read. */
export function takePendingWorkroomDeviceRequest(): WorkroomDeviceRequest | null {
  try {
    const raw = sessionStorage.getItem(WORKROOM_DEVICE_PENDING_KEY);
    sessionStorage.removeItem(WORKROOM_DEVICE_PENDING_KEY);
    return raw ? workroomDeviceRequest(JSON.parse(raw)) : null;
  } catch { return null; }
}
