import {describe, expect, test} from 'bun:test';
import {workroomSessionLabels, workroomSessionStartedAt} from '../src/workroomSessionLabel';

const project = (id: string) => ({a: 'ai-trend-monitor', b: 'AgentsToZ'} as Record<string, string>)[id];

describe('workroomSessionLabels', () => {
  test('keeps a unique session plain', () => {
    const labels = workroomSessionLabels([{id: '1', targetId: 'a', agent: 'codex', createdAt: '2026-09-25T00:54:20Z'}], project);
    expect(labels.get('1')).toBe('ai-trend-monitor · codex');
  });

  test('numbers same project + AI in start order, regardless of list order', () => {
    const labels = workroomSessionLabels([
      {id: 'late', targetId: 'a', agent: 'codex', createdAt: '2026-09-25T00:55:08Z'},
      {id: 'other', targetId: 'b', agent: 'codex', createdAt: '2026-09-25T00:50:00Z'},
      {id: 'early', targetId: 'a', agent: 'codex', createdAt: '2026-09-25T00:54:20Z'},
      {id: 'claude', targetId: 'a', agent: 'claude', createdAt: '2026-09-25T00:56:00Z'},
    ], project);
    expect(labels.get('early')).toBe('ai-trend-monitor · codex #1');
    expect(labels.get('late')).toBe('ai-trend-monitor · codex #2');
    expect(labels.get('other')).toBe('AgentsToZ · codex');
    expect(labels.get('claude')).toBe('ai-trend-monitor · claude');
  });

  test('falls back for an unknown project', () => {
    expect(workroomSessionLabels([{id: '1', targetId: 'zz', agent: 'agy', createdAt: 'x'}], project).get('1')).toBe('프로젝트 · agy');
  });

  test('start time tooltip', () => {
    expect(workroomSessionStartedAt('not a date')).toBe('');
    expect(workroomSessionStartedAt('2026-09-25T00:54:20Z')).toMatch(/^\d{2}:\d{2} 시작$/);
  });
});
