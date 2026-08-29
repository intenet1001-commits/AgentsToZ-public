export type PortalDeviceSelectionMode = 'recent' | 'fixed' | 'none';

export interface SelectablePortalDevice {
  id: string;
  sourceIds?: readonly string[];
}

export function normalizePortalDeviceSelectionMode(value: unknown): PortalDeviceSelectionMode {
  return value === 'fixed' || value === 'none' ? value : 'recent';
}

export function storedPortalDeviceSelection(
  mode: PortalDeviceSelectionMode,
  lastViewedDeviceId: string,
  fixedDeviceId: string,
): string {
  if (mode === 'none') return '';
  return mode === 'fixed' ? fixedDeviceId : lastViewedDeviceId;
}

function resolveAvailableDeviceId(devices: readonly SelectablePortalDevice[], candidate: string): string {
  if (!candidate) return '';
  return devices.find(device => device.id === candidate || device.sourceIds?.includes(candidate))?.id ?? '';
}

/**
 * 배포 포털의 시작 단말 정책. 단말이 하나뿐이어도 임의로 선택하지 않는다.
 * `none`은 마지막 조회 기록을 지우지 않고 이번 시작만 빈 상태로 둔다.
 */
export function resolvePortalDeviceSelection(input: {
  mode: PortalDeviceSelectionMode;
  lastViewedDeviceId: string;
  fixedDeviceId: string;
  devices: readonly SelectablePortalDevice[];
}): { selectedDeviceId: string; shouldOpenPicker: boolean } {
  if (input.mode === 'none') return { selectedDeviceId: '', shouldOpenPicker: false };
  const candidate = input.mode === 'fixed' ? input.fixedDeviceId : input.lastViewedDeviceId;
  const selectedDeviceId = resolveAvailableDeviceId(input.devices, candidate);
  return {
    selectedDeviceId,
    shouldOpenPicker: !selectedDeviceId && input.devices.length > 0,
  };
}
