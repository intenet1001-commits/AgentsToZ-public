import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const portal = readFileSync(new URL('../src/portal-main.tsx', import.meta.url), 'utf8');
const manager = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');
const identity = readFileSync(new URL('../src/portalDeviceIdentity.ts', import.meta.url), 'utf8');
const vitePortal = readFileSync(new URL('../vite.portal.config.ts', import.meta.url), 'utf8');

describe('모바일 헤더 — 탭이 우측 버튼 위로 겹치지 않는다', () => {
  // 첫 줄에 두면 좌측 박스는 min-w-0 로 줄지만 탭의 whitespace-nowrap 때문에 내용은
  // min-content 아래로 줄지 않아 우측 아이콘 위에 그려진다. 실측상 1023px 까지 겹쳤다.
  test('탭은 lg 미만에서 첫 줄에 없다', () => {
    expect(portal).toContain('<div className="hidden lg:flex items-center gap-1">{tabsEl}</div>');
  });

  test('둘째 줄 경계는 sm 이 아니라 lg 다 — 640·768·834px 에서도 겹쳤다', () => {
    expect(portal).toContain('<div className="lg:hidden pt-2 flex flex-col gap-2">');
    expect(portal).toContain('overflow-x-auto scrollbar-none">{tabsEl}</div>');
  });

  test('탭 정의는 한 곳뿐이다 — 두 줄이 서로 어긋나지 않게', () => {
    expect(portal).toContain('const tabsEl = ');
    expect((portal.match(/\{tabsEl\}/g) ?? []).length).toBe(2);
  });

  test('우측 컨트롤은 찌그러지지 않고 라벨도 접히지 않는다', () => {
    expect(portal).toContain('<div className="flex items-center gap-1.5 shrink-0">');
    expect(portal).toContain("const btnCls = 'flex items-center gap-1.5 shrink-0 whitespace-nowrap");
  });
});

describe('프로젝트 행 — 가로 스크롤을 만들지 않는다', () => {
  // shrink-0 이 붙으면 랩핑 flex 의 max-content 가 "한 줄 전체 폭"으로 굳어
  // 안쪽 flex-wrap 이 발동하지 못한다.
  test('행 액션 그룹에 shrink-0 이 없다', () => {
    expect(portal).not.toContain('flex items-center gap-1.5 shrink-0 flex-wrap');
    expect(portal).toContain('<div className="flex items-center gap-3 sm:gap-1.5 flex-wrap">');
  });
});

describe('기기 신원과 조회 선택은 다른 값이다', () => {
  // 예전에는 둘이 같은 키를 공유해, 남의 기기를 한 번 보면 신원이 그 기기가 되고
  // 그 상태의 Push 가 남의 기기 행을 갱신·개명했다.
  test('신원은 전용 모듈이 소유한다', () => {
    expect(identity).toContain("export const OWN_DEVICE_ID_KEY = 'portal-device-id';");
    expect(identity).toContain('export function getOwnDeviceId()');
    expect(identity).toContain('export function setOwnDeviceId(');
  });

  test('조회 선택은 신원을 건드리지 않는다', () => {
    const sel = portal.slice(portal.indexOf('function selectDevice('), portal.indexOf('async function openPortsHistory'));
    expect(sel).toContain('SELECTED_DEVICE_KEY');
    expect(sel).not.toContain('existing.deviceId');
    expect(sel).not.toContain('PORTAL_WEB_KEY');
  });

  test('URL로 전달된 조회 대상도 신원 저장소를 덮어쓰지 않는다', () => {
    const apply = portal.slice(portal.indexOf('function applyUrlParams()'), portal.indexOf("type ViewMode"));
    expect(apply).toContain('localStorage.setItem(SELECTED_DEVICE_KEY, device)');
    expect(apply).toContain('localStorage.setItem(SELECTED_DEVICE_NAME_KEY, nameParam)');
    expect(apply).not.toContain('withName.deviceId');
    expect(apply).not.toContain('withName.deviceName');
  });

  test('Supabase에서 보정한 조회 이름도 별도 선택 키에만 저장한다', () => {
    const load = portal.slice(portal.indexOf('async function loadDevices()'), portal.indexOf('// Auto-open picker'));
    expect(load).toContain('localStorage.setItem(SELECTED_DEVICE_NAME_KEY, matched.name)');
    expect(load).not.toContain('existing.deviceName');
    expect(load).not.toContain('PORTAL_WEB_KEY');
  });

  test('부팅 시 조회 선택을 신원에 덮어쓰던 코드가 없다', () => {
    expect(portal).not.toContain('Startup sync: heal pre-existing mismatch');
    expect(portal).not.toContain('existing.deviceId = selectedId');
  });

  test('오염 가능성이 있는 값은 신원으로 승격하지 않는다', () => {
    // 조회 이력이 있는 브라우저의 portalData_v1.deviceId 는 이미 남의 기기일 수 있다.
    expect(identity).toContain('if (readLocal(SELECTED_DEVICE_KEY)) return null;');
  });

  test('등록만 신원을 정한다', () => {
    expect(portal).toContain('setOwnDeviceId(newId);');
  });

  test('PortalManager 는 runtime별 authoritative 신원만 읽는다', () => {
    expect(manager).toContain("import { getOwnDeviceId, setOwnDeviceId } from './portalDeviceIdentity';");
    expect(manager).toContain("runtime: isTauri() ? 'tauri' : 'web'");
    expect(manager).toContain('getBrowserDeviceId: getOwnDeviceId');
    expect(manager).toContain('if (!isTauri()) setOwnDeviceId(newId);');
  });
});

