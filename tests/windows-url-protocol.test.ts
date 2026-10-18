import { expect, test } from 'bun:test';
import {
  WINDOWS_URL_PROTOCOL_HIVES,
  isPinnedWindowsUrlScheme,
  isWindowsUrlProtocolRegistered,
  windowsUrlProtocolKey,
  windowsUrlProtocolQueryArgs,
} from '../src/windowsUrlProtocol';

test('only the pinned schemes are accepted', () => {
  for (const scheme of ['codex', 'chatgpt', 'claude']) {
    expect(isPinnedWindowsUrlScheme(scheme)).toBe(true);
  }
  // A scheme must never arrive from a request body; this rejects anything else.
  for (const scheme of ['', 'http', 'file', 'CODEX', 'codex ', 'codex\\..', 'cmd', 'x'.repeat(40)]) {
    expect(isPinnedWindowsUrlScheme(scheme)).toBe(false);
  }
});

test('the registry key is built per hive and rejects a malformed scheme', () => {
  expect(windowsUrlProtocolKey('HKCU', 'codex')).toBe('HKCU\\Software\\Classes\\codex');
  expect(windowsUrlProtocolKey('HKLM', 'chatgpt')).toBe('HKLM\\Software\\Classes\\chatgpt');
  for (const scheme of ['', 'has space', 'a\\b', 'UPPER', '1leading', 'x'.repeat(40)]) {
    expect(() => windowsUrlProtocolKey('HKCU', scheme)).toThrow();
    expect(() => windowsUrlProtocolQueryArgs('HKCU', scheme)).toThrow();
  }
});

test('the query asks only for the URL Protocol value', () => {
  const args = windowsUrlProtocolQueryArgs('HKCU', 'codex');
  expect(args[0]).toBe('query');
  expect(args[1]).toBe('HKCU\\Software\\Classes\\codex');
  expect(args).toContain('/v');
  expect(args[args.indexOf('/v') + 1]).toBe('URL Protocol');
  // No /s recursion: a handler subkey layout differs between AppX and classic
  // installers, and the presence of the value is the whole question.
  expect(args).not.toContain('/s');
});

test('per-user registration is probed before machine-wide', () => {
  // An AppX or per-user installer writes HKCU, which is the common case here.
  expect([...WINDOWS_URL_PROTOCOL_HIVES]).toEqual(['HKCU', 'HKLM']);
});

test('registration is decided by reg.exe exit codes, never by its localized output', () => {
  // Measured on Windows 11 26100: registered = exit 0, absent = exit 1.
  expect(isWindowsUrlProtocolRegistered([0, 1])).toBe(true);
  expect(isWindowsUrlProtocolRegistered([1, 0])).toBe(true);
  expect(isWindowsUrlProtocolRegistered([1, 1])).toBe(false);
  // A spawn that could not run at all proves nothing and must not read as present.
  expect(isWindowsUrlProtocolRegistered([null, null])).toBe(false);
  expect(isWindowsUrlProtocolRegistered([])).toBe(false);
});
