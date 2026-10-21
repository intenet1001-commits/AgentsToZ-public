import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {
  initialVoiceDockWindowState, showVoiceDockReopen, voiceDockWindowReducer,
  type VoiceDockWindowEvent, type VoiceDockWindowState,
} from '../src/voiceDockWindowState';

// VOC 2026-10-15: once the 「아젠투지 호출」 window was closed, the only way back was to quit the whole app.
const run = (...events: VoiceDockWindowEvent[]) => events.reduce(voiceDockWindowReducer, initialVoiceDockWindowState);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// Report only the missing needle, never the whole (huge) source file.
const has = (source: string, needle: string | RegExp) => ({needle: String(needle), found: typeof needle === 'string' ? source.includes(needle) : needle.test(source)});
const expectHas = (source: string, needle: string | RegExp) => expect(has(source, needle)).toEqual({needle: String(needle), found: true});

describe('voice dock window state', () => {
  test('nothing is offered until we know the window is gone', () => {
    expect(showVoiceDockReopen(initialVoiceDockWindowState)).toBe(false);
    expect(showVoiceDockReopen(run({type: 'open-requested'}))).toBe(false);
    expect(showVoiceDockReopen(run({type: 'open-requested'}, {type: 'opened'}))).toBe(false);
  });
  test('closing the window offers the reopen button; reopening hides it again', () => {
    const closed = run({type: 'open-requested'}, {type: 'opened'}, {type: 'closed'});
    expect(showVoiceDockReopen(closed)).toBe(true);
    const reopening = voiceDockWindowReducer(closed, {type: 'open-requested'});
    expect(showVoiceDockReopen(reopening)).toBe(false);
    expect(showVoiceDockReopen(voiceDockWindowReducer(reopening, {type: 'opened'}))).toBe(false);
  });
  test('a failed open leaves the reopen path available', () => {
    expect(showVoiceDockReopen(run({type: 'open-requested'}, {type: 'open-failed'}))).toBe(true);
  });
  test('a state query answers only if nothing happened since it was sent', () => {
    const opened = run({type: 'open-requested'}, {type: 'opened'});
    const asked = opened.epoch;
    // The window closed while the query was in flight: the stale "open" answer must not hide the button.
    const closed = voiceDockWindowReducer(opened, {type: 'closed'});
    expect(showVoiceDockReopen(voiceDockWindowReducer(closed, {type: 'queried', epoch: asked, open: true}))).toBe(true);
    // An undisturbed query is believed both ways (e.g. the native close happened while the main window slept).
    expect(showVoiceDockReopen(voiceDockWindowReducer(opened, {type: 'queried', epoch: asked, open: false}))).toBe(true);
    expect(showVoiceDockReopen(voiceDockWindowReducer(closed, {type: 'queried', epoch: closed.epoch, open: true}))).toBe(false);
  });
  test('a query never flips an open that is still in progress', () => {
    const opening: VoiceDockWindowState = run({type: 'open-requested'});
    expect(voiceDockWindowReducer(opening, {type: 'queried', epoch: opening.epoch, open: false})).toEqual(opening);
  });
});

describe('the main window learns that the voice window is gone', () => {
  test('Rust tells main when the voice window is destroyed and answers whether it exists', () => {
    const rust = read('../src-tauri/src/voice_popout.rs');
    expectHas(rust, 'voice-dock:closed');
    expectHas(rust, /WindowEvent::Destroyed/);
    expectHas(rust, /emit_to\("main",\s*CLOSED_EVENT/);
    // The behaviour of the handler (ALIVE cleared before main is told) is tested in Rust; this pins its registration.
    expectHas(rust, /voice\.on_window_event\(move\|event\|on_voice_window_event\(event,/);
    expectHas(rust, /pub\(crate\) (async )?fn voice_window_open\(/);
    const lib = read('../src-tauri/src/lib.rs');
    expectHas(lib, 'voice_popout::voice_window_open');
  });
  test('the launcher wires the state, the event, the query and a compact (not panel) reopen', () => {
    const source = read('../src/NativeVoiceLauncher.tsx');
    expectHas(source, "from './voiceDockWindowState'");
    expectHas(source, 'voice-dock:closed');
    expectHas(source, "invoke<boolean>('voice_window_open')");
    expectHas(source, 'data-testid="voice-dock-reopen"');
    expectHas(source, '아젠투지 호출 열기');
    expectHas(source, /addEventListener\('focus'/);
    expectHas(source, /addEventListener\('visibilitychange'/);
    // The reopen button brings back the compact dock, not the full voice panel.
    expectHas(source, 'const reopen=()=>openRef.current(false);');
    expectHas(source, 'const reopenDock=()=>open(false);');
    expectHas(source, 'onClick={reopen}');
  });
  test('「도구 및 설정」 offers the same compact reopen next to the voice panel button (app only)', () => {
    const app = read('../src/App.tsx');
    expectHas(app, 'data-testid="voice-dock-reopen-tools"');
    expectHas(app, 'OPEN_VOICE_DOCK_EVENT');
    expectHas(read('../src/NativeVoiceLauncher.tsx'), 'OPEN_VOICE_DOCK_EVENT');
  });
});

describe('the reopen button stays out of the way of the rest of the app', () => {
  const css = read('../src/NativeVoiceLauncher.css');
  const pillZ = Number(/\.voice-dock-reopen\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
  test('it sits below every full-screen modal scrim, so an open dialog covers it', () => {
    const {readdirSync} = require('node:fs') as typeof import('node:fs');
    const files = (readdirSync(new URL('../src', import.meta.url), {recursive: true}) as string[])
      .filter(name => /\.(tsx|css)$/.test(name)).map(name => read(`../src/${name}`));
    const scrims: number[] = [];
    for (const source of files) {
      for (const match of source.matchAll(/className=["'{`][^"'`]*\bfixed inset-0\b[^"'`]*/g)) {
        const z = /\bz-(?:\[(\d+)\]|(\d+))/.exec(match[0]);
        if (z) scrims.push(Number(z[1] ?? z[2]));
      }
      for (const match of source.matchAll(/\{[^}]*\binset:\s*0\s*;[^}]*\}/g)) {
        const z = /z-index:\s*(\d+)/.exec(match[0]);
        if (z && /position:\s*fixed/.test(match[0])) scrims.push(Number(z[1]));
      }
    }
    expect(scrims.length).toBeGreaterThan(5);
    expect(Number.isFinite(pillZ)).toBe(true);
    expect(pillZ).toBeLessThan(Math.min(...scrims));
  });
  test('「별명·카테고리 작업 다시 열기」 in the same corner is lifted above it', () => {
    const app = read('../src/App.tsx');
    const legacy = /<button[^<]*data-testid="legacy-name-work-reopen"[\s\S]*?<\/button>/.exec(app)?.[0] ?? '';
    expect(legacy.length).toBeGreaterThan(0);
    expectHas(legacy, /bottom:\s*'calc\(20px \+ var\(--voice-dock-offset, 0px\)\)'/);
    expect(/\bbottom-5\b/.test(legacy)).toBe(false);
  });
});
