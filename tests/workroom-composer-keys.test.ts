import {describe, expect, test} from 'bun:test';
import {workroomComposerKeyToCli} from '../src/workroomComposerKeys';

// VOC 2026-10-02: the CLI's keys work from the Workroom input box (NHCS 0.10.1 draftKeyToCli).
const none = {ctrl: false, meta: false, alt: false, shift: false};
const empty = {empty: true, appCursor: false, menuOpen: false};
const typed = {...empty, empty: false};

describe('Workroom input box keys that go to the CLI', () => {
  test('while the box is empty: arrows, Tab, Enter and the editing keys, as a terminal sends them', () => {
    const sent = (key: string, mods = none, context = empty) => workroomComposerKeyToCli(key, mods, context);
    expect(['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].map(key => sent(key))).toEqual(['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F']);
    // A CLI in application cursor mode (DECCKM) gets SS3 arrows, like the key buttons below the screen.
    expect(['ArrowUp', 'ArrowDown', 'Home'].map(key => sent(key, none, {...empty, appCursor: true}))).toEqual(['\x1bOA', '\x1bOB', '\x1bOH']);
    expect(sent('Tab')).toBe('\t');
    expect(sent('Tab', {...none, shift: true})).toBe('\x1b[Z');
    expect(sent('Enter')).toBe('\r');
    expect(sent('Enter', {...none, shift: true})).toBeNull();
    expect([sent('Backspace'), sent('Delete'), sent('PageUp'), sent('PageDown')]).toEqual(['\x7f', '\x1b[3~', '\x1b[5~', '\x1b[6~']);
  });

  test('with anything in the box, those keys edit or send it as before', () => {
    for (const key of ['ArrowUp', 'ArrowLeft', 'Tab', 'Enter', 'Backspace', 'Home']) expect(workroomComposerKeyToCli(key, none, typed)).toBeNull();
  });

  test('Esc and Ctrl+C always go — except Esc while a suggestion list is open', () => {
    expect(workroomComposerKeyToCli('Escape', none, typed)).toBe('\x1b');
    expect(workroomComposerKeyToCli('Escape', none, {...typed, menuOpen: true})).toBeNull();
    expect(workroomComposerKeyToCli('c', {...none, ctrl: true}, typed)).toBe('\x03');
    expect(workroomComposerKeyToCli('d', {...none, ctrl: true}, empty)).toBeNull();
    expect(workroomComposerKeyToCli('c', {...none, ctrl: true, shift: true}, empty)).toBeNull();
  });

  test('never ⌘/⌥ chords or text, and a held Backspace stops at the box', () => {
    expect(workroomComposerKeyToCli('ArrowUp', {...none, meta: true}, empty)).toBeNull();
    expect(workroomComposerKeyToCli('4', {...none, meta: true, alt: true}, empty)).toBeNull();
    expect(workroomComposerKeyToCli('a', none, empty)).toBeNull();
    expect(workroomComposerKeyToCli('1', none, empty)).toBeNull();
    expect(workroomComposerKeyToCli('Backspace', none, {...empty, repeat: true})).toBeNull();
    expect(workroomComposerKeyToCli('ArrowDown', none, {...empty, repeat: true})).toBe('\x1b[B');
  });
});
