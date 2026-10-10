import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoteVocInbox,
  normalizeRemoteVocInbox,
  REMOTE_VOC_INBOX_FEATURE,
  REMOTE_VOC_INBOX_MAX_ITEMS,
  vocInboxSummaryLine,
} from '../src/vocInboxSummary';
import { readPendingVocRecords, remoteVocInboxSnapshot } from '../src/vocInbox.server';
import { completeVoc, saveVocRecord } from '../src/vocStore.server';
import { normalizeMobileWorkspaceRequest, normalizeMobileWorkspaceResult, workspaceScope } from '../src/mobileWorkspaceProtocol';
import { createMobileWorkspaceGateway } from '../src/mobileWorkspaceGateway';
import { buildVocInboxWorkroomHandoff, buildVocItemWorkroomHandoff } from '../src/voc/vocWorkroomHandoff';
import { REMOTE_CONTROL_SUPPORTED_FEATURE_LIMIT } from '../src/remoteControlProtocol';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const anchor = { tag: 'button', text: '저장', testId: 'save-button', path: [] as string[] };

let appData: string;
beforeEach(() => { appData = mkdtempSync(join(tmpdir(), 'voc-inbox-remote-')); });
afterEach(() => rmSync(appData, { recursive: true, force: true }));

describe('쌓인 VOC 요약 (voc.inbox)', () => {
  test('첫 줄만 짧게, 출처는 Mac/휴대폰으로 구분하고 경로·사진 바이트는 싣지 않는다', async () => {
    await saveVocRecord({ appDataDir: appData, comment: '\n\n  헤더 버튼이 겹쳐요  \n둘째 줄', anchor, tab: 'projects', appVersion: 'v1', now: new Date('2026-09-27T01:00:00Z') });
    await saveVocRecord({ appDataDir: appData, comment: '사진 참고', anchor: { tag: 'phone', text: '사진 공유', path: [] }, tab: '', appVersion: '', images: [{ bytes: PNG }], source: 'phone-share', now: new Date('2026-09-27T02:00:00Z') });
    const inbox = remoteVocInboxSnapshot(appData);
    expect(inbox.total).toBe(2);
    expect(inbox.items.map(i => [i.source, i.summary, i.photos])).toEqual([['phone-share', '사진 참고', 1], ['mac', '헤더 버튼이 겹쳐요', 0]]);
    const wire = JSON.stringify(inbox);
    expect(wire).not.toContain(appData);
    expect(wire).not.toContain('attachments/');
    expect(normalizeRemoteVocInbox(JSON.parse(wire))).toEqual(inbox);
  });

  test('처리된(done/) VOC는 세지 않고, 읽을 수 없는 파일은 개수로만 알린다', async () => {
    const saved = await saveVocRecord({ appDataDir: appData, comment: '처리됨', anchor, tab: '', appVersion: '' });
    await saveVocRecord({ appDataDir: appData, comment: '남음', anchor: { tag: 'div', text: '다른 곳', path: [] }, tab: '', appVersion: '' });
    completeVoc(appData, saved.file, saved.path);
    writeFileSync(join(appData, 'voc', '2026-09-27-0100-broken.json'), '{not json');
    const outside = join(appData, 'secret.json');
    writeFileSync(outside, JSON.stringify({ comment: 'outside' }));
    symlinkSync(outside, join(appData, 'voc', '2026-09-27-0101-link.json'));
    const records = readPendingVocRecords(appData);
    expect(records.filter(r => r.unreadable === true)).toHaveLength(2);
    const inbox = remoteVocInboxSnapshot(appData);
    expect(inbox).toMatchObject({ total: 3, unreadable: 2 });
    expect(inbox.items.map(i => i.summary)).toEqual(['남음']);
    expect(JSON.stringify(inbox)).not.toContain('outside');
  });

  test('항목 수와 바이트 예산 안에서 자르고, 결과 봉투가 워크스페이스 응답 상한(8,500B) 안에 든다', () => {
    const long = '가'.repeat(400);
    const records = Array.from({ length: 40 }, (_, i) => ({
      file: `2026-09-27-${String(1000 + i)}-${'한글앵커'.repeat(9)}.json`,
      createdAt: '2026-09-27T01:00:00.000Z', comment: long, source: 'phone-error', attachments: [1, 2, 3, 4, 5, 6],
    }));
    const inbox = buildRemoteVocInbox(records);
    expect(inbox.total).toBe(40);
    expect(inbox.items.length).toBeLessThanOrEqual(REMOTE_VOC_INBOX_MAX_ITEMS);
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items.every(i => Array.from(i.summary).length <= 60 && i.photos === 5)).toBe(true);
    const result = normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'voc.inbox', vocInbox: inbox });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(8500);
  });

  test('요약 줄은 제어문자를 지우고 60자에서 자른다', () => {
    expect(vocInboxSummaryLine('a\u0007b')).toBe('a b');
    expect(Array.from(vocInboxSummaryLine('x'.repeat(100)))).toHaveLength(60);
    expect(vocInboxSummaryLine(42)).toBe('');
  });

  test('휴대폰 정규화기는 모르는 키·경로 같은 파일명·긴 요약·모르는 출처를 거절한다', () => {
    const good = { total: 1, unreadable: 0, items: [{ file: '2026-09-27-0100-a.json', createdAt: '2026-09-27T01:00:00Z', source: 'mac', summary: 'x', photos: 0 }] };
    expect(normalizeRemoteVocInbox(good).items).toHaveLength(1);
    const bad = [
      { ...good, extra: 1 },
      { ...good, items: [{ ...good.items[0], attachmentPaths: ['/Users/x/1.jpg'] }] },
      { ...good, items: [{ ...good.items[0], file: '../escape.json' }] },
      { ...good, items: [{ ...good.items[0], summary: 'x'.repeat(61) }] },
      { ...good, items: [{ ...good.items[0], source: 'somewhere' }] },
      { ...good, items: [{ ...good.items[0], photos: 6 }] },
      { ...good, total: 0 },
    ];
    for (const value of bad) expect(() => normalizeRemoteVocInbox(value)).toThrow();
  });
});

