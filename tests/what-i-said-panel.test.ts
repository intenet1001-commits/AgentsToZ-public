import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  WHAT_I_SAID_SOURCE_URL,
  WhatISaidPanel,
  normalizeWhatISaidGlobalStatus,
  normalizeWhatISaidListPage,
  normalizeWhatISaidGlobalApplySummary,
  normalizeWhatISaidSourceStatus,
  normalizeWhatISaidStatus,
  oneTimeWhatISaidAccessToken,
  WHAT_I_SAID_DEFAULT_PROJECT_FILTER,
  WHAT_I_SAID_STALE_CAPTURE_MS,
  reconcileWhatISaidProjectFilter,
  whatISaidCaptureFreshness,
  whatISaidApi,
  whatISaidConnectionBundle,
  whatISaidProjectPath,
  whatISaidRemoteUiState,
} from '../src/WhatISaidPanel';

const panelSource = readFileSync(new URL('../src/WhatISaidPanel.tsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('What I said panel data contract', () => {
  test('worktree path scopes capture before the parent project path', () => {
    expect(whatISaidProjectPath({ id: 'one', name: 'One', folderPath: '/project', worktreePath: '/worktree' })).toBe('/worktree');
    expect(whatISaidProjectPath({ id: 'two', name: 'Two', folderPath: ' /project ' })).toBe('/project');
    expect(whatISaidProjectPath({ id: 'three', name: 'Three' })).toBeNull();
  });

  test('falls back to 모든 장기기억 instead of silently adopting an arbitrary one', () => {
    // VOC 2026-09-01: opening on whichever project sorted first showed an empty
    // library, and the space under it was reported as a layout defect.
    expect(WHAT_I_SAID_DEFAULT_PROJECT_FILTER).toBe('all');
    expect(reconcileWhatISaidProjectFilter('', [])).toBe('all');
    expect(reconcileWhatISaidProjectFilter('', [{ id: 'first' }, { id: 'second' }])).toBe('all');
    expect(reconcileWhatISaidProjectFilter('second', [{ id: 'first' }, { id: 'second' }])).toBe('second');
    expect(reconcileWhatISaidProjectFilter('missing', [{ id: 'first' }])).toBe('all');
    expect(reconcileWhatISaidProjectFilter('all', [{ id: 'first' }])).toBe('all');
  });

  test('remote UI claims upload only after credentials, exclusions, and the remote read are healthy', () => {
    const ready = {
      enabled: true,
      projects: [],
      deviceId: 'device-1',
      deviceName: 'Mac',
      credentialsReady: true,
      exclusionsReady: true,
      storedRows: 0,
      remoteError: null,
    };
    expect(whatISaidRemoteUiState(null)).toEqual({
      uploadOperational: false,
      remoteCopiesRemain: false,
      scopeUnverified: true,
      toggleBlocked: true,
    });
    expect(whatISaidRemoteUiState(ready)).toEqual({
      uploadOperational: true,
      remoteCopiesRemain: false,
      scopeUnverified: false,
      toggleBlocked: false,
    });
    // Fail-closed exclusion reads stop the uploader, so enabled alone must not
    // render "uploads to Supabase". It remains possible to switch this policy off.
    expect(whatISaidRemoteUiState({ ...ready, exclusionsReady: false })).toEqual({
      uploadOperational: false,
      remoteCopiesRemain: false,
      scopeUnverified: true,
      toggleBlocked: false,
    });
    expect(whatISaidRemoteUiState({ ...ready, remoteError: 'timeout' }).scopeUnverified).toBe(true);
    expect(whatISaidRemoteUiState({
      ...ready,
      enabled: false,
      credentialsReady: false,
      exclusionsReady: false,
    })).toEqual({
      uploadOperational: false,
      remoteCopiesRemain: false,
      scopeUnverified: true,
      toggleBlocked: true,
    });
    expect(whatISaidRemoteUiState({ ...ready, enabled: false })).toEqual({
      uploadOperational: false,
      remoteCopiesRemain: false,
      scopeUnverified: false,
      toggleBlocked: false,
    });
    expect(whatISaidRemoteUiState({ ...ready, enabled: false, storedRows: 3 })).toEqual({
      uploadOperational: false,
      remoteCopiesRemain: true,
      scopeUnverified: false,
      toggleBlocked: false,
    });
  });

  test('exports a generic HMAC v1 connection bundle without project paths', () => {
    const accessKey = 'a'.repeat(64);
    expect(JSON.parse(whatISaidConnectionBundle(accessKey))).toEqual({
      schemaVersion: 1,
      protocol: 'AgentsToZ-HMAC v1',
      endpoint_url: WHAT_I_SAID_SOURCE_URL,
      access_key: accessKey,
    });
  });

  test('status accepts direct and wrapped responses while missing consent fails closed', () => {
    expect(normalizeWhatISaidStatus({
      enabled: true,
      retentionDays: 90,
      analysisAllowed: true,
      count: 8,
      lastCaptureAt: '2026-08-30T01:02:03Z',
      scan: { complete: false, unreadable: 2, withheld: 1 },
    })).toEqual({
      enabled: true,
      cryptoState: 'ready',
      retentionDays: 90,
      analysisAllowed: true,
      count: 8,
      lastCaptureAt: '2026-08-30T01:02:03Z',
      scan: { complete: false, unreadable: 2, withheld: 1 },
    });
    expect(normalizeWhatISaidStatus({ status: { enabled: true, retentionDays: 7 } }))
      .toMatchObject({ enabled: true, retentionDays: 30, analysisAllowed: false });
    expect(normalizeWhatISaidStatus({ status: { enabled: true, retentionDays: 'forever' } }))
      .toMatchObject({ enabled: true, retentionDays: 'forever', analysisAllowed: false });
    expect(normalizeWhatISaidStatus({ enabled: 'yes', retentionDays: -1, analysisAllowed: 'yes' }))
      .toMatchObject({ enabled: false, retentionDays: 30, analysisAllowed: false });
  });

  test('global apply summary reports only bounded non-negative counts', () => {
    expect(normalizeWhatISaidGlobalApplySummary({
      applied: { registeredProjects: 4, appliedProjects: 3, failedProjects: 1 },
    })).toEqual({ registeredProjects: 4, appliedProjects: 3, failedProjects: 1 });
    expect(normalizeWhatISaidGlobalApplySummary({
      applied: { registeredProjects: -1, appliedProjects: 'bad', failedProjects: 0 },
    })).toEqual({ registeredProjects: 0, appliedProjects: 0, failedProjects: 0 });
  });

  test('global status is independent from the selected project and fails closed', () => {
    expect(normalizeWhatISaidGlobalStatus({ status: {
      configured: true,
      enabled: true,
      retentionDays: 'forever',
      analysisAllowed: true,
      updatedAt: '2026-08-31T10:00:00Z',
    } })).toEqual({
      configured: true,
      enabled: true,
      retentionDays: 'forever',
      analysisAllowed: true,
      updatedAt: '2026-08-31T10:00:00Z',
    });
    expect(normalizeWhatISaidGlobalStatus({ status: {
      configured: 'yes', enabled: 'yes', retentionDays: 7, registeredProjects: -1,
    } })).toEqual({
      configured: false,
      enabled: false,
      retentionDays: 90,
      analysisAllowed: false,
      updatedAt: null,
    });
  });

  test('list requires complete user-prompt records and preserves the sequence cursor', () => {
    const page = normalizeWhatISaidListPage({
      items: [
        { id: 'a', seq: '12', recordedAt: '2026-08-30T01:00:00Z', agent: 'claude', projectId: 'p1', projectName: 'Project', text: 'hello', deviceName: 'cs Mac', deviceId: 'd-1', promptOrigin: 'agentstoz' },
        // 기록 이전에 저장된 행 — 기기를 모른다고 목록 전체를 거절하면 안 된다.
        { id: 'b', seq: '11', recordedAt: '2026-08-30T00:00:00Z', agent: 'codex', projectId: 'p1', projectName: 'Project', text: 'older' },
      ],
      nextBeforeSeq: '9',
      hasMore: true,
      scan: { unreadable: 1, withheld: 2 },
    });
    expect(page.items).toEqual([{
      id: 'a',
      seq: '12',
      recordedAt: '2026-08-30T01:00:00Z',
      agent: 'claude',
      projectId: 'p1',
      projectName: 'Project',
      text: 'hello',
      deviceId: 'd-1',
      deviceName: 'cs Mac',
      promptOrigin: 'agentstoz',
    }, {
      id: 'b',
      seq: '11',
      recordedAt: '2026-08-30T00:00:00Z',
      agent: 'codex',
      projectId: 'p1',
      projectName: 'Project',
      text: 'older',
      deviceId: null,
      deviceName: null,
      promptOrigin: 'unknown',
    }]);
    expect(page.nextBeforeSeq).toBe('9');
    expect(page.hasMore).toBe(true);
    expect(page.scan).toEqual({ complete: true, unreadable: 1, withheld: 2 });
    // 필드가 없는 응답(옛 sidecar)은 「모름」이다. 「수집한 적 없음」으로 승격하면
    // 잘 돌고 있는 기기가 한 번도 수집하지 않은 것처럼 보인다.
    expect(page.capture).toBeNull();
    expect(normalizeWhatISaidListPage({ capture: { lastCaptureAt: null } }).capture)
      .toEqual({ lastCaptureAt: null });
    expect(normalizeWhatISaidListPage({ capture: { lastCaptureAt: '2026-08-31T18:10:13.511Z' } }).capture)
      .toEqual({ lastCaptureAt: '2026-08-31T18:10:13.511Z' });
    expect(normalizeWhatISaidListPage({ capture: 'yesterday' }).capture).toBeNull();
    expect(() => normalizeWhatISaidListPage({
      items: [{ id: 'bad-agent', seq: '11', recordedAt: '2026-08-30T00:00:00Z', agent: 'assistant', text: 'must not render' }],
    })).toThrow('목록 응답이 올바르지 않습니다');
    expect(() => normalizeWhatISaidListPage({
      items: [{ id: 'missing-text', seq: '10', recordedAt: '2026-08-29T23:00:00Z', agent: 'codex' }],
    })).toThrow('목록 응답이 올바르지 않습니다');
    expect(normalizeWhatISaidListPage({ nextBeforeSeq: 'wisg1_Y3Vyc29y.c2lnbmF0dXJl', hasMore: true }))
      .toMatchObject({ nextBeforeSeq: 'wisg1_Y3Vyc29y.c2lnbmF0dXJl', hasMore: true });
    expect(normalizeWhatISaidListPage({ nextBeforeSeq: 9, hasMore: true }).nextBeforeSeq).toBeNull();
  });

  test('separates unknown, never, fresh and stale capture instead of rendering them alike', () => {
    // 수집은 세션에 매여 있다 — 장기기억 저장·세션 기억하기·「지금 수집」에서만 돈다.
    // 그래서 며칠 묵은 라이브러리가 정상 라이브러리와 똑같이 그려지면, 사용자는
    // 정책대로 동작하는 기능을 고장으로 읽는다 (실측 2026-09-05: 마지막 수집
    // 2026-08-31, 화면에는 다른 기기가 올린 09-02 프롬프트).
    const now = Date.parse('2026-09-05T12:00:00Z');
    expect(whatISaidCaptureFreshness(null, now).state).toBe('unknown');
    expect(whatISaidCaptureFreshness({ lastCaptureAt: null }, now).state).toBe('never');
    // 읽을 수 없는 값은 「수집한 적 없음」이 아니라 「모름」이다.
    expect(whatISaidCaptureFreshness({ lastCaptureAt: 'not-a-date' }, now).state).toBe('unknown');

    expect(whatISaidCaptureFreshness({ lastCaptureAt: '2026-09-05T09:30:00Z' }, now))
      .toEqual({ state: 'fresh', days: 0, hours: 2 });
    expect(whatISaidCaptureFreshness({ lastCaptureAt: '2026-09-04T13:00:00Z' }, now).state).toBe('fresh');
    expect(whatISaidCaptureFreshness({ lastCaptureAt: '2026-08-31T18:10:13.511Z' }, now))
      .toMatchObject({ state: 'stale', days: 4 });

    // 하루를 임계값으로 잡으면 그 프로젝트를 하루 쉰 사람에게 매번 경고가 뜨고,
    // 그러면 경고를 읽지 않게 된다. 경계는 정확히 이틀이다.
    expect(WHAT_I_SAID_STALE_CAPTURE_MS).toBe(2 * 24 * 60 * 60 * 1000);
    expect(whatISaidCaptureFreshness({ lastCaptureAt: new Date(now - WHAT_I_SAID_STALE_CAPTURE_MS + 1).toISOString() }, now).state)
      .toBe('fresh');
    expect(whatISaidCaptureFreshness({ lastCaptureAt: new Date(now - WHAT_I_SAID_STALE_CAPTURE_MS).toISOString() }, now).state)
      .toBe('stale');

    // 시계가 뒤로 간 기기가 미래 수집을 주장하면 안 된다.
    expect(whatISaidCaptureFreshness({ lastCaptureAt: '2026-09-06T00:00:00Z' }, now))
      .toEqual({ state: 'fresh', days: 0, hours: 0 });
  });

  test('the displayed source address is fixed and access keys are read only from one-time action payloads', () => {
    expect(normalizeWhatISaidSourceStatus({ enabled: true, sourceUrl: 'https://attacker.example/feed' })).toEqual({
      enabled: true,
      sourceUrl: WHAT_I_SAID_SOURCE_URL,
    });
    const token = 'a'.repeat(64);
    expect(oneTimeWhatISaidAccessToken({ status: { enabled: true }, accessToken: token })).toBe(token);
    expect(oneTimeWhatISaidAccessToken({ token })).toBeNull();
    expect(oneTimeWhatISaidAccessToken({ accessToken: 'not-a-fixed-token' })).toBeNull();
    expect(oneTimeWhatISaidAccessToken({ enabled: true })).toBeNull();
  });
});

