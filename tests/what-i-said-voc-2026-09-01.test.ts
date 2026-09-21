import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const panelSource = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
const collectorSource = readFileSync(new URL('../src/whatISaidTranscriptCollector.ts', import.meta.url), 'utf8');

describe('VOC 2026-09-01 15:38 — 두 가져오기 버튼의 차이가 화면에 보인다', () => {
  test('라벨이 「얼마나 거슬러 올라가는가」로 갈린다', () => {
    // 예전 라벨은 「…지금 가져오기」와 「지금까지의 기록 가져오기」였다. 두 문장이
    // 같은 축을 말하지 않아 차이가 읽히지 않는다는 것이 접수된 요청이었다.
    expect(panelSource).toContain("captureNow: '새로 오간 대화만 가져오기'");
    expect(panelSource).toContain("backfill: '켜기 전 대화까지 처음부터 가져오기'");
    expect(panelSource).not.toContain("captureNow: '이 장기기억의 프롬프트 지금 가져오기'");
    expect(panelSource).not.toContain("backfill: '지금까지의 기록 가져오기'");
    expect(panelSource).toContain("captureNow: 'Import only what is new'");
    expect(panelSource).toContain("backfill: 'Import from the start, including before it was on'");
  });

  test('담기는 범위가 버튼 밑에 보인다 — title 툴팁에만 있으면 없는 것과 같다', () => {
    expect(panelSource).toContain('data-testid="what-i-said-capture-now-scope"');
    expect(panelSource).toContain('data-testid="what-i-said-backfill-scope"');
    expect(panelSource).toContain('{t.captureNowScope}');
    expect(panelSource).toContain('{t.backfillHelp}');
    // 설명이 툴팁으로 다시 숨지 않도록, backfill 버튼의 title 은 비활성 안내 전용이다.
    expect(panelSource).not.toContain('t.captureDisabledHint : t.backfillHelp');
    // 두 설명 모두 담기는 범위를 첫머리에 적는다.
    expect(panelSource).toContain("captureNowScope: '담기는 범위 · ");
    expect(panelSource).toContain("backfillHelp: '담기는 범위 · ");
  });

  test('과거로 거슬러 담는 것은 여전히 확인을 받는다', () => {
    expect(panelSource).toContain('if (backfill && !window.confirm(t.backfillConfirm(selectedMemoryIds.length))) return;');
    expect(panelSource).toContain('data-testid="what-i-said-backfill"');
    // 두 버튼은 같은 함수의 인자 하나로만 갈린다. 경로가 갈라지면 설명이 곧 거짓이 된다.
    expect(panelSource).toContain('onClick={() => void captureNow()}');
    expect(panelSource).toContain('onClick={() => void captureNow(true)}');
  });

  test('backfill 은 실제로 처음부터 다시 읽는다 — 설명이 구현과 어긋나면 안 된다', () => {
    expect(collectorSource).toContain('let expected = input.backfill === true ? null : readWhatISaidTranscriptCursor({');
    expect(collectorSource).toContain('? new Date(0).toISOString()');
    expect(collectorSource).toContain('...(input.backfill === true ? { allowBeforeEnabled: true } : {}),');
  });
});

describe('VOC 2026-09-01 08:10 — 단말 정보가 함께 기록되는지 화면에서 확인된다', () => {
  test('전체 저장 정책 카드가 이 기기를 이름으로 말한다', () => {
    expect(panelSource).toContain('data-testid="what-i-said-device-scope"');
    expect(panelSource).toContain('{t.deviceScopeTitle} · {remoteStatus.deviceName ?? remoteStatus.deviceId ?? t.deviceUnknown}');
    expect(panelSource).toContain("deviceScopeTitle: '이 기기'");
    expect(panelSource).toContain('memoryId로 Supabase에 합쳐집니다');
    expect(panelSource).toContain("deviceScopeTitle: 'This device'");
  });

  test('상태를 못 읽었을 때와 이름이 없을 때를 같은 문구로 칠하지 않는다', () => {
    // remoteStatus === null 은 「아직 모름」이다. 그때 「이름 없음」을 그리면 멀쩡한
    // 기기가 설정 안 된 것으로 읽힌다.
    expect(panelSource).toContain('{remoteStatus && (\n                  <div className="rounded-xl border border-zinc-800 bg-[rgb(var(--surface-shade-rgb))]/15 p-3" data-testid="what-i-said-device-scope">');
    expect(panelSource).toContain('{remoteStatus.deviceName || remoteStatus.deviceId ? t.deviceScopeHelp : t.deviceMissingHelp}');
    expect(panelSource).toContain("deviceUnknown: '기기 이름이 설정되지 않았습니다'");
  });

  test('이름이 비어도 UUID 는 남으므로 둘을 따로 든다', () => {
    expect(panelSource).toContain("deviceId: typeof payload?.deviceId === 'string' ? payload.deviceId : null,");
    expect(panelSource).toContain('  deviceId: string | null;\n  deviceName: string | null;');
  });

  test('수집 경로가 실제로 기기 신원을 함께 저장한다', () => {
    const capture = apiSource.slice(
      apiSource.indexOf('const result = collectWhatISaidTranscripts({'),
      apiSource.indexOf('lastWhatISaidScanByMemoryId.set('),
    );
    expect(capture).toContain('...whatISaidDeviceIdentity(),');
    // 저장 시점에 값이 없으면 지어내지 않고 null 로 떨어뜨린다.
    expect(apiSource).toContain('function whatISaidDeviceIdentity()');
  });
});
