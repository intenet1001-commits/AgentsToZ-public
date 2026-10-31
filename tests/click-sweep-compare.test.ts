import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {compareSweep, isReacting, strongReactions} from '../scripts/agentstoz-click-sweep.mjs';

type SweepElement = {role: string; name: string; depth: number; via: string[]; count: number; reactions: string[]; requests: string[]; errors?: string[]; unnamed?: boolean};
type SweepInventory = {schemaVersion: 1; surface: string; viewport: string; maxDepth: number; elements: Record<string, SweepElement>};

const element = (reactions: string[], extra: Partial<SweepElement> = {}): SweepElement =>
  ({role: 'button', name: 'x', depth: 0, via: [], count: 1, reactions, requests: [], ...extra});
const inventory = (elements: Record<string, SweepElement>, extra: Partial<SweepInventory> = {}): SweepInventory =>
  ({schemaVersion: 1, surface: 'desktop', viewport: '1440x900', maxDepth: 2, elements, ...extra});
const ok = {budgetHit: null};

describe('click sweep baseline comparison', () => {
  test('a run identical to its baseline passes with nothing to report', () => {
    const inv = inventory({a: element(['ui']), b: element(['none']), c: element(['disabled'])});
    expect(compareSweep(inv, structuredClone(inv), ok)).toEqual({failures: [], notes: []});
  });

  test('a button that used to react and now does nothing fails, and so does one that became unclickable', () => {
    const base = inventory({save: element(['dialog', 'ui']), copy: element(['clipboard'])});
    const now = inventory({save: element(['none']), copy: element(['not-clickable'])});
    const {failures} = compareSweep(base, now, ok);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toContain('반응 상실 — save');
    expect(failures[1]).toContain('반응 상실 — copy');
  });

  test('new errors fail, errors already recorded in the baseline do not, and fixed errors are reported', () => {
    const base = inventory({pin: element(['ui'], {errors: ['pageerror: known']}), tab: element(['ui'], {errors: ['console: gone']})});
    const now = inventory({pin: element(['ui'], {errors: ['pageerror: known', 'pageerror: new']}), tab: element(['ui'])});
    const {failures, notes} = compareSweep(base, now, ok);
    expect(failures).toEqual(['새 오류 — pin: pageerror: new']);
    expect(notes).toEqual(['오류 사라짐 — tab: console: gone']);
  });

  test('a baseline target that disappeared fails; a new target is only reported', () => {
    const {failures, notes} = compareSweep(inventory({old: element(['ui'])}), inventory({fresh: element(['dialog'])}), ok);
    expect(failures).toEqual(['사라짐 — old']);
    expect(notes).toEqual(['새 대상 — fresh (dialog)']);
  });

  test('a target that starts reacting is an improvement, not a failure', () => {
    const {failures, notes} = compareSweep(inventory({a: element(['none'])}), inventory({a: element(['dialog', 'network'])}), ok);
    expect(failures).toEqual([]);
    expect(notes).toEqual(['반응 생김 — a: dialog,network']);
  });

  test('losing only a weak reaction (a background request or DOM churn) is reported, not failed', () => {
    const base = inventory({modal: element(['network']), toggle: element(['dom']), button: element(['ui', 'network'])});
    const now = inventory({modal: element(['none']), toggle: element(['none']), button: element(['network'])});
    const {failures, notes} = compareSweep(base, now, ok);
    expect(failures).toEqual(['반응 상실 — button: 기준선 ui,network → 지금 network']);
    expect(notes).toEqual(['약한 반응만 사라짐 — modal: 기준선 network → 지금 none', '약한 반응만 사라짐 — toggle: 기준선 dom → 지금 none']);
  });

  test('a run cut short by its budget is never a pass and does not claim targets disappeared', () => {
    const {failures, notes} = compareSweep(inventory({a: element(['ui']), b: element(['ui'])}), inventory({a: element(['ui'])}), {budgetHit: 'time'});
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('탐색 예산(time)');
    expect(notes).toContain('예산에 걸린 실행이라 사라짐 판정은 건너뛰었습니다');
  });

  test('without a baseline the check fails instead of silently writing one', () => {
    expect(compareSweep(null, inventory({a: element(['ui'])}), ok).failures).toEqual(['기준선이 없습니다 — 처음 한 번 --update로 만들고 그 파일을 커밋하세요']);
  });

  test('a baseline taken at another depth or viewport cannot be compared', () => {
    const {failures} = compareSweep(inventory({}, {maxDepth: 1, viewport: '390x844'}), inventory({}), ok);
    expect(failures).toHaveLength(2);
  });

  test('only real reactions count as reacting', () => {
    for (const r of ['ui', 'dialog', 'network', 'clipboard', 'dom', 'navigation', 'popup', 'crash']) expect(isReacting([r])).toBe(true);
    for (const r of ['none', 'disabled', 'not-clickable']) expect(isReacting([r])).toBe(false);
    expect(isReacting([])).toBe(false);
    expect(strongReactions(['network', 'dom'])).toEqual([]);
    expect(strongReactions(['dialog', 'network'])).toEqual(['dialog']);
  });

  test('the committed desktop baseline is well-formed and every key is unique and reachable by a recorded path', () => {
    const baseline = JSON.parse(readFileSync(new URL('./click-sweep/desktop.json', import.meta.url), 'utf8')) as SweepInventory;
    expect(baseline.schemaVersion).toBe(1);
    const keys = Object.keys(baseline.elements);
    expect(keys.length).toBeGreaterThan(50);
    for (const [key, value] of Object.entries(baseline.elements)) {
      expect(value.reactions.length).toBeGreaterThan(0);
      expect(value.depth).toBe(value.via.length);
      expect(value.depth).toBeLessThanOrEqual(baseline.maxDepth);
      for (const step of value.via) expect(keys).toContain(step);
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