describe('What I said local API client', () => {
  test('explains an older protected sidecar as a restart recovery instead of a corrupt store', () => {
    expect(panelSource).toContain('WHAT_I_SAID_SCHEMA_UNSUPPORTED');
    expect(panelSource).toContain('이전 앱 또는 개발용 API를 종료한 뒤 현재 앱을 다시 열어주세요');
    expect(panelSource).toContain('does not match this app’s secure connection');
  });

  test('uses the exact route, method, and body contract without putting source secrets in URLs', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await whatISaidApi.globalStatus();
    await whatISaidApi.status('/project');
    await whatISaidApi.statusMemory('memory-b');
    await whatISaidApi.configure({ folderPath: '/project', enabled: true, retentionDays: 30, analysisAllowed: false });
    await whatISaidApi.configureAll({ enabled: true, retentionDays: 90, analysisAllowed: false });
    await whatISaidApi.capture('/project');
    await whatISaidApi.list({ folderPath: '/project', query: 'hello', agent: 'codex', beforeSeq: '42', limit: 50 });
    await whatISaidApi.capture('/project', true);
    await whatISaidApi.sync(['memory-a', 'memory-c']);
    await whatISaidApi.sync(['memory-a', 'memory-c'], true);
    await whatISaidApi.deleteOne('/project', 'prompt-1');
    await whatISaidApi.deleteProject('/project');
    await whatISaidApi.sourceStatus('/project');
    await whatISaidApi.enableSource('/project');
    await whatISaidApi.rotateSource('/project');
    await whatISaidApi.disableSource('/project');

    expect(calls).toEqual([
      { url: '/api/what-i-said/global-status', method: 'POST', body: {} },
      { url: '/api/what-i-said/status', method: 'POST', body: { folderPath: '/project' } },
      { url: '/api/what-i-said/status', method: 'POST', body: { memoryId: 'memory-b' } },
      { url: '/api/what-i-said/configure', method: 'POST', body: { folderPath: '/project', enabled: true, retentionDays: 30, analysisAllowed: false } },
      { url: '/api/what-i-said/configure-all', method: 'POST', body: { enabled: true, retentionDays: 90, analysisAllowed: false } },
      { url: '/api/what-i-said/capture', method: 'POST', body: { folderPath: '/project', backfill: false } },
      { url: '/api/what-i-said/list', method: 'POST', body: { folderPath: '/project', query: 'hello', agent: 'codex', beforeSeq: '42', limit: 50 } },
      { url: '/api/what-i-said/capture', method: 'POST', body: { folderPath: '/project', backfill: true } },
      { url: '/api/what-i-said/sync', method: 'POST', body: { memoryIds: ['memory-a', 'memory-c'], backfill: false } },
      { url: '/api/what-i-said/sync', method: 'POST', body: { memoryIds: ['memory-a', 'memory-c'], backfill: true } },
      { url: '/api/what-i-said/delete', method: 'POST', body: { folderPath: '/project', id: 'prompt-1' } },
      { url: '/api/what-i-said/delete', method: 'POST', body: { folderPath: '/project', all: true } },
      { url: '/api/what-i-said/source/status', method: 'POST', body: { folderPath: '/project' } },
      { url: '/api/what-i-said/source/enable', method: 'POST', body: { folderPath: '/project' } },
      { url: '/api/what-i-said/source/rotate', method: 'POST', body: { folderPath: '/project' } },
      { url: '/api/what-i-said/source', method: 'DELETE', body: { folderPath: '/project' } },
    ]);
    expect(calls.every(call => !call.url.includes('secret') && !call.url.includes('token='))).toBe(true);
    expect(panelSource).toContain("invoke<unknown>('what_i_said_management_request'");
    expect(panelSource).not.toContain('what_i_said_management_capability');
    expect(panelSource).not.toContain('X-AgentsToZ-What-I-Said-Capability');
  });
});

