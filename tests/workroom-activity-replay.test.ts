import {describe, expect, test} from 'bun:test';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  WORKROOM_ACTIVITY_SAMPLE_MS, WORKROOM_NEEDS_ANSWER_STABLE_MS, WORKROOM_TURN_FINISHED_QUIET_MS,
  initialWorkroomActivityTracker, reduceWorkroomActivity, workroomSampleInputs, workroomSampleWantsRows,
  type WorkroomActivityInput, type WorkroomActivityTracker, type WorkroomSampleMemory,
} from '../src/aiTerminalActivity';

/**
 * Every recorded real-CLI session (Claude Code 2.1.301, Codex 0.162.1 — see tests/fixtures/workroom-activity and
 * tests/workroom-activity-fixtures.test.ts) replayed through the shipped sampler (`workroomSampleWantsRows` +
 * `workroomSampleInputs`, the same functions AiTerminalService runs) and reducer, on a fake clock driven by the
 * recorded timestamps: writes set `lastOutputAt`, the screen at each sweep is the last recorded frame, inputs are
 * applied when written, transcript end lines are reported by the first sweep after they reached the disk.
 * Each fixture runs at four sweep phases (0/250/500/750 ms), with and without the transcript.
 */

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'workroom-activity');
type Phase = {name: string; kind: 'working' | 'idle' | 'prompt' | 'startup'; start: number; end: number};
type Action = {t: number; action: string; data?: string; note?: string};
type TranscriptLine = {seenAt: number; writtenAtApprox: number | null; type: string; subtype: string | null; stopReason?: string | null};
interface Fixture {
  cli: 'claude' | 'codex'; scenario: string; phases: Phase[]; actions: Action[]; output: [number, number][];
  screens: {t: number; rows: string[] | Record<string, string>}[]; transcript: TranscriptLine[];
}
const loadFixtures = () => readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json')).sort()
  .map(file => ({file, data: JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture}));

interface Transition {at: number; state: string; exact: boolean; source: string}
/** The turn end markers a transcript tail would report (Claude end_turn, Codex task_complete). */
const turnEnds = (fixture: Fixture) => fixture.transcript.filter(line => fixture.cli === 'claude'
  ? line.type === 'assistant' && line.stopReason === 'end_turn' : line.type === 'event_msg' && line.subtype === 'task_complete');

function replay(fixture: Fixture, options: {offset?: number; transcript?: boolean; sampleMs?: number} = {}) {
  const sampleMs = options.sampleMs ?? WORKROOM_ACTIVITY_SAMPLE_MS;
  // Rebuild every screen: the first frame is whole, later ones carry only the rows that changed.
  let rows: string[] = [];
  const screens = fixture.screens.map(s => {
    rows = Array.isArray(s.rows) ? [...s.rows] : rows.map((row, i) => (s.rows as Record<string, string>)[i] ?? row);
    return {t: s.t, rows};
  });
  const writes = fixture.output.map(([t]) => t);
  const startAt = fixture.actions.find(a => a.action === 'start')!.t;
  const closeAt = fixture.actions.find(a => a.action === 'close')!.t;
  const inputs = fixture.actions.filter(a => a.action === 'input');
  const ends = options.transcript === false ? [] : turnEnds(fixture);

  let tracker: WorkroomActivityTracker = initialWorkroomActivityTracker(startAt);
  const memory: WorkroomSampleMemory = {startedAt: startAt};
  const transitions: Transition[] = [{at: startAt, state: 'starting', exact: true, source: 'screen'}];
  let turn = 0;
  const apply = (input: WorkroomActivityInput) => {
    const result = reduceWorkroomActivity(tracker, input);
    tracker = result.tracker;
    if (result.changed) transitions.push({at: input.at, state: tracker.activity.state, exact: tracker.activity.exact, source: tracker.activity.source});
  };
  const lastBefore = <T extends {t: number}>(list: T[], t: number) => { let found: T | undefined; for (const item of list) { if (item.t > t) break; found = item; } return found; };
  let nextInput = 0, nextEnd = 0;
  for (let tick = startAt + (options.offset ?? 0) + sampleMs; tick < closeAt; tick += sampleMs) {
    // Inputs are applied when written (the service does it on the write path), before the next sweep.
    while (nextInput < inputs.length && inputs[nextInput]!.t <= tick) {
      const input = inputs[nextInput++]!;
      turn++;
      apply({type: /[\r\n]$/.test(input.data ?? '') ? 'submit' : 'keys', at: input.t, turn});
    }
    let lastOutputAt: number | null = null;
    for (const t of writes) { if (t > tick) break; lastOutputAt = t; }
    const shown = workroomSampleWantsRows(memory, lastOutputAt) ? lastBefore(screens, tick)?.rows ?? null : undefined;
    for (const input of workroomSampleInputs(memory, {at: tick, turn, lastOutputAt, rows: shown})) apply(input);
    // The sweep then tails transcripts: an end line already on disk is reported in this sweep.
    while (nextEnd < ends.length && ends[nextEnd]!.seenAt <= tick) {
      const end = ends[nextEnd++]!;
      apply({type: 'transcript', at: tick, turn, key: `end:${end.seenAt}`, completedAt: end.writtenAtApprox ?? end.seenAt});
    }
  }
  return transitions;
}
const sequence = (transitions: Transition[]) => transitions.map(t => `${t.state}${t.exact ? '' : '~'}`);

