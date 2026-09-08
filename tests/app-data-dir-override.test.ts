import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveAppDataDirFromEnvironment } from '../src/appDataDir';

describe('sidecar APP_DATA_DIR bootstrap override', () => {
  test('uses and normalizes an explicit absolute directory', () => {
    expect(resolveAppDataDirFromEnvironment('darwin', {
      APP_DATA_DIR: '/tmp/agentstoz-e2e/../isolated',
    }, '/Users/test')).toBe('/tmp/isolated');
    expect(resolveAppDataDirFromEnvironment('win32', {
      APP_DATA_DIR: 'C:\\agentstoz-e2e\\isolated\\',
    }, 'C:\\Users\\test')).toBe('C:\\agentstoz-e2e\\isolated\\');
  });

  test('falls back to the platform contract only when no override was supplied', () => {
    expect(resolveAppDataDirFromEnvironment('linux', {
      XDG_CONFIG_HOME: '/srv/config',
    }, '/home/test')).toBe('/srv/config/com.portmanager.portmanager');
  });

  test('rejects empty, relative, root, and NUL-bearing overrides', () => {
    for (const value of ['', '.', 'relative/path', '/', '/tmp/bad\0path']) {
      expect(() => resolveAppDataDirFromEnvironment('linux', {
        APP_DATA_DIR: value,
      }, '/home/test')).toThrow();
    }
    for (const value of ['C:\\', '\\relative']) {
      expect(() => resolveAppDataDirFromEnvironment('win32', {
        APP_DATA_DIR: value,
      }, 'C:\\Users\\test')).toThrow();
    }
  });

  test('captures the validated override before scrubbing child-process environment', () => {
    const source = readFileSync(new URL('../api-server.ts', import.meta.url), 'utf8');
    expect(source.indexOf('const APP_DATA_DIR = resolveAppDataDirFromEnvironment()'))
      .toBeLessThan(source.indexOf('delete process.env.APP_DATA_DIR'));
  });
});
