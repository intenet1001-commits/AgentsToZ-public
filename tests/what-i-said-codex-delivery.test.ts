import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWhatISaidTranscripts } from '../src/whatISaidTranscriptCollector';
import { WhatISaidPromptOriginRegistry } from '../src/whatISaidPromptOriginRegistry';
import { captureWhatISaidPrompt, enableWhatISaidCapture, listWhatISaidEntries } from '../src/whatISaidStore';
import { analyzePromptGuideSuggestions } from '../src/promptGuideSuggestions';

const temporaryRoots: string[] = [];
afterEach(() => { for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = '2026-08-30T12:00:00.000Z';
const encode = (record: unknown) => `${JSON.stringify(record)}\n`;

function pair(text: string, turn: string, kind = 'user.text') {
  const response = { type: 'response_item', timestamp: at, payload: {
    type: 'message', id: `message-${turn}`, role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: [kind] },
  }, metadata: { client_authored: false, retained_source: {
    id: { message_id: `message-${turn}`, turn_id: turn, role: 'user' }, revision: 1, complete: kind === 'user.text',
  } } };
  const event = { type: 'event_msg', timestamp: '2026-08-30T12:00:00.003Z', payload: {
    type: 'item_completed', turn_id: turn,
    item: { type: 'UserMessage', id: `completed-${turn}`, content: [{ type: 'text', text }] },
  } };
  return { response, event };
}

function fixture(records: unknown[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'agentstoz-delivery-origin-'));
  temporaryRoots.push(root);
  const projectRoot = join(root, 'project');
  const appDataDir = join(root, 'app-data');
  const codexSessionsDir = join(root, 'sessions');
  const claudeProjectsDir = join(root, 'claude');
  for (const path of [projectRoot, appDataDir, codexSessionsDir, claudeProjectsDir]) mkdirSync(path);
  const file = join(codexSessionsDir, 'delivery.jsonl');
  writeFileSync(file, encode({ type: 'session_meta', payload: { cwd: projectRoot } }) + records.map(encode).join(''));
  const input = { projectRoot, appDataDir, codexSessionsDir, claudeProjectsDir, memoryId: 'delivery-fixture', key: Buffer.alloc(32, 0x58) };
  enableWhatISaidCapture({ ...input, retention: 'forever', now: '2026-08-30T10:00:00Z' });
  const registry = new WhatISaidPromptOriginRegistry(appDataDir);
  registry.register('앱에서 복사한 확인용 문장', '2026-08-30T11:59:00Z');
  const collect = (scanByteBudget?: number) => collectWhatISaidTranscripts({
    ...input, worktreeRoots: [projectRoot], now: '2026-08-30T12:10:00Z', scanByteBudget,
    promptOrigin: (text, recordedAt, delivery) => registry.classify(text, recordedAt, delivery),
  });
  const entries = () => listWhatISaidEntries({ ...input, now: '2026-08-30T12:10:00Z' }).items;
  return { file, input, registry, collect, entries };
}