describe('What I said accessible UI contract', () => {
  test('honors visible and renders the standalone top-level panel in either language', () => {
    const projects = [{ id: 'p1', name: 'Project one', folderPath: '/project' }];
    expect(renderToStaticMarkup(createElement(WhatISaidPanel, { projects, language: 'ko', visible: false }))).toBe('');
    const html = renderToStaticMarkup(createElement(WhatISaidPanel, { projects, language: 'en', visible: true }));
    expect(html).toContain('data-testid="what-i-said-panel"');
    expect(html).toContain('What I said');
    expect(html).toContain('Prompt library');
    expect(html).toContain('Collect and sync prompts in bulk');
    expect(html).toContain('Prompt status by memory');
    expect(html.indexOf('data-testid="what-i-said-memory-bulk-card"'))
      .toBeLessThan(html.indexOf('data-testid="what-i-said-project-status-card"'));
    expect(html).toContain('External app key');
    expect(panelSource).toContain('Create one key per connected app');
    expect(appSource).toContain('role="tabpanel" aria-labelledby="tab-memory"');
    expect(appSource).toContain('aria-labelledby="tab-what-i-said"');
  });

  test('distinguishes loading, empty, filtered-empty, and error states in both languages', () => {
    for (const phrase of [
      '프롬프트를 불러오는 중입니다.',
      '아직 수집된 프롬프트가 없습니다.',
      '조건에 맞는 프롬프트가 없습니다.',
      '프롬프트를 불러오지 못했습니다.',
      'Loading prompts.',
      'No prompts have been captured yet.',
      'No prompts match these filters.',
      'Could not load prompts.',
    ]) expect(panelSource).toContain(phrase);
    // 기본값은 '모든 장기기억'이다. 하나로 좁혀 열면 수집이 없는 장기기억에서
    // 빈 라이브러리가 뜨고, 그 아래 여백이 레이아웃 오류로 읽힌다.
    expect(panelSource).toContain('useState<string>(WHAT_I_SAID_DEFAULT_PROJECT_FILTER)');
    // 손대지 않은 패널이 "필터가 걸려 있다"고 주장하면 안 되므로 둘이 같아야 한다.
    expect(panelSource).toContain('const defaultProjectFilterId = WHAT_I_SAID_DEFAULT_PROJECT_FILTER;');
    expect(panelSource).toContain('reconcileWhatISaidProjectFilter(projectFilterId, libraryScopes)');
    expect(panelSource).toContain('if (!projectFilterReady)');
    // 이 탭의 단위는 장기기억이다 — 같은 저장소의 워크트리는 한 줄로 묶이고,
    // 정책·개수·삭제가 모두 그 단위로 적용된다. 라벨이 프로젝트라고 말하면
    // 화면이 세는 것과 사용자가 읽는 것이 어긋난다.
    expect(panelSource).toContain('등록된 모든 장기기억에서 프롬프트 자동 저장');
    // 단위(장기기억)가 목적어(프롬프트)를 대체하면 안 된다 — 「이 장기기억 기록 모두
    // 삭제」는 장기기억 자체를 지운다고 읽힌다.
    expect(panelSource).toContain('모든 장기기억의 프롬프트 저장 정책');
    expect(panelSource).toContain('이 장기기억의 프롬프트 모두 삭제');
    expect(panelSource).not.toContain('이 장기기억 기록 모두 삭제');
    expect(panelSource).toContain('프롬프트 일괄 수집·동기화');
    expect(panelSource).toContain('장기기억별 프롬프트 상태');
    expect(panelSource).toContain('상태를 확인할 장기기억');
    expect(panelSource).toContain('이 선택은 위의 일괄 수집 대상을 바꾸지 않습니다.');
    expect(panelSource).toContain('자동 수집의 켜기·끄기는 위 저장 정책에서 설정합니다.');
    expect(panelSource).toContain('data-testid="what-i-said-memory-bulk-card"');
    expect(panelSource).toContain('data-testid="what-i-said-global-policy-card"');
    expect(panelSource).toContain('data-testid="what-i-said-project-status-card"');
    expect(panelSource).toContain('data-testid="what-i-said-global-actions"');
    expect(panelSource).toContain('data-testid="what-i-said-project-actions"');
    expect(panelSource).toContain('모든 장기기억 프롬프트 저장 시작');
    expect(panelSource).toContain('모든 장기기억에 설정 다시 적용');
    expect(panelSource).toContain('모든 장기기억 프롬프트 저장 중지');
    expect(panelSource).toContain('void saveCaptureSettings(true)');
    expect(panelSource).toContain('void saveCaptureSettings(false)');
    expect(panelSource).not.toContain('setEnabledDraft');
    expect(panelSource).toContain('whatISaidApi.configureAll({');
    expect(panelSource).toContain('whatISaidApi.globalStatus()');
    // 이 숫자는 서버가 registeredWhatISaidProjects() 로 장기기억 중복을 제거해 센다.
    expect(panelSource).toContain('현재 등록 장기기억 ${registered}개 중 ${applied}개');
    expect(panelSource).toContain('기본은 「모든 장기기억」이며 Supabase 적재 순서로 최근 50개씩 읽습니다.');
    // Remember-session and explicit prompt sync are distinct user intents. The
    // explanation comes before the actions and the manual path names sync.
    expect(panelSource).toContain('「세션 기억하기」는 장기기억 갱신과 프롬프트 수집·동기화를 함께 합니다.');
    expect(panelSource).toContain('선택한 ${count}개 기억 수집·동기화');
    expect(panelSource).toContain('t.syncSelectedCount(selectedMemoryIds.length)');
    expect(panelSource.indexOf('data-testid="what-i-said-capture-now-help"'))
      .toBeLessThan(panelSource.indexOf('data-testid="what-i-said-project-actions"'));
    // 필터 지우기 must return to the cheap scoped default, never to the
    // all-projects sweep that took ~52s before the resolver memo.
    expect(panelSource).toContain('setProjectFilterId(defaultProjectFilterId)');
    expect(panelSource).not.toContain("setProjectFilterId('all')");
    // Turning 전체 저장 on creates a store per project but imports nothing until
    // the next session save, so 41 of 41 projects read as "아직 수집된 프롬프트가
    // 없습니다" — indistinguishable from a broken feature. Three states, and an
    // explicit way to reach back.
    expect(panelSource).toContain('아직 이 장기기억의 프롬프트를 수집하지 않았습니다.');
    expect(panelSource).toContain('No prompts have been captured for this memory yet.');
    expect(panelSource).toContain('notCapturedYet ? t.notCapturedYetTitle : t.emptyTitle');
    expect(panelSource).toContain('data-testid="what-i-said-stored-count"');
    expect(panelSource).toContain('data-testid="what-i-said-backfill"');
    expect(panelSource).toContain('켜기 전 대화까지 처음부터 가져오기');
    // Reaching past the consent instant must be confirmed, never automatic.
    expect(panelSource).toContain('if (backfill && !window.confirm(t.backfillConfirm(selectedMemoryIds.length))) return;');
  });

  test('says how old the library is, why, and points at the capture action that already exists', () => {
    // 저장 건수 옆에 신선도가 함께 있어야 한다 — 「N건 저장」만으로는 그것이 오늘의
    // 기록인지 지난달 기록인지 알 수 없다.
    expect(panelSource).toContain('data-testid="what-i-said-stored-count"');
    expect(panelSource).toContain('data-testid="what-i-said-last-capture"');
    expect(panelSource.indexOf('data-testid="what-i-said-stored-count"'))
      .toBeLessThan(panelSource.indexOf('data-testid="what-i-said-last-capture"'));
    expect(panelSource).toContain("captureFreshness.state !== 'unknown' && (");

    // 두 언어 모두. 한쪽만 고치면 다른 언어 사용자에게는 이 결함이 그대로 남는다.
    expect(panelSource).toContain("lastCollectedDays: (days: number) => `마지막 수집 ${days}일 전`");
    expect(panelSource).toContain("neverCollected: '아직 수집된 적 없음'");
    expect(panelSource).toContain('lastCollectedDays: (days: number) => `Last collected ${days} day${days === 1 ? \'\' : \'s\'} ago`');
    expect(panelSource).toContain("neverCollected: 'Never collected yet'");

    // Background rotation is explained in both languages.
    expect(panelSource).toContain('data-testid="what-i-said-capture-stale-note"');
    expect(panelSource).toContain('앱이 실행 중이면 자동 저장 대상을 순환 수집합니다.');
    expect(panelSource).toContain('automatic saving cycles through registered memories.');
    expect(panelSource).toContain('자동 수집의 켜기·끄기는 위 저장 정책에서 설정합니다.');
    expect(panelSource).toContain('Manage automatic collection in the saving policy above.');
    expect(panelSource).toContain('이 선택은 위의 일괄 수집 대상을 바꾸지 않습니다.');
    expect(panelSource).toContain('This selection does not change the bulk collection targets above.');
    expect(panelSource).toContain('{t.staleCaptureNote(t.syncSelected)}');

    // 수집 버튼은 위 카드에 이미 하나 있다. 안내가 두 번째 버튼을 만들면 안 된다.
    const libraryCard = panelSource.slice(panelSource.indexOf('data-testid="what-i-said-last-capture"'));
    expect(libraryCard).not.toContain('void captureNow(');
    // 주기 실행은 서버가 소유하며 UI에 타이머를 추가하지 않는다.
    expect(panelSource).not.toContain('setInterval');
  });

  test('renders prompts as an ordered article list with machine-readable time and live outcomes', () => {
    expect(panelSource).toContain('<ol className="space-y-3"');
    expect(panelSource).toContain('<article className=');
    expect(panelSource).toContain('<time dateTime=');
    expect(panelSource).toContain("role={notice?.kind === 'error' ? 'alert' : 'status'}");
    expect(panelSource).toContain('aria-live={notice?.kind');
    expect(panelSource).toContain('aria-atomic="true"');
  });

  test('keeps AI analysis as explicit stored consent and does not claim a model call', () => {
    expect(panelSource).toContain('AI 분석 사용을 별도로 허용');
    expect(panelSource).toContain('이 동의는 설정만 저장합니다. 지금 모델을 호출하거나 프롬프트를 외부로 보내지 않습니다.');
    expect(panelSource).toContain('analysisAllowed: analysisDraft');
  });

  /**
   * 프로젝트별 로컬 loopback 소스 카드는 제거됐다. 외부 앱 연결은 원격 적재
   * 카드 안의 **장기기억 단위 키** 하나뿐이고, 두 개를 나란히 두면 어느 쪽에
   * 키를 만들어야 하는지 화면만 봐서는 알 수 없다(실제로 그 질문을 받았다).
   */
  test('offers exactly one external-app key surface, scoped to the long-term memory', () => {
    expect(panelSource).not.toContain('외부 앱용 읽기 전용 소스');
    expect(panelSource).not.toContain("type={showAccessToken ? 'text' : 'password'}");
    expect(panelSource).not.toContain('이 접근 키는 지금 한 번만 표시됩니다.');
    expect(panelSource).toContain('data-testid="what-i-said-remote-key"');
    expect(panelSource).toContain('외부 앱 연결 키');
    // 키의 단위는 소비하는 앱이다 — 장기기억 선택기가 있으면 다시 단위가 갈린다.
    expect(panelSource).not.toContain('data-testid="what-i-said-remote-key-project"');
    expect(panelSource).toContain('data-testid="what-i-said-remote-key-list"');
    expect(panelSource).toContain('data-testid="what-i-said-remote-key-label"');
    expect(panelSource).toContain("captureStatus.cryptoState === 'unavailable'");
  });
});

