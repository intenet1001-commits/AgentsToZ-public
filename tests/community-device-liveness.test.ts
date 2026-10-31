import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {AGENT_DIALOGUE_HEARTBEAT_MS,COMMUNITY_DEVICE_STALE_MS,communityDeviceLastSeen,communityDeviceStale,communityStaleDevices} from '../src/communityDeviceLiveness';

const now=Date.parse('2026-10-31T00:10:00.000Z');
const ago=(ms:number)=>new Date(now-ms).toISOString();

test('a device is stale only after missing at least two heartbeats', ()=>{
  expect(COMMUNITY_DEVICE_STALE_MS).toBe(3*AGENT_DIALOGUE_HEARTBEAT_MS);
  expect(communityDeviceStale(ago(AGENT_DIALOGUE_HEARTBEAT_MS+60_000),now)).toBe(false);
  expect(communityDeviceStale(ago(COMMUNITY_DEVICE_STALE_MS),now)).toBe(false);
  expect(communityDeviceStale(ago(COMMUNITY_DEVICE_STALE_MS+1),now)).toBe(true);
  // Nothing known is not called stale: an older host that never sent lastSeenAt keeps its ordinary tab.
  expect(communityDeviceStale(null,now)).toBe(false);
  expect(communityDeviceStale(undefined,now)).toBe(false);
  expect(communityDeviceStale('어제',now)).toBe(false);
});

test('the last-seen words are relative minutes, hours, then days', ()=>{
  expect(communityDeviceLastSeen(ago(42*60_000),now)).toBe('마지막 42분 전');
  expect(communityDeviceLastSeen(ago(5*3_600_000+59*60_000),now)).toBe('마지막 5시간 전');
  expect(communityDeviceLastSeen(ago(47*3_600_000),now)).toBe('마지막 47시간 전');
  expect(communityDeviceLastSeen(ago(3*86_400_000),now)).toBe('마지막 3일 전');
  // A clock a little ahead of the server never reads as 「-1분 전」.
  expect(communityDeviceLastSeen(new Date(now+30_000).toISOString(),now)).toBe('마지막 0분 전');
});

test('the live 2호 row from the readiness check reads as no answer, 1호 does not', ()=>{
  const at=Date.parse('2026-10-30T15:07:00.000Z');
  const devices=[
    {endpointId:'e-2',lastSeenAt:'2026-10-29T18:03:11Z'},
    {endpointId:'e-1',lastSeenAt:'2026-10-30T14:57:43Z'},
    {endpointId:'e-x',lastSeenAt:null},
  ];
  expect(communityStaleDevices(devices,at)).toEqual({'e-2':'마지막 21시간 전'});
});

test('the Workroom device tabs mark a stale device, keep it selectable and count it in the chat line', ()=>{
  const source=readFileSync(new URL('../src/WorkroomDeviceSwitch.tsx',import.meta.url),'utf8');
  expect(source).toContain("import {communityStaleDevices} from './communityDeviceLiveness';");
  expect(source).toContain('data-stale={stale[item.endpointId]?\'true\':undefined}');
  expect(source).toContain(' · 응답 없음 · {stale[item.endpointId]}');
  expect(source).toContain('data-testid="workroom-device-stale-note"');
  expect(source).toContain('응답 없음 ${staleCount}개');
  // Stale is a label, never a lock: the tab has no disabled state, and the list does not drop the device.
  const tab=source.slice(source.indexOf('{devices.map(item=><button'),source.indexOf('</button>)}'));
  expect(tab).toContain('onClick={()=>choose(item.endpointId)}');
  expect(tab).not.toContain('disabled');
  const server=readFileSync(new URL('../api-server.ts',import.meta.url),'utf8');
  expect(server).toContain('},AGENT_DIALOGUE_HEARTBEAT_MS);\n(agentDialogueMaintenanceTimer as any).unref?.();');
});

// 2026-10-31 click QA: 「대화 세션 → 기기」 showed a sleeping 2호 as 「확인 아직 확인하지 않음」 until its list timed out.
// Browser proof: tests/workroom-session-directory.e2e.mjs `stale-device-label`.
test('the session directory marks a stale device with the same rule, keeps it listed and counts it in the chat line', ()=>{
  const source=readFileSync(new URL('../src/WorkroomSessionDirectory.tsx',import.meta.url),'utf8');
  expect(source).toContain("import {communityStaleDevices} from './communityDeviceLiveness';");
  expect(source).toContain('const stale=useMemo(()=>communityStaleDevices(devices,now),[devices,now]);');
  expect(source).toContain('data-testid="session-directory-device-stale"');
  expect(source).toContain('data-testid="session-directory-device-stale-note"');
  expect(source).toContain('응답 없음 ${staleCount}개');
});