const fixtures = loadFixtures();
const OFFSETS = [0, 250, 500, 750];
/** `?` marks a state the recording may or may not reach (Codex sat quiet ~5 s before the recorder submitted). */
const EXPECTED: Record<string, string[]> = {
  'claude-startup': ['starting', 'needs-answer~', 'starting~', 'idle~', 'working', 'turn-finished'],
  'codex-startup': ['starting', 'needs-answer~', 'starting~', 'idle~', 'working', 'turn-finished'],
  'claude-stream': ['starting', 'working', 'turn-finished'],
  'codex-stream': ['starting', 'idle~?', 'working', 'turn-finished'],
  'claude-approval': ['starting', 'working', 'needs-answer~', 'working~', 'turn-finished'],
  'codex-approval': ['starting', 'idle~?', 'working', 'needs-answer~', 'working~', 'turn-finished'],
  'claude-silent': ['starting', 'working', 'turn-finished'],
  'codex-silent': ['starting', 'idle~?', 'working', 'turn-finished'],
};
function matches(actual: string[], expected: string[]): boolean {
  const required = expected.filter(e => !e.endsWith('?'));
  const optional = expected.map(e => e.replace(/\?$/, ''));
  const withOptional = actual.join(' ') === optional.join(' ');
  return withOptional || actual.join(' ') === required.join(' ');
}
const stateAt = (transitions: Transition[], t: number) => { let state = transitions[0]!; for (const tr of transitions) { if (tr.at > t) break; state = tr; } return state; };