test('a single fresh memory does not mask a stale one in the aggregate', () => {
  // Measured on this machine 2026-09-05: 42 stores, 34 never captured, 7 stale,
  // exactly 1 fresh. Reducing the scope to the NEWEST capture rendered that as a
  // reassuring "fresh" while the library was five days behind -- the precise
  // failure the badge exists to prevent. Staleness is decided by the laggard.
  const now = Date.parse('2026-09-05T12:00:00Z');
  const fresh = '2026-09-05T11:00:00Z';
  const stale = '2026-08-31T18:10:13.511Z';

  expect(whatISaidCaptureFreshness({ lastCaptureAt: fresh, oldestCaptureAt: stale }, now).state)
    .toBe('stale');
  expect(whatISaidCaptureFreshness({ lastCaptureAt: fresh, oldestCaptureAt: fresh }, now).state)
    .toBe('fresh');
  // The label still names the most recent capture; only the warning follows the laggard.
  expect(whatISaidCaptureFreshness({ lastCaptureAt: fresh, oldestCaptureAt: stale }, now).hours)
    .toBe(1);
  // An older sidecar omits the field entirely; fall back rather than mis-warn.
  expect(whatISaidCaptureFreshness({ lastCaptureAt: fresh }, now).state).toBe('fresh');
  expect(whatISaidCaptureFreshness({ lastCaptureAt: stale }, now).state).toBe('stale');
  // A non-string from a proxy is unknown, never an assertive "never captured".
  expect(whatISaidCaptureFreshness({ lastCaptureAt: undefined }, now).state).toBe('unknown');
});

import { whatISaidErrorMessage } from '../src/WhatISaidPanel';
test('Tauri string rejections preserve secure API recovery guidance', () => {
  const message = whatISaidErrorMessage('What I said 로컬 API의 보안 연결을 확인하지 못했습니다.', 'generic', 'ko');
  expect(message).toContain('포트 3001');
  expect(message).toContain('개발용 API');
  expect(message).not.toContain('오래되어');
  expect(whatISaidErrorMessage('read failed', 'generic', 'ko')).toBe('read failed');
});