describe('조회 실패를 기기 없음으로 보고하지 않는다', () => {
  test('devices 조회 오류를 사실대로 알린다', () => {
    expect(portal).toContain('if (devError) {');
    expect(portal).toContain('기기 목록을 불러오지 못했습니다');
  });

  test('세션 복원을 기다린 뒤 조회한다', () => {
    const load = portal.slice(portal.indexOf('async function loadDevices()'));
    expect(load.indexOf('auth.getSession()')).toBeLessThan(load.indexOf("from('portmgr_devices')"));
  });
});

describe('포털 번들', () => {
  // CJS 진입점은 트리셰이킹이 안 되어 쓰지 않는 아이콘 전량이 실린다(실측 959KB → 390KB).
  test('lucide-react 를 CJS 로 alias 하지 않는다', () => {
    expect(vitePortal).not.toContain('lucide-react/dist/cjs');
  });
});

describe('모바일 조작성', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

  test('iOS 자동 확대를 전역 규칙으로 막는다 — 입력마다 고치면 새 입력에서 재발한다', () => {
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain("input:not([type='checkbox']):not([type='radio'])");
    expect(css).toContain('font-size: 16px;');
  });

  test('탭 타깃을 모바일에서만 키우고 데스크톱 밀도는 유지한다', () => {
    expect(portal).toContain('px-2.5 py-2.5 sm:py-1.5');
    expect(portal).toContain('px-2.5 py-2 sm:px-2 sm:py-1');
  });

  test('수정/삭제 간격을 모바일에서 벌린다 — 버튼만 키워선 오탭이 남는다', () => {
    expect(portal).toContain('gap-3 sm:gap-1.5 flex-wrap');
  });
});

describe('레이아웃 전환이 본문을 리마운트하지 않는다', () => {
  test('본문은 분기 바깥에 한 번만 있다', () => {
    // 전체/컴팩트가 같은 자식 트리를 각각 쓰면 전환 때 서브트리가 통째로 다시 마운트된다.
    expect((portal.match(/<PortsView /g) ?? []).length).toBe(1);
    expect((portal.match(/<PortalMemoryDirectory /g) ?? []).length).toBe(1);
    expect((portal.match(/<PortalManager /g) ?? []).length).toBe(1);
    expect(portal).toContain('{isFullLayout && (');
  });
});

describe('장기기억 조회를 두 소비자가 공유한다', () => {
  const dir = readFileSync(new URL('../src/projectMemoryDirectory.ts', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/PortalMemoryDirectory.tsx', import.meta.url), 'utf8');

  test('in-flight 프라미스를 재사용한다', () => {
    expect(dir).toContain('export async function loadMemoryDirectory(');
    expect(dir).toContain('if (slot.inFlight) return slot.inFlight;');
  });

  test('실패는 캐싱하지 않는다 — 다음 시도가 즉시 다시 나가야 한다', () => {
    expect(dir).toContain('cache.delete(key);');
  });

  test('두 소비자가 같은 함수와 같은 컬럼 목록을 쓴다', () => {
    for (const source of [portal, view]) {
      expect(source).toContain('loadMemoryDirectory(');
      expect(source).toContain('MEMORY_LIST_COLUMNS');
    }
  });

  test('TOKEN_REFRESHED 로는 다시 읽지 않는다', () => {
    for (const source of [portal, view]) {
      expect(source).not.toContain("=== 'TOKEN_REFRESHED'");
    }
  });
});

describe('Push 히스토리가 거부를 "기록 없음"으로 보고하지 않는다', () => {
  const history = readFileSync(new URL('../src/pushHistory.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const manager2 = readFileSync(new URL('../src/PortalManager.tsx', import.meta.url), 'utf8');

  test('오류를 빈 배열로 뭉개지 않는다', () => {
    expect((history.match(/if \(error\) throw error;/g) ?? []).length).toBe(2);
    expect(history).toContain('.maybeSingle()');
    // 실제 호출만 본다 — 주석 안의 언급은 제외.
    expect(history).not.toContain('    .single()');
  });

  test('던지도록 바뀐 만큼 모든 호출부가 받는다 — 안 받으면 스피너가 영원히 돈다', () => {
    for (const source of [portal, app, manager2]) {
      expect(source).toContain('히스토리를 읽지 못했습니다');
    }
  });
});