describe('워크스페이스 채널 계약', () => {
  const request = { operation: 'workspace', requestId: crypto.randomUUID(), targetId: 'target-dev-1', workspace: { action: 'voc.inbox' } };

  test('voc.inbox는 추가 필드 없는 읽기이고, 기능 권한 없이 프로젝트 범위만 요구한다', () => {
    expect(workspaceScope('voc.inbox')).toBeNull();
    expect(normalizeMobileWorkspaceRequest(request).workspace.action).toBe('voc.inbox');
    expect(() => normalizeMobileWorkspaceRequest({ ...request, workspace: { action: 'voc.inbox', query: 'x' } })).toThrow();
    expect(() => normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'voc.inbox', vocInbox: { total: 0, unreadable: 0, items: [] }, voc: {} })).toThrow();
    expect(() => normalizeMobileWorkspaceResult({ kind: 'workspace', action: 'voc.submit', vocInbox: { total: 0, unreadable: 0, items: [] } })).toThrow();
  });

  test('읽기 예산(분당 60)을 쓰고 VOC 보내기 예산(분당 10)은 건드리지 않는다', async () => {
    const performed: string[] = [];
    const gateway = createMobileWorkspaceGateway({
      terminal: async () => { throw new Error('not used'); },
      active: () => true,
      resolve: async () => [{ controlId: 'target-dev-1', runtimeTargetId: 'runtime-dev' }],
      consent: async () => ({ targetIds: new Set(['runtime-dev']), workspaceScopes: [], isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async req => {
        performed.push(req.workspace.action);
        return req.workspace.action === 'voc.inbox'
          ? { kind: 'workspace', action: 'voc.inbox', vocInbox: { total: 0, unreadable: 0, items: [] } }
          : { kind: 'workspace', action: 'voc.submit', voc: { vocId: crypto.randomUUID(), file: 'a.json', attachmentPaths: [], transitDeleted: true } };
      },
    });
    // More than the ten-per-minute VOC submit budget: reads are not counted there.
    for (let i = 0; i < 60; i += 1) await gateway({ ...request, requestId: crypto.randomUUID() } as never, [], 'internet:s1');
    await expect(gateway({ ...request, requestId: crypto.randomUUID() } as never, [], 'internet:s1')).rejects.toThrow('모바일 조회 요청이 많습니다');
    expect(performed.filter(a => a === 'voc.inbox')).toHaveLength(60);
  });

  test('프로젝트 범위 밖 기기는 읽지 못한다', async () => {
    const gateway = createMobileWorkspaceGateway({
      terminal: async () => { throw new Error('not used'); }, active: () => true,
      resolve: async () => [{ controlId: 'target-dev-1', runtimeTargetId: 'runtime-dev' }],
      consent: async () => ({ targetIds: new Set(['other']), workspaceScopes: [], isActive: () => true, requestOwner: 'device:h:c' }),
      perform: async () => { throw new Error('must not run'); },
    });
    await expect(gateway(request as never, [], 'internet:s1')).rejects.toThrow('프로젝트 범위');
  });

  test('Mac이 기능 이름을 광고하고, 기능 목록이 옛 휴대폰의 상한(8) 안에 남는다', () => {
    expect(REMOTE_VOC_INBOX_FEATURE).toBe('voc-inbox-v1');
    const agent = readFileSync(new URL('../src/remoteControlInternetAgent.ts', import.meta.url), 'utf8');
    expect(agent).toContain('REMOTE_VOC_FEATURE,REMOTE_VOC_INBOX_FEATURE');
    expect(REMOTE_CONTROL_SUPPORTED_FEATURE_LIMIT).toBe(8);
  });
});

