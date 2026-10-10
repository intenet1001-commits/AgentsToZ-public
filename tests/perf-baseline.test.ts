/**
 * 성능 기준선의 계산·비교·파일 모양만 본다. 시간 자체는 단언하지 않는다 — 기기·부하에 따라 흔들리는
 * 숫자를 테스트 통과 조건으로 쓰면 흔들리는 테스트가 된다. 숫자는 `bun run perf:baseline -- --compare`가 본다.
 */
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  compareBaselines,
  DEFAULT_REGRESSION_FLOOR,
  formatComparison,
  measurement,
  median,
  percentile,
  summarize,
  validateBaseline,
  type PerfMeasurement,
} from '../scripts/perf/stats';

const m = (samples: number[], extra: Partial<PerfMeasurement> = {}): PerfMeasurement =>
  ({...measurement({unit: 'ms', samples, method: 'fixture measurement method', reproducible: true}), ...extra});

describe('statistics', () => {
  test('nearest-rank percentiles and a midpoint median', () => {
    expect(percentile([5, 1, 4, 2, 3], 0)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(summarize([10, 30, 20])).toEqual({min: 10, median: 20, p90: 30});
  });
  test('non-finite samples are ignored and an empty set is refused', () => {
    expect(median([NaN, 4, Infinity, 2])).toBe(3);
    expect(() => median([])).toThrow();
    expect(() => percentile([1], 1.5)).toThrow();
  });
});

describe('comparison', () => {
  test('a regression needs both the ratio and the absolute floor', () => {
    const base = {measurements: {a: m([100, 100, 100]), b: m([10, 10, 10]), c: m([1000, 1000, 1000])}};
    const current = {measurements: {
      a: m([160, 160, 160]), // ×1.6 and +60 > floor 50 → regressed
      b: m([30, 30, 30]),    // ×3 but only +20 ≤ floor 50 → noise, ok
      c: m([1400, 1400, 1400]), // +400 but ×1.4 ≤ 1.5 → ok
    }};
    const result = compareBaselines(base, current);
    expect(result.regressed).toEqual(['a']);
    expect(result.rows.find(row => row.id === 'b')!.verdict).toBe('ok');
    expect(result.rows.find(row => row.id === 'c')!.verdict).toBe('ok');
    expect(DEFAULT_REGRESSION_FLOOR.ms).toBe(50);
  });
  test('the per-measurement floor wins over the unit default', () => {
    const base = {measurements: {a: m([10, 10, 10], {regressionFloor: 5})}};
    expect(compareBaselines(base, {measurements: {a: m([20, 20, 20])}}).regressed).toEqual(['a']);
  });
  test('non-reproducible measurements never fail the comparison', () => {
    const base = {measurements: {live: m([100, 100, 100], {reproducible: false})}};
    const result = compareBaselines(base, {measurements: {live: m([900, 900, 900], {reproducible: false})}});
    expect(result.regressed).toEqual([]);
    expect(result.rows[0]!.verdict).toBe('informational');
  });
  test('improvements, new, missing and unit changes are reported, not failed', () => {
    const base = {measurements: {fast: m([400, 400, 400]), gone: m([1, 1, 1]), unit: m([3, 3, 3])}};
    const current = {measurements: {
      fast: m([100, 100, 100]), fresh: m([5, 5, 5]),
      unit: {...m([3, 3, 3]), unit: 'count' as const},
    }};
    const result = compareBaselines(base, current);
    const verdict = (id: string) => result.rows.find(row => row.id === id)!.verdict;
    expect(verdict('fast')).toBe('improved');
    expect(verdict('fresh')).toBe('new');
    expect(verdict('gone')).toBe('missing');
    expect(verdict('unit')).toBe('unit-changed');
    expect(result.regressed).toEqual([]);
    expect(formatComparison(result)).toContain('회귀 없음');
  });
  test('a ratio at or below 1 is refused (everything would regress)', () => {
    expect(() => compareBaselines({measurements: {}}, {measurements: {}}, {ratio: 1})).toThrow();
  });
});

describe('baseline file', () => {
  const valid = () => ({
    schemaVersion: 1, measuredAt: '2026-10-08T00:00:00.000Z',
    environment: {machineModel: 'Mac', cpuModel: 'M', cpuCount: 8, totalMemoryGiB: 16, os: 'Darwin', bunVersion: '1', gitHead: 'abc', gitDirty: false, loadavgStart: [1, 1, 1], loadavgEnd: [1, 1, 1]},
    measurements: {'x.y': m([1, 2, 3])},
  });
  test('the validator accepts a well-formed document', () => {
    expect(validateBaseline(valid())).toEqual([]);
  });
  test('the validator reports every problem, including summaries that do not match their samples', () => {
    const broken: any = valid();
    broken.schemaVersion = 2;
    broken.measurements['x.y'].median = 99;
    broken.measurements['Bad Id'] = {unit: 'seconds', samples: [], method: 'x'};
    const problems = validateBaseline(broken);
    expect(problems.some(p => p.includes('schemaVersion'))).toBe(true);
    expect(problems.some(p => p.includes('median 99 does not match'))).toBe(true);
    expect(problems.some(p => p.startsWith('Bad Id'))).toBe(true);
  });
  test('the committed docs/perf/baseline.json is a valid baseline with every measurement group', () => {
    const doc = JSON.parse(readFileSync(join(import.meta.dir, '..', 'docs', 'perf', 'baseline.json'), 'utf8'));
    expect(validateBaseline(doc)).toEqual([]);
    const ids = Object.keys(doc.measurements);
    for (const prefix of ['sidecar.start.', 'workroom.start.', 'workroom.read.', 'community.control.', 'remote.list.', 'remote.workroom.', 'ui.projects.', 'ui.bookmarks.']) {
      expect(ids.some(id => id.startsWith(prefix))).toBe(true);
    }
    // Every measurement says how it was taken and what the load was while it ran.
    for (const id of ids) {
      expect(doc.measurements[id].loadavg?.start?.length).toBe(3);
      expect(typeof doc.measurements[id].reproducible).toBe('boolean');
    }
  });
});