describe('activity replay on real CLI recordings', () => {
  test('every fixture has an expected sequence', () => {
    expect(fixtures.map(f => f.file.replace(/\.json$/, '')).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const {file, data} of fixtures) {
    const name = file.replace(/\.json$/, '');
    describe(name, () => {
      const runs = OFFSETS.flatMap(offset => [true, false].map(transcript => ({offset, transcript, transitions: replay(data, {offset, transcript})})));
      const label = (run: {offset: number; transcript: boolean}) => `${name} offset ${run.offset} ${run.transcript ? 'with' : 'without'} transcript`;

      test('the state sequence matches, the turn end exact only from the transcript', () => {
        for (const run of runs) {
          const expected = EXPECTED[name]!.map(e => run.transcript || !e.startsWith('turn-finished') ? e : 'turn-finished~');
          expect(matches(sequence(run.transitions), expected), `${label(run)}: ${sequence(run.transitions).join(' → ')}`).toBe(true);
          const finish = run.transitions.at(-1)!;
          expect(finish.state).toBe('turn-finished');
          expect(finish.source).toBe(run.transcript ? 'transcript' : 'screen');
        }
      });

      test('working throughout every working stretch, silent model waits and tool runs included', () => {
        const prompts = data.phases.filter(p => p.kind === 'prompt');
        for (const run of runs) for (const phase of data.phases.filter(p => p.kind === 'working')) {
          // A stretch resumed after an answer is working from the next sweep on.
          const from = phase.start + (prompts.some(p => p.end === phase.start) ? WORKROOM_ACTIVITY_SAMPLE_MS : 0);
          for (let t = from; t < phase.end; t += 100) {
            if (prompts.some(p => t >= p.start && t < p.end + WORKROOM_ACTIVITY_SAMPLE_MS)) continue;
            expect(stateAt(run.transitions, t).state, `${label(run)} ${phase.name} @${t}`).toBe('working');
          }
        }
      });

      test('a trust or approval prompt is needs-answer within the stable window plus two sweeps, and only then', () => {
        const prompts = data.phases.filter(p => p.kind === 'prompt');
        for (const run of runs) {
          for (const tr of run.transitions.filter(t => t.state === 'needs-answer'))
            expect(prompts.some(p => tr.at >= p.start && tr.at <= p.end), `${label(run)} needs-answer @${tr.at}`).toBe(true);
          for (const prompt of prompts) {
            const asked = run.transitions.find(t => t.state === 'needs-answer' && t.at >= prompt.start);
            expect(asked, `${label(run)} ${prompt.name}`).toBeDefined();
            expect(asked!.at - prompt.start).toBeLessThanOrEqual(WORKROOM_NEEDS_ANSWER_STABLE_MS + 2 * WORKROOM_ACTIVITY_SAMPLE_MS);
            // The answer moves it on within a sweep of the next screen change.
            const left = run.transitions.find(t => t.at > asked!.at);
            expect(left && left.at - prompt.end, `${label(run)} after ${prompt.name}`).toBeLessThanOrEqual(WORKROOM_ACTIVITY_SAMPLE_MS + 100);
          }
        }
      });

      test('idle stretches never read as working (no false work from a lone repaint)', () => {
        for (const run of runs) for (const phase of data.phases.filter(p => p.kind === 'idle'))
          for (const tr of run.transitions.filter(t => t.at > phase.start && t.at < phase.end))
            expect(['working', 'needs-answer'], `${label(run)} ${phase.name} @${tr.at}`).not.toContain(tr.state);
      });

      test('the turn end lands one sweep after the transcript line, or 3–4 s after the last write without it', () => {
        const ends = turnEnds(data);
        expect(ends.length).toBe(1);
        const writes = data.output.map(([t]) => t);
        for (const run of runs) {
          const finish = run.transitions.at(-1)!;
          if (run.transcript) {
            expect(finish.at - ends[0]!.seenAt, label(run)).toBeGreaterThanOrEqual(0);
            expect(finish.at - ends[0]!.seenAt, label(run)).toBeLessThanOrEqual(WORKROOM_ACTIVITY_SAMPLE_MS);
          } else {
            const lastWrite = writes.filter(t => t <= finish.at).at(-1)!;
            expect(finish.at - lastWrite, label(run)).toBeGreaterThanOrEqual(WORKROOM_TURN_FINISHED_QUIET_MS);
            expect(finish.at - lastWrite, label(run)).toBeLessThanOrEqual(WORKROOM_TURN_FINISHED_QUIET_MS + WORKROOM_ACTIVITY_SAMPLE_MS);
          }
        }
      });
    });
  }

  test('the heuristic turn-end threshold keeps at least 3× margin over the longest silence while working', () => {
    for (const {file, data} of fixtures) {
      const writes = data.output.map(([t]) => t);
      const prompts = data.phases.filter(p => p.kind === 'prompt');
      for (const phase of data.phases.filter(p => p.kind === 'working' && p.name !== 'whole-turn')) {
        const inside = writes.filter(t => t >= phase.start && t <= phase.end && !prompts.some(p => t >= p.start && t < p.end));
        const gaps = inside.slice(1).map((t, i) => t - inside[i]!);
        expect(Math.max(0, ...gaps) * 3, `${file} ${phase.name}`).toBeLessThan(WORKROOM_TURN_FINISHED_QUIET_MS);
      }
    }
  });
});