describe('워크룸 초안', () => {
  test('쌓인 VOC 전체 초안은 특정 VOC를 지목하지 않고 미처리 전체와 휴대폰 오류를 읽게 한다', () => {
    const { prompt } = buildVocInboxWorkroomHandoff({ projectPath: '/repo' });
    expect(prompt).not.toContain('<focus_voc>');
    expect(prompt).toContain('GET http://127.0.0.1:3001/api/voc');
    expect(prompt).toContain('/api/client-errors');
    expect(prompt).toContain('이 작업은 AgentsToZ 워크룸 안에서 실행 중입니다');
  });

  test('한 건 초안은 요약·사진 개수만으로도 전체 내용과 사진 경로를 Mac에서 읽게 한다', () => {
    const { prompt } = buildVocItemWorkroomHandoff({ file: '2026-09-27-0100-a.json', comment: '첫 줄', source: 'phone-share', photoCount: 2, commentIsSummary: true });
    expect(prompt).toContain('<focus_voc>');
    expect(prompt).toContain('2026-09-27-0100-a.json');
    expect(prompt).toContain('사진 2장');
    expect(prompt).toContain('attachmentPaths');
    expect(prompt).toContain('첫 줄 요약');
  });

  test('경로를 아는 Mac 목록은 경로를 그대로 싣고 개수 안내는 하지 않는다', () => {
    const { prompt } = buildVocItemWorkroomHandoff({ file: 'a.json', comment: '전체', attachmentPaths: ['/Users/me/voc/attachments/a/1.png'], photoCount: 1 });
    expect(prompt).toContain('/Users/me/voc/attachments/a/1.png');
    expect(prompt).not.toContain('사진 1장이 첨부되어');
  });
});

describe('Mac 개선 요청 상자도 같은 초안을 준다', () => {
  test('쌓인 전체·한 건 버튼이 같은 초안 빌더를 쓰고, Mac 목록은 사진 경로를 넘긴다', () => {
    const overlay = readFileSync(new URL('../src/voc/VocOverlay.tsx', import.meta.url), 'utf8');
    expect(overlay).toContain('data-testid="voc-inbox-workroom"');
    expect(overlay).toContain('data-testid="voc-inbox-item-workroom"');
    expect(overlay).toContain('buildVocInboxWorkroomHandoff({ projectPath })');
    expect(overlay).toContain('attachmentPaths: item.attachmentPaths');
  });
});
