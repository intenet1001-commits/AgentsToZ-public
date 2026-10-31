/**
 * 「휴대폰 알림」 for the Mac's weekly allowance (docs/claude/remote-control.md 「문턱 알림 푸시」). Browser-safe: what the dock
 * reads and says. The host side is src/weeklyUsagePushHost.ts; the push goes through AgentsToZ Screen, which holds the Mac
 * key the iPhone app pinned, and the screen-push relay (supabase/functions/screen-push, kind `weekly-usage`).
 *
 * Per Mac and OFF by default. Nothing here reaches the phone portal: the remote DTOs and the extended feature list are unchanged.
 */

/** What AgentsToZ Screen last wrote about itself (its status.json), reduced to what decides delivery. Display only. */
export type WeeklyUsagePushScreen = {state: 'missing'} | {state: 'off' | 'starting' | 'waiting' | 'on'; devices: number};
export interface WeeklyUsagePushStatus {enabled: boolean; screen: WeeklyUsagePushScreen}

const SCREEN_STATES = new Set(['off', 'starting', 'waiting', 'on']);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));

/** Strict reader for the host's answer. Anything else (an older Mac app that does not know the operation) is null: the dock
 * then shows no setting rather than a switch that does nothing. */
export function normalizeWeeklyUsagePushStatus(value: unknown): WeeklyUsagePushStatus | null {
  if (!plain(value) || !keys(value, ['enabled', 'screen']) || typeof value.enabled !== 'boolean' || !plain(value.screen)) return null;
  const screen = value.screen;
  if (screen.state === 'missing' && keys(screen, ['state'])) return {enabled: value.enabled, screen: {state: 'missing'}};
  if (typeof screen.state !== 'string' || !SCREEN_STATES.has(screen.state) || !keys(screen, ['state', 'devices'])
    || typeof screen.devices !== 'number' || !Number.isInteger(screen.devices) || screen.devices < 0 || screen.devices > 10_000) return null;
  return {enabled: value.enabled, screen: {state: screen.state as 'off' | 'starting' | 'waiting' | 'on', devices: screen.devices}};
}

export const WEEKLY_USAGE_PUSH_COPY = {
  label: '휴대폰 알림',
  short: '10%마다',
  explain: '주간 잔여가 10%씩 줄 때와 소진될 때, 이 Mac의 AgentsToZ Screen에 등록하고 「알림 받기」를 켠 iPhone으로 알립니다. '
    + '내용은 Mac 이름·AI 이름·경계뿐이고 계정이나 정확한 숫자는 보내지 않습니다.',
  shared: '같은 계정을 여러 Mac에서 쓰면 Mac 한 대에서만 켜세요. 두 대에서 켜면 같은 알림이 두 번 옵니다.',
  requirement: '알림 중계 주소를 넣어 만든 AgentsToZ Screen과 iPhone 앱이 있어야 보냅니다. 보내지 못한 알림은 다시 보내지 않습니다.',
  failed: '휴대폰 알림 설정을 바꾸지 못했습니다.',
} as const;

/** The one line under the switch while it is on: whether AgentsToZ Screen can send now. */
export function weeklyUsagePushNote(status: WeeklyUsagePushStatus): string {
  const screen = status.screen;
  if (screen.state === 'missing') return 'AgentsToZ Screen이 실행 중이 아니어서 지금은 보내지 못합니다.';
  if (screen.state === 'off' || screen.state === 'starting') return 'AgentsToZ Screen에서 화면 제어를 켜 둔 동안만 보냅니다. 2시간 넘게 못 보낸 알림은 버립니다.';
  if (screen.devices === 0) return 'AgentsToZ Screen에 등록한 기기가 없어 보낼 곳이 없습니다.';
  return `AgentsToZ Screen으로 보냅니다 · 등록 기기 ${screen.devices}대`;
}
