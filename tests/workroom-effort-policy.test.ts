/**
 * Workroom 「에포트 자동」 (w16, 2026-10-16): the deterministic, local decision of which reasoning effort a request
 * needs. The golden table is shared with docs; the policy module is its only implementation.
 */
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {AI_TERMINAL_AGENTS} from '../src/aiTerminalProtocol';
import {
  WORKROOM_EFFORT_AUTO_LEVELS,
  WORKROOM_EFFORT_LOW_MAX_CHARS,
  WORKROOM_EFFORT_SUPPORT,
  WORKROOM_EFFORT_TEXT_MAX_CHARS,
  classifyWorkroomEffort,
  workroomEffortLevel,
  workroomEffortRequestText,
} from '../src/workroomEffortPolicy';

const golden = JSON.parse(readFileSync(new URL('./fixtures/workroom-effort-golden.json', import.meta.url), 'utf8')) as {
  classify: {text: string; expect: {tier: string; reason: string} | null}[];
  levels: {agent: (typeof AI_TERMINAL_AGENTS)[number]; tier: 'low' | 'medium' | 'high'; level: string | null}[];
};

describe('golden table', () => {
  for (const row of golden.classify) {
    test(`classify ${JSON.stringify(row.text)}`, () => {
      expect(classifyWorkroomEffort(row.text)).toEqual(row.expect as never);
    });
  }
  for (const row of golden.levels) {
    test(`${row.agent} × ${row.tier} → ${row.level}`, () => {
      expect(workroomEffortLevel(row.agent, row.tier)).toBe(row.level as never);
    });
  }
});

test('auto never chooses a level above high (xhigh/max fail a turn with thinking off; ultra/max cost the most)', () => {
  expect([...WORKROOM_EFFORT_AUTO_LEVELS]).toEqual(['low', 'medium', 'high']);
  const samples = [...golden.classify.map(row => row.text), 'x'.repeat(10_000), '데드락 '.repeat(2_000), 'ultra max xhigh effort please'];
  for (const text of samples) {
    const decision = classifyWorkroomEffort(text);
    if (!decision) continue;
    for (const agent of AI_TERMINAL_AGENTS) {
      const level = workroomEffortLevel(agent, decision.tier);
      expect(level === null || ['low', 'medium', 'high'].includes(level)).toBe(true);
    }
  }
});

test('which CLIs auto can drive, and how', () => {
  expect(WORKROOM_EFFORT_SUPPORT).toEqual({claude: 'launch', codex: 'launch', hermes: 'launch', agy: 'none'});
});

test('a model that does not offer the level gets no flag (never a level the model may reject)', () => {
  expect(workroomEffortLevel('codex', 'high', ['low', 'medium'])).toBeNull();
  expect(workroomEffortLevel('codex', 'low', ['low', 'medium'])).toBe('low');
  expect(workroomEffortLevel('codex', 'medium', [])).toBeNull();
});

test('a routine cue in a long request is not «routine» (low only up to the limit)', () => {
  const long = '오타 ' + '설명 문장입니다. '.repeat(Math.ceil(WORKROOM_EFFORT_LOW_MAX_CHARS / 8));
  expect(long.length).toBeGreaterThan(WORKROOM_EFFORT_LOW_MAX_CHARS);
  expect(classifyWorkroomEffort(long)).toEqual({tier: 'medium', reason: 'standard'});
  expect(classifyWorkroomEffort('오타 수정')).toEqual({tier: 'low', reason: 'typo'});
});

test('only the first 4,000 characters are read', () => {
  const late = 'a'.repeat(WORKROOM_EFFORT_TEXT_MAX_CHARS + 10) + ' deadlock';
  expect(classifyWorkroomEffort(late)).toEqual({tier: 'medium', reason: 'standard'});
  const early = 'deadlock ' + 'a'.repeat(WORKROOM_EFFORT_TEXT_MAX_CHARS);
  expect(classifyWorkroomEffort(early)).toEqual({tier: 'high', reason: 'concurrency'});
});

test('request text: the final Enter and an attachment block are not part of what the person asked', () => {
  const message = '왜 자꾸 실패하지\n\n[첨부 이미지 1개 — 각 파일을 열어 확인하세요]\n/Users/x/Library/Application Support/com.portmanager.portmanager/workroom-images/2026-10-16/a.png';
  expect(workroomEffortRequestText('fix the typo\r')).toBe('fix the typo');
  const stripped = workroomEffortRequestText(message + '\r');
  expect(stripped).toBe(message.split('\n\n')[0]!);
});

test('English cues match whole words only', () => {
  expect(classifyWorkroomEffort('update the racetrack page')).toEqual({tier: 'medium', reason: 'standard'});
  expect(classifyWorkroomEffort('migrations folder cleanup')).toEqual({tier: 'high', reason: 'migration'});
  expect(classifyWorkroomEffort('typography tweaks')).toEqual({tier: 'medium', reason: 'standard'});
});
