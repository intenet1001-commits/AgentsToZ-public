import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {workroomScreenAwaitsAnswer} from '../src/workroomRouteDelivery';

/**
 * Real CLI screens recorded through AiTerminalService's own headless screen (Claude Code 2.1.301,
 * Codex 0.162.1; isolated config, dummy key, a local fake model — see tests/fixtures/workroom-activity).
 * The recordings are static data, so these checks are deterministic: they pin what the screen
 * heuristic says on real prompts, real working screens and real idle composers.
 */
const DIR = join(import.meta.dir, 'fixtures', 'workroom-activity');
type Phase = {name: string; kind: 'working' | 'idle' | 'prompt' | 'startup'; start: number; end: number};
type Shot = {t: number; rows: string[]; awaitsAnswer: boolean};
interface Fixture {schema: string; cli: string; scenario: string; phases: Phase[]; screens: {t: number; awaitsAnswer: boolean; rows: string[] | Record<string, string>}[]; output: [number, number][]; titles: [number, string][]}

const fixtures = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => ({file: f, data: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture}));

/** The first screen is stored whole; later ones only carry the rows that changed. */
function screens(fixture: Fixture): Shot[] {
  let rows: string[] = [];
  return fixture.screens.map(s => {
    rows = Array.isArray(s.rows) ? [...s.rows] : rows.map((row, i) => (s.rows as Record<string, string>)[i] ?? row);
    return {t: s.t, rows, awaitsAnswer: s.awaitsAnswer};
  });
}
const inPhase = (shots: Shot[], phase: Phase) => shots.filter(s => s.t >= phase.start && s.t < phase.end);

describe('workroom activity fixtures (real CLI recordings)', () => {
  test('every CLI and scenario is present, and nothing machine-specific leaked', () => {
    expect(fixtures.map(f => f.file).sort()).toEqual(['claude', 'codex'].flatMap(cli => ['approval', 'silent', 'startup', 'stream'].map(s => `${cli}-${s}.json`)).sort());
    for (const {file, data} of fixtures) {
      expect(data.schema).toBe('workroom-activity-calibration/v1');
      const text = readFileSync(join(DIR, file), 'utf8');
      for (const leak of ['/Users/', '/private/', 'sk-ant-', 'dummy-key']) expect(text.includes(leak)).toBe(false);
    }
  });

  test('a trust or approval prompt reads as awaiting an answer on every recorded frame', () => {
    for (const {file, data} of fixtures) {
      const shots = screens(data);
      for (const phase of data.phases.filter(p => p.kind === 'prompt')) {
        const frames = inPhase(shots, phase);
        expect(frames.length, `${file} ${phase.name}`).toBeGreaterThan(0);
        for (const frame of frames) expect(workroomScreenAwaitsAnswer(frame.rows), `${file} ${phase.name} @${frame.t}`).toBe(true);
      }
    }
  });

  test('working and idle screens never read as awaiting an answer', () => {
    let checked = 0;
    for (const {file, data} of fixtures) {
      const shots = screens(data);
      const prompts = data.phases.filter(p => p.kind === 'prompt');
      for (const phase of data.phases.filter(p => p.kind === 'working' || p.kind === 'idle')) {
        for (const frame of inPhase(shots, phase)) {
          if (prompts.some(p => frame.t >= p.start && frame.t < p.end)) continue;
          expect(workroomScreenAwaitsAnswer(frame.rows), `${file} ${phase.name} @${frame.t}`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test('the recorded prompts keep repainting, so a quiet-output rule alone would never see them', () => {
    // Claude blinks a row about every 0.6 s while waiting for approval; Codex toggles its window title every second.
    for (const {file, data} of fixtures.filter(f => f.data.scenario === 'approval')) {
      const phase = data.phases.find(p => p.name === 'approval-prompt-waiting')!;
      const writes = data.output.map(([t]) => t).filter(t => t >= phase.start && t < phase.end);
      const gaps = writes.slice(1).map((t, i) => t - writes[i]!);
      expect(writes.length, file).toBeGreaterThan(10);
      expect(Math.max(...gaps), file).toBeLessThan(1500);
    }
  });
});
