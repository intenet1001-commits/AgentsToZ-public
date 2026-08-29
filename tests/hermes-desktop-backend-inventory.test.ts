import { describe, expect, test } from 'bun:test';
import { liveHermesDesktopProfiles } from '../src/hermesDesktopBackendInventory';

describe('Hermes Desktop local Bot server inventory', () => {
  test('keeps only live profile serve processes', () => {
    const result = liveHermesDesktopProfiles({ backends: [
      { pid: 11, profile: 'nh-plugins', command: 'python -m hermes_cli.main --profile nh-plugins serve --host 127.0.0.1' },
      { pid: 12, profile: 'stale', command: 'python -m hermes_cli.main --profile stale serve --host 127.0.0.1' },
      { pid: 13, profile: 'wrong', command: 'python something-else --profile wrong serve' },
    ] }, pid => pid === 11);
    expect([...result]).toEqual(['nh-plugins']);
  });

  test('accepts the default profile command without a profile flag', () => {
    const result = liveHermesDesktopProfiles({ backends: [
      { pid: 20, profile: 'default', command: 'python -m hermes_cli.main serve --host 127.0.0.1' },
    ] }, () => true);
    expect(result.has('default')).toBe(true);
  });

  test('fails closed for malformed ownership data', () => {
    expect(liveHermesDesktopProfiles(null, () => true).size).toBe(0);
    expect(liveHermesDesktopProfiles({ backends: 'bad' }, () => true).size).toBe(0);
  });
});