describe('Codex delivery provenance, independently of message text', () => {
  test('retains a scheduled instruction as unknown and preserves an ordinary message quoting heartbeat XML', () => {
    const automaticText = '지난 검증 결과를 읽고 다음 확인을 진행해 주세요.';
    const quotedText = '설명용 <heartbeat>다음 확인</heartbeat> 문자열을 검토해 주세요.';
    const automatic = pair(automaticText, 'automatic', 'user.heartbeat');
    const quoted = pair(quotedText, 'quoted');
    const test = fixture([automatic.response, automatic.event, quoted.response, quoted.event]);
    expect(test.collect()).toMatchObject({ stored: 2, userEvents: 2, unreadable: 0 });
    const rows = test.entries();
    expect(rows.find(row => row.text === automaticText)?.promptOrigin).toBe('unknown');
    expect(rows.find(row => row.text === quotedText)?.promptOrigin).toBe('human');
    expect(analyzePromptGuideSuggestions(rows, { includeRecent: true }).recent?.map(row => row.body)).toEqual([quotedText]);
    expect(test.collect()).toMatchObject({ stored: 0, duplicates: 0 });
  });

  test('a known scheduled delivery cannot become app copy merely because its body was copied earlier', () => {
    const text = '앱에서 복사한 확인용 문장';
    const automatic = pair(text, 'scheduled-copy', 'user.heartbeat');
    const test = fixture([automatic.response, automatic.event]);
    expect(test.collect().stored).toBe(1);
    expect(test.entries()[0]?.promptOrigin).toBe('unknown');
  });

  test('producer kinds, rather than client-authored or completeness flags, select delivery', () => {
    const ordinary = pair('확인한 사용자 메시지를 보존해 주세요.', 'ordinary-flags');
    ordinary.response.metadata.retained_source.complete = false;
    const automatic = pair('예약된 점검 메시지도 원문은 남겨 주세요.', 'automatic-flags', 'user.heartbeat');
    automatic.response.metadata.client_authored = true;
    automatic.response.metadata.retained_source.complete = true;
    const test = fixture([ordinary.response, ordinary.event, automatic.response, automatic.event]);
    expect(test.collect().stored).toBe(2);
    expect(test.entries().find(row => row.text === ordinary.event.payload.item.content[0]!.text)?.promptOrigin).toBe('human');
    expect(test.entries().find(row => row.text === automatic.event.payload.item.content[0]!.text)?.promptOrigin).toBe('unknown');
  });

  test('an existing captured row is a duplicate, never an automatic reclassification or rewrite', () => {
    const automatic = pair('기존 예약 점검 원문을 보존해 주세요.', 'existing', 'user.heartbeat');
    const test = fixture([automatic.response, automatic.event]);
    const original = captureWhatISaidPrompt({ ...test.input, agent:'codex', sourceIdentity:`codex:${realpathSync(test.file)}`,
      sourceEventIdentity:'3', recordedAt:automatic.event.timestamp, text:automatic.event.payload.item.content[0]!.text,
      promptOrigin:'human', now:'2026-08-30T12:10:00Z' });
    expect(original.stored).toBe(true);
    const before = test.entries();
    expect(test.collect()).toMatchObject({ stored:0, duplicates:1 });
    expect(test.entries()).toEqual(before);
  });

  test('no matched producer metadata means unknown, not proof of a person typing', () => {
    const message = pair('출처 없는 일반 메시지도 원문은 보존해 주세요.', 'missing');
    const test = fixture([message.event]);
    expect(test.collect().stored).toBe(1);
    expect(test.entries()[0]?.promptOrigin).toBe('unknown');
    expect(test.registry.classify('새 지시', at)).toBe('unknown');
  });

  test.each(['turn', 'text', 'retained-id', 'kinds', 'timestamp', 'intervening-record'])(
    'does not borrow ordinary-message evidence across a mismatched %s', mismatch => {
      const message = pair('동일한 메시지와 전달 시점을 정확히 확인해 주세요.', 'bound');
      if (mismatch === 'turn') message.event.payload.turn_id = 'other';
      if (mismatch === 'text') message.event.payload.item.content[0]!.text = '다른 사용자 메시지입니다.';
      if (mismatch === 'retained-id') message.response.metadata.retained_source.id.message_id = 'other';
      if (mismatch === 'kinds') message.response.payload.internal_chat_message_metadata_passthrough.content_item_kinds.push('user.heartbeat');
      if (mismatch === 'timestamp') message.event.timestamp = '2026-08-30T12:30:00Z';
      const test = fixture([message.response, ...(mismatch === 'intervening-record' ? [{ type: 'event_msg', payload: { type: 'token_count' } }] : []), message.event]);
      expect(test.collect().stored).toBe(1);
      expect(test.entries()[0]?.promptOrigin).toBe('unknown');
    },
  );

  test('restores bounded evidence after collection ends between the metadata and completion event', () => {
    const message = pair('원래 사용자 메시지를 한 번만 보존해 주세요.', 'append');
    const test = fixture([message.response]);
    expect(test.collect()).toMatchObject({ stored: 0, hasMore: false });
    appendFileSync(test.file, encode(message.event));
    const before = readFileSync(test.file);
    expect(test.collect()).toMatchObject({ stored: 1, hasMore: false, unreadable: 0 });
    expect(test.entries()[0]?.promptOrigin).toBe('human');
    expect(readFileSync(test.file)).toEqual(before);
  });

  test('truncated or over-budget evidence fails to unknown while the completed original is retained', () => {
    const message = pair('출처 증거가 너무 길면 확인 불가로 보존해 주세요.', 'bounded');
    Object.assign(message.response.payload, { padding: 'x'.repeat(70_000) });
    const test = fixture([message.response]);
    expect(test.collect().stored).toBe(0);
    appendFileSync(test.file, encode(message.event));
    const result = test.collect();
    expect(result).toMatchObject({ stored: 1, unreadable: 0 });
    // Includes ownership-header and durable-cursor anchor reads, not only lookback.
    expect(result.bytesRead).toBeLessThan(72 * 1024);
    expect(test.entries()[0]?.promptOrigin).toBe('unknown');
  });
});
